"""
Sage Microsoft SQL Server synchronisation controller.

This module is responsible for connecting the Isambane Finances application
to the external Microsoft SQL Server database used by Sage.

Current scope
-------------
At this stage, the controller performs only a connection test:

1. Load the ``IS Finance Setup`` singleton.
2. Check whether Sage database connectivity is enabled.
3. Retrieve the configured server URL, username, and encrypted password.
4. Open a connection to Microsoft SQL Server.
5. Execute ``SELECT 1`` to confirm that the connection is operational.
6. Close the connection.
7. Write the outcome to the site-specific Sage Sync log.

No Sage data is currently read, inserted, updated, or deleted.

Security
--------
- The Sage password is retrieved through Frappe's Password-field API.
- Credentials are never written to logs.
- The generated connection string is never written to logs.
- SQL Server errors are sanitised before being written to logs because some
  ODBC drivers may include portions of the connection string in exceptions.

Required Python dependency
--------------------------
This controller uses ``pyodbc``.

Add it to the application's Python dependencies, for example in pyproject.toml:

    dependencies = [
        "pyodbc>=5.1.0",
    ]

The bench host or application container must also have a compatible Microsoft
ODBC Driver for SQL Server installed. The default driver used by this module is:

    ODBC Driver 18 for SQL Server

Supported ``sage_database_url`` formats
---------------------------------------
The field accepts one of the following formats.

1. Host and database:

       sql-server.example.local/SageDatabase

2. Host, port, and database:

       sql-server.example.local:1433/SageDatabase

3. Named SQL Express instance and database:

       sql-server.example.local\\SQLEXPRESS/SageDatabase

4. Microsoft SQL URL:

       mssql://sql-server.example.local:1433/SageDatabase

5. A complete ODBC connection string without username or password:

       DRIVER={ODBC Driver 18 for SQL Server};
       SERVER=sql-server.example.local\\SQLEXPRESS;
       DATABASE=SageDatabase;
       Encrypt=yes;
       TrustServerCertificate=yes;

The username and password are always taken from ``IS Finance Setup``. They
should not be embedded in the URL or ODBC connection string.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlparse

import frappe


SETTINGS_DOCTYPE = "IS Finance Setup"
LOGGER_NAME = "sage_sync"

DEFAULT_ODBC_DRIVER = "ODBC Driver 18 for SQL Server"
DEFAULT_CONNECTION_TIMEOUT_SECONDS = 30

# Prevent multiple copies of the same scheduled test from running concurrently.
JOB_LOCK_KEY = "is_finances:sage_sync:connection_test_lock"
JOB_LOCK_TIMEOUT_SECONDS = 10 * 60


@dataclass(frozen=True)
class SageDatabaseSettings:
    """
    Validated Sage database connection settings.

    Keeping the values in a dataclass makes the connection layer independent
    from the Frappe Document object and gives future synchronisation code a
    clear, typed settings interface.
    """

    database_url: str
    username: str
    password: str


class SageSyncConfigurationError(Exception):
    """Raised when the Sage database configuration is missing or invalid."""


def run_daily_sage_sync() -> None:
    """
    Scheduled entry point for the daily Sage synchronisation job.

    This method is intended to be referenced by ``scheduler_events`` in
    ``hooks.py`` under ``daily_long``.

    At present, it performs only a connection test. Later, the call to
    ``test_sage_database_connection`` can be followed by the actual Sage
    extraction and synchronisation workflow.

    The exception is deliberately re-raised after logging. This is important
    because Frappe must receive the exception to mark the scheduled/background
    job as failed rather than incorrectly recording it as successful.
    """
    logger = _get_logger()

    logger.info("Daily Sage database connection job started.")

    lock = frappe.cache.lock(
        JOB_LOCK_KEY,
        timeout=JOB_LOCK_TIMEOUT_SECONDS,
    )

    acquired = lock.acquire(blocking=False)

    if not acquired:
        logger.warning(
            "Sage database connection job skipped because another Sage "
            "connection job is already running."
        )
        return

    try:
        result = test_sage_database_connection()

        if result["status"] == "disabled":
            logger.info(
                "Daily Sage database connection job completed without testing "
                "the connection because Sage integration is disabled."
            )
            return

        logger.info(
            "Daily Sage database connection job completed successfully. "
            "The Microsoft SQL Server connection was opened, tested, and closed."
        )

    except Exception:
        logger.error(
            "Daily Sage database connection job failed.",
            exc_info=True,
        )

        # Create a Desk-visible Error Log while ensuring no credentials are
        # included in the title or custom message.
        frappe.log_error(
            title="Sage Database Connection Failed",
            message=frappe.get_traceback(),
        )

        # Re-raise so the Frappe Scheduled Job Log / background job correctly
        # records the execution as failed.
        raise

    finally:
        lock.release()


def test_sage_database_connection() -> dict[str, Any]:
    """
    Connect to the configured Microsoft SQL Server and execute ``SELECT 1``.

    Returns
    -------
    dict
        A small, non-sensitive status dictionary.

        Disabled integration::

            {
                "status": "disabled",
                "message": "Sage database integration is disabled."
            }

        Successful connection::

            {
                "status": "success",
                "message": "Sage database connection succeeded."
            }

    Raises
    ------
    SageSyncConfigurationError
        If the enabled integration is missing required configuration.

    RuntimeError
        If ``pyodbc`` is unavailable.

    pyodbc.Error
        If Microsoft SQL Server cannot be reached or authentication fails.

    Notes
    -----
    This method does not fetch any Sage records. The ``SELECT 1`` statement is
    used only to verify that:

    - DNS/server resolution works;
    - the SQL Server instance accepts connections;
    - the supplied SQL login is valid;
    - the target database can be opened; and
    - the connection can execute a basic query.
    """
    logger = _get_logger()
    settings_doc = frappe.get_doc(SETTINGS_DOCTYPE)

    if not settings_doc.get("connect_to_sage_database"):
        logger.info(
            "Sage database connection test skipped because "
            "'Connect To Sage Database' is disabled."
        )
        return {
            "status": "disabled",
            "message": "Sage database integration is disabled.",
        }

    settings = _get_validated_settings(settings_doc)
    connection_string = _build_connection_string(settings)

    connection = None

    try:
        pyodbc = _import_pyodbc()

        logger.info(
            "Attempting to connect to the configured Sage Microsoft SQL Server."
        )

        connection = pyodbc.connect(
            connection_string,
            timeout=DEFAULT_CONNECTION_TIMEOUT_SECONDS,
            autocommit=True,
        )

        cursor = connection.cursor()

        try:
            cursor.execute("SELECT 1")
            row = cursor.fetchone()

            if row is None or int(row[0]) != 1:
                raise RuntimeError(
                    "The Sage database connection opened, but the test query "
                    "did not return the expected result."
                )
        finally:
            cursor.close()

        logger.info(
            "Sage Microsoft SQL Server connection test succeeded."
        )

        return {
            "status": "success",
            "message": "Sage database connection succeeded.",
        }

    except Exception as exc:
        # Do not include the connection string, URL, username, or password in
        # the log message. The traceback remains available through Frappe's
        # normal exception logging.
        logger.error(
            "Sage Microsoft SQL Server connection test failed: %s",
            _sanitise_exception_message(exc),
            exc_info=True,
        )
        raise

    finally:
        if connection is not None:
            try:
                connection.close()
                logger.info("Sage Microsoft SQL Server connection closed.")
            except Exception:
                logger.warning(
                    "The Sage database connection could not be closed cleanly.",
                    exc_info=True,
                )


def _get_validated_settings(settings_doc: Any) -> SageDatabaseSettings:
    """
    Read and validate values from the ``IS Finance Setup`` singleton.

    Password fields must be read using ``Document.get_password``. Reading the
    field directly may return a masked value rather than the decrypted secret.
    """
    database_url = (settings_doc.get("sage_database_url") or "").strip()
    username = (settings_doc.get("sage_database_user") or "").strip()

    try:
        password = settings_doc.get_password("sage_database_password") or ""
    except Exception as exc:
        raise SageSyncConfigurationError(
            "The Sage database password could not be decrypted."
        ) from exc

    missing_fields: list[str] = []

    if not database_url:
        missing_fields.append("Sage Database URL")

    if not username:
        missing_fields.append("Sage Database User")

    if not password:
        missing_fields.append("Sage Database Password")

    if missing_fields:
        raise SageSyncConfigurationError(
            "Sage database integration is enabled, but the following settings "
            f"are missing: {', '.join(missing_fields)}."
        )

    return SageDatabaseSettings(
        database_url=database_url,
        username=username,
        password=password,
    )


def _build_connection_string(settings: SageDatabaseSettings) -> str:
    """
    Build a pyodbc connection string from the configured database URL.

    A complete ODBC connection string can be supplied in the URL field. When
    that format is used, UID and PWD are removed from the supplied string and
    replaced with the separately stored Frappe credentials.

    For shorthand URLs, this method extracts the SQL Server host/instance and
    database name, then builds an ODBC Driver 18 connection string.
    """
    database_url = settings.database_url.strip()

    if _looks_like_odbc_connection_string(database_url):
        base_connection_string = _normalise_odbc_connection_string(database_url)

        # Credentials in the supplied string are removed so the Password field
        # remains the sole source of authentication information.
        base_connection_string = _remove_odbc_property(
            base_connection_string,
            "UID",
        )
        base_connection_string = _remove_odbc_property(
            base_connection_string,
            "USER ID",
        )
        base_connection_string = _remove_odbc_property(
            base_connection_string,
            "PWD",
        )
        base_connection_string = _remove_odbc_property(
            base_connection_string,
            "PASSWORD",
        )

        return (
            f"{base_connection_string}"
            f"UID={_escape_odbc_value(settings.username)};"
            f"PWD={_escape_odbc_value(settings.password)};"
        )

    server, database = _parse_database_url(database_url)

    return (
        f"DRIVER={{{DEFAULT_ODBC_DRIVER}}};"
        f"SERVER={_escape_odbc_value(server)};"
        f"DATABASE={_escape_odbc_value(database)};"
        f"UID={_escape_odbc_value(settings.username)};"
        f"PWD={_escape_odbc_value(settings.password)};"
        "Encrypt=yes;"
        "TrustServerCertificate=yes;"
        f"Connection Timeout={DEFAULT_CONNECTION_TIMEOUT_SECONDS};"
    )


def _parse_database_url(database_url: str) -> tuple[str, str]:
    """
    Parse the Sage database URL into a SQL Server address and database name.

    Accepted examples:

    - ``mssql://server:1433/SageDatabase``
    - ``sqlserver://server/SageDatabase``
    - ``server:1433/SageDatabase``
    - ``server\\\\SQLEXPRESS/SageDatabase``
    """
    value = database_url.strip()

    if "://" in value:
        parsed = urlparse(value)

        supported_schemes = {
            "mssql",
            "mssql+pyodbc",
            "sqlserver",
        }

        if parsed.scheme.lower() not in supported_schemes:
            raise SageSyncConfigurationError(
                "Unsupported Sage Database URL scheme. Use mssql://, "
                "mssql+pyodbc://, sqlserver://, a host/database value, or a "
                "complete ODBC connection string."
            )

        if parsed.username or parsed.password:
            raise SageSyncConfigurationError(
                "Do not include a username or password in the Sage Database "
                "URL. Use the dedicated Sage Database User and Password fields."
            )

        server = parsed.hostname or ""

        if parsed.port:
            server = f"{server},{parsed.port}"

        database = unquote(parsed.path.lstrip("/")).strip()

    else:
        # rsplit is used so the server portion can contain other separators.
        try:
            server, database = value.rsplit("/", 1)
        except ValueError as exc:
            raise SageSyncConfigurationError(
                "The Sage Database URL must include the database name. "
                "Example: sql-server\\\\SQLEXPRESS/SageDatabase."
            ) from exc

        server = server.strip()
        database = database.strip()

        # ODBC uses a comma between a host and explicit TCP port.
        host_port_match = re.fullmatch(
            r"(?P<host>[^:,\\/]+):(?P<port>\d+)",
            server,
        )

        if host_port_match:
            server = (
                f"{host_port_match.group('host')},"
                f"{host_port_match.group('port')}"
            )

    if not server:
        raise SageSyncConfigurationError(
            "The Sage Database URL does not contain a SQL Server hostname."
        )

    if not database:
        raise SageSyncConfigurationError(
            "The Sage Database URL does not contain a database name."
        )

    return server, database


def _looks_like_odbc_connection_string(value: str) -> bool:
    """Return whether the configured value resembles an ODBC string."""
    upper_value = value.upper()

    return (
        ";" in value
        and (
            "SERVER=" in upper_value
            or "DATA SOURCE=" in upper_value
        )
    )


def _normalise_odbc_connection_string(value: str) -> str:
    """Ensure a supplied ODBC connection string ends with a semicolon."""
    normalised = value.strip()

    if not normalised.endswith(";"):
        normalised += ";"

    return normalised


def _remove_odbc_property(connection_string: str, property_name: str) -> str:
    """
    Remove a property from an ODBC connection string.

    The expression is intentionally scoped to semicolon-delimited ODBC
    properties. It is used only to remove credentials supplied accidentally.
    """
    pattern = re.compile(
        rf"(?i)(?:^|;)\s*{re.escape(property_name)}\s*="
        r"(?:\{(?:[^}]|}})*\}|[^;]*)\s*;",
    )

    cleaned = pattern.sub(";", connection_string).strip("; ")

    return f"{cleaned};" if cleaned else ""


def _escape_odbc_value(value: str) -> str:
    """
    Escape a value for use in an ODBC connection string.

    Braced ODBC values allow semicolons and other special characters. A closing
    brace is escaped by doubling it.
    """
    escaped = str(value).replace("}", "}}")
    return f"{{{escaped}}}"


def _import_pyodbc() -> Any:
    """
    Import pyodbc with a clear operational error if it is not installed.
    """
    try:
        import pyodbc
    except ImportError as exc:
        raise RuntimeError(
            "The pyodbc Python package is not installed. Add pyodbc to the "
            "is_finances application dependencies, install the Microsoft SQL "
            "Server ODBC driver on the bench host, and restart the workers."
        ) from exc

    return pyodbc


def _sanitise_exception_message(exc: Exception) -> str:
    """
    Return a limited exception message suitable for operational logging.

    The error is intentionally truncated and common credential properties are
    redacted as a defence against ODBC drivers that echo connection details.
    """
    message = str(exc)

    message = re.sub(
        r"(?i)\b(?:PWD|PASSWORD)\s*=\s*[^;]*",
        "PASSWORD=[REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)\b(?:UID|USER ID)\s*=\s*[^;]*",
        "USER=[REDACTED]",
        message,
    )

    # Avoid excessively large log entries from nested driver messages.
    return message[:2_000]


def _get_logger() -> Any:
    """
    Return the site-specific Sage synchronisation logger.

    Log output will normally be written beneath the site's ``logs`` directory,
    using Frappe's logging configuration.
    """
    return frappe.logger(
        LOGGER_NAME,
        allow_site=True,
        file_count=20,
    )
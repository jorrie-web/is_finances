"""
Sage Microsoft SQL Server synchronisation controller.

This module is responsible for connecting the Isambane Finances application
to one or more external Microsoft SQL Server databases used by Sage.

Current scope
-------------
The controller provides both connection testing and incremental POSTGL import:

1. Load the ``IS Finance Setup`` singleton.
2. Check whether Sage database connectivity is enabled.
3. Read and validate each configured Sage company database.
4. Read only new ``POSTGL`` rows where ``AutoIdx`` is greater than that
   connection row's ``last_postgl_auto_idx``.
5. For each POSTGL row, use ``POSTGL.AccountLink`` only as a lookup key into
   the Sage ``Accounts`` table to retrieve ``Master_Sub_Account``, ``Brch``,
   account ``Description``, and ``iAccountType``.
6. Read the project ID from ``POSTGL.Project`` and use it only as a lookup key
   into the Sage ``Project`` table via ``Project.ProjectLink`` to retrieve
   ``ProjectCode``, ``ProjectName``, and ``ProjectDescription``.
7. Read ``POSTGL.Order_No`` directly into the ERP ``order_no`` field.
8. Use ``POSTGL.DrCrAccount`` as a lookup key. Look in Sage ``Vendor`` first;
   only if no Vendor match exists, fall back to Sage ``Client``. Retrieve
   ``DCLink``, ``Account``, and ``Name`` into the ERP customer/supplier fields.
9. POSTGL remains the master/driving table: lookup tables can enrich a POSTGL
   row but can never create additional ERP transaction rows themselves.
10. Bulk insert the completed rows into the Frappe ``Sage POSTGL Entry`` DocType.
11. Advance the per-company high-water mark only after a successful batch.
12. Never insert, update, or delete records in the Sage SQL Server database.

The global ``postgl_sync_record_limit`` setting controls how many new records
are imported per Company per run. 0 means unlimited; unlimited mode is still
processed in bounded batches.

Multi-company design
--------------------
``IS Finance Setup`` is a singleton and acts as the global configuration
container for the Sage integration.

Individual Sage database connections are stored in the
``IS Finance Setup Table`` child table. Each row identifies:

- the Frappe Company to which the Sage database belongs;
- the Sage database URL / SQL Server address;
- the Sage database username; and
- the encrypted Sage database password.

This design allows a single Frappe site to connect to multiple Sage company
databases while keeping the credentials for each company isolated.

Security
--------
- Sage passwords are retrieved through Frappe's Password-field API.
- Decrypted passwords are deliberately excluded from dataclass ``repr`` output.
  This is important because Frappe Error Logs can include local variables from
  tracebacks.
- Credentials are never intentionally written to logs.
- Generated connection strings are not stored in the main connection-test
  function's local variables.
- SQL Server errors are sanitised before being written to logs because some
  ODBC drivers may include portions of the connection string in exceptions.
- Connection-test result dictionaries contain Company names only and never
  contain usernames, passwords, URLs, or connection strings.

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
Each child-table row accepts one of the following formats.

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

The username and password are always taken from the child-table row. They
should not be embedded in the URL or ODBC connection string.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote, urlparse

import frappe
from frappe.utils import now_datetime


SETTINGS_DOCTYPE = "IS Finance Setup"
CONNECTION_TABLE_FIELD = "database_connections"
CONNECTION_CHILD_DOCTYPE = "IS Finance Setup Table"

LOGGER_NAME = "sage_sync"

DEFAULT_ODBC_DRIVER = "ODBC Driver 18 for SQL Server"
DEFAULT_CONNECTION_TIMEOUT_SECONDS = 30

# Prevent multiple copies of the same scheduled Sage connection/sync job from
# running concurrently. This is particularly important now that one scheduled
# invocation may connect to several company databases.
JOB_LOCK_KEY = "is_finances:sage_sync:connection_test_lock"
JOB_LOCK_TIMEOUT_SECONDS = 10 * 60

# POSTGL incremental synchronisation configuration.
POSTGL_TARGET_DOCTYPE = "Sage POSTGL Entry"
POSTGL_SOURCE_TABLE = "POSTGL"
ACCOUNTS_SOURCE_TABLE = "Accounts"
PROJECT_SOURCE_TABLE = "Project"
VENDOR_SOURCE_TABLE = "Vendor"
CLIENT_SOURCE_TABLE = "Client"
POSTGL_RECORD_LIMIT_FIELD = "postgl_sync_record_limit"

# Blank/missing uses a safe first-run default. Set 0 in IS Finance Setup for
# unlimited records per Company per run.
DEFAULT_POSTGL_RECORD_LIMIT = 100

# Unlimited mode still fetches/inserts in bounded batches.
POSTGL_FETCH_BATCH_SIZE = 1000
POSTGL_BULK_INSERT_CHUNK_SIZE = 1000


@dataclass(frozen=True)
class SageDatabaseSettings:
    """
    Validated Sage database connection settings for one Frappe Company.

    Keeping these values in a dataclass makes the actual connection layer
    independent from the Frappe child Document object and gives future Sage
    extraction/synchronisation code a small, typed settings interface.

    ``password`` deliberately uses ``repr=False``.

    Frappe Error Logs can include local variables from a traceback. Without
    ``repr=False``, a dataclass containing the decrypted Sage password could
    display that password when the dataclass is represented in diagnostic
    output.

    ``row_name`` is retained only for internal diagnostics. It allows us to
    identify the configuration row without logging any connection details.
    """

    company: str
    database_url: str
    username: str
    password: str = field(repr=False)
    row_name: str = ""
    last_postgl_auto_idx: int = 0


class SageSyncConfigurationError(Exception):
    """Raised when the Sage database configuration is missing or invalid."""


class SageConnectionTestError(Exception):
    """
    Raised when one or more configured Sage database connections fail.

    The exception message must contain only sanitised operational information.
    It must never include connection URLs, usernames, passwords, or complete
    ODBC connection strings.
    """


def run_daily_sage_sync() -> None:
    """
    Scheduled entry point for the daily incremental Sage POSTGL sync.

    Existing Scheduled Job Types may continue to point to this function.
    Connection-only diagnostics remain available via
    ``test_sage_database_connections``.
    """
    run_sage_postgl_sync()


def run_sage_postgl_sync() -> None:
    """Run the incremental POSTGL sync under a distributed lock."""
    logger = _get_logger()
    logger.info("Sage POSTGL sync job started.")

    lock = frappe.cache.lock(
        JOB_LOCK_KEY,
        timeout=JOB_LOCK_TIMEOUT_SECONDS,
    )
    acquired = lock.acquire(blocking=False)

    if not acquired:
        logger.warning(
            "Sage POSTGL sync skipped because another Sage sync job is running."
        )
        return

    try:
        result = sync_sage_postgl()

        if result["status"] == "disabled":
            logger.info(
                "Sage POSTGL sync skipped because Sage integration is disabled."
            )
            return

        logger.info(
            "Sage POSTGL sync completed successfully. "
            "%s row(s) processed across %s Company connection(s).",
            result["processed"],
            result["companies_tested"],
        )

    except Exception:
        logger.error("Sage POSTGL sync job failed.", exc_info=True)
        frappe.log_error(
            title="Sage POSTGL Sync Failed",
            message=frappe.get_traceback(),
        )
        raise

    finally:
        lock.release()


def sync_sage_postgl(
    company: str | None = None,
) -> dict[str, Any]:
    """
    Incrementally import new Sage POSTGL rows into Sage POSTGL Entry.

    IS Finance Setup.postgl_sync_record_limit:
      blank/missing -> 100
      positive N    -> at most N rows per Company per run
      0             -> unlimited

    IS Finance Setup Table.last_postgl_auto_idx is the durable per-company
    high-water mark and is advanced only with a successfully committed batch.
    """
    logger = _get_logger()
    settings_doc = frappe.get_doc(SETTINGS_DOCTYPE)

    if not settings_doc.get("connect_to_sage_database"):
        logger.info(
            "Sage POSTGL sync skipped because 'Connect To Sage Database' "
            "is disabled."
        )
        return {
            "status": "disabled",
            "message": "Sage database integration is disabled.",
            "processed": 0,
            "companies_tested": 0,
            "companies": [],
        }

    record_limit = _get_postgl_record_limit(settings_doc)
    settings_list = _get_validated_database_settings(
        settings_doc,
        company=company,
    )

    results: list[dict[str, Any]] = []
    failures: list[tuple[str, str]] = []

    for settings in settings_list:
        try:
            results.append(
                _sync_single_company_postgl(
                    settings,
                    record_limit=record_limit,
                )
            )
        except Exception as exc:
            frappe.db.rollback()
            safe_message = _sanitise_exception_message(exc)
            failures.append((settings.company, safe_message))
            logger.error(
                "Sage POSTGL sync failed for Company '%s': %s",
                settings.company,
                safe_message,
                exc_info=True,
            )

    if failures:
        summary = "; ".join(
            f"{company_name}: {message}"
            for company_name, message in failures
        )
        raise SageConnectionTestError(
            f"{len(failures)} of {len(settings_list)} Sage POSTGL sync(s) "
            f"failed. {summary}"
        )

    processed = sum(r["processed"] for r in results)

    return {
        "status": "success",
        "message": "Sage POSTGL incremental sync completed.",
        "record_limit": record_limit,
        "processed": processed,
        "companies_tested": len(results),
        "companies": results,
    }


def _sync_single_company_postgl(
    settings: SageDatabaseSettings,
    *,
    record_limit: int,
) -> dict[str, Any]:
    """Import only POSTGL rows newer than one Company's saved AutoIdx."""
    logger = _get_logger()
    pyodbc = _import_pyodbc()

    starting_auto_idx = settings.last_postgl_auto_idx
    high_water = starting_auto_idx
    processed = 0
    batches = 0
    remaining = record_limit if record_limit > 0 else None

    connection = None
    cursor = None

    logger.info(
        "Starting Sage POSTGL sync for Company '%s' after AutoIdx %s. "
        "Per-run limit=%s.",
        settings.company,
        starting_auto_idx,
        "unlimited" if record_limit == 0 else record_limit,
    )

    try:
        connection = pyodbc.connect(
            _build_connection_string(settings),
            timeout=DEFAULT_CONNECTION_TIMEOUT_SECONDS,
            autocommit=True,
        )
        cursor = connection.cursor()

        while remaining is None or remaining > 0:
            fetch_size = POSTGL_FETCH_BATCH_SIZE
            if remaining is not None:
                fetch_size = min(fetch_size, remaining)

            cursor.execute(
                _build_postgl_select_sql(fetch_size),
                high_water,
            )
            rows = cursor.fetchall()

            if not rows:
                break

            batch_high_water = max(int(row[0]) for row in rows)
            if batch_high_water <= high_water:
                raise RuntimeError(
                    "The Sage POSTGL query did not advance AutoIdx."
                )

            _bulk_insert_postgl_rows(
                company=settings.company,
                rows=rows,
            )

            frappe.db.set_value(
                CONNECTION_CHILD_DOCTYPE,
                settings.row_name,
                "last_postgl_auto_idx",
                str(batch_high_water),
                update_modified=False,
            )

            frappe.db.commit()

            batch_count = len(rows)
            processed += batch_count
            batches += 1
            high_water = batch_high_water

            if remaining is not None:
                remaining -= batch_count

            logger.info(
                "Committed Sage POSTGL batch for Company '%s'. "
                "Rows=%s, Last AutoIdx=%s.",
                settings.company,
                batch_count,
                high_water,
            )

            if batch_count < fetch_size:
                break

    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                logger.warning(
                    "Could not close Sage POSTGL cursor for Company '%s'.",
                    settings.company,
                    exc_info=True,
                )

        if connection is not None:
            try:
                connection.close()
            except Exception:
                logger.warning(
                    "Could not close Sage POSTGL connection for Company '%s'.",
                    settings.company,
                    exc_info=True,
                )

    return {
        "company": settings.company,
        "starting_auto_idx": starting_auto_idx,
        "ending_auto_idx": high_water,
        "processed": processed,
        "batches": batches,
    }


def _get_postgl_record_limit(settings_doc: Any) -> int:
    """Return POSTGL rows-per-Company per run; 0 means unlimited."""
    raw_value = settings_doc.get(POSTGL_RECORD_LIMIT_FIELD)

    if raw_value in (None, ""):
        return DEFAULT_POSTGL_RECORD_LIMIT

    try:
        record_limit = int(raw_value)
    except (TypeError, ValueError) as exc:
        raise SageSyncConfigurationError(
            "POSTGL Sync Record Limit must be a whole number. "
            "Use 0 for unlimited."
        ) from exc

    if record_limit < 0:
        raise SageSyncConfigurationError(
            "POSTGL Sync Record Limit cannot be negative. "
            "Use 0 for unlimited."
        )

    return record_limit


def _build_postgl_select_sql(fetch_size: int) -> str:
    """
    Build the read-only SQL Server query for the next POSTGL batch.

    POSTGL is the master/driving table.

    Customer/Supplier lookup rule:
      Id = 'Inv'  -> Client lookup using DrCrAccount = Client.DCLink
      Id = 'APTx' -> Vendor lookup using DrCrAccount = Vendor.DCLink
      Other Id    -> no lookup; classify as CashBook
    """
    fetch_size = int(fetch_size)

    if fetch_size < 1:
        raise ValueError("POSTGL fetch size must be at least 1.")

    return f"""
        SELECT TOP {fetch_size}
            p.[AutoIdx],
            p.[TxDate],
            p.[AccountLink],
            p.[TrCodeID],
            p.[Debit],
            p.[Credit],
            p.[Description] AS [POSTGLDescription],
            p.[Reference],

            a.[Master_Sub_Account],
            a.[Brch],
            a.[Description] AS [AccountDescription],
            a.[iAccountType],

            p.[Project] AS [ProjectID],
            pr.[ProjectCode],
            pr.[ProjectName],
            pr.[ProjectDescription],

            p.[Order_No],

            CASE
                WHEN p.[Id] = 'Inv' THEN c.[DCLink]
                WHEN p.[Id] = 'APTx' THEN v.[DCLink]
                ELSE p.[DrCrAccount]
            END AS [DrCrAccountCode],

            CASE
                WHEN p.[Id] = 'Inv' THEN c.[Account]
                WHEN p.[Id] = 'APTx' THEN v.[Account]
                ELSE 'CashBook'
            END AS [ClSupAccountNumber],

            CASE
                WHEN p.[Id] = 'Inv' THEN c.[Name]
                WHEN p.[Id] = 'APTx' THEN v.[Name]
                ELSE 'CashBook'
            END AS [ClSupName]

        FROM [{POSTGL_SOURCE_TABLE}] AS p

        OUTER APPLY (
            SELECT TOP 1
                acc.[Master_Sub_Account],
                acc.[Brch],
                acc.[Description],
                acc.[iAccountType]
            FROM [{ACCOUNTS_SOURCE_TABLE}] AS acc
            WHERE acc.[AccountLink] = p.[AccountLink]
        ) AS a

        OUTER APPLY (
            SELECT TOP 1
                proj.[ProjectCode],
                proj.[ProjectName],
                proj.[ProjectDescription]
            FROM [{PROJECT_SOURCE_TABLE}] AS proj
            WHERE proj.[ProjectLink] = p.[Project]
        ) AS pr

        OUTER APPLY (
            SELECT TOP 1
                cli.[DCLink],
                cli.[Account],
                cli.[Name]
            FROM [{CLIENT_SOURCE_TABLE}] AS cli
            WHERE p.[Id] = 'Inv'
              AND cli.[DCLink] = p.[DrCrAccount]
        ) AS c

        OUTER APPLY (
            SELECT TOP 1
                ven.[DCLink],
                ven.[Account],
                ven.[Name]
            FROM [{VENDOR_SOURCE_TABLE}] AS ven
            WHERE p.[Id] = 'APTx'
              AND ven.[DCLink] = p.[DrCrAccount]
        ) AS v

        WHERE p.[AutoIdx] > ?
        ORDER BY p.[AutoIdx] ASC
    """


def _bulk_insert_postgl_rows(
    *,
    company: str,
    rows: list[Any],
) -> None:
    """
    Bulk insert a POSTGL-master batch enriched by Accounts and Project.

    Row positions:
      0-7    POSTGL transaction fields
      8-11   Accounts lookup fields
      12     POSTGL.Project (project ID)
      13-15  Project lookup fields
      16     POSTGL.Order_No
      17-19  Id-based Client/Vendor/CashBook fields

    Frappe document names are deterministic hashes of Company + AutoIdx, making
    retries idempotent even though AutoIdx can repeat across Sage companies.
    """
    if not rows:
        return

    timestamp = now_datetime()
    owner = (
        frappe.session.user
        if getattr(frappe, "session", None)
        and frappe.session.user
        and frappe.session.user != "Guest"
        else "Administrator"
    )

    fields = [
        "name",
        "creation",
        "modified",
        "modified_by",
        "owner",
        "docstatus",
        "company",
        "sage_auto_idx",
        "tx_date",
        "account_link",
        "tr_code_id",
        "debit",
        "credit",
        "description",
        "reference",
        "master_sub_account",
        "brch",
        "sage_account_description",
        "iaccounttype",
        "sage_projectid",
        "sage_projectcode",
        "sage_projectname",
        "sage_project_description",
        "order_no",
        "drcr_account_code",
        "cl_sup_account_number",
        "cl_sup_name",
    ]

    values = []
    for row in rows:
        auto_idx = int(row[0])
        values.append(
            (
                _make_postgl_docname(company, auto_idx),
                timestamp,
                timestamp,
                owner,
                owner,
                0,
                company,
                str(auto_idx),
                row[1],
                row[2],
                row[3],
                row[4],
                row[5],
                row[6],
                row[7],
                row[8],
                row[9],
                row[10],
                row[11],
                row[12],
                row[13],
                row[14],
                row[15],
                row[16],
                row[17],
                row[18],
                row[19],
            )
        )

    frappe.db.bulk_insert(
        POSTGL_TARGET_DOCTYPE,
        fields,
        values,
        ignore_duplicates=True,
        chunk_size=POSTGL_BULK_INSERT_CHUNK_SIZE,
    )


def _make_postgl_docname(company: str, auto_idx: int) -> str:
    """Return a deterministic cross-company Frappe document name."""
    raw_key = f"{company}\x1f{auto_idx}".encode("utf-8")
    return hashlib.sha256(raw_key).hexdigest()


def test_sage_database_connections(
    company: str | None = None,
) -> dict[str, Any]:
    """
    Test the configured Microsoft SQL Server connection(s).

    Parameters
    ----------
    company:
        Optional Frappe Company name.

        When omitted, every configured row in ``database_connections`` is
        tested.

        When supplied, only the row belonging to that Frappe Company is
        tested. This is useful for future company-specific synchronisation
        jobs, manual diagnostics, and API calls.

    Returns
    -------
    dict
        A small, non-sensitive status dictionary.

        Disabled integration::

            {
                "status": "disabled",
                "message": "Sage database integration is disabled.",
                "tested": 0,
                "companies": [],
            }

        Successful connection test::

            {
                "status": "success",
                "message": "Sage database connection tests succeeded.",
                "tested": 2,
                "companies": [
                    "Isambane Mining",
                    "Another Company",
                ],
            }

    Raises
    ------
    SageSyncConfigurationError
        If the enabled integration has no connection rows, a requested Company
        has no configuration row, duplicate Company rows exist, or required
        connection fields are missing.

    RuntimeError
        If ``pyodbc`` is unavailable.

    SageConnectionTestError
        If one or more Microsoft SQL Server connection tests fail.

    Notes
    -----
    This method does not fetch any Sage business records.

    ``SELECT 1`` is used only to verify that:

    - DNS/server resolution works;
    - the SQL Server instance accepts connections;
    - the supplied SQL login is valid;
    - the target database can be opened; and
    - the connection can execute a basic query.

    Every selected connection is attempted, even if an earlier company fails.
    This makes the daily test more useful operationally because a single broken
    database does not hide the state of all the other databases.
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
            "tested": 0,
            "companies": [],
        }

    settings_list = _get_validated_database_settings(
        settings_doc,
        company=company,
    )

    logger.info(
        "Preparing to test %s Sage database connection(s).",
        len(settings_list),
    )

    successful_companies: list[str] = []
    failed_connections: list[tuple[str, str]] = []

    for settings in settings_list:
        try:
            _test_single_sage_database_connection(settings)
            successful_companies.append(settings.company)

        except Exception as exc:
            # Continue testing the remaining companies so that one failed Sage
            # server does not hide connectivity problems/successes elsewhere.
            #
            # Only a sanitised exception message is stored. Do not place the
            # settings object, URL, username, password, or connection string
            # into this list.
            safe_message = _sanitise_exception_message(exc)

            failed_connections.append(
                (
                    settings.company,
                    safe_message,
                )
            )

            logger.error(
                "Sage Microsoft SQL Server connection test failed for "
                "Company '%s': %s",
                settings.company,
                safe_message,
                exc_info=True,
            )

    if failed_connections:
        # Build a deliberately limited summary containing only Company names
        # and sanitised driver/error messages.
        #
        # This exception is raised only after every selected database has been
        # attempted.
        failure_summary = "; ".join(
            f"{company_name}: {message}"
            for company_name, message in failed_connections
        )

        raise SageConnectionTestError(
            f"{len(failed_connections)} of {len(settings_list)} Sage database "
            f"connection test(s) failed. {failure_summary}"
        )

    logger.info(
        "All %s Sage Microsoft SQL Server connection test(s) succeeded.",
        len(successful_companies),
    )

    return {
        "status": "success",
        "message": "Sage database connection tests succeeded.",
        "tested": len(successful_companies),
        "companies": successful_companies,
    }


def test_sage_database_connection(
    company: str | None = None,
) -> dict[str, Any]:
    """
    Backwards-compatible wrapper for the original public function name.

    Earlier versions of this controller supported only one Sage database and
    therefore exposed the singular function
    ``test_sage_database_connection``.

    The configuration is now multi-company, but retaining this function avoids
    breaking existing hooks, Console commands, API calls, tests, or other code
    that may already import the original function.

    Parameters
    ----------
    company:
        Optional Frappe Company to test. When omitted, all configured Company
        connections are tested.

    Returns
    -------
    dict
        The same result returned by ``test_sage_database_connections``.
    """
    return test_sage_database_connections(company=company)


def _test_single_sage_database_connection(
    settings: SageDatabaseSettings,
) -> None:
    """
    Open, verify, and close one configured Sage SQL Server connection.

    Parameters
    ----------
    settings:
        Validated settings for exactly one Frappe Company.

    Raises
    ------
    RuntimeError
        If ``pyodbc`` is unavailable or the test query returns an unexpected
        result.

    pyodbc.Error
        If SQL Server cannot be reached, authentication fails, the configured
        database cannot be opened, or another ODBC-level error occurs.

    Security
    --------
    The complete ODBC connection string is intentionally passed directly into
    ``pyodbc.connect`` rather than being retained in a local
    ``connection_string`` variable.

    This reduces the chance of Frappe's traceback-with-variables diagnostics
    displaying the SQL password if a later statement raises an exception.
    """
    logger = _get_logger()
    pyodbc = _import_pyodbc()

    connection = None

    logger.info(
        "Attempting Sage Microsoft SQL Server connection for Company '%s'.",
        settings.company,
    )

    try:
        connection = pyodbc.connect(
            _build_connection_string(settings),
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
            "Sage Microsoft SQL Server connection test succeeded for "
            "Company '%s'.",
            settings.company,
        )

    finally:
        if connection is not None:
            try:
                connection.close()

                logger.info(
                    "Sage Microsoft SQL Server connection closed for "
                    "Company '%s'.",
                    settings.company,
                )

            except Exception:
                # A failure while closing the connection should be visible in
                # the logs, but it should not replace the original connection
                # or query exception if one is already propagating.
                logger.warning(
                    "The Sage database connection for Company '%s' could not "
                    "be closed cleanly.",
                    settings.company,
                    exc_info=True,
                )


def _get_validated_database_settings(
    settings_doc: Any,
    *,
    company: str | None = None,
) -> list[SageDatabaseSettings]:
    """
    Read and validate Sage connection rows from ``IS Finance Setup``.

    Parameters
    ----------
    settings_doc:
        Loaded ``IS Finance Setup`` singleton.

    company:
        Optional Frappe Company name. If supplied, only that Company's
        connection row is returned.

    Returns
    -------
    list[SageDatabaseSettings]
        Validated settings objects.

    Raises
    ------
    SageSyncConfigurationError
        If:

        - no database connection rows exist;
        - a requested Company has no configured row;
        - the same Company appears more than once;
        - a Company value is missing;
        - a database URL is missing;
        - a username is missing; or
        - a password is missing/cannot be decrypted.

    Password fields
    ---------------
    The Sage password now belongs to the child document rather than the parent
    singleton.

    It must therefore be read from each child row using
    ``row.get_password("sage_database_password")``.

    Reading the field value directly may return a masked value and must not be
    used as the SQL Server credential.
    """
    logger = _get_logger()

    rows = settings_doc.get(CONNECTION_TABLE_FIELD) or []

    if not rows:
        raise SageSyncConfigurationError(
            "Sage database integration is enabled, but no Sage Database "
            "Connections have been configured."
        )

    requested_company = (company or "").strip()

    # Detect duplicate Company mappings before selecting a specific row.
    #
    # Each Frappe Company should map to exactly one Sage database connection.
    # Allowing duplicates would make future synchronisation ambiguous and could
    # result in data being read from the wrong Sage database.
    company_row_counts: dict[str, int] = {}

    for row in rows:
        row_company = (row.get("company") or "").strip()

        if row_company:
            company_row_counts[row_company] = (
                company_row_counts.get(row_company, 0) + 1
            )

    duplicate_companies = sorted(
        company_name
        for company_name, count in company_row_counts.items()
        if count > 1
    )

    if duplicate_companies:
        raise SageSyncConfigurationError(
            "Each Frappe Company may have only one Sage Database Connection. "
            "Duplicate connection rows were found for: "
            f"{', '.join(duplicate_companies)}."
        )

    selected_rows = []

    if requested_company:
        selected_rows = [
            row
            for row in rows
            if (row.get("company") or "").strip() == requested_company
        ]

        if not selected_rows:
            raise SageSyncConfigurationError(
                f"No Sage Database Connection is configured for Company "
                f"'{requested_company}'."
            )

    else:
        selected_rows = list(rows)

    validated_settings: list[SageDatabaseSettings] = []

    for row in selected_rows:
        row_name = (row.get("name") or "").strip()
        row_company = (row.get("company") or "").strip()
        database_url = (row.get("sage_database_url") or "").strip()
        username = (row.get("sage_database_user") or "").strip()

        raw_last_postgl_auto_idx = str(
            row.get("last_postgl_auto_idx") or ""
        ).strip()

        if raw_last_postgl_auto_idx:
            try:
                last_postgl_auto_idx = int(raw_last_postgl_auto_idx)
            except (TypeError, ValueError) as exc:
                raise SageSyncConfigurationError(
                    "Last POSTGL AutoIdx must contain a whole number for "
                    f"Company '{row_company or 'Unspecified Company'}'."
                ) from exc

            if last_postgl_auto_idx < 0:
                raise SageSyncConfigurationError(
                    "Last POSTGL AutoIdx cannot be negative for "
                    f"Company '{row_company or 'Unspecified Company'}'."
                )
        else:
            last_postgl_auto_idx = 0

        missing_fields: list[str] = []

        if not row_company:
            missing_fields.append("Frappe Company")

        if not database_url:
            missing_fields.append("Sage Database URL")

        if not username:
            missing_fields.append("Sage Database User")

        # Password fields must be decrypted using the child Document's
        # get_password API. Never use row.get("sage_database_password") as the
        # actual SQL password because Frappe may return the masked value.
        try:
            password = row.get_password("sage_database_password") or ""

        except Exception as exc:
            row_identifier = row_company or row_name or "unknown row"

            logger.error(
                "The Sage database password could not be decrypted for "
                "connection row '%s'.",
                row_identifier,
                exc_info=True,
            )

            raise SageSyncConfigurationError(
                "The Sage database password could not be decrypted for "
                f"Company '{row_company or 'Unspecified Company'}'."
            ) from exc

        if not password:
            missing_fields.append("Sage Database Password")

        if missing_fields:
            row_identifier = row_company or row_name or "unknown row"

            raise SageSyncConfigurationError(
                "Sage database integration is enabled, but Sage Database "
                f"Connection '{row_identifier}' is missing the following "
                f"required setting(s): {', '.join(missing_fields)}."
            )

        validated_settings.append(
            SageDatabaseSettings(
                company=row_company,
                database_url=database_url,
                username=username,
                password=password,
                row_name=row_name,
                last_postgl_auto_idx=last_postgl_auto_idx,
            )
        )

    return validated_settings


def get_sage_database_settings_for_company(
    company: str,
) -> SageDatabaseSettings:
    """
    Return validated Sage database settings for one Frappe Company.

    This helper is provided for the next phase of the integration where actual
    Sage extraction/synchronisation operations will need to resolve a SQL
    Server connection from a Frappe Company.

    Keeping this lookup in the controller avoids duplicating child-table
    traversal and password-decryption logic in future synchronisation modules.

    Parameters
    ----------
    company:
        Exact Frappe Company name.

    Returns
    -------
    SageDatabaseSettings
        Validated settings for that Company.

    Raises
    ------
    SageSyncConfigurationError
        If Sage connectivity is disabled or no valid row exists for the
        requested Company.
    """
    company = (company or "").strip()

    if not company:
        raise SageSyncConfigurationError(
            "A Frappe Company is required to resolve Sage database settings."
        )

    settings_doc = frappe.get_doc(SETTINGS_DOCTYPE)

    if not settings_doc.get("connect_to_sage_database"):
        raise SageSyncConfigurationError(
            "Sage database integration is disabled."
        )

    settings_list = _get_validated_database_settings(
        settings_doc,
        company=company,
    )

    # _get_validated_database_settings guarantees exactly one row for a
    # requested Company because duplicate Company rows are rejected.
    return settings_list[0]


def _build_connection_string(
    settings: SageDatabaseSettings,
) -> str:
    """
    Build a pyodbc connection string from one Company's configured database URL.

    A complete ODBC connection string can be supplied in the URL field. When
    that format is used, UID and PWD are removed from the supplied string and
    replaced with the separately stored Frappe credentials.

    For shorthand URLs, this method extracts the SQL Server host/instance and
    database name, then builds an ODBC Driver 18 connection string.

    Security
    --------
    The username and password stored in the Frappe child row always override
    any credentials accidentally supplied inside a complete ODBC connection
    string.

    The returned string contains the decrypted password and must therefore
    never be written to logs.
    """
    database_url = settings.database_url.strip()

    if _looks_like_odbc_connection_string(database_url):
        base_connection_string = _normalise_odbc_connection_string(
            database_url
        )

        # Credentials in a supplied ODBC string are removed so the Frappe
        # Password field remains the sole source of authentication
        # information.
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


def _parse_database_url(
    database_url: str,
) -> tuple[str, str]:
    """
    Parse the Sage database URL into a SQL Server address and database name.

    Accepted examples:

    - ``mssql://server:1433/SageDatabase``
    - ``sqlserver://server/SageDatabase``
    - ``server:1433/SageDatabase``
    - ``server\\\\SQLEXPRESS/SageDatabase``

    Returns
    -------
    tuple[str, str]
        ``(server, database)`` where an explicit TCP port is converted to the
        comma syntax expected by the SQL Server ODBC driver.
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
                "URL. Use the dedicated Sage Database User and Password fields "
                "on the Sage Database Connection row."
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

        # ODBC uses a comma rather than a colon between a host and explicit
        # TCP port.
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


def _looks_like_odbc_connection_string(
    value: str,
) -> bool:
    """
    Return whether the configured value resembles a complete ODBC string.

    This is intentionally a lightweight detection function. Full validation is
    left to the SQL Server ODBC driver because connection strings can contain a
    broad range of valid driver-specific properties.
    """
    upper_value = value.upper()

    return (
        ";" in value
        and (
            "SERVER=" in upper_value
            or "DATA SOURCE=" in upper_value
        )
    )


def _normalise_odbc_connection_string(
    value: str,
) -> str:
    """
    Ensure a supplied ODBC connection string ends with a semicolon.

    Normalising this before appending the Frappe-managed UID/PWD properties
    prevents malformed property boundaries.
    """
    normalised = value.strip()

    if not normalised.endswith(";"):
        normalised += ";"

    return normalised


def _remove_odbc_property(
    connection_string: str,
    property_name: str,
) -> str:
    """
    Remove a property from an ODBC connection string.

    The expression is intentionally scoped to semicolon-delimited ODBC
    properties. It is used primarily to remove credentials that may have been
    supplied accidentally in the configuration field.

    Both braced and normal property values are supported.
    """
    pattern = re.compile(
        rf"(?i)(?:^|;)\s*{re.escape(property_name)}\s*="
        r"(?:\{(?:[^}]|}})*\}|[^;]*)\s*;",
    )

    cleaned = pattern.sub(";", connection_string).strip("; ")

    return f"{cleaned};" if cleaned else ""


def _escape_odbc_value(
    value: str,
) -> str:
    """
    Escape a value for use in an ODBC connection string.

    Braced ODBC values allow semicolons and other special characters. A closing
    brace is escaped by doubling it.

    This is particularly important for passwords because SQL passwords often
    contain punctuation that would otherwise be interpreted as an ODBC
    property delimiter.
    """
    escaped = str(value).replace("}", "}}")

    return f"{{{escaped}}}"


def _import_pyodbc() -> Any:
    """
    Import pyodbc with a clear operational error if it is not installed.

    ``pyodbc`` is imported lazily so merely importing this controller does not
    prevent the Frappe application from starting on a host where the optional
    Sage integration has not yet been provisioned.
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


def _sanitise_exception_message(
    exc: Exception,
) -> str:
    """
    Return a limited exception message suitable for operational logging.

    The error is intentionally truncated and common credential properties are
    redacted as a defence against ODBC drivers that echo connection details.

    In addition to UID/PWD properties, common URL-style credentials are
    redacted because third-party libraries sometimes reproduce the original
    connection URL in exception messages.
    """
    message = str(exc)

    # Redact standard ODBC password properties.
    message = re.sub(
        r"(?i)\b(?:PWD|PASSWORD)\s*=\s*(?:\{(?:[^}]|}})*\}|[^;]*)",
        "PASSWORD=[REDACTED]",
        message,
    )

    # Redact standard ODBC username properties.
    message = re.sub(
        r"(?i)\b(?:UID|USER ID)\s*=\s*(?:\{(?:[^}]|}})*\}|[^;]*)",
        "USER=[REDACTED]",
        message,
    )

    # Defence in depth for URL-like strings containing credentials, e.g.
    # mssql://username:password@server/database.
    message = re.sub(
        r"(?i)(mssql(?:\+pyodbc)?://)"
        r"[^:@/\s]+:"
        r"[^@/\s]+@",
        r"\1[REDACTED]:[REDACTED]@",
        message,
    )

    # Avoid excessively large log entries from nested ODBC/driver messages.
    return message[:2_000]


def _get_logger() -> Any:
    """
    Return the site-specific Sage synchronisation logger.

    Log output will normally be written beneath the site's ``logs`` directory
    using Frappe's logging configuration.

    ``allow_site=True`` keeps logs separated per Frappe site when a bench hosts
    more than one site.
    """
    return frappe.logger(
        LOGGER_NAME,
        allow_site=True,
        file_count=20,
    )
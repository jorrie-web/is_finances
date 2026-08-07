### Isambane Finances

Internal Financial Management Suite for Isambane Mining

### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI.

This app requires several external system dependencies in addition to the Python packages declared in `pyproject.toml`.

#### Tesseract OCR

Install Tesseract OCR on Debian / Ubuntu:

```bash
sudo apt install -y tesseract-ocr
```

#### Microsoft SQL Server ODBC Driver

The Sage database integration uses `pyodbc` to connect to Microsoft SQL Server.

The Python `pyodbc` package is declared in `pyproject.toml`, but the Microsoft SQL Server ODBC driver is a native operating-system dependency and must be installed separately on the bench host or application container.

Required packages:

- `msodbcsql18` - Microsoft ODBC Driver 18 for SQL Server
- `unixodbc-dev` - unixODBC development headers

> `msodbcsql18` is provided by Microsoft's package repository and is normally not available from the default Ubuntu or Debian repositories. Configure the Microsoft repository before installing the package.

##### Ubuntu

Install the Microsoft package repository for the Ubuntu version running on the server, then install the driver:

```bash
VERSION_ID=$(grep VERSION_ID /etc/os-release | cut -d '"' -f 2)

curl -sSL -O https://packages.microsoft.com/config/ubuntu/${VERSION_ID}/packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb
rm packages-microsoft-prod.deb

sudo apt-get update
sudo ACCEPT_EULA=Y apt-get install -y msodbcsql18 unixodbc-dev
```

##### Debian

Install the Microsoft package repository for the Debian major version running on the server, then install the driver:

```bash
VERSION_ID=$(grep VERSION_ID /etc/os-release | cut -d '"' -f 2 | cut -d '.' -f 1)

curl -sSL -O https://packages.microsoft.com/config/debian/${VERSION_ID}/packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb
rm packages-microsoft-prod.deb

sudo apt-get update
sudo ACCEPT_EULA=Y apt-get install -y msodbcsql18 unixodbc-dev
```

For Debian slim/minimal images, the Kerberos runtime library may also be required:

```bash
sudo apt-get install -y libgssapi-krb5-2
```

##### Verify the ODBC installation

Confirm that unixODBC can see the Microsoft driver:

```bash
odbcinst -q -d
```

The output should include:

```text
[ODBC Driver 18 for SQL Server]
```

You can also verify the driver from the bench Python environment:

```bash
bench python -c "import pyodbc; print('pyodbc:', pyodbc.version); print('drivers:', pyodbc.drivers())"
```

The returned driver list should contain `ODBC Driver 18 for SQL Server`.

Microsoft's official installation documentation is available at:
https://learn.microsoft.com/en-us/sql/connect/odbc/linux-mac/installing-the-microsoft-odbc-driver-for-sql-server

#### Install the Frappe app

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app https://github.com/jorrie-web/is_finances --branch develop
bench install-app is_finances
```

After installing or updating dependencies on an existing bench, restart the Frappe processes:

```bash
bench restart
```

### Contributing

This app uses `pre-commit` for code formatting and linting. Please [install pre-commit](https://pre-commit.com/#installation) and enable it for this repository:

```bash
cd apps/is_finances
pre-commit install
```

Pre-commit is configured to use the following tools for checking and formatting your code:

- ruff
- eslint
- prettier
- pyupgrade

### License

mit

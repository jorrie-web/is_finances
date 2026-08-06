### Isambane Finances

Internal Financial Management Suite for Isambane Mining

### Installation

You can install this app using the [bench](https://github.com/frappe/bench) CLI:

Note, this app requires external dependencies, including tessaract-ocr, it can be installed using apt in debian / ubuntu:

```bash
sudo apt install -y tesseract-ocr
```

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO --branch develop
bench install-app is_finances
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

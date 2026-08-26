# Copyright (c) 2026, Isambane Mining and contributors
# For license information, please see license.txt

from datetime import date

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months, cint, flt, getdate


IS_DIMENSIONS = {
    "IS-Revenue",
    "IS-Other Income",
    "IS-Cost of Sales",
    "IS-Other Expenditure",
}


class ISForecastEntry(Document):
    def validate(self):
        self._normalise_period()
        scenario = self._get_and_validate_scenario()
        self._sync_company(scenario)
        self._validate_period_in_scenario(scenario)
        self._sync_and_validate_account()
        self._sync_and_validate_cost_center()
        self._set_financial_year()
        self._calculate_forecast_amount()
        self._validate_duplicate()

    def on_trash(self):
        if not self.forecast_scenario:
            return

        status = frappe.db.get_value(
            "IS Forecast Scenario",
            self.forecast_scenario,
            "status",
        )

        if status and status != "Draft":
            frappe.throw(
                _("Entries belonging to a {0} scenario cannot be deleted.").format(
                    status
                )
            )

    def _normalise_period(self):
        if not self.forecast_period:
            frappe.throw(_("Forecast Period is required."))

        period = getdate(self.forecast_period)
        self.forecast_period = date(period.year, period.month, 1)

    def _get_and_validate_scenario(self):
        if not self.forecast_scenario:
            frappe.throw(_("Forecast Scenario is required."))

        scenario = frappe.db.get_value(
            "IS Forecast Scenario",
            self.forecast_scenario,
            [
                "company",
                "forecast_start_month",
                "forecast_end_month",
                "horizon_months",
                "status",
                "is_active",
            ],
            as_dict=True,
        )

        if not scenario:
            frappe.throw(_("Forecast Scenario could not be found."))

        if scenario.status != "Draft":
            frappe.throw(
                _("Forecast entries can only be changed while the scenario is Draft. Current status: {0}.").format(
                    frappe.bold(scenario.status)
                )
            )

        if not cint(scenario.is_active):
            frappe.throw(_("Forecast Scenario is not active."))

        return scenario

    def _sync_company(self, scenario):
        self.company = scenario.company

    def _validate_period_in_scenario(self, scenario):
        start = getdate(scenario.forecast_start_month)

        if scenario.forecast_end_month:
            end = getdate(scenario.forecast_end_month)
        else:
            end = getdate(add_months(start, cint(scenario.horizon_months) - 1))

        period = getdate(self.forecast_period)

        if period < start or period > end:
            frappe.throw(
                _("Forecast Period {0} is outside scenario range {1} to {2}.").format(
                    frappe.format_value(period, {"fieldtype": "Date"}),
                    frappe.format_value(start, {"fieldtype": "Date"}),
                    frappe.format_value(end, {"fieldtype": "Date"}),
                )
            )

    def _sync_and_validate_account(self):
        if not self.account:
            frappe.throw(_("Account is required."))

        account = frappe.db.get_value(
            "Account",
            self.account,
            [
                "account_number",
                "account_name",
                "company",
                "is_group",
                "report_type",
                "isf_sage_account_type",
                "isf_report_dimension",
                "isf_forecast_enabled",
                "isf_forecast_method",
                "isf_default_forecast_uom",
                "isf_ebitda_treatment",
            ],
            as_dict=True,
        )

        if not account:
            frappe.throw(_("Account could not be found."))

        if account.company != self.company:
            frappe.throw(_("Account must belong to the Forecast Scenario company."))

        if cint(account.is_group):
            frappe.throw(_("Forecasts must be entered against a non-group Account."))

        if account.report_type and account.report_type != "Profit and Loss":
            frappe.throw(_("Only Profit and Loss accounts can be forecast in IS Forecast Entry."))

        account_number = (account.account_number or "").strip()
        if len(account_number) != 4 or not account_number.isdigit():
            frappe.throw(
                _("Forecast Account must have a 4-digit group account number. Account {0} has number {1}.").format(
                    frappe.bold(self.account),
                    frappe.bold(account_number or _("blank")),
                )
            )

        report_dimension = (account.isf_report_dimension or "").strip()
        if report_dimension not in IS_DIMENSIONS:
            frappe.throw(
                _("Account {0} must have a valid Income Statement Report Dimension.").format(
                    frappe.bold(self.account)
                )
            )

        self.account_number = account_number
        self.account_name = account.account_name
        self.sage_account_type = account.isf_sage_account_type
        self.custom_report_dimension = report_dimension
        self.custom_forecast_enabled = cint(account.isf_forecast_enabled)
        self.forecast_method = account.isf_forecast_method
        self.ebtda_treatment = account.isf_ebitda_treatment

        if not self.volume_uom and account.isf_default_forecast_uom:
            self.volume_uom = account.isf_default_forecast_uom

        if not self.forecast_method:
            frappe.throw(
                _("Account {0} does not have a Forecast Method configured.").format(
                    frappe.bold(self.account)
                )
            )

    def _sync_and_validate_cost_center(self):
        if not self.cost_center:
            frappe.throw(_("Cost Center is required."))

        cost_center = frappe.db.get_value(
            "Cost Center",
            self.cost_center,
            ["company", "is_group", "cost_center_number"],
            as_dict=True,
        )

        if not cost_center:
            frappe.throw(_("Cost Center could not be found."))

        if cost_center.company != self.company:
            frappe.throw(_("Cost Center must belong to the Forecast Scenario company."))

        if cint(cost_center.is_group):
            frappe.throw(_("Forecasts must be entered against a non-group Cost Center."))

        if not cost_center.cost_center_number:
            frappe.throw(
                _("Cost Center {0} must have a Cost Center Number / Sage branch code.").format(
                    frappe.bold(self.cost_center)
                )
            )

        self.cost_center_number = cost_center.cost_center_number

    def _set_financial_year(self):
        period = getdate(self.forecast_period)
        start_year = period.year if period.month >= 3 else period.year - 1
        self.financial_year = f"FY {start_year}/{str(start_year + 1)[-2:]}"

    def _calculate_forecast_amount(self):
        method = (self.forecast_method or "").strip().lower()

        if method in {"volume x price", "volume × price"}:
            if not self.volume_uom:
                frappe.throw(_("Volume UOM is required for Volume x Price forecasts."))

            volume = flt(self.volume)
            price = flt(self.price_per_unit)

            if volume < 0:
                frappe.throw(_("Volume cannot be negative."))

            if price < 0:
                frappe.throw(_("Price Per Unit cannot be negative."))

            self.forecast_amount = flt(volume * price, 2)

            if not self.input_source or self.input_source == "Manual":
                self.input_source = "Volume x Price"

        elif method == "amount":
            self.forecast_amount = flt(self.forecast_amount, 2)

            if not self.input_source:
                self.input_source = "Manual"

        else:
            frappe.throw(
                _("Unsupported Forecast Method: {0}. Use Amount or Volume x Price.").format(
                    frappe.bold(self.forecast_method)
                )
            )

    def _validate_duplicate(self):
        existing = frappe.db.get_value(
            "IS Forecast Entry",
            {
                "forecast_scenario": self.forecast_scenario,
                "cost_center": self.cost_center,
                "account": self.account,
                "forecast_period": self.forecast_period,
            },
            "name",
        )

        if existing and existing != self.name:
            frappe.throw(
                _(
                    "A forecast entry already exists for Scenario {0}, Cost Center {1}, Account {2}, Period {3}: {4}"
                ).format(
                    frappe.bold(self.forecast_scenario),
                    frappe.bold(self.cost_center),
                    frappe.bold(self.account),
                    frappe.bold(self.financial_year),
                    frappe.bold(existing),
                )
            )

# Copyright (c) 2026, Isambane Mining and contributors
# For license information, please see license.txt

from datetime import date

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_months, cint, getdate


MIN_FORECAST_MONTHS = 60


class ISForecastScenario(Document):
    def validate(self):
        self._normalise_start_month()
        self._validate_horizon()
        self._set_end_month()
        self._validate_based_on_scenario()

    def on_trash(self):
        if frappe.db.exists("IS Forecast Entry", {"forecast_scenario": self.name}):
            frappe.throw(
                _("Forecast Scenario {0} cannot be deleted because forecast entries exist.").format(
                    frappe.bold(self.name)
                )
            )

    def _normalise_start_month(self):
        if not self.forecast_start_month:
            frappe.throw(_("Forecast Start Month is required."))

        start = getdate(self.forecast_start_month)
        self.forecast_start_month = date(start.year, start.month, 1)

    def _validate_horizon(self):
        months = cint(self.horizon_months)

        if months < MIN_FORECAST_MONTHS:
            frappe.throw(
                _("Horizon Months must be at least {0} months.").format(
                    MIN_FORECAST_MONTHS
                )
            )

        self.horizon_months = months

    def _set_end_month(self):
        # The first month counts as month 1, therefore a 60-month scenario
        # ends 59 months after the starting month.
        self.forecast_end_month = add_months(
            self.forecast_start_month,
            self.horizon_months - 1,
        )

    def _validate_based_on_scenario(self):
        if not self.based_on_scenario:
            return

        if self.based_on_scenario == self.name:
            frappe.throw(_("A scenario cannot be based on itself."))

        base = frappe.db.get_value(
            "IS Forecast Scenario",
            self.based_on_scenario,
            ["company", "status"],
            as_dict=True,
        )

        if not base:
            frappe.throw(_("Based On Scenario could not be found."))

        if base.company != self.company:
            frappe.throw(
                _("Based On Scenario must belong to the same Company.")
            )

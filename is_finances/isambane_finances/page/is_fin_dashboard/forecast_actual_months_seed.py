from datetime import date
import time

import frappe
from frappe import _
from frappe.utils import add_months, cint, flt, getdate

from . import is_fin_dashboard as dashboard
from .forecast_actual_months import AUTO_ACTUAL_MONTHS, _actual_cutoff_for_selection


def _actual_average_for_cutoff(scenario, source_cost_center, cutoff):
    source_cost_center = (source_cost_center or dashboard.ALL_FORECAST_COST_CENTRES).strip()
    branch_sql, branch_values, source_info = dashboard._forecast_actual_branch_condition(
        scenario.company, source_cost_center
    )

    anchor_month = date(cutoff.year, cutoff.month, 1)
    start_month = getdate(add_months(anchor_month, -2))
    average_from = date(start_month.year, start_month.month, 1)
    average_to = cutoff

    signed = dashboard._signed_amount_sql()
    values = {
        "company": scenario.company,
        "from_date": average_from,
        "to_date": average_to,
        **branch_values,
    }
    rows = frappe.db.sql(
        f"""
        SELECT
            LEFT(TRIM(COALESCE(p.master_sub_account, '')), 4) AS group_account,
            SUM({signed}) / 3.0 AS average_amount
        FROM `tabSage POSTGL Entry` p
        INNER JOIN `tabSageAccountType` a
            ON a.sage_account_type = p.iaccounttype
        WHERE p.company = %(company)s
          AND p.tx_date >= %(from_date)s
          AND p.tx_date < DATE_ADD(%(to_date)s, INTERVAL 1 DAY)
          AND a.report_dimension IN ('IS-Cost of Sales', 'IS-Other Expenditure')
          AND TRIM(COALESCE(p.master_sub_account, '')) REGEXP '^[0-9]{{4}}'
          {branch_sql}
        GROUP BY LEFT(TRIM(COALESCE(p.master_sub_account, '')), 4)
        """,
        values,
        as_dict=True,
    )
    return {
        "source_label": source_info["label"],
        "from_date": average_from,
        "to_date": average_to,
        "period_label": f"{average_from.strftime('%d %b %Y')} - {average_to.strftime('%d %b %Y')}",
        "averages": {
            str(row.group_account): flt(row.average_amount, 2)
            for row in rows if row.group_account
        },
    }


@frappe.whitelist()
def seed_expense_forecast_from_actual_average(
    forecast_scenario,
    target_cost_center,
    source_cost_center,
    financial_year,
    actual_months=AUTO_ACTUAL_MONTHS,
):
    """Fill every blue Forecast month from the selected 3M actual average.

    The selected Actual Months control defines the split. If 4 is selected for
    FY 2026/27, Mar-Jun remain Actual and every Jul-Feb expense Forecast column
    is populated. Existing forecast values in those months are overwritten.
    """
    started = time.perf_counter()
    scenario = dashboard._get_forecast_scenario(forecast_scenario)

    if scenario.status != "Draft":
        frappe.throw(_("Only Draft Forecast Scenarios can be seeded."))
    if not cint(scenario.is_active):
        frappe.throw(_("Forecast Scenario is not active."))

    target_cost_center = (target_cost_center or "").strip()
    if not target_cost_center or target_cost_center == dashboard.ALL_FORECAST_COST_CENTRES:
        frappe.throw(_("Select an individual target Cost Center before populating forecast values."))

    fy_start, fy_end = dashboard._forecast_financial_year_bounds(financial_year)
    actual_cutoff, selected_months = _actual_cutoff_for_selection(
        scenario, fy_start, fy_end, actual_months
    )

    if selected_months is None:
        scenario_start = date(
            getdate(scenario.forecast_start_month).year,
            getdate(scenario.forecast_start_month).month,
            1,
        )
        cutoff_month = date(actual_cutoff.year, actual_cutoff.month, 1)
        first_forecast_month = max(scenario_start, dashboard._next_month(cutoff_month))
    elif actual_cutoff < fy_start:
        first_forecast_month = fy_start
    else:
        first_forecast_month = dashboard._next_month(date(actual_cutoff.year, actual_cutoff.month, 1))

    scenario_end = date(
        getdate(scenario.forecast_end_month).year,
        getdate(scenario.forecast_end_month).month,
        1,
    )
    selected_fy_end_month = date(fy_end.year, fy_end.month, 1)
    last_forecast_month = min(scenario_end, selected_fy_end_month)

    if first_forecast_month > last_forecast_month:
        return {
            "created": 0,
            "updated": 0,
            "deleted": 0,
            "account_count": 0,
            "month_count": 0,
            "source_label": "",
            "period_label": "",
            "runtime_ms": round((time.perf_counter() - started) * 1000, 1),
        }

    target_info = dashboard._forecast_cost_center_info(
        scenario.company, target_cost_center, allow_all=False
    )
    average_payload = _actual_average_for_cutoff(scenario, source_cost_center, actual_cutoff)
    averages = average_payload["averages"]

    expense_accounts = [
        row for row in dashboard._get_forecast_accounts(scenario.company)
        if row.report_dimension in ("IS-Cost of Sales", "IS-Other Expenditure")
        and (row.forecast_method or "Amount").strip().lower() == "amount"
    ]

    periods = []
    current = first_forecast_month
    while current <= last_forecast_month:
        periods.append(current)
        current = dashboard._next_month(current)

    existing = frappe.db.sql(
        """
        SELECT name, account, forecast_period
        FROM `tabIS Forecast Entry`
        WHERE forecast_scenario = %(scenario)s
          AND cost_center = %(cost_center)s
          AND forecast_period >= %(start)s
          AND forecast_period <= %(end)s
        """,
        {
            "scenario": scenario.name,
            "cost_center": target_cost_center,
            "start": first_forecast_month,
            "end": last_forecast_month,
        },
        as_dict=True,
    )
    existing_keys = {
        (
            row.account,
            date(getdate(row.forecast_period).year, getdate(row.forecast_period).month, 1),
        ): row.name
        for row in existing
    }

    updated = 0
    deleted = 0
    new_rows = []
    user = frappe.session.user
    now = frappe.utils.now_datetime()
    source_note = _("Seeded from {0} actual average: {1}").format(
        average_payload["source_label"], average_payload["period_label"]
    )

    for account in expense_accounts:
        average = flt(averages.get(str(account.account_number), 0), 2)
        account_existing = [
            key for key in existing_keys
            if key[0] == account.account and first_forecast_month <= key[1] <= last_forecast_month
        ]

        if not average:
            if account_existing:
                names = [existing_keys[key] for key in account_existing]
                for i in range(0, len(names), 500):
                    chunk = names[i:i + 500]
                    placeholders = ",".join(["%s"] * len(chunk))
                    frappe.db.sql(
                        f"DELETE FROM `tabIS Forecast Entry` WHERE name IN ({placeholders})",
                        tuple(chunk),
                    )
                    deleted += len(chunk)
            continue

        if account_existing:
            frappe.db.sql(
                """
                UPDATE `tabIS Forecast Entry`
                SET forecast_amount = %(amount)s,
                    volume = 0,
                    price_per_unit = 0,
                    input_source = 'Last 3M Actual Avg',
                    comments = %(comments)s,
                    modified = %(modified)s,
                    modified_by = %(modified_by)s
                WHERE forecast_scenario = %(scenario)s
                  AND cost_center = %(cost_center)s
                  AND account = %(account)s
                  AND forecast_period >= %(start)s
                  AND forecast_period <= %(end)s
                """,
                {
                    "amount": average,
                    "comments": source_note,
                    "modified": now,
                    "modified_by": user,
                    "scenario": scenario.name,
                    "cost_center": target_cost_center,
                    "account": account.account,
                    "start": first_forecast_month,
                    "end": last_forecast_month,
                },
            )
            updated += len(account_existing)

        for period in periods:
            if (account.account, period) in existing_keys:
                continue
            fy_start_year = period.year if period.month >= 3 else period.year - 1
            new_rows.append(
                (
                    frappe.generate_hash(length=10), now, now, user, user, 0, 0,
                    scenario.name, scenario.company, period,
                    dashboard._financial_year_label(fy_start_year), target_cost_center,
                    account.account, account.account_number, account.account_name,
                    account.sage_account_type or "", account.report_dimension,
                    1, account.forecast_method or "Amount", account.ebitda_treatment or "Normal",
                    0, account.default_forecast_uom or "", 0, average,
                    target_info["cost_center_number"], "Last 3M Actual Avg", source_note,
                )
            )

    if new_rows:
        fields = [
            "name", "creation", "modified", "modified_by", "owner", "docstatus", "idx",
            "forecast_scenario", "company", "forecast_period", "financial_year", "cost_center",
            "account", "account_number", "account_name", "sage_account_type",
            "custom_report_dimension", "custom_forecast_enabled", "forecast_method",
            "ebitda_treatment", "volume", "volume_uom", "price_per_unit", "forecast_amount",
            "cost_center_number", "input_source", "comments",
        ]
        row_placeholder = "(" + ",".join(["%s"] * len(fields)) + ")"
        for i in range(0, len(new_rows), 250):
            chunk = new_rows[i:i + 250]
            sql = (
                "INSERT INTO `tabIS Forecast Entry` (`"
                + "`,`".join(fields)
                + "`) VALUES "
                + ",".join([row_placeholder] * len(chunk))
            )
            flat = []
            for row in chunk:
                flat.extend(row)
            frappe.db.sql(sql, tuple(flat))

    frappe.db.commit()
    return {
        "created": len(new_rows),
        "updated": updated,
        "deleted": deleted,
        "account_count": len(expense_accounts),
        "month_count": len(periods),
        "source_label": average_payload["source_label"],
        "period_label": average_payload["period_label"],
        "runtime_ms": round((time.perf_counter() - started) * 1000, 1),
    }

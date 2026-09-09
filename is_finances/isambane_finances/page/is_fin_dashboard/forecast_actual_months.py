from datetime import date, timedelta

import frappe
from frappe import _
from frappe.utils import add_months, cint, getdate

from . import is_fin_dashboard as dashboard


AUTO_ACTUAL_MONTHS = "auto"


def _normalise_actual_months(value):
    if value is None or str(value).strip().lower() in {"", AUTO_ACTUAL_MONTHS}:
        return None
    try:
        months = int(value)
    except (TypeError, ValueError):
        frappe.throw(_("Actual Months must be a number from 0 to 12."))
    if months < 0 or months > 12:
        frappe.throw(_("Actual Months must be between 0 and 12."))
    return months


def _actual_cutoff_for_selection(scenario, fy_start, fy_end, actual_months):
    base_cutoff = dashboard._forecast_actual_cutoff(scenario)
    selected = _normalise_actual_months(actual_months)

    if selected is None:
        return min(fy_end, base_cutoff), None

    if selected == 0:
        requested_cutoff = fy_start - timedelta(days=1)
    else:
        first_day_after_actuals = getdate(add_months(fy_start, selected))
        requested_cutoff = first_day_after_actuals - timedelta(days=1)

    # Never mark months as Actual beyond the scenario's permitted actual cut-off.
    return min(fy_end, base_cutoff, requested_cutoff), selected


def _forecast_months_for_selection(
    fy_start,
    scenario_start,
    scenario_end,
    actual_cutoff,
    selected_months,
):
    """Build the 12 FY months for the selected Actual/Forecast split.

    Auto mode keeps the scenario's configured forecast start. When the user
    explicitly selects the number of actual months, the very next month becomes
    a forecast month. This prevents a blank gap between the last Actual month
    and the first Forecast month (for example 4 Actual Months = Mar-Jun actual,
    Jul-Feb forecast).
    """
    if selected_months is None:
        return dashboard._forecast_year_months(
            fy_start,
            scenario_start,
            scenario_end,
            actual_cutoff=actual_cutoff,
        )

    cutoff_month = date(actual_cutoff.year, actual_cutoff.month, 1)
    if actual_cutoff < fy_start:
        effective_forecast_start = fy_start
    else:
        effective_forecast_start = dashboard._next_month(cutoff_month)

    return dashboard._forecast_year_months(
        fy_start,
        effective_forecast_start,
        scenario_end,
        actual_cutoff=actual_cutoff,
    )


@frappe.whitelist()
def get_forecast_data(forecast_scenario, cost_center, financial_year, actual_months=AUTO_ACTUAL_MONTHS):
    """Return the dashboard forecast grid with a selectable number of actual FY months.

    `actual_months` is 0-12, counted from March for the selected financial year.
    `auto` preserves the scenario's normal Actual Cut-off Date behaviour. A numeric
    selection is always capped at the scenario's permitted actual cut-off so future
    months can never be presented as actuals. For an explicit numeric selection,
    the month immediately after the last actual month is always a forecast month.
    """
    started = frappe.utils.now_datetime()
    scenario = dashboard._get_forecast_scenario(forecast_scenario)
    cost_center = (cost_center or dashboard.ALL_FORECAST_COST_CENTRES).strip()

    scenario_start = getdate(scenario.forecast_start_month)
    scenario_end = getdate(scenario.forecast_end_month)
    valid_years = dashboard._scenario_financial_years(scenario_start, scenario_end)
    if financial_year not in valid_years:
        frappe.throw(_("Financial Year is outside the selected Forecast Scenario."))

    fy_start, fy_end = dashboard._forecast_financial_year_bounds(financial_year)
    actual_cutoff, selected_months = _actual_cutoff_for_selection(
        scenario, fy_start, fy_end, actual_months
    )
    months = _forecast_months_for_selection(
        fy_start,
        scenario_start,
        scenario_end,
        actual_cutoff,
        selected_months,
    )

    if cost_center != dashboard.ALL_FORECAST_COST_CENTRES:
        cc = frappe.db.get_value(
            "Cost Center",
            cost_center,
            ["name", "company", "is_group", "cost_center_number"],
            as_dict=True,
        )
        if not cc or cc.company != scenario.company or cint(cc.is_group):
            frappe.throw(_("Invalid Cost Center for this Forecast Scenario."))
        cost_center_label = f"{cc.cost_center_number or ''} - {cc.name}".strip(" -")
    else:
        cost_center_label = _("All Cost Centres (Consolidated)")

    import time
    query_started = time.perf_counter()
    accounts = dashboard._get_forecast_accounts(scenario.company)
    entries = dashboard._get_forecast_entries(
        forecast_scenario=forecast_scenario,
        cost_center=cost_center,
        from_date=fy_start,
        to_date=fy_end,
    )

    actual_from = fy_start
    actual_to = min(fy_end, actual_cutoff)
    if actual_to >= actual_from:
        actuals = dashboard._get_forecast_actuals(
            company=scenario.company,
            cost_center=cost_center,
            from_date=actual_from,
            to_date=actual_to,
        )
    else:
        actuals = dashboard._empty_forecast_actuals()
    db_ms = (time.perf_counter() - query_started) * 1000

    sections, summary, monthly, fy_summary, fy_monthly = dashboard._build_forecast_grid(
        accounts, entries, months, actuals
    )

    for section in sections:
        section["actual_total"] = float(
            actuals.get("section_totals", {}).get(section["report_dimension"], 0) or 0
        )

    uoms = frappe.get_all("UOM", pluck="name", order_by="name asc", limit_page_length=1000)
    applied_months = sum(1 for month in months if month.get("display_mode") == "actual")

    runtime_ms = (frappe.utils.now_datetime() - started).total_seconds() * 1000
    return {
        "scenario": {
            "name": scenario.name,
            "scenario_name": scenario.scenario_name or scenario.name,
            "company": scenario.company,
            "scenario_type": scenario.scenario_type,
            "status": scenario.status,
            "forecast_start_month": str(scenario_start),
            "forecast_end_month": str(scenario_end),
            "actual_cutoff_date": str(actual_cutoff),
        },
        "filters": {
            "cost_center": cost_center,
            "cost_center_label": cost_center_label,
            "financial_year": financial_year,
            "actual_months": AUTO_ACTUAL_MONTHS if selected_months is None else selected_months,
            "actual_months_applied": applied_months,
        },
        "editable": scenario.status == "Draft" and cost_center != dashboard.ALL_FORECAST_COST_CENTRES,
        "months": months,
        "sections": sections,
        "summary": summary,
        "monthly": monthly,
        "fy_summary": fy_summary,
        "fy_monthly": fy_monthly,
        "actuals": {
            "from_date": str(actual_from) if actual_to >= actual_from else None,
            "to_date": str(actual_to) if actual_to >= actual_from else None,
            "period_label": (
                f"{actual_from.strftime('%d %b %Y')} - {actual_to.strftime('%d %b %Y')}"
                if actual_to >= actual_from else _("No actuals in this financial year")
            ),
            "summary": actuals.get("summary", {}),
            "monthly": actuals.get("monthly", []),
        },
        "uoms": uoms,
        "performance": {
            "server_runtime_ms": round(runtime_ms, 1),
            "database_runtime_ms": round(db_ms, 1),
            "account_count": len(accounts),
            "entry_count": len(entries),
        },
    }

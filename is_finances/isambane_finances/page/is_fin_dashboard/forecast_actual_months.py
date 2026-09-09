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
        requested_cutoff = getdate(add_months(fy_start, selected)) - timedelta(days=1)
    return min(fy_end, base_cutoff, requested_cutoff), selected


def _forecast_months_for_selection(fy_start, scenario_start, scenario_end, actual_cutoff, selected_months):
    if selected_months is None:
        return dashboard._forecast_year_months(fy_start, scenario_start, scenario_end, actual_cutoff=actual_cutoff)
    if actual_cutoff < fy_start:
        effective_forecast_start = fy_start
    else:
        effective_forecast_start = dashboard._next_month(date(actual_cutoff.year, actual_cutoff.month, 1))
    return dashboard._forecast_year_months(fy_start, effective_forecast_start, scenario_end, actual_cutoff=actual_cutoff)


@frappe.whitelist()
def apply_actual_months_to_scenario(forecast_scenario, financial_year, actual_months):
    """Persist the selected Actual/Forecast split on a Draft scenario.

    This keeps normal forecast loading, editing and saving aligned with the dashboard:
    the scenario Actual Cut-off Date becomes the end of the selected actual period and
    Forecast Start Month becomes the first following month.
    """
    selected = _normalise_actual_months(actual_months)
    if selected is None:
        return {"changed": False, "mode": AUTO_ACTUAL_MONTHS}

    scenario = dashboard._get_forecast_scenario(forecast_scenario)
    if scenario.status != "Draft":
        frappe.throw(_("Only Draft Forecast Scenarios can be changed."))

    fy_start, fy_end = dashboard._forecast_financial_year_bounds(financial_year)
    if selected == 0:
        cutoff = fy_start - timedelta(days=1)
        forecast_start = fy_start
    else:
        forecast_start = getdate(add_months(fy_start, selected))
        cutoff = forecast_start - timedelta(days=1)
        if cutoff > fy_end:
            cutoff = fy_end

    existing_end = getdate(scenario.forecast_end_month)
    if forecast_start > existing_end:
        frappe.throw(_("The selected Actual Months leaves no Forecast period inside this scenario."))

    frappe.db.set_value(
        "IS Forecast Scenario",
        scenario.name,
        {
            "actual_cutoff_date": cutoff,
            "forecast_start_month": forecast_start,
        },
        update_modified=True,
    )
    frappe.db.commit()
    return {
        "changed": True,
        "actual_months": selected,
        "actual_cutoff_date": str(cutoff),
        "forecast_start_month": str(forecast_start),
    }


@frappe.whitelist()
def get_forecast_data(forecast_scenario, cost_center, financial_year, actual_months=AUTO_ACTUAL_MONTHS):
    started = frappe.utils.now_datetime()
    scenario = dashboard._get_forecast_scenario(forecast_scenario)
    cost_center = (cost_center or dashboard.ALL_FORECAST_COST_CENTRES).strip()
    scenario_start = getdate(scenario.forecast_start_month)
    scenario_end = getdate(scenario.forecast_end_month)
    valid_years = dashboard._scenario_financial_years(scenario_start, scenario_end)
    if financial_year not in valid_years:
        frappe.throw(_("Financial Year is outside the selected Forecast Scenario."))

    fy_start, fy_end = dashboard._forecast_financial_year_bounds(financial_year)
    actual_cutoff, selected_months = _actual_cutoff_for_selection(scenario, fy_start, fy_end, actual_months)
    months = _forecast_months_for_selection(fy_start, scenario_start, scenario_end, actual_cutoff, selected_months)

    if cost_center != dashboard.ALL_FORECAST_COST_CENTRES:
        cc = frappe.db.get_value("Cost Center", cost_center, ["name", "company", "is_group", "cost_center_number"], as_dict=True)
        if not cc or cc.company != scenario.company or cint(cc.is_group):
            frappe.throw(_("Invalid Cost Center for this Forecast Scenario."))
        cost_center_label = f"{cc.cost_center_number or ''} - {cc.name}".strip(" -")
    else:
        cost_center_label = _("All Cost Centres (Consolidated)")

    import time
    query_started = time.perf_counter()
    accounts = dashboard._get_forecast_accounts(scenario.company)
    entries = dashboard._get_forecast_entries(forecast_scenario, cost_center, fy_start, fy_end)
    actual_from = fy_start
    actual_to = min(fy_end, actual_cutoff)
    actuals = dashboard._get_forecast_actuals(scenario.company, cost_center, actual_from, actual_to) if actual_to >= actual_from else dashboard._empty_forecast_actuals()
    db_ms = (time.perf_counter() - query_started) * 1000
    sections, summary, monthly, fy_summary, fy_monthly = dashboard._build_forecast_grid(accounts, entries, months, actuals)
    for section in sections:
        section["actual_total"] = float(actuals.get("section_totals", {}).get(section["report_dimension"], 0) or 0)
    uoms = frappe.get_all("UOM", pluck="name", order_by="name asc", limit_page_length=1000)
    applied_months = sum(1 for month in months if month.get("display_mode") == "actual")
    runtime_ms = (frappe.utils.now_datetime() - started).total_seconds() * 1000
    return {
        "scenario": {"name": scenario.name, "scenario_name": scenario.scenario_name or scenario.name, "company": scenario.company, "scenario_type": scenario.scenario_type, "status": scenario.status, "forecast_start_month": str(scenario_start), "forecast_end_month": str(scenario_end), "actual_cutoff_date": str(actual_cutoff)},
        "filters": {"cost_center": cost_center, "cost_center_label": cost_center_label, "financial_year": financial_year, "actual_months": AUTO_ACTUAL_MONTHS if selected_months is None else selected_months, "actual_months_applied": applied_months},
        "editable": scenario.status == "Draft" and cost_center != dashboard.ALL_FORECAST_COST_CENTRES,
        "months": months, "sections": sections, "summary": summary, "monthly": monthly,
        "fy_summary": fy_summary, "fy_monthly": fy_monthly,
        "actuals": {"from_date": str(actual_from) if actual_to >= actual_from else None, "to_date": str(actual_to) if actual_to >= actual_from else None, "period_label": f"{actual_from.strftime('%d %b %Y')} - {actual_to.strftime('%d %b %Y')}" if actual_to >= actual_from else _("No actuals in this financial year"), "summary": actuals.get("summary", {}), "monthly": actuals.get("monthly", [])},
        "uoms": uoms,
        "performance": {"server_runtime_ms": round(runtime_ms, 1), "database_runtime_ms": round(db_ms, 1), "account_count": len(accounts), "entry_count": len(entries)},
    }

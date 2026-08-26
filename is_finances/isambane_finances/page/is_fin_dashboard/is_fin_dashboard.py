# Copyright (c) 2026, Isambane Mining and contributors
# For license information, please see license.txt

from datetime import date
import re
import time

import frappe
from frappe import _
from frappe.utils import add_months, cint, flt, getdate, nowdate


IS_DIMENSIONS = [
    "IS-Revenue",
    "IS-Other Income",
    "IS-Cost of Sales",
    "IS-Other Expenditure",
]

DIMENSION_LABELS = {
    "IS-Revenue": "Revenue",
    "IS-Other Income": "Other Income",
    "IS-Cost of Sales": "Cost of Sales",
    "IS-Other Expenditure": "Other Expenditure",
}

ALL_COST_CENTRES = "All Cost Centres"
HEAD_OFFICE = "Head Office"
ALL_FORECAST_COST_CENTRES = "__all__"


@frappe.whitelist()
def get_financial_years():
    """Return available March-to-February financial years for the dashboard."""
    frappe.only_for("System Manager")

    row = frappe.db.sql(
        """
        SELECT MIN(p.tx_date) AS min_date, MAX(p.tx_date) AS max_date
        FROM `tabSage POSTGL Entry` p
        WHERE p.tx_date IS NOT NULL
        """,
        as_dict=True,
    )[0]

    today = getdate(nowdate())
    current_start_year = today.year if today.month >= 3 else today.year - 1
    min_date = getdate(row.min_date) if row.min_date else date(current_start_year, 3, 1)
    max_date = getdate(row.max_date) if row.max_date else today

    first_start_year = min_date.year if min_date.month >= 3 else min_date.year - 1
    last_data_start_year = max_date.year if max_date.month >= 3 else max_date.year - 1
    last_start_year = max(last_data_start_year, current_start_year)

    years = []
    for start_year in range(last_start_year, first_start_year - 1, -1):
        fy_start = date(start_year, 3, 1)
        fy_end = date(start_year + 1, 2, 29 if _is_leap_year(start_year + 1) else 28)
        effective_to = min(fy_end, today) if start_year == current_start_year else fy_end
        years.append(
            {
                "label": _financial_year_label(start_year),
                "start_year": start_year,
                "from_date": str(fy_start),
                "to_date": str(effective_to),
                "full_to_date": str(fy_end),
                "is_current": start_year == current_start_year,
            }
        )

    return {
        "financial_years": years,
        "current_financial_year": _financial_year_label(current_start_year),
    }


@frappe.whitelist()
def get_cost_centres(from_date=None, to_date=None):
    """Return Sage branch values as cost centres. Blank branch = Head Office."""
    frappe.only_for("System Manager")

    conditions = ["p.tx_date IS NOT NULL"]
    values = {}

    if from_date:
        conditions.append("p.tx_date >= %(from_date)s")
        values["from_date"] = getdate(from_date)
    if to_date:
        conditions.append("p.tx_date < DATE_ADD(%(to_date)s, INTERVAL 1 DAY)")
        values["to_date"] = getdate(to_date)

    rows = frappe.db.sql(
        f"""
        SELECT DISTINCT
            CASE
                WHEN p.brch IS NULL OR p.brch = '' OR TRIM(p.brch) = '' THEN %(head_office)s
                ELSE p.brch
            END AS cost_centre
        FROM `tabSage POSTGL Entry` p
        WHERE {' AND '.join(conditions)}
        ORDER BY cost_centre
        """,
        {**values, "head_office": HEAD_OFFICE},
        as_dict=True,
    )

    return {
        "cost_centres": [ALL_COST_CENTRES]
        + [str(r.cost_centre).strip() for r in rows if r.cost_centre]
    }


@frappe.whitelist()
def get_dashboard_data(from_date, to_date, cost_centre=None):
    """Return the full dashboard from one POSTGL aggregation query.

    Performance design:
    - one aggregate query supplies IS tree, monthly charts and EBITDA adjustments;
    - a specific site uses direct p.brch equality so a branch/date index can be used;
    - drilldowns remain lazy and only run when the user opens an account.
    """
    frappe.only_for("System Manager")

    server_started = time.perf_counter()
    from_date, to_date = _validate_dates(from_date, to_date)
    cost_centre = _normalise_cost_centre(cost_centre)
    months = _get_months(from_date, to_date)

    query_started = time.perf_counter()
    rows = _get_dashboard_aggregate(from_date, to_date, cost_centre)
    query_ms = (time.perf_counter() - query_started) * 1000

    build_started = time.perf_counter()
    sections, summary, monthly = _build_dashboard_from_aggregate(rows, months)
    build_ms = (time.perf_counter() - build_started) * 1000
    server_ms = (time.perf_counter() - server_started) * 1000

    return {
        "filters": {
            "from_date": str(from_date),
            "to_date": str(to_date),
            "cost_centre": cost_centre,
            "financial_year": _financial_year_label_for_period(from_date, to_date),
            "report_scope": "Consolidated" if cost_centre == ALL_COST_CENTRES else "Site",
        },
        "months": months,
        "sections": sections,
        "summary": summary,
        "monthly": monthly,
        "performance": {
            "server_runtime_ms": round(server_ms, 1),
            "database_runtime_ms": round(query_ms, 1),
            "build_runtime_ms": round(build_ms, 1),
            "aggregate_rows": len(rows),
            "dashboard_query_count": 1,
        },
    }


@frappe.whitelist()
def get_income_statement_drilldown(from_date, to_date, group_account, account_type, cost_centre=None):
    """Return month-column drilldown by cost centre or master-sub account."""
    frappe.only_for("System Manager")

    started = time.perf_counter()
    from_date, to_date = _validate_dates(from_date, to_date)
    cost_centre = _normalise_cost_centre(cost_centre)
    months = _get_months(from_date, to_date)

    try:
        account_type = int(account_type)
    except (TypeError, ValueError):
        frappe.throw(_("Invalid account type."))

    group_account = (group_account or "").strip()
    if len(group_account) != 4 or not group_account.isdigit():
        frappe.throw(_("Group account must contain the first four numeric characters."))

    query_started = time.perf_counter()
    if cost_centre == ALL_COST_CENTRES:
        raw = _get_cost_centre_drilldown(from_date, to_date, group_account, account_type)
        level = "cost_centre"
        rows = _pivot_drilldown(raw, months, "cost_centre")
    else:
        raw = _get_sub_account_drilldown(from_date, to_date, group_account, account_type, cost_centre)
        level = "sub_account"
        rows = _pivot_drilldown(raw, months, "master_sub_account", clean_descriptions=True)
    query_ms = (time.perf_counter() - query_started) * 1000

    return {
        "level": level,
        "months": months,
        "rows": rows,
        "performance": {
            "server_runtime_ms": round((time.perf_counter() - started) * 1000, 1),
            "database_runtime_ms": round(query_ms, 1),
        },
    }


@frappe.whitelist()
def get_summary_metric_drilldown(
    from_date,
    to_date,
    metric,
    cost_centre=None,
    month_key=None,
):
    """Return Profit/(Loss) or EBITDA contribution by cost centre.

    Clicking a monthly summary amount returns that month by cost centre.
    Clicking the period total returns all selected months plus the period total.
    """
    frappe.only_for("System Manager")

    started = time.perf_counter()
    from_date, to_date = _validate_dates(from_date, to_date)
    cost_centre = _normalise_cost_centre(cost_centre)

    metric = (metric or "").strip().lower()
    metric_labels = {
        "profit_loss": _("Profit / (Loss)"),
        "ebitda": _("EBITDA"),
    }
    if metric not in metric_labels:
        frappe.throw(_("Invalid summary metric."))

    period_from = from_date
    period_to = to_date
    months = _get_months(from_date, to_date)
    period_label = _("Selected period")

    if month_key:
        month_start, month_end, period_label = _month_bounds(month_key)
        period_from = max(from_date, month_start)
        period_to = min(to_date, month_end)
        if period_from > period_to:
            return {
                "metric": metric,
                "metric_label": metric_labels[metric],
                "period_label": period_label,
                "months": [],
                "rows": [],
                "performance": {"server_runtime_ms": 0.0, "database_runtime_ms": 0.0},
            }
        months = _get_months(period_from, period_to)

    cost_filter_sql, values = _cost_centre_condition(cost_centre)
    values.update(
        {
            "period_from": period_from,
            "period_to": period_to,
            "head_office": HEAD_OFFICE,
            "dimensions": tuple(IS_DIMENSIONS),
        }
    )

    signed = _signed_amount_sql()
    pnl_effect = f"""
        CASE
            WHEN a.report_dimension IN ('IS-Revenue', 'IS-Other Income') THEN ({signed})
            ELSE -({signed})
        END
    """
    interest_paid = f"""
        CASE
            WHEN LOWER(COALESCE(p.sage_account_description, '')) LIKE '%%interest%%'
             AND a.report_dimension IN ('IS-Cost of Sales', 'IS-Other Expenditure')
            THEN ({signed}) ELSE 0
        END
    """
    depreciation = f"""
        CASE
            WHEN LOWER(COALESCE(p.sage_account_description, '')) LIKE '%%depreciat%%'
            THEN ({signed}) ELSE 0
        END
    """
    interest_received = f"""
        CASE
            WHEN LOWER(COALESCE(p.sage_account_description, '')) LIKE '%%interest%%'
             AND a.report_dimension IN ('IS-Revenue', 'IS-Other Income')
            THEN ({signed}) ELSE 0
        END
    """

    metric_sql = pnl_effect
    if metric == "ebitda":
        metric_sql = f"(({pnl_effect}) + ({interest_paid}) + ({depreciation}) - ({interest_received}))"

    query_started = time.perf_counter()
    raw_rows = frappe.db.sql(
        f"""
        SELECT
            CASE
                WHEN p.brch IS NULL OR p.brch = '' OR TRIM(p.brch) = '' THEN %(head_office)s
                ELSE p.brch
            END AS cost_centre,
            YEAR(p.tx_date) AS posting_year,
            MONTH(p.tx_date) AS posting_month,
            SUM({metric_sql}) AS amount
        FROM `tabSage POSTGL Entry` p
        INNER JOIN `tabSageAccountType` a
            ON a.sage_account_type = p.iaccounttype
        WHERE
            a.report_dimension IN %(dimensions)s
            AND p.tx_date >= %(period_from)s
            AND p.tx_date < DATE_ADD(%(period_to)s, INTERVAL 1 DAY)
            {cost_filter_sql}
        GROUP BY
            CASE
                WHEN p.brch IS NULL OR p.brch = '' OR TRIM(p.brch) = '' THEN %(head_office)s
                ELSE p.brch
            END,
            YEAR(p.tx_date),
            MONTH(p.tx_date)
        ORDER BY cost_centre, posting_year, posting_month
        """,
        values,
        as_dict=True,
    )
    query_ms = (time.perf_counter() - query_started) * 1000

    month_keys = [m["key"] for m in months]
    by_cost_centre = {}
    for row in raw_rows:
        cc = str(row.cost_centre or HEAD_OFFICE).strip() or HEAD_OFFICE
        if cc not in by_cost_centre:
            by_cost_centre[cc] = {
                "cost_centre": cc,
                "months": {key: 0.0 for key in month_keys},
                "amount": 0.0,
            }
        key = f"{int(row.posting_year):04d}_{int(row.posting_month):02d}"
        amount = float(row.amount or 0)
        if key in by_cost_centre[cc]["months"]:
            by_cost_centre[cc]["months"][key] += amount
        by_cost_centre[cc]["amount"] += amount

    result_rows = sorted(by_cost_centre.values(), key=lambda row: row["cost_centre"])

    return {
        "metric": metric,
        "metric_label": metric_labels[metric],
        "period_label": period_label,
        "months": months,
        "rows": result_rows,
        "performance": {
            "server_runtime_ms": round((time.perf_counter() - started) * 1000, 1),
            "database_runtime_ms": round(query_ms, 1),
        },
    }


@frappe.whitelist()
def get_income_statement_transactions(
    from_date,
    to_date,
    group_account,
    account_type,
    cost_centre=None,
    month_key=None,
    master_sub_account=None,
):
    """Return lazy transaction detail for a clicked Income Statement amount."""
    frappe.only_for("System Manager")

    started = time.perf_counter()
    from_date, to_date = _validate_dates(from_date, to_date)
    cost_centre = _normalise_cost_centre(cost_centre)

    try:
        account_type = int(account_type)
    except (TypeError, ValueError):
        frappe.throw(_("Invalid account type."))

    group_account = (group_account or "").strip()
    if len(group_account) != 4 or not group_account.isdigit():
        frappe.throw(_("Group account must contain the first four numeric characters."))

    period_from = from_date
    period_to = to_date
    period_label = _("Selected period")

    if month_key:
        month_start, month_end, period_label = _month_bounds(month_key)
        period_from = max(from_date, month_start)
        period_to = min(to_date, month_end)
        if period_from > period_to:
            return {
                "rows": [],
                "transaction_count": 0,
                "total_amount": 0.0,
                "period_label": period_label,
                "performance": {"server_runtime_ms": 0.0, "database_runtime_ms": 0.0},
            }

    conditions = [
        "p.iaccounttype = %(account_type)s",
        "p.master_sub_account LIKE %(group_account_pattern)s",
        "p.tx_date >= %(period_from)s",
        "p.tx_date < DATE_ADD(%(period_to)s, INTERVAL 1 DAY)",
        "a.report_dimension IN %(dimensions)s",
    ]
    values = {
        "account_type": account_type,
        "group_account_pattern": group_account + "%",
        "period_from": period_from,
        "period_to": period_to,
        "dimensions": tuple(IS_DIMENSIONS),
    }

    cost_filter_sql, cost_values = _cost_centre_condition(cost_centre)
    values.update(cost_values)

    if master_sub_account:
        master_sub_account = str(master_sub_account).strip()
        conditions.append("p.master_sub_account = %(master_sub_account)s")
        values["master_sub_account"] = master_sub_account

    query_started = time.perf_counter()
    rows = frappe.db.sql(
        f"""
        SELECT
            p.tx_date,
            p.reference,
            p.description,
            p.master_sub_account,
            CASE
                WHEN p.brch IS NULL OR p.brch = '' OR TRIM(p.brch) = '' THEN %(head_office)s
                ELSE p.brch
            END AS cost_centre,
            {_signed_amount_sql()} AS amount
        FROM `tabSage POSTGL Entry` p
        INNER JOIN `tabSageAccountType` a
            ON a.sage_account_type = p.iaccounttype
        WHERE
            {' AND '.join(conditions)}
            {cost_filter_sql}
        ORDER BY p.tx_date, p.reference, p.name
        """,
        {**values, "head_office": HEAD_OFFICE},
        as_dict=True,
    )
    query_ms = (time.perf_counter() - query_started) * 1000

    result_rows = []
    total_amount = 0.0
    for row in rows:
        amount = float(row.amount or 0)
        total_amount += amount
        result_rows.append(
            {
                "date": str(getdate(row.tx_date)) if row.tx_date else "",
                "reference": row.reference or "",
                "description": row.description or "",
                "amount": amount,
                "master_sub_account": row.master_sub_account or "",
                "cost_centre": str(row.cost_centre or "").strip(),
            }
        )

    return {
        "rows": result_rows,
        "transaction_count": len(result_rows),
        "total_amount": total_amount,
        "period_label": period_label,
        "performance": {
            "server_runtime_ms": round((time.perf_counter() - started) * 1000, 1),
            "database_runtime_ms": round(query_ms, 1),
        },
    }


@frappe.whitelist()
def get_forecast_scenarios(company=None):
    """Return active forecast scenarios and their March-February FY windows."""
    frappe.only_for("System Manager")

    filters = {"is_active": 1}
    if company:
        filters["company"] = company

    rows = frappe.get_all(
        "IS Forecast Scenario",
        filters=filters,
        fields=[
            "name",
            "scenario_name",
            "company",
            "scenario_type",
            "forecast_start_month",
            "forecast_end_month",
            "horizon_months",
            "status",
            "actual_cutoff_date",
        ],
        order_by="forecast_start_month desc, scenario_name asc",
        limit_page_length=500,
    )

    scenarios = []
    for row in rows:
        start = getdate(row.forecast_start_month) if row.forecast_start_month else None
        end = getdate(row.forecast_end_month) if row.forecast_end_month else None
        if start and not end:
            end = getdate(add_months(start, cint(row.horizon_months or 60) - 1))

        scenarios.append(
            {
                "name": row.name,
                "scenario_name": row.scenario_name or row.name,
                "company": row.company,
                "scenario_type": row.scenario_type,
                "status": row.status,
                "forecast_start_month": str(start) if start else None,
                "forecast_end_month": str(end) if end else None,
                "horizon_months": cint(row.horizon_months),
                "actual_cutoff_date": str(getdate(row.actual_cutoff_date)) if row.actual_cutoff_date else None,
                "financial_years": _scenario_financial_years(start, end) if start and end else [],
            }
        )

    return {"scenarios": scenarios}


@frappe.whitelist()
def get_forecast_cost_centres(forecast_scenario):
    """Return standard ERPNext Cost Centers available to a scenario company."""
    frappe.only_for("System Manager")

    scenario = _get_forecast_scenario(forecast_scenario)

    rows = frappe.get_all(
        "Cost Center",
        filters={
            "company": scenario.company,
            "is_group": 0,
            "disabled": 0,
        },
        fields=["name", "cost_center_name", "cost_center_number"],
        order_by="cost_center_number asc, name asc",
        limit_page_length=1000,
    )

    result = [
        {
            "name": ALL_FORECAST_COST_CENTRES,
            "label": _("All Cost Centres (Consolidated)"),
            "cost_center_number": "",
        }
    ]

    for row in rows:
        number = (row.cost_center_number or "").strip()
        if not number:
            continue
        result.append(
            {
                "name": row.name,
                "label": f"{number} - {row.cost_center_name or row.name}",
                "cost_center_number": number,
            }
        )

    return {"cost_centres": result}


@frappe.whitelist()
def get_forecast_data(forecast_scenario, cost_center, financial_year):
    """Return one editable/read-only March-February forecast grid."""
    frappe.only_for("System Manager")

    started = time.perf_counter()
    scenario = _get_forecast_scenario(forecast_scenario)
    cost_center = (cost_center or ALL_FORECAST_COST_CENTRES).strip()

    valid_years = _scenario_financial_years(
        getdate(scenario.forecast_start_month),
        getdate(scenario.forecast_end_month),
    )
    if financial_year not in valid_years:
        frappe.throw(_("Financial Year is outside the selected Forecast Scenario."))

    fy_start, fy_end = _forecast_financial_year_bounds(financial_year)
    actual_cutoff = _forecast_actual_cutoff(scenario)
    months = _forecast_year_months(
        fy_start,
        getdate(scenario.forecast_start_month),
        getdate(scenario.forecast_end_month),
        actual_cutoff=actual_cutoff,
    )

    if cost_center != ALL_FORECAST_COST_CENTRES:
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

    query_started = time.perf_counter()
    accounts = _get_forecast_accounts(scenario.company)
    entries = _get_forecast_entries(
        forecast_scenario=forecast_scenario,
        cost_center=cost_center,
        from_date=fy_start,
        to_date=fy_end,
    )

    actual_from = fy_start
    actual_to = min(fy_end, actual_cutoff)
    if actual_to >= actual_from:
        actuals = _get_forecast_actuals(
            company=scenario.company,
            cost_center=cost_center,
            from_date=actual_from,
            to_date=actual_to,
        )
    else:
        actuals = _empty_forecast_actuals()

    db_ms = (time.perf_counter() - query_started) * 1000

    sections, summary, monthly, fy_summary, fy_monthly = _build_forecast_grid(
        accounts, entries, months, actuals
    )

    for section in sections:
        section["actual_total"] = float(
            actuals.get("section_totals", {}).get(section["report_dimension"], 0) or 0
        )

    uoms = frappe.get_all("UOM", pluck="name", order_by="name asc", limit_page_length=1000)

    return {
        "scenario": {
            "name": scenario.name,
            "scenario_name": scenario.scenario_name or scenario.name,
            "company": scenario.company,
            "scenario_type": scenario.scenario_type,
            "status": scenario.status,
            "forecast_start_month": str(getdate(scenario.forecast_start_month)),
            "forecast_end_month": str(getdate(scenario.forecast_end_month)),
            "actual_cutoff_date": str(actual_cutoff),
        },
        "filters": {
            "cost_center": cost_center,
            "cost_center_label": cost_center_label,
            "financial_year": financial_year,
        },
        "editable": scenario.status == "Draft" and cost_center != ALL_FORECAST_COST_CENTRES,
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
            "server_runtime_ms": round((time.perf_counter() - started) * 1000, 1),
            "database_runtime_ms": round(db_ms, 1),
            "account_count": len(accounts),
            "entry_count": len(entries),
        },
    }


@frappe.whitelist()
def get_expense_actual_average(forecast_scenario, source_cost_center):
    """Return the last-three-month actual average by expense group account.

    The averaging anchor is the Scenario Actual Cut-off Date when supplied.
    Otherwise it is the earlier of today and the day before Forecast Start Month.
    This makes the period explicit and avoids silently using actuals after the
    forecast starts.
    """
    frappe.only_for("System Manager")

    scenario = _get_forecast_scenario(forecast_scenario)
    payload = _get_expense_actual_average_data(scenario, source_cost_center)
    return {
        "source_cost_center": source_cost_center,
        "source_label": payload["source_label"],
        "from_date": str(payload["from_date"]),
        "to_date": str(payload["to_date"]),
        "period_label": payload["period_label"],
        "averages": payload["averages"],
    }


@frappe.whitelist()
def seed_expense_forecast_from_actual_average(
    forecast_scenario,
    target_cost_center,
    source_cost_center,
):
    """Populate every scenario month for expense accounts from a 3-month actual average.

    This intentionally overwrites existing expense forecast amounts for the
    target cost centre across the full scenario horizon. Revenue/driver accounts
    are not changed. The resulting Forecast Entries remain fully editable.
    """
    frappe.only_for("System Manager")

    started = time.perf_counter()
    scenario = _get_forecast_scenario(forecast_scenario)

    if scenario.status != "Draft":
        frappe.throw(_("Only Draft Forecast Scenarios can be seeded."))
    if not cint(scenario.is_active):
        frappe.throw(_("Forecast Scenario is not active."))

    target_cost_center = (target_cost_center or "").strip()
    if not target_cost_center or target_cost_center == ALL_FORECAST_COST_CENTRES:
        frappe.throw(_("Select an individual target Cost Center before populating forecast values."))

    target_info = _forecast_cost_center_info(
        scenario.company,
        target_cost_center,
        allow_all=False,
    )
    average_payload = _get_expense_actual_average_data(scenario, source_cost_center)
    averages = average_payload["averages"]

    expense_accounts = [
        row for row in _get_forecast_accounts(scenario.company)
        if row.report_dimension in ("IS-Cost of Sales", "IS-Other Expenditure")
        and (row.forecast_method or "Amount").strip().lower() == "amount"
    ]

    scenario_start = date(
        getdate(scenario.forecast_start_month).year,
        getdate(scenario.forecast_start_month).month,
        1,
    )
    cutoff = _forecast_actual_cutoff(scenario)
    cutoff_month = date(cutoff.year, cutoff.month, 1)
    first_future_month = _next_month(cutoff_month)
    scenario_start = max(scenario_start, first_future_month)
    scenario_end = date(
        getdate(scenario.forecast_end_month).year,
        getdate(scenario.forecast_end_month).month,
        1,
    )
    periods = []
    current = scenario_start
    while current <= scenario_end:
        periods.append(current)
        current = _next_month(current)

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
            "start": scenario_start,
            "end": scenario_end,
        },
        as_dict=True,
    )
    existing_keys = {
        (row.account, date(getdate(row.forecast_period).year, getdate(row.forecast_period).month, 1)): row.name
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
            if key[0] == account.account and scenario_start <= key[1] <= scenario_end
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

        # Update all already stored months for this account in one statement.
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
                    "start": scenario_start,
                    "end": scenario_end,
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
                    _financial_year_label(fy_start_year), target_cost_center,
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


@frappe.whitelist()
def save_forecast_changes(forecast_scenario, cost_center, changes):
    """Create/update/delete changed monthly Forecast Entries from the dashboard."""
    frappe.only_for("System Manager")

    started = time.perf_counter()
    scenario = _get_forecast_scenario(forecast_scenario)

    if scenario.status != "Draft":
        frappe.throw(_("Only Draft Forecast Scenarios can be edited."))

    if not cint(scenario.is_active):
        frappe.throw(_("Forecast Scenario is not active."))

    cost_center = (cost_center or "").strip()
    if not cost_center or cost_center == ALL_FORECAST_COST_CENTRES:
        frappe.throw(_("Select an individual Cost Center before saving forecast values."))

    cc = frappe.db.get_value(
        "Cost Center",
        cost_center,
        ["company", "is_group"],
        as_dict=True,
    )
    if not cc or cc.company != scenario.company or cint(cc.is_group):
        frappe.throw(_("Invalid Cost Center for this Forecast Scenario."))

    if isinstance(changes, str):
        changes = frappe.parse_json(changes)
    changes = changes or []
    if not isinstance(changes, list):
        frappe.throw(_("Forecast changes must be supplied as a list."))

    result = {"created": 0, "updated": 0, "deleted": 0, "unchanged": 0}

    for change in changes:
        account = (change.get("account") or "").strip()
        period = getdate(change.get("forecast_period")) if change.get("forecast_period") else None
        if not account or not period:
            continue
        period = date(period.year, period.month, 1)

        account_meta = frappe.db.get_value(
            "Account",
            account,
            [
                "company",
                "isf_forecast_enabled",
                "isf_forecast_method",
                "isf_default_forecast_uom",
            ],
            as_dict=True,
        )
        if not account_meta or account_meta.company != scenario.company:
            frappe.throw(_("Invalid forecast Account: {0}").format(frappe.bold(account)))
        if not cint(account_meta.isf_forecast_enabled):
            frappe.throw(_("Forecast is not enabled for Account {0}.").format(frappe.bold(account)))

        method = (account_meta.isf_forecast_method or "").strip().lower()
        volume = flt(change.get("volume"))
        price = flt(change.get("price_per_unit"))
        amount = flt(change.get("forecast_amount"))
        volume_uom = change.get("volume_uom") or account_meta.isf_default_forecast_uom
        comments = change.get("comments") or ""

        if method in {"volume x price", "volume × price"}:
            amount = flt(volume * price, 2)
            is_empty = not volume and not price
        else:
            is_empty = not amount

        existing = frappe.db.get_value(
            "IS Forecast Entry",
            {
                "forecast_scenario": forecast_scenario,
                "cost_center": cost_center,
                "account": account,
                "forecast_period": period,
            },
            "name",
        )

        if is_empty:
            if existing:
                frappe.delete_doc("IS Forecast Entry", existing)
                result["deleted"] += 1
            else:
                result["unchanged"] += 1
            continue

        if existing:
            doc = frappe.get_doc("IS Forecast Entry", existing)
            doc.volume = volume
            doc.volume_uom = volume_uom
            doc.price_per_unit = price
            doc.forecast_amount = amount
            doc.comments = comments
            doc.input_source = "Volume x Price" if method in {"volume x price", "volume × price"} else "Manual"
            doc.save()
            result["updated"] += 1
        else:
            doc = frappe.get_doc(
                {
                    "doctype": "IS Forecast Entry",
                    "forecast_scenario": forecast_scenario,
                    "cost_center": cost_center,
                    "account": account,
                    "forecast_period": period,
                    "volume": volume,
                    "volume_uom": volume_uom,
                    "price_per_unit": price,
                    "forecast_amount": amount,
                    "comments": comments,
                    "input_source": "Volume x Price" if method in {"volume x price", "volume × price"} else "Manual",
                }
            )
            doc.insert()
            result["created"] += 1

    result["runtime_ms"] = round((time.perf_counter() - started) * 1000, 1)
    return result


def _get_forecast_scenario(name):
    if not name:
        frappe.throw(_("Forecast Scenario is required."))

    scenario = frappe.db.get_value(
        "IS Forecast Scenario",
        name,
        [
            "name",
            "scenario_name",
            "company",
            "scenario_type",
            "forecast_start_month",
            "forecast_end_month",
            "horizon_months",
            "status",
            "is_active",
            "actual_cutoff_date",
        ],
        as_dict=True,
    )
    if not scenario:
        frappe.throw(_("Forecast Scenario could not be found."))
    if not scenario.forecast_start_month:
        frappe.throw(_("Forecast Scenario does not have a Forecast Start Month."))
    if not scenario.forecast_end_month:
        scenario.forecast_end_month = add_months(
            scenario.forecast_start_month,
            cint(scenario.horizon_months or 60) - 1,
        )
    return scenario


def _scenario_financial_years(start, end):
    if not start or not end:
        return []
    first = start.year if start.month >= 3 else start.year - 1
    last = end.year if end.month >= 3 else end.year - 1
    return [_financial_year_label(year) for year in range(first, last + 1)]


def _forecast_financial_year_bounds(label):
    match = re.match(r"^FY\s+(\d{4})/(\d{2})$", str(label or "").strip())
    if not match:
        frappe.throw(_("Invalid Forecast Financial Year."))
    start_year = int(match.group(1))
    expected = str(start_year + 1)[-2:]
    if match.group(2) != expected:
        frappe.throw(_("Invalid Forecast Financial Year."))
    start = date(start_year, 3, 1)
    end_year = start_year + 1
    end = date(end_year, 2, 29 if _is_leap_year(end_year) else 28)
    return start, end


def _forecast_year_months(fy_start, scenario_start, scenario_end, actual_cutoff=None):
    """Return March-February months with Actual/Forecast display mode.

    Actuals take precedence up to the actual cut-off month. Forecast input is
    available from the scenario start month onward. This gives one continuous
    Actual + Forecast financial-year view.
    """
    months = []
    current = fy_start
    actual_cutoff_month = None
    if actual_cutoff:
        cutoff = getdate(actual_cutoff)
        actual_cutoff_month = date(cutoff.year, cutoff.month, 1)

    for _ in range(12):
        forecast_available = scenario_start <= current <= scenario_end
        actual_available = bool(actual_cutoff_month and current <= actual_cutoff_month)
        display_mode = "actual" if actual_available else ("forecast" if forecast_available else "none")
        months.append(
            {
                "key": current.strftime("%Y_%m"),
                "label": current.strftime("%b %Y"),
                "short_label": current.strftime("%b"),
                "period": str(current),
                "year": current.year,
                "month": current.month,
                "available": forecast_available,
                "forecast_available": forecast_available,
                "actual_available": actual_available,
                "display_mode": display_mode,
            }
        )
        current = _next_month(current)
    return months


def _get_forecast_accounts(company):
    return frappe.db.sql(
        """
        SELECT
            a.name AS account,
            a.account_number,
            a.account_name,
            a.isf_report_dimension AS report_dimension,
            a.isf_forecast_method AS forecast_method,
            a.isf_default_forecast_uom AS default_forecast_uom,
            a.isf_ebitda_treatment AS ebitda_treatment,
            a.isf_sage_account_type AS sage_account_type,
            sat.sage_accounttype_decsription AS account_type_description,
            COALESCE(sat.sort_order, 0) AS sort_order
        FROM `tabAccount` a
        LEFT JOIN `tabSageAccountType` sat
            ON sat.name = a.isf_sage_account_type
        WHERE
            a.company = %(company)s
            AND a.is_group = 0
            AND a.disabled = 0
            AND a.report_type = 'Profit and Loss'
            AND a.isf_forecast_enabled = 1
            AND a.isf_report_dimension IN %(dimensions)s
            AND a.account_number REGEXP '^[0-9]{4}$'
        ORDER BY
            CASE a.isf_report_dimension
                WHEN 'IS-Revenue' THEN 1
                WHEN 'IS-Other Income' THEN 2
                WHEN 'IS-Cost of Sales' THEN 3
                WHEN 'IS-Other Expenditure' THEN 4
                ELSE 99
            END,
            COALESCE(sat.sort_order, 0),
            CAST(a.account_number AS UNSIGNED),
            a.account_name
        """,
        {"company": company, "dimensions": tuple(IS_DIMENSIONS)},
        as_dict=True,
    )


def _get_forecast_entries(forecast_scenario, cost_center, from_date, to_date):
    values = {
        "forecast_scenario": forecast_scenario,
        "from_date": from_date,
        "to_date": to_date,
    }

    if cost_center == ALL_FORECAST_COST_CENTRES:
        return frappe.db.sql(
            """
            SELECT
                e.account,
                e.forecast_period,
                NULL AS name,
                SUM(COALESCE(e.volume, 0)) AS volume,
                CASE
                    WHEN SUM(COALESCE(e.volume, 0)) <> 0
                    THEN SUM(COALESCE(e.forecast_amount, 0)) / SUM(COALESCE(e.volume, 0))
                    ELSE 0
                END AS price_per_unit,
                SUM(COALESCE(e.forecast_amount, 0)) AS forecast_amount,
                CASE
                    WHEN COUNT(DISTINCT NULLIF(e.volume_uom, '')) = 1 THEN MAX(e.volume_uom)
                    ELSE ''
                END AS volume_uom,
                '' AS comments
            FROM `tabIS Forecast Entry` e
            WHERE
                e.forecast_scenario = %(forecast_scenario)s
                AND e.forecast_period >= %(from_date)s
                AND e.forecast_period <= %(to_date)s
            GROUP BY e.account, e.forecast_period
            ORDER BY e.account, e.forecast_period
            """,
            values,
            as_dict=True,
        )

    values["cost_center"] = cost_center
    return frappe.db.sql(
        """
        SELECT
            e.name,
            e.account,
            e.forecast_period,
            COALESCE(e.volume, 0) AS volume,
            e.volume_uom,
            COALESCE(e.price_per_unit, 0) AS price_per_unit,
            COALESCE(e.forecast_amount, 0) AS forecast_amount,
            e.comments
        FROM `tabIS Forecast Entry` e
        WHERE
            e.forecast_scenario = %(forecast_scenario)s
            AND e.cost_center = %(cost_center)s
            AND e.forecast_period >= %(from_date)s
            AND e.forecast_period <= %(to_date)s
        ORDER BY e.account, e.forecast_period
        """,
        values,
        as_dict=True,
    )


def _forecast_actual_cutoff(scenario):
    """Actual cut-off used by the Forecast tab.

    Scenario Actual Cut-off Date wins. Otherwise use today, but never use
    actuals on/after the Scenario Forecast Start Month.
    """
    if getattr(scenario, "actual_cutoff_date", None):
        return getdate(scenario.actual_cutoff_date)

    today = getdate(nowdate())
    start = getdate(scenario.forecast_start_month)
    day_before_start = date(start.year, start.month, 1)
    from datetime import timedelta
    day_before_start = day_before_start - timedelta(days=1)
    return min(today, day_before_start)


def _forecast_cost_center_info(company, cost_center, allow_all=True):
    cost_center = (cost_center or ALL_FORECAST_COST_CENTRES).strip()
    if cost_center == ALL_FORECAST_COST_CENTRES:
        if not allow_all:
            frappe.throw(_("An individual Cost Center is required."))
        return {
            "name": ALL_FORECAST_COST_CENTRES,
            "label": _("All Cost Centres (Consolidated)"),
            "cost_center_number": "",
        }

    row = frappe.db.get_value(
        "Cost Center",
        cost_center,
        ["name", "cost_center_name", "cost_center_number", "company", "is_group", "disabled"],
        as_dict=True,
    )
    if not row or row.company != company or cint(row.is_group) or cint(row.disabled):
        frappe.throw(_("Invalid Cost Center for this Forecast Scenario."))

    number = (row.cost_center_number or "").strip()
    if not number:
        frappe.throw(_("Cost Center {0} does not have a Cost Center Number.").format(frappe.bold(row.name)))
    return {
        "name": row.name,
        "label": f"{number} - {row.cost_center_name or row.name}",
        "cost_center_number": number,
    }


def _forecast_actual_branch_condition(company, cost_center):
    info = _forecast_cost_center_info(company, cost_center, allow_all=True)
    if cost_center == ALL_FORECAST_COST_CENTRES:
        return "", {}, info

    branch = info["cost_center_number"]
    if branch == "MID":
        return (
            "AND (p.brch = %(actual_branch)s OR p.brch IS NULL OR p.brch = '' OR TRIM(p.brch) = '')",
            {"actual_branch": branch},
            info,
        )
    return "AND p.brch = %(actual_branch)s", {"actual_branch": branch}, info


def _empty_forecast_actuals():
    return {
        "by_account": {},
        "by_account_month": {},
        "section_totals": {dimension: 0.0 for dimension in IS_DIMENSIONS},
        "section_month_totals": {dimension: {} for dimension in IS_DIMENSIONS},
        "monthly": [],
        "monthly_map": {},
        "summary": {
            "revenue": 0.0,
            "other_income": 0.0,
            "cost_of_sales": 0.0,
            "other_expenditure": 0.0,
            "profit_loss": 0.0,
            "interest_paid": 0.0,
            "depreciation": 0.0,
            "interest_received": 0.0,
            "ebitda": 0.0,
        },
    }


def _get_forecast_actuals(company, cost_center, from_date, to_date):
    """Return YTD and monthly actuals using the same Sage sign rules as the IS."""
    if from_date > to_date:
        return _empty_forecast_actuals()

    branch_sql, branch_values, _ = _forecast_actual_branch_condition(company, cost_center)
    values = {
        "company": company,
        "from_date": from_date,
        "to_date": to_date,
        "dimensions": tuple(IS_DIMENSIONS),
        **branch_values,
    }
    signed = _signed_amount_sql()
    rows = frappe.db.sql(
        f"""
        SELECT
            LEFT(TRIM(COALESCE(p.master_sub_account, '')), 4) AS group_account,
            a.report_dimension,
            YEAR(p.tx_date) AS posting_year,
            MONTH(p.tx_date) AS posting_month,
            SUM({signed}) AS amount,
            SUM(CASE
                WHEN LOWER(COALESCE(p.sage_account_description, '')) LIKE '%%depreciat%%'
                THEN {signed} ELSE 0 END) AS depreciation,
            SUM(CASE
                WHEN LOWER(COALESCE(p.sage_account_description, '')) LIKE '%%interest%%'
                 AND a.report_dimension IN ('IS-Cost of Sales', 'IS-Other Expenditure')
                THEN {signed} ELSE 0 END) AS interest_paid,
            SUM(CASE
                WHEN LOWER(COALESCE(p.sage_account_description, '')) LIKE '%%interest%%'
                 AND a.report_dimension IN ('IS-Revenue', 'IS-Other Income')
                THEN {signed} ELSE 0 END) AS interest_received
        FROM `tabSage POSTGL Entry` p
        INNER JOIN `tabSageAccountType` a
            ON a.sage_account_type = p.iaccounttype
        WHERE p.company = %(company)s
          AND p.tx_date >= %(from_date)s
          AND p.tx_date < DATE_ADD(%(to_date)s, INTERVAL 1 DAY)
          AND a.report_dimension IN %(dimensions)s
          AND TRIM(COALESCE(p.master_sub_account, '')) REGEXP '^[0-9]{{4}}'
          {branch_sql}
        GROUP BY
            LEFT(TRIM(COALESCE(p.master_sub_account, '')), 4),
            a.report_dimension,
            YEAR(p.tx_date),
            MONTH(p.tx_date)
        ORDER BY posting_year, posting_month
        """,
        values,
        as_dict=True,
    )

    result = _empty_forecast_actuals()
    month_sections = {}
    month_adjustments = {}

    for row in rows:
        account = str(row.group_account or "").strip()
        month_key = f"{int(row.posting_year):04d}_{int(row.posting_month):02d}"
        amount = flt(row.amount)

        if account:
            result["by_account"][account] = result["by_account"].get(account, 0.0) + amount
            result["by_account_month"].setdefault(account, {})[month_key] = (
                result["by_account_month"].setdefault(account, {}).get(month_key, 0.0) + amount
            )

        if row.report_dimension in result["section_totals"]:
            result["section_totals"][row.report_dimension] += amount
            monthly_bucket = result["section_month_totals"][row.report_dimension]
            monthly_bucket[month_key] = monthly_bucket.get(month_key, 0.0) + amount

        sections = month_sections.setdefault(
            month_key, {dimension: 0.0 for dimension in IS_DIMENSIONS}
        )
        if row.report_dimension in sections:
            sections[row.report_dimension] += amount

        adj = month_adjustments.setdefault(
            month_key, {"interest_paid": 0.0, "depreciation": 0.0, "interest_received": 0.0}
        )
        adj["interest_paid"] += flt(row.interest_paid)
        adj["depreciation"] += flt(row.depreciation)
        adj["interest_received"] += flt(row.interest_received)

    # Build monthly actual summary.
    current = date(from_date.year, from_date.month, 1)
    end_month = date(to_date.year, to_date.month, 1)
    while current <= end_month:
        key = current.strftime("%Y_%m")
        sections = month_sections.get(key, {dimension: 0.0 for dimension in IS_DIMENSIONS})
        adj = month_adjustments.get(
            key, {"interest_paid": 0.0, "depreciation": 0.0, "interest_received": 0.0}
        )
        profit = (
            sections["IS-Revenue"] + sections["IS-Other Income"]
            - sections["IS-Cost of Sales"] - sections["IS-Other Expenditure"]
        )
        row = {
            "key": key,
            "label": current.strftime("%b %Y"),
            "revenue": sections["IS-Revenue"],
            "other_income": sections["IS-Other Income"],
            "cost_of_sales": sections["IS-Cost of Sales"],
            "other_expenditure": sections["IS-Other Expenditure"],
            "total_costs": sections["IS-Cost of Sales"] + sections["IS-Other Expenditure"],
            "profit_loss": profit,
            "interest_paid": adj["interest_paid"],
            "depreciation": adj["depreciation"],
            "interest_received": adj["interest_received"],
            "ebitda": profit + adj["interest_paid"] + adj["depreciation"] - adj["interest_received"],
        }
        result["monthly"].append(row)
        result["monthly_map"][key] = row
        current = _next_month(current)

    sections = result["section_totals"]
    profit = (
        sections["IS-Revenue"] + sections["IS-Other Income"]
        - sections["IS-Cost of Sales"] - sections["IS-Other Expenditure"]
    )
    total_adj = {
        "interest_paid": sum(v["interest_paid"] for v in month_adjustments.values()),
        "depreciation": sum(v["depreciation"] for v in month_adjustments.values()),
        "interest_received": sum(v["interest_received"] for v in month_adjustments.values()),
    }
    result["summary"] = {
        "revenue": sections["IS-Revenue"],
        "other_income": sections["IS-Other Income"],
        "cost_of_sales": sections["IS-Cost of Sales"],
        "other_expenditure": sections["IS-Other Expenditure"],
        "profit_loss": profit,
        **total_adj,
        "ebitda": profit + total_adj["interest_paid"] + total_adj["depreciation"] - total_adj["interest_received"],
    }
    return result


def _get_expense_actual_average_data(scenario, source_cost_center):
    source_cost_center = (source_cost_center or ALL_FORECAST_COST_CENTRES).strip()
    branch_sql, branch_values, source_info = _forecast_actual_branch_condition(
        scenario.company, source_cost_center
    )
    anchor = _forecast_actual_cutoff(scenario)
    anchor_month = date(anchor.year, anchor.month, 1)
    start_month = getdate(add_months(anchor_month, -2))
    average_from = date(start_month.year, start_month.month, 1)
    average_to = anchor

    signed = _signed_amount_sql()
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


def _build_forecast_grid(accounts, entries, months, actuals=None):
    """Build forecast-only and blended Actual + Forecast financial-year views."""
    month_keys = [m["key"] for m in months]
    actuals = actuals or _empty_forecast_actuals()
    actual_by_account = actuals.get("by_account", {})
    actual_by_account_month = actuals.get("by_account_month", {})
    actual_monthly_map = actuals.get("monthly_map", {})

    entry_map = {}
    for row in entries:
        period = getdate(row.forecast_period)
        key = (row.account, period.strftime("%Y_%m"))
        entry_map[key] = row

    sections_map = {
        dimension: {
            "report_dimension": dimension,
            "label": DIMENSION_LABELS[dimension],
            "lines": [],
            "month_totals": {key: 0.0 for key in month_keys},
            "actual_month_totals": {key: 0.0 for key in month_keys},
            "fy_month_totals": {key: 0.0 for key in month_keys},
            "total": 0.0,
            "fy_total": 0.0,
        }
        for dimension in IS_DIMENSIONS
    }

    adjustments = {
        key: {"interest_paid": 0.0, "depreciation": 0.0, "interest_received": 0.0}
        for key in month_keys
    }

    for account in accounts:
        dimension = account.report_dimension
        if dimension not in sections_map:
            continue

        account_number = str(account.account_number)
        line = {
            "account": account.account,
            "account_number": account.account_number,
            "account_name": _clean_account_name(account.account_name),
            "report_dimension": dimension,
            "forecast_method": account.forecast_method or "Amount",
            "default_forecast_uom": account.default_forecast_uom or "",
            "ebitda_treatment": account.ebitda_treatment or "Normal",
            "account_type_description": account.account_type_description or "",
            "actual_amount": float(actual_by_account.get(account_number, 0) or 0),
            "months": {},
            "total": 0.0,
            "fy_total": 0.0,
        }

        for month in months:
            row = entry_map.get((account.account, month["key"]))
            actual_amount = float(
                actual_by_account_month.get(account_number, {}).get(month["key"], 0) or 0
            )
            forecast_amount = float(row.forecast_amount or 0) if row else 0.0
            display_amount = actual_amount if month.get("display_mode") == "actual" else (
                forecast_amount if month.get("display_mode") == "forecast" else 0.0
            )
            cell = {
                "entry_name": row.name if row else None,
                "forecast_period": month["period"],
                "available": bool(month["available"]),
                "display_mode": month.get("display_mode"),
                "actual_amount": actual_amount,
                "volume": float(row.volume or 0) if row else 0.0,
                "volume_uom": (row.volume_uom or account.default_forecast_uom or "") if row else (account.default_forecast_uom or ""),
                "price_per_unit": float(row.price_per_unit or 0) if row else 0.0,
                "forecast_amount": forecast_amount,
                "display_amount": display_amount,
                "comments": row.comments or "" if row else "",
            }
            line["months"][month["key"]] = cell
            line["total"] += forecast_amount
            line["fy_total"] += display_amount
            sections_map[dimension]["month_totals"][month["key"]] += forecast_amount
            sections_map[dimension]["actual_month_totals"][month["key"]] += actual_amount
            sections_map[dimension]["fy_month_totals"][month["key"]] += display_amount

            treatment = (line["ebitda_treatment"] or "Normal").strip().lower()
            if treatment == "depreciation":
                adjustments[month["key"]]["depreciation"] += forecast_amount
            elif treatment == "interest paid":
                adjustments[month["key"]]["interest_paid"] += forecast_amount
            elif treatment == "interest received":
                adjustments[month["key"]]["interest_received"] += forecast_amount

        sections_map[dimension]["total"] += line["total"]
        sections_map[dimension]["fy_total"] += line["fy_total"]
        sections_map[dimension]["lines"].append(line)

    sections = [sections_map[d] for d in IS_DIMENSIONS]
    monthly = []
    fy_monthly = []
    period_adjustments = {"interest_paid": 0.0, "depreciation": 0.0, "interest_received": 0.0}

    for month in months:
        key = month["key"]
        revenue = sections_map["IS-Revenue"]["month_totals"][key]
        other_income = sections_map["IS-Other Income"]["month_totals"][key]
        cost_of_sales = sections_map["IS-Cost of Sales"]["month_totals"][key]
        other_expenditure = sections_map["IS-Other Expenditure"]["month_totals"][key]
        profit_loss = revenue + other_income - cost_of_sales - other_expenditure
        adj = adjustments[key]
        ebitda = profit_loss + adj["interest_paid"] + adj["depreciation"] - adj["interest_received"]

        for bucket in period_adjustments:
            period_adjustments[bucket] += adj[bucket]

        monthly.append({
            "key": key, "label": month["label"],
            "revenue": revenue, "other_income": other_income,
            "cost_of_sales": cost_of_sales, "other_expenditure": other_expenditure,
            "total_costs": cost_of_sales + other_expenditure,
            "profit_loss": profit_loss,
            "interest_paid": adj["interest_paid"], "depreciation": adj["depreciation"],
            "interest_received": adj["interest_received"], "ebitda": ebitda,
        })

        if month.get("display_mode") == "actual":
            actual_row = actual_monthly_map.get(key, {})
            fy_row = {
                "key": key, "label": month["label"], "mode": "Actual",
                "revenue": flt(actual_row.get("revenue")),
                "other_income": flt(actual_row.get("other_income")),
                "cost_of_sales": flt(actual_row.get("cost_of_sales")),
                "other_expenditure": flt(actual_row.get("other_expenditure")),
                "total_costs": flt(actual_row.get("total_costs")),
                "profit_loss": flt(actual_row.get("profit_loss")),
                "interest_paid": flt(actual_row.get("interest_paid")),
                "depreciation": flt(actual_row.get("depreciation")),
                "interest_received": flt(actual_row.get("interest_received")),
                "ebitda": flt(actual_row.get("ebitda")),
            }
        elif month.get("display_mode") == "forecast":
            fy_row = {**monthly[-1], "mode": "Forecast"}
        else:
            fy_row = {
                "key": key, "label": month["label"], "mode": "None",
                "revenue": 0.0, "other_income": 0.0, "cost_of_sales": 0.0,
                "other_expenditure": 0.0, "total_costs": 0.0, "profit_loss": 0.0,
                "interest_paid": 0.0, "depreciation": 0.0, "interest_received": 0.0, "ebitda": 0.0,
            }
        fy_monthly.append(fy_row)

    totals = {dimension: sections_map[dimension]["total"] for dimension in IS_DIMENSIONS}
    profit_loss = totals["IS-Revenue"] + totals["IS-Other Income"] - totals["IS-Cost of Sales"] - totals["IS-Other Expenditure"]
    ebitda = profit_loss + period_adjustments["interest_paid"] + period_adjustments["depreciation"] - period_adjustments["interest_received"]
    summary = {
        "revenue": totals["IS-Revenue"], "other_income": totals["IS-Other Income"],
        "cost_of_sales": totals["IS-Cost of Sales"], "other_expenditure": totals["IS-Other Expenditure"],
        "profit_loss": profit_loss, "interest_paid": period_adjustments["interest_paid"],
        "depreciation": period_adjustments["depreciation"], "interest_received": period_adjustments["interest_received"],
        "ebitda": ebitda,
    }

    fy_summary = {
        "revenue": sum(r["revenue"] for r in fy_monthly),
        "other_income": sum(r["other_income"] for r in fy_monthly),
        "cost_of_sales": sum(r["cost_of_sales"] for r in fy_monthly),
        "other_expenditure": sum(r["other_expenditure"] for r in fy_monthly),
        "profit_loss": sum(r["profit_loss"] for r in fy_monthly),
        "interest_paid": sum(r["interest_paid"] for r in fy_monthly),
        "depreciation": sum(r["depreciation"] for r in fy_monthly),
        "interest_received": sum(r["interest_received"] for r in fy_monthly),
        "ebitda": sum(r["ebitda"] for r in fy_monthly),
    }

    return sections, summary, monthly, fy_summary, fy_monthly


def _get_dashboard_aggregate(from_date, to_date, cost_centre):
    """Single aggregate query used by the initial dashboard run."""
    cost_filter_sql, values = _cost_centre_condition(cost_centre)
    values.update(
        {
            "from_date": from_date,
            "to_date": to_date,
            "dimensions": tuple(IS_DIMENSIONS),
        }
    )

    signed = _signed_amount_sql()

    return frappe.db.sql(
        f"""
        SELECT
            LEFT(TRIM(COALESCE(p.master_sub_account, '')), 4) AS group_account,
            p.iaccounttype AS account_type,
            a.sage_accounttype_decsription AS account_type_description,
            a.report_dimension,
            a.sort_order,
            MAX(NULLIF(TRIM(COALESCE(p.sage_account_description, '')), '')) AS group_description,
            YEAR(p.tx_date) AS posting_year,
            MONTH(p.tx_date) AS posting_month,
            SUM({signed}) AS amount,
            SUM(
                CASE
                    WHEN LOWER(COALESCE(p.sage_account_description, '')) LIKE '%%depreciat%%'
                    THEN {signed}
                    ELSE 0
                END
            ) AS depreciation,
            SUM(
                CASE
                    WHEN LOWER(COALESCE(p.sage_account_description, '')) LIKE '%%interest%%'
                     AND a.report_dimension IN ('IS-Cost of Sales', 'IS-Other Expenditure')
                    THEN {signed}
                    ELSE 0
                END
            ) AS interest_paid,
            SUM(
                CASE
                    WHEN LOWER(COALESCE(p.sage_account_description, '')) LIKE '%%interest%%'
                     AND a.report_dimension IN ('IS-Revenue', 'IS-Other Income')
                    THEN {signed}
                    ELSE 0
                END
            ) AS interest_received
        FROM `tabSage POSTGL Entry` p
        INNER JOIN `tabSageAccountType` a
            ON a.sage_account_type = p.iaccounttype
        WHERE
            a.report_dimension IN %(dimensions)s
            AND p.tx_date >= %(from_date)s
            AND p.tx_date < DATE_ADD(%(to_date)s, INTERVAL 1 DAY)
            AND p.master_sub_account IS NOT NULL
            AND p.master_sub_account <> ''
            {cost_filter_sql}
        GROUP BY
            LEFT(TRIM(COALESCE(p.master_sub_account, '')), 4),
            p.iaccounttype,
            a.sage_accounttype_decsription,
            a.report_dimension,
            a.sort_order,
            YEAR(p.tx_date),
            MONTH(p.tx_date)
        ORDER BY
            CASE a.report_dimension
                WHEN 'IS-Revenue' THEN 1
                WHEN 'IS-Other Income' THEN 2
                WHEN 'IS-Cost of Sales' THEN 3
                WHEN 'IS-Other Expenditure' THEN 4
                ELSE 99
            END,
            COALESCE(a.sort_order, 0),
            group_account,
            p.iaccounttype,
            posting_year,
            posting_month
        """,
        values,
        as_dict=True,
    )


def _build_dashboard_from_aggregate(rows, months):
    """Build tree rows, monthly graph data, P/L and EBITDA from one SQL result."""
    month_keys = [m["key"] for m in months]
    line_map = {}
    dimension_months = {
        d: {key: 0.0 for key in month_keys}
        for d in IS_DIMENSIONS
    }
    adjustments_monthly = {
        key: {"interest_paid": 0.0, "depreciation": 0.0, "interest_received": 0.0}
        for key in month_keys
    }

    for row in rows:
        group_account = str(row.group_account or "").strip()
        if len(group_account) != 4 or not group_account.isdigit():
            continue

        month_key = f"{int(row.posting_year):04d}_{int(row.posting_month):02d}"
        if month_key not in month_keys:
            continue

        dimension = row.report_dimension
        amount = float(row.amount or 0)
        dimension_months[dimension][month_key] += amount

        adjustments_monthly[month_key]["interest_paid"] += float(row.interest_paid or 0)
        adjustments_monthly[month_key]["depreciation"] += float(row.depreciation or 0)
        adjustments_monthly[month_key]["interest_received"] += float(row.interest_received or 0)

        key = (dimension, group_account, int(row.account_type))
        if key not in line_map:
            line_map[key] = {
                "group_account": group_account,
                "account_type": int(row.account_type),
                "account_type_description": _clean_account_name(row.account_type_description),
                "report_dimension": dimension,
                "sort_order": int(row.sort_order or 0),
                "group_description": _clean_account_name(
                    row.group_description or row.account_type_description or _("Unlabelled account")
                ),
                "months": {mk: 0.0 for mk in month_keys},
                "amount": 0.0,
            }

        line_map[key]["months"][month_key] += amount
        line_map[key]["amount"] += amount

    sections = []
    totals = {dimension: 0.0 for dimension in IS_DIMENSIONS}

    for dimension in IS_DIMENSIONS:
        lines = [v for v in line_map.values() if v["report_dimension"] == dimension]
        lines.sort(key=lambda x: (x["sort_order"], x["group_account"], x["account_type"]))
        total = sum(line["amount"] for line in lines)
        totals[dimension] = total

        sections.append(
            {
                "report_dimension": dimension,
                "label": DIMENSION_LABELS[dimension],
                "total": total,
                "month_totals": dimension_months[dimension],
                "lines": lines,
            }
        )

    monthly = []
    period_adjustments = {"interest_paid": 0.0, "depreciation": 0.0, "interest_received": 0.0}

    for month in months:
        key = month["key"]
        revenue = dimension_months["IS-Revenue"][key]
        other_income = dimension_months["IS-Other Income"][key]
        cost_of_sales = dimension_months["IS-Cost of Sales"][key]
        other_expenditure = dimension_months["IS-Other Expenditure"][key]
        profit_loss = revenue + other_income - cost_of_sales - other_expenditure
        adj = adjustments_monthly[key]
        ebitda = (
            profit_loss
            + adj["interest_paid"]
            + adj["depreciation"]
            - adj["interest_received"]
        )

        for bucket in period_adjustments:
            period_adjustments[bucket] += adj[bucket]

        monthly.append(
            {
                "key": key,
                "label": month["label"],
                "revenue": revenue,
                "other_income": other_income,
                "cost_of_sales": cost_of_sales,
                "other_expenditure": other_expenditure,
                "total_income": revenue + other_income,
                "total_costs": cost_of_sales + other_expenditure,
                "profit_loss": profit_loss,
                "interest_paid": adj["interest_paid"],
                "depreciation": adj["depreciation"],
                "interest_received": adj["interest_received"],
                "ebitda": ebitda,
            }
        )

    profit_loss = (
        totals["IS-Revenue"]
        + totals["IS-Other Income"]
        - totals["IS-Cost of Sales"]
        - totals["IS-Other Expenditure"]
    )
    ebitda = (
        profit_loss
        + period_adjustments["interest_paid"]
        + period_adjustments["depreciation"]
        - period_adjustments["interest_received"]
    )

    summary = {
        "revenue": totals["IS-Revenue"],
        "other_income": totals["IS-Other Income"],
        "cost_of_sales": totals["IS-Cost of Sales"],
        "other_expenditure": totals["IS-Other Expenditure"],
        "profit_loss": profit_loss,
        "interest_paid": period_adjustments["interest_paid"],
        "depreciation": period_adjustments["depreciation"],
        "interest_received": period_adjustments["interest_received"],
        "ebitda": ebitda,
    }

    return sections, summary, monthly


def _get_cost_centre_drilldown(from_date, to_date, group_account, account_type):
    return frappe.db.sql(
        f"""
        SELECT
            CASE
                WHEN p.brch IS NULL OR p.brch = '' OR TRIM(p.brch) = '' THEN %(head_office)s
                ELSE p.brch
            END AS cost_centre,
            YEAR(p.tx_date) AS posting_year,
            MONTH(p.tx_date) AS posting_month,
            COUNT(*) AS transaction_count,
            SUM({_signed_amount_sql()}) AS amount
        FROM `tabSage POSTGL Entry` p
        INNER JOIN `tabSageAccountType` a
            ON a.sage_account_type = p.iaccounttype
        WHERE
            p.iaccounttype = %(account_type)s
            AND p.master_sub_account LIKE %(group_account_pattern)s
            AND p.tx_date >= %(from_date)s
            AND p.tx_date < DATE_ADD(%(to_date)s, INTERVAL 1 DAY)
            AND a.report_dimension IN %(dimensions)s
        GROUP BY
            CASE
                WHEN p.brch IS NULL OR p.brch = '' OR TRIM(p.brch) = '' THEN %(head_office)s
                ELSE p.brch
            END,
            YEAR(p.tx_date),
            MONTH(p.tx_date)
        ORDER BY cost_centre, posting_year, posting_month
        """,
        {
            "from_date": from_date,
            "to_date": to_date,
            "group_account": group_account,
            "group_account_pattern": group_account + "%",
            "account_type": account_type,
            "head_office": HEAD_OFFICE,
            "dimensions": tuple(IS_DIMENSIONS),
        },
        as_dict=True,
    )


def _get_sub_account_drilldown(from_date, to_date, group_account, account_type, cost_centre):
    cost_filter_sql, values = _cost_centre_condition(cost_centre)
    values.update(
        {
            "from_date": from_date,
            "to_date": to_date,
            "group_account": group_account,
            "group_account_pattern": group_account + "%",
            "account_type": account_type,
            "dimensions": tuple(IS_DIMENSIONS),
        }
    )

    return frappe.db.sql(
        f"""
        SELECT
            p.master_sub_account,
            MAX(NULLIF(TRIM(COALESCE(p.sage_account_description, '')), '')) AS description,
            YEAR(p.tx_date) AS posting_year,
            MONTH(p.tx_date) AS posting_month,
            COUNT(*) AS transaction_count,
            SUM({_signed_amount_sql()}) AS amount
        FROM `tabSage POSTGL Entry` p
        INNER JOIN `tabSageAccountType` a
            ON a.sage_account_type = p.iaccounttype
        WHERE
            p.iaccounttype = %(account_type)s
            AND p.master_sub_account LIKE %(group_account_pattern)s
            AND p.tx_date >= %(from_date)s
            AND p.tx_date < DATE_ADD(%(to_date)s, INTERVAL 1 DAY)
            AND a.report_dimension IN %(dimensions)s
            {cost_filter_sql}
        GROUP BY p.master_sub_account, YEAR(p.tx_date), MONTH(p.tx_date)
        ORDER BY p.master_sub_account, posting_year, posting_month
        """,
        values,
        as_dict=True,
    )


def _pivot_drilldown(raw_rows, months, identity_field, clean_descriptions=False):
    month_keys = [m["key"] for m in months]
    result = {}

    for row in raw_rows:
        identity = str(row.get(identity_field) or "").strip()
        if identity not in result:
            result[identity] = {
                identity_field: identity,
                "description": _clean_account_name(row.get("description")) if clean_descriptions else row.get("description"),
                "transaction_count": 0,
                "amount": 0.0,
                "months": {key: 0.0 for key in month_keys},
            }

        month_key = f"{int(row.posting_year):04d}_{int(row.posting_month):02d}"
        amount = float(row.amount or 0)
        result[identity]["transaction_count"] += int(row.transaction_count or 0)
        result[identity]["amount"] += amount
        if month_key in result[identity]["months"]:
            result[identity]["months"][month_key] += amount

    return list(result.values())



def _month_bounds(month_key):
    """Convert YYYY_MM into first/last calendar date and a display label."""
    try:
        year_text, month_text = str(month_key).split("_", 1)
        year = int(year_text)
        month = int(month_text)
        start = date(year, month, 1)
    except (TypeError, ValueError):
        frappe.throw(_("Invalid month selection."))

    next_start = _next_month(start)
    end = date.fromordinal(next_start.toordinal() - 1)
    return start, end, start.strftime("%b %Y")


def _get_months(from_date, to_date):
    months = []
    current = date(from_date.year, from_date.month, 1)
    end = date(to_date.year, to_date.month, 1)
    while current <= end:
        months.append(
            {
                "key": current.strftime("%Y_%m"),
                "label": current.strftime("%b %Y"),
                "year": current.year,
                "month": current.month,
            }
        )
        current = _next_month(current)
    return months


def _clean_account_name(value):
    """Remove trailing branch suffix such as ' - MID' from display names."""
    text = (value or "").strip()
    return re.sub(r"\s+-\s+[A-Z0-9]{2,5}\s*$", "", text).strip()


def _signed_amount_sql():
    return """
        CASE
            WHEN a.report_dimension IN ('IS-Revenue', 'IS-Other Income')
                THEN COALESCE(p.credit, 0) - COALESCE(p.debit, 0)
            ELSE COALESCE(p.debit, 0) - COALESCE(p.credit, 0)
        END
    """


def _cost_centre_condition(cost_centre):
    if cost_centre == ALL_COST_CENTRES:
        return "", {}
    if cost_centre == HEAD_OFFICE:
        return "AND (p.brch IS NULL OR p.brch = '' OR TRIM(p.brch) = '')", {}

    # Deliberately do not wrap p.brch in TRIM/COALESCE for normal sites.
    # Direct equality lets MariaDB use an index beginning with brch.
    return "AND p.brch = %(cost_centre)s", {"cost_centre": cost_centre}


def _normalise_cost_centre(cost_centre):
    cost_centre = (cost_centre or ALL_COST_CENTRES).strip()
    return cost_centre or ALL_COST_CENTRES


def _validate_dates(from_date, to_date):
    if not from_date:
        frappe.throw(_("From Date is required."))
    if not to_date:
        frappe.throw(_("To Date is required."))
    from_date = getdate(from_date)
    to_date = getdate(to_date)
    if from_date > to_date:
        frappe.throw(_("From Date cannot be after To Date."))
    return from_date, to_date


def _next_month(current):
    if current.month == 12:
        return date(current.year + 1, 1, 1)
    return date(current.year, current.month + 1, 1)


def _financial_year_label(start_year):
    return f"FY {start_year}/{str(start_year + 1)[-2:]}"


def _financial_year_label_for_period(from_date, to_date):
    a = from_date.year if from_date.month >= 3 else from_date.year - 1
    b = to_date.year if to_date.month >= 3 else to_date.year - 1
    return _financial_year_label(a) if a == b else _("Multiple Financial Years")


def _is_leap_year(year):
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)

# Copyright (c) 2026, Isambane Mining and contributors
# For license information, please see license.txt

from datetime import date
import re
import time

import frappe
from frappe import _
from frappe.utils import getdate, nowdate


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


@frappe.whitelist()
def get_financial_years():
    """Return available March-to-February financial years for the dashboard."""
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

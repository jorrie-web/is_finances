from datetime import date
import time

import frappe
from frappe import _
from frappe.utils import add_months, cint, flt, getdate

from . import is_fin_dashboard as dashboard
from .forecast_actual_months import AUTO_ACTUAL_MONTHS, _actual_cutoff_for_selection


def _average_window(fy_start, cutoff):
    """Return up to the last 3 actual months, never crossing before the selected FY.

    Examples for a March FY start:
    - Mar actual only      -> Mar / 1
    - Mar-Apr actual       -> Mar-Apr / 2
    - Mar-May actual       -> Mar-May / 3
    - Mar-Jun actual       -> Apr-Jun / 3
    """
    if cutoff < fy_start:
        frappe.throw(_("At least 1 Actual Month is required to calculate the expense average."))

    anchor_month = date(cutoff.year, cutoff.month, 1)
    three_month_start = getdate(add_months(anchor_month, -2))
    average_from = max(fy_start, date(three_month_start.year, three_month_start.month, 1))
    average_to = cutoff
    month_count = ((anchor_month.year - average_from.year) * 12) + (anchor_month.month - average_from.month) + 1
    month_count = max(1, min(3, month_count))
    return average_from, average_to, month_count


def _average_label(month_count):
    return _("{0}M actual average").format(month_count)


def _actual_average_for_cutoff(scenario, source_cost_center, cutoff, fy_start):
    source_cost_center = (source_cost_center or dashboard.ALL_FORECAST_COST_CENTRES).strip()
    branch_sql, branch_values, source_info = dashboard._forecast_actual_branch_condition(
        scenario.company, source_cost_center
    )

    average_from, average_to, month_count = _average_window(fy_start, cutoff)
    signed = dashboard._signed_amount_sql()
    values = {
        "company": scenario.company,
        "from_date": average_from,
        "to_date": average_to,
        "month_count": month_count,
        **branch_values,
    }
    rows = frappe.db.sql(
        f"""
        SELECT
            LEFT(TRIM(COALESCE(p.master_sub_account, '')), 4) AS group_account,
            SUM({signed}) / %(month_count)s AS average_amount
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
        "month_count": month_count,
        "average_label": _average_label(month_count),
        "period_label": f"{average_from.strftime('%d %b %Y')} - {average_to.strftime('%d %b %Y')}",
        "averages": {
            str(row.group_account): flt(row.average_amount, 2)
            for row in rows if row.group_account
        },
    }


def _forecast_window(scenario, financial_year, actual_months):
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
    last_forecast_month = min(scenario_end, date(fy_end.year, fy_end.month, 1))

    periods = []
    current = first_forecast_month
    while current <= last_forecast_month:
        periods.append(current)
        current = dashboard._next_month(current)

    return fy_start, fy_end, actual_cutoff, first_forecast_month, last_forecast_month, periods


def _expense_accounts(company):
    return [
        row for row in dashboard._get_forecast_accounts(company)
        if row.report_dimension in ("IS-Cost of Sales", "IS-Other Expenditure")
        and (row.forecast_method or "Amount").strip().lower() == "amount"
    ]


def _bulk_cost_centers(company, targets):
    targets = [str(value).strip() for value in (targets or []) if str(value).strip()]
    if not targets:
        return []

    placeholders = ",".join(["%s"] * len(targets))
    rows = frappe.db.sql(
        f"""
        SELECT name, cost_center_name, cost_center_number
        FROM `tabCost Center`
        WHERE name IN ({placeholders})
          AND company = %s
          AND COALESCE(is_group, 0) = 0
          AND COALESCE(disabled, 0) = 0
        """,
        tuple(targets) + (company,),
        as_dict=True,
    )
    by_name = {row.name: row for row in rows}
    missing = [name for name in targets if name not in by_name]
    if missing:
        frappe.throw(_("Invalid Forecast Cost Center(s): {0}").format(", ".join(missing)))
    for row in rows:
        if not (row.cost_center_number or "").strip():
            frappe.throw(_("Cost Center {0} does not have a Cost Center Number.").format(row.name))
    return [by_name[name] for name in targets]


def _bulk_own_site_averages(scenario, cost_centers, cutoff, fy_start):
    """Read all selected sites' available actual-month expense averages in one query."""
    if not cost_centers:
        return {}, "", 0

    average_from, average_to, month_count = _average_window(fy_start, cutoff)
    branches = [(row.cost_center_number or "").strip() for row in cost_centers]
    branch_placeholders = ",".join(["%s"] * len(branches))
    signed = dashboard._signed_amount_sql()

    rows = frappe.db.sql(
        f"""
        SELECT
            CASE
                WHEN p.brch IS NULL OR TRIM(p.brch) = '' THEN 'MID'
                ELSE TRIM(p.brch)
            END AS branch_key,
            LEFT(TRIM(COALESCE(p.master_sub_account, '')), 4) AS group_account,
            SUM({signed}) / %s AS average_amount
        FROM `tabSage POSTGL Entry` p
        INNER JOIN `tabSageAccountType` a
            ON a.sage_account_type = p.iaccounttype
        WHERE p.company = %s
          AND p.tx_date >= %s
          AND p.tx_date < DATE_ADD(%s, INTERVAL 1 DAY)
          AND a.report_dimension IN ('IS-Cost of Sales', 'IS-Other Expenditure')
          AND TRIM(COALESCE(p.master_sub_account, '')) REGEXP '^[0-9]{{4}}'
          AND (
                TRIM(COALESCE(p.brch, '')) IN ({branch_placeholders})
                OR ('MID' IN ({branch_placeholders}) AND (p.brch IS NULL OR TRIM(p.brch) = ''))
              )
        GROUP BY
            CASE WHEN p.brch IS NULL OR TRIM(p.brch) = '' THEN 'MID' ELSE TRIM(p.brch) END,
            LEFT(TRIM(COALESCE(p.master_sub_account, '')), 4)
        """,
        tuple([month_count, scenario.company, average_from, average_to] + branches + branches),
        as_dict=True,
    )

    averages = {}
    for row in rows:
        averages.setdefault(str(row.branch_key), {})[str(row.group_account)] = flt(row.average_amount, 2)

    period_label = f"{average_from.strftime('%d %b %Y')} - {average_to.strftime('%d %b %Y')}"
    return averages, period_label, month_count


def _insert_forecast_rows(rows):
    if not rows:
        return 0

    fields = [
        "name", "creation", "modified", "modified_by", "owner", "docstatus", "idx",
        "forecast_scenario", "company", "forecast_period", "financial_year", "cost_center",
        "account", "account_number", "account_name", "sage_account_type",
        "custom_report_dimension", "custom_forecast_enabled", "forecast_method",
        "ebitda_treatment", "volume", "volume_uom", "price_per_unit", "forecast_amount",
        "cost_center_number", "input_source", "comments",
    ]
    row_placeholder = "(" + ",".join(["%s"] * len(fields)) + ")"
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
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
    return len(rows)


@frappe.whitelist()
def bulk_seed_expense_forecast_from_actual_average(
    forecast_scenario,
    target_cost_centers,
    source_cost_center,
    financial_year,
    actual_months=AUTO_ACTUAL_MONTHS,
):
    """High-performance expense fill using up to the last 3 selected actual months."""
    started = time.perf_counter()
    scenario = dashboard._get_forecast_scenario(forecast_scenario)
    if scenario.status != "Draft":
        frappe.throw(_("Only Draft Forecast Scenarios can be seeded."))
    if not cint(scenario.is_active):
        frappe.throw(_("Forecast Scenario is not active."))

    if isinstance(target_cost_centers, str):
        try:
            target_cost_centers = frappe.parse_json(target_cost_centers)
        except Exception:
            target_cost_centers = [target_cost_centers]
    target_cost_centers = target_cost_centers or []
    cost_centers = _bulk_cost_centers(scenario.company, target_cost_centers)

    fy_start, fy_end_unused, actual_cutoff, first_forecast_month, last_forecast_month, periods = _forecast_window(
        scenario, financial_year, actual_months
    )
    if not periods:
        return {
            "created": 0, "updated": 0, "deleted": 0,
            "account_count": 0, "month_count": 0, "cost_center_count": len(cost_centers),
            "runtime_ms": round((time.perf_counter() - started) * 1000, 1),
        }

    if actual_cutoff < fy_start:
        frappe.throw(_("Select at least 1 Actual Month before using Fill Expenses from Actual Average."))

    expense_accounts = _expense_accounts(scenario.company)
    if not expense_accounts:
        return {
            "created": 0, "updated": 0, "deleted": 0,
            "account_count": 0, "month_count": len(periods), "cost_center_count": len(cost_centers),
            "runtime_ms": round((time.perf_counter() - started) * 1000, 1),
        }

    source_cost_center = (source_cost_center or dashboard.ALL_FORECAST_COST_CENTRES).strip()
    own_site_mode = source_cost_center == dashboard.ALL_FORECAST_COST_CENTRES
    if own_site_mode:
        averages_by_branch, period_label, average_month_count = _bulk_own_site_averages(
            scenario, cost_centers, actual_cutoff, fy_start
        )
        shared_averages = None
        source_label = _("Each Cost Centre")
    else:
        payload = _actual_average_for_cutoff(scenario, source_cost_center, actual_cutoff, fy_start)
        shared_averages = payload["averages"]
        averages_by_branch = None
        period_label = payload["period_label"]
        average_month_count = payload["month_count"]
        source_label = payload["source_label"]

    target_names = [row.name for row in cost_centers]
    account_names = [row.account for row in expense_accounts]
    target_ph = ",".join(["%s"] * len(target_names))
    account_ph = ",".join(["%s"] * len(account_names))

    existing_count = frappe.db.sql(
        f"""
        SELECT COUNT(*)
        FROM `tabIS Forecast Entry`
        WHERE forecast_scenario = %s
          AND cost_center IN ({target_ph})
          AND account IN ({account_ph})
          AND forecast_period >= %s
          AND forecast_period <= %s
        """,
        tuple([scenario.name] + target_names + account_names + [first_forecast_month, last_forecast_month]),
    )[0][0]

    frappe.db.sql(
        f"""
        DELETE FROM `tabIS Forecast Entry`
        WHERE forecast_scenario = %s
          AND cost_center IN ({target_ph})
          AND account IN ({account_ph})
          AND forecast_period >= %s
          AND forecast_period <= %s
        """,
        tuple([scenario.name] + target_names + account_names + [first_forecast_month, last_forecast_month]),
    )

    user = frappe.session.user
    now = frappe.utils.now_datetime()
    new_rows = []
    input_source = f"Last {average_month_count}M Actual Avg"
    average_label = _average_label(average_month_count)

    for cc in cost_centers:
        branch = (cc.cost_center_number or "").strip()
        averages = averages_by_branch.get(branch, {}) if own_site_mode else shared_averages
        note = _("Seeded from {0} {1}: {2}").format(
            f"{branch} - {cc.cost_center_name or cc.name}" if own_site_mode else source_label,
            average_label,
            period_label,
        )
        for account in expense_accounts:
            average = flt((averages or {}).get(str(account.account_number), 0), 2)
            if not average:
                continue
            for period in periods:
                fy_start_year = period.year if period.month >= 3 else period.year - 1
                new_rows.append((
                    frappe.generate_hash(length=10), now, now, user, user, 0, 0,
                    scenario.name, scenario.company, period,
                    dashboard._financial_year_label(fy_start_year), cc.name,
                    account.account, account.account_number, account.account_name,
                    account.sage_account_type or "", account.report_dimension,
                    1, account.forecast_method or "Amount", account.ebitda_treatment or "Normal",
                    0, account.default_forecast_uom or "", 0, average,
                    branch, input_source, note,
                ))

    created = _insert_forecast_rows(new_rows)
    frappe.db.commit()
    return {
        "created": created,
        "updated": 0,
        "deleted": cint(existing_count),
        "account_count": len(expense_accounts),
        "month_count": len(periods),
        "cost_center_count": len(cost_centers),
        "average_month_count": average_month_count,
        "average_label": average_label,
        "source_label": source_label,
        "period_label": period_label,
        "runtime_ms": round((time.perf_counter() - started) * 1000, 1),
    }


@frappe.whitelist()
def seed_expense_forecast_from_actual_average(
    forecast_scenario,
    target_cost_center,
    source_cost_center,
    financial_year,
    actual_months=AUTO_ACTUAL_MONTHS,
):
    """Backward-compatible single-site wrapper around the bulk implementation."""
    return bulk_seed_expense_forecast_from_actual_average(
        forecast_scenario=forecast_scenario,
        target_cost_centers=[target_cost_center],
        source_cost_center=source_cost_center,
        financial_year=financial_year,
        actual_months=actual_months,
    )
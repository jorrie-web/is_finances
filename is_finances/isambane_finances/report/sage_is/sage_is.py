# Copyright (c) 2026, Isambane Mining and contributors
# For license information, please see license.txt

from datetime import date

import frappe
from frappe import _
from frappe.utils import getdate


IS_DIMENSIONS = [
    "IS-Revenue",
    "IS-Other Income",
    "IS-Cost of Sales",
    "IS-Other Expenditure",
]

DIMENSION_ORDER = {
    "IS-Revenue": 1,
    "IS-Other Income": 2,
    "IS-Cost of Sales": 3,
    "IS-Other Expenditure": 4,
}


def execute(filters=None):
    filters = frappe._dict(filters or {})

    validate_filters(filters)

    show_budget = (filters.get("show_budget") or "Yes") == "Yes"

    months = get_months(
        filters.from_date,
        filters.to_date
    )

    columns = get_columns(months, show_budget)

    account_types = get_account_types()

    actual_data = get_actual_data(
        filters.from_date,
        filters.to_date
    )

    budget_data = {}

    if show_budget:
        budget_data = get_budget_data(months)

    data = build_report_data(
        account_types=account_types,
        months=months,
        actual_data=actual_data,
        budget_data=budget_data,
        show_budget=show_budget,
    )

    return columns, data


def validate_filters(filters):
    if not filters.get("from_date"):
        frappe.throw(_("From Date is required."))

    if not filters.get("to_date"):
        frappe.throw(_("To Date is required."))

    from_date = getdate(filters.from_date)
    to_date = getdate(filters.to_date)

    if from_date > to_date:
        frappe.throw(_("From Date cannot be after To Date."))


def get_columns(months, show_budget):
    columns = [
        {
            "label": _("Account Type"),
            "fieldname": "account_type",
            "fieldtype": "Int",
            "width": 100,
        },
        {
            "label": _("Description"),
            "fieldname": "description",
            "fieldtype": "Data",
            "width": 220,
        },
        {
            "label": _("Income Statement Section"),
            "fieldname": "report_dimension",
            "fieldtype": "Data",
            "width": 170,
        },
    ]

    for month in months:
        month_key = month["key"]
        month_label = month["label"]

        columns.append(
            {
                "label": _("{0} Actual").format(month_label),
                "fieldname": f"{month_key}_actual",
                "fieldtype": "Currency",
                "width": 130,
            }
        )

        if show_budget:
            columns.append(
                {
                    "label": _("{0} Budget").format(month_label),
                    "fieldname": f"{month_key}_budget",
                    "fieldtype": "Currency",
                    "width": 130,
                }
            )

            columns.append(
                {
                    "label": _("{0} Variance").format(month_label),
                    "fieldname": f"{month_key}_variance",
                    "fieldtype": "Currency",
                    "width": 130,
                }
            )

    return columns


def get_account_types():
    rows = frappe.db.sql(
        """
        SELECT
            sage_account_type,
            sage_accounttype_decsription,
            report_dimension,
            sort_order
        FROM `tabSageAccountType`
        WHERE report_dimension IN (
            'IS-Revenue',
            'IS-Other Income',
            'IS-Cost of Sales',
            'IS-Other Expenditure'
        )
        """,
        as_dict=True,
    )

    rows.sort(
        key=lambda row: (
            DIMENSION_ORDER.get(row.report_dimension, 999),
            row.sort_order or 0,
            row.sage_account_type or 0,
        )
    )

    return rows


def get_actual_data(from_date, to_date):
    rows = frappe.db.sql(
        """
        SELECT
            p.iaccounttype AS account_type,
            a.report_dimension,
            YEAR(p.tx_date) AS posting_year,
            MONTH(p.tx_date) AS posting_month,

            SUM(
                CASE
                    WHEN a.report_dimension IN (
                        'IS-Revenue',
                        'IS-Other Income'
                    )
                    THEN
                        COALESCE(p.credit, 0)
                        - COALESCE(p.debit, 0)

                    ELSE
                        COALESCE(p.debit, 0)
                        - COALESCE(p.credit, 0)
                END
            ) AS actual_amount

        FROM `tabSage POSTGL Entry` p

        INNER JOIN `tabSageAccountType` a
            ON a.sage_account_type = p.iaccounttype

        WHERE
            a.report_dimension IN (
                'IS-Revenue',
                'IS-Other Income',
                'IS-Cost of Sales',
                'IS-Other Expenditure'
            )

            AND p.tx_date >= %(from_date)s

            AND p.tx_date <
                DATE_ADD(%(to_date)s, INTERVAL 1 DAY)

        GROUP BY
            p.iaccounttype,
            a.report_dimension,
            YEAR(p.tx_date),
            MONTH(p.tx_date)
        """,
        {
            "from_date": from_date,
            "to_date": to_date,
        },
        as_dict=True,
    )

    result = {}

    for row in rows:
        key = (
            int(row.account_type),
            int(row.posting_year),
            int(row.posting_month),
        )

        result[key] = float(row.actual_amount or 0)

    return result


def get_budget_data(months):
    if not months:
        return {}

    budget_from = months[0]["date"]

    last_month = months[-1]["date"]
    budget_to = next_month(last_month)

    rows = frappe.db.sql(
        """
        SELECT
            b.sage_budget_iaccounttype AS account_type,
            a.report_dimension,
            YEAR(b.sage_budget_dperioddate) AS budget_year,
            MONTH(b.sage_budget_dperioddate) AS budget_month,
            SUM(COALESCE(b.sage_fbudget, 0)) AS budget_amount

        FROM `tabSage Budget Entry` b

        INNER JOIN `tabSageAccountType` a
            ON a.sage_account_type =
               b.sage_budget_iaccounttype

        WHERE
            a.report_dimension IN (
                'IS-Revenue',
                'IS-Other Income',
                'IS-Cost of Sales',
                'IS-Other Expenditure'
            )

            AND b.sage_budget_dperioddate >= %(budget_from)s
            AND b.sage_budget_dperioddate < %(budget_to)s

        GROUP BY
            b.sage_budget_iaccounttype,
            a.report_dimension,
            YEAR(b.sage_budget_dperioddate),
            MONTH(b.sage_budget_dperioddate)
        """,
        {
            "budget_from": budget_from,
            "budget_to": budget_to,
        },
        as_dict=True,
    )

    result = {}

    for row in rows:
        key = (
            int(row.account_type),
            int(row.budget_year),
            int(row.budget_month),
        )

        result[key] = abs(float(row.budget_amount or 0))

    return result


def build_report_data(
    account_types,
    months,
    actual_data,
    budget_data,
    show_budget,
):
    data = []

    profit_actual = {
        month["key"]: 0.0
        for month in months
    }

    profit_budget = {
        month["key"]: 0.0
        for month in months
    }

    for account in account_types:
        account_type = int(account.sage_account_type)

        row = {
            "account_type": account_type,
            "description":
                account.sage_accounttype_decsription,
            "report_dimension":
                account.report_dimension,
            "sort_order":
                account.sort_order or 0,
        }

        for month in months:
            month_key = month["key"]

            lookup_key = (
                account_type,
                month["year"],
                month["month"],
            )

            actual = actual_data.get(
                lookup_key,
                0.0,
            )

            row[f"{month_key}_actual"] = actual

            if account.report_dimension in (
                "IS-Revenue",
                "IS-Other Income",
            ):
                profit_actual[month_key] += actual

            elif account.report_dimension in (
                "IS-Cost of Sales",
                "IS-Other Expenditure",
            ):
                profit_actual[month_key] -= actual

            if show_budget:
                budget = budget_data.get(
                    lookup_key,
                    0.0,
                )

                variance = actual - budget

                row[f"{month_key}_budget"] = budget
                row[f"{month_key}_variance"] = variance

                if account.report_dimension in (
                    "IS-Revenue",
                    "IS-Other Income",
                ):
                    profit_budget[month_key] += budget

                elif account.report_dimension in (
                    "IS-Cost of Sales",
                    "IS-Other Expenditure",
                ):
                    profit_budget[month_key] -= budget

        data.append(row)

    profit_row = {
        "account_type": None,
        "description": _("Profit / (Loss)"),
        "report_dimension": _("Profit / Loss"),
        "is_profit_loss": 1,
    }

    for month in months:
        month_key = month["key"]

        actual_profit = profit_actual[month_key]

        profit_row[f"{month_key}_actual"] = actual_profit

        if show_budget:
            budget_profit = profit_budget[month_key]

            profit_row[f"{month_key}_budget"] = budget_profit
            profit_row[f"{month_key}_variance"] = (
                actual_profit - budget_profit
            )

    data.append(profit_row)

    return data


def get_months(from_date, to_date):
    from_date = getdate(from_date)
    to_date = getdate(to_date)

    current = date(
        from_date.year,
        from_date.month,
        1,
    )

    end = date(
        to_date.year,
        to_date.month,
        1,
    )

    months = []

    while current <= end:
        months.append(
            {
                "date": current,
                "year": current.year,
                "month": current.month,
                "key": current.strftime("%Y_%m"),
                "label": current.strftime("%b %Y"),
            }
        )

        current = next_month(current)

    return months


def next_month(current):
    if current.month == 12:
        return date(
            current.year + 1,
            1,
            1,
        )

    return date(
        current.year,
        current.month + 1,
        1,
    )

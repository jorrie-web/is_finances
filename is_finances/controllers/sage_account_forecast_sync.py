# Copyright (c) 2026, Isambane Mining and contributors
# For license information, please see license.txt

import frappe
from frappe import _


IS_DIMENSIONS = {
    "IS-Revenue",
    "IS-Other Income",
    "IS-Cost of Sales",
    "IS-Other Expenditure",
}


@frappe.whitelist()
def sync_sage_postgl_to_account(dry_run=1, company=None):
    """
    Synchronise Sage POSTGL group-account information to ERPNext Account.

    Rules:
    - Group account = first 4 characters of Sage POSTGL master_sub_account.
      Example: 1100>001 -> 1100
    - Match to ERPNext Account.account_number within the same company.
    - Populate:
        isf_sage_account_type
        isf_report_dimension
        isf_forecast_enabled
        isf_forecast_method (only when blank)
        isf_ebitda_treatment (only when blank)
    - Never creates missing ERPNext Accounts.
    - Never guesses when one group account has multiple Sage account types.
    - Default Forecast UOM is intentionally NOT populated automatically.

    dry_run:
        1 = preview only, no database updates
        0 = apply changes
    """

    dry_run = frappe.utils.cint(dry_run)

    frappe.has_permission("Account", "read" if dry_run else "write", throw=True)

    rows = _get_sage_group_accounts(company=company)

    result = {
        "dry_run": bool(dry_run),
        "sage_group_accounts": len(rows),
        "updated": 0,
        "unchanged": 0,
        "missing_accounts": [],
        "multiple_account_matches": [],
        "account_type_conflicts": [],
        "missing_sage_account_types": [],
        "updates": [],
    }

    for row in rows:
        group_account = str(row.group_account or "").strip()
        sage_company = row.company

        # Safety: only operate on clean 4-digit group accounts.
        if len(group_account) != 4 or not group_account.isdigit():
            continue

        account_types = _parse_account_types(row.account_types)

        # One 4-digit group account must resolve to one Sage Account Type.
        if len(account_types) != 1:
            result["account_type_conflicts"].append(
                {
                    "company": sage_company,
                    "group_account": group_account,
                    "account_types": account_types,
                    "sample_description": row.sample_description,
                }
            )
            continue

        sage_account_type = account_types[0]

        sage_type = frappe.db.get_value(
            "SageAccountType",
            {"sage_account_type": sage_account_type},
            [
                "name",
                "sage_account_type",
                "sage_accounttype_decsription",
                "report_dimension",
                "sort_order",
            ],
            as_dict=True,
        )

        if not sage_type:
            result["missing_sage_account_types"].append(
                {
                    "company": sage_company,
                    "group_account": group_account,
                    "sage_account_type": sage_account_type,
                }
            )
            continue

        accounts = frappe.get_all(
            "Account",
            filters={
                "company": sage_company,
                "account_number": group_account,
            },
            fields=[
                "name",
                "account_name",
                "account_number",
                "company",
                "is_group",
                "report_type",
                "isf_sage_account_type",
                "isf_report_dimension",
                "isf_forecast_enabled",
                "isf_forecast_method",
                "isf_ebitda_treatment",
            ],
            limit_page_length=5,
        )

        if not accounts:
            result["missing_accounts"].append(
                {
                    "company": sage_company,
                    "group_account": group_account,
                    "sage_account_type": sage_account_type,
                    "report_dimension": sage_type.report_dimension,
                    "sample_description": row.sample_description,
                }
            )
            continue

        if len(accounts) > 1:
            result["multiple_account_matches"].append(
                {
                    "company": sage_company,
                    "group_account": group_account,
                    "accounts": [d.name for d in accounts],
                }
            )
            continue

        account = accounts[0]

        updates = _build_account_updates(
            account=account,
            sage_type=sage_type,
            sample_description=row.sample_description,
        )

        if not updates:
            result["unchanged"] += 1
            continue

        result["updates"].append(
            {
                "account": account.name,
                "account_number": group_account,
                "account_name": account.account_name,
                "company": sage_company,
                "changes": updates,
            }
        )

        if not dry_run:
            frappe.db.set_value(
                "Account",
                account.name,
                updates,
                update_modified=True,
            )

        result["updated"] += 1

    if not dry_run:
        frappe.db.commit()

    result["message"] = _build_summary_message(result)

    return result


def _get_sage_group_accounts(company=None):
    """
    Return one row per Company + 4-digit Sage group account.

    GROUP_CONCAT is deliberate: it allows us to detect a situation where the
    same 4-digit group account has been assigned more than one iaccounttype.
    """

    conditions = [
        "p.master_sub_account IS NOT NULL",
        "TRIM(p.master_sub_account) <> ''",
        "TRIM(p.master_sub_account) REGEXP '^[0-9]{4}'",
    ]
    values = {}

    if company:
        conditions.append("p.company = %(company)s")
        values["company"] = company

    return frappe.db.sql(
        f"""
        SELECT
            p.company,
            LEFT(TRIM(p.master_sub_account), 4) AS group_account,
            GROUP_CONCAT(
                DISTINCT p.iaccounttype
                ORDER BY p.iaccounttype
                SEPARATOR ','
            ) AS account_types,
            COUNT(DISTINCT p.iaccounttype) AS account_type_count,
            MAX(p.sage_account_description) AS sample_description,
            COUNT(*) AS transaction_count
        FROM `tabSage POSTGL Entry` p
        WHERE {" AND ".join(conditions)}
        GROUP BY
            p.company,
            LEFT(TRIM(p.master_sub_account), 4)
        ORDER BY
            p.company,
            LEFT(TRIM(p.master_sub_account), 4)
        """,
        values,
        as_dict=True,
    )


def _parse_account_types(value):
    if not value:
        return []

    result = []

    for item in str(value).split(","):
        item = item.strip()

        if not item:
            continue

        try:
            result.append(int(item))
        except (TypeError, ValueError):
            result.append(item)

    return result


def _build_account_updates(account, sage_type, sample_description=None):
    updates = {}

    # SageAccountType autoname is based on sage_account_type, so using the
    # document name is safest for the Link field.
    target_sage_type = sage_type.name
    target_dimension = sage_type.report_dimension

    if account.isf_sage_account_type != target_sage_type:
        updates["isf_sage_account_type"] = target_sage_type

    if account.isf_report_dimension != target_dimension:
        updates["isf_report_dimension"] = target_dimension

    is_income_statement = target_dimension in IS_DIMENSIONS

    # Forecast Enabled is synchronised from the report classification:
    # Income Statement account = enabled.
    # Balance Sheet / non-IS account = disabled.
    target_enabled = 1 if is_income_statement else 0

    if frappe.utils.cint(account.isf_forecast_enabled) != target_enabled:
        updates["isf_forecast_enabled"] = target_enabled

    # Do NOT overwrite a user's manually selected Forecast Method.
    if is_income_statement and not account.isf_forecast_method:
        if target_dimension == "IS-Revenue":
            updates["isf_forecast_method"] = "Volume x Price"
        else:
            updates["isf_forecast_method"] = "Amount"

    # Do NOT overwrite a user's manually selected EBITDA Treatment.
    if is_income_statement and not account.isf_ebitda_treatment:
        updates["isf_ebitda_treatment"] = _default_ebitda_treatment(
            report_dimension=target_dimension,
            account_name=account.account_name,
            sample_description=sample_description,
        )

    return updates


def _default_ebitda_treatment(
    report_dimension,
    account_name=None,
    sample_description=None,
):
    """
    Initial classification only.

    Existing manually populated EBITDA Treatment values are never overwritten.
    """
    text = " ".join(
        [
            str(account_name or ""),
            str(sample_description or ""),
        ]
    ).lower()

    if "depreciat" in text:
        return "Depreciation"

    if "interest" in text:
        if report_dimension in ("IS-Revenue", "IS-Other Income"):
            return "Interest Received"

        if report_dimension in ("IS-Cost of Sales", "IS-Other Expenditure"):
            return "Interest Paid"

    return "Normal"


def _build_summary_message(result):
    mode = "PREVIEW" if result["dry_run"] else "APPLIED"

    return _(
        "{0}: {1} Sage group accounts checked; "
        "{2} Account records {3}; "
        "{4} unchanged; "
        "{5} missing Account masters; "
        "{6} Sage account-type conflicts."
    ).format(
        mode,
        result["sage_group_accounts"],
        result["updated"],
        "would change" if result["dry_run"] else "updated",
        result["unchanged"],
        len(result["missing_accounts"]),
        len(result["account_type_conflicts"]),
    )


@frappe.whitelist()
def get_sage_account_reconciliation(company=None):
    """
    Convenience preview for UI / bench testing.
    """
    frappe.has_permission("Account", "read", throw=True)

    return sync_sage_postgl_to_account(
        dry_run=1,
        company=company,
    )

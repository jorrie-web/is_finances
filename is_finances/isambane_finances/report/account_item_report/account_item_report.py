import frappe
from collections import defaultdict

def execute(filters=None):
    if not filters:
        filters = {}

    columns = get_columns()
    data = get_data(filters)
    return columns, data


def get_columns():
    return [
        {
            "label": "Expense Account",
            "fieldname": "expense_account",
            "fieldtype": "Link",
            "options": "Account",
            "width": 250,
        },
        {
            "label": "Item Code",
            "fieldname": "item_code",
            "fieldtype": "Link",
            "options": "Item",
            "width": 150,
        },
        {
            "label": "Item Name",
            "fieldname": "item_name",
            "fieldtype": "Data",
            "width": 200,
        },
        {
            "label": "Stock UOM",
            "fieldname": "stock_uom",
            "fieldtype": "Link",
            "options": "UOM",
            "width": 90,
        },
        {
            "label": "Cost Center",
            "fieldname": "cost_center",
            "fieldtype": "Link",
            "options": "Cost Center",
            "width": 200,
        },
        {
            "label": "Budget Rate",
            "fieldname": "budget_rate",
            "fieldtype": "Currency",
            "width": 120,
        },
    ]


def get_data(filters):
    data = []

    # --- 1) Collect all Item Default rows that have an expense_account (and optional company) ---
    item_default_filters = {"expense_account": ["is", "set"]}

    # 🔎 Apply Company filter if provided (Item Default has `company` field)
    if filters.get("company"):
        item_default_filters["company"] = filters["company"]

    item_defaults = frappe.get_all(
        "Item Default",
        fields=["parent as item_code", "expense_account"],
        filters=item_default_filters,
        order_by="expense_account asc, parent asc",
    )

    # Map: expense_account -> set of item_codes
    exp_to_items = defaultdict(set)
    for row in item_defaults:
        exp_to_items[row.expense_account].add(row.item_code)

    if not exp_to_items:
        data.append({
            "expense_account": "No expense accounts found on Item Defaults",
            "indent": 0,
            "is_group": 0,
        })
        return data

    # --- 2) Preload basic item fields in one go, with optional item_group filter ---
    all_item_codes = sorted({item for items in exp_to_items.values() for item in items})

    if all_item_codes:
        item_filters = {"name": ["in", all_item_codes]}

        # Item Group filter (Link → Item Group)
        if filters.get("item_group"):
            item_filters["item_group"] = filters["item_group"]

        item_info = {
            d.name: d
            for d in frappe.get_all(
                "Item",
                fields=["name", "item_name", "stock_uom", "item_group"],
                filters=item_filters,
            )
        }
    else:
        item_info = {}

    # --- 3) Build hierarchical rows ---
    for expense_account in sorted(exp_to_items.keys()):
        # Level 0: Expense Account
        data.append({
            "expense_account": expense_account,
            "indent": 0,
            "is_group": 1,
        })

        for item_code in sorted(exp_to_items[expense_account]):
            item_row = item_info.get(item_code)

            # If an item_group filter is applied and this item didn't pass it → skip
            if filters.get("item_group") and not item_row:
                continue

            # Level 1: Item
            data.append({
                "expense_account": None,
                "item_code": item_code,
                "item_name": (item_row.item_name if item_row else None),
                "stock_uom": (item_row.stock_uom if item_row else None),
                "indent": 1,
                "is_group": 1,
            })

            # Level 2: Budget rows from Item.budget_rate_table
            budgets = []
            try:
                item_doc = frappe.get_doc("Item", item_code)
                budgets = list(item_doc.get("budget_rate_table") or [])
            except Exception:
                budgets = []

            if budgets:
                for br in budgets:
                    cost_center = br.cost_center or "No value"
                    budget_rate = br.budget_rate if br.budget_rate is not None else "No value"

                    data.append({
                        "cost_center": cost_center,
                        "budget_rate": budget_rate,
                        "indent": 2,
                        "is_group": 0,
                    })
            else:
                data.append({
                    "cost_center": "No value",
                    "budget_rate": "No value",
                    "indent": 2,
                    "is_group": 0,
                })

    return data

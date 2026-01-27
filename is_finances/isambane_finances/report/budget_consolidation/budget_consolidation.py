# Copyright (c) 2026, Isambane Mining and contributors
# For license information, please see license.txt

from __future__ import annotations

from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

import frappe
from frappe.utils import flt, fmt_money, getdate


MONTH_CODES: List[str] = [
    "01-Jan", "02-Feb", "03-Mar", "04-Apr", "05-May", "06-Jun",
    "07-Jul", "08-Aug", "09-Sep", "10-Oct", "11-Nov", "12-Dec",
]


def rotate_months_to_fy_start(fiscal_year: Optional[str]) -> List[str]:
    start_idx = 2  # default March
    if fiscal_year:
        start = frappe.db.get_value("Fiscal Year", fiscal_year, "year_start_date")
        if start:
            start_idx = max(0, min(11, getdate(start).month - 1))
    codes = MONTH_CODES[:]
    return codes[start_idx:] + codes[:start_idx]


def _get_item_default_account(item_code: str, company: str) -> Optional[str]:
    if not item_code or not company:
        return None
    row = frappe.db.get_value(
        "Item Default",
        {"parent": item_code, "parenttype": "Item", "company": company},
        ["income_account", "expense_account"],
        as_dict=True,
    ) or {}
    return row.get("income_account") or row.get("expense_account")


def _get_parent_account(account: str) -> Optional[str]:
    return frappe.db.get_value("Account", account, "parent_account") if account else None


def _get_root_type(account: str) -> Optional[str]:
    return frappe.db.get_value("Account", account, "root_type") if account else None


def _currency(company: str) -> str:
    return frappe.db.get_value("Company", company, "default_currency") or ""


def _money(company: str, x: float) -> str:
    return fmt_money(x, currency=_currency(company))


def _get_parent_cost_centers(cost_centers: List[str], company: str) -> Dict[str, str]:
    out: Dict[str, str] = {cc: "No Parent Cost Center" for cc in (cost_centers or []) if cc}
    if not cost_centers:
        return out

    rows = frappe.get_all(
        "Cost Center",
        filters={"name": ["in", cost_centers], "company": company},
        fields=["name", "parent_cost_center"],
        limit_page_length=5000,
    ) or []

    for r in rows:
        out[r.name] = r.parent_cost_center or "No Parent Cost Center"

    return out


HIDE_GRID_CSS = r"""
<style>
  .query-report .report-result,
  .query-report .grid-report,
  .query-report .datatable,
  .query-report .datatable-wrapper,
  .query-report .dt-scrollable,
  .query-report .dt-header,
  .query-report .dt-footer,
  .query-report .result-footer,
  .query-report .report-wrapper .datatable,
  .query-report .report-wrapper .datatable-wrapper,
  .query-report .report-wrapper .dt-scrollable,
  .query-report .report-wrapper .dt-header,
  .query-report .report-wrapper .dt-footer,
  .query-report .report-wrapper .result-footer {
    display: none !important;
  }

  .query-report .empty-state,
  .query-report .no-result,
  .query-report .no-results,
  .query-report .result-message,
  .query-report .report-wrapper .empty-state,
  .query-report .report-wrapper .no-result,
  .query-report .report-wrapper .no-results,
  .query-report .report-wrapper .result-message,
  .query-report .report-wrapper [data-empty-state],
  .query-report [data-empty-state],
  .empty-state,
  .no-result,
  .no-results {
    display: none !important;
  }

  .bp-sum { font-size: 12.5px; }
  .bp-sum details { border:1px solid #e5eaee; border-radius:10px; padding:10px 12px; margin:10px 0; background:#fff; }
  .bp-sum summary { cursor:pointer; font-weight:600; display:flex; justify-content:space-between; gap:12px; }
  .bp-sum .lvl1 { margin-left: 0px; }
  .bp-sum .lvl2 { margin-left: 14px; }
  .bp-sum .lvl3 { margin-left: 28px; }
  .bp-sum .lvl4 { margin-left: 42px; }
  .bp-sum .lvl5 { margin-left: 56px; }

  .bp-matrix { overflow:auto; margin-top:10px; border:1px solid #e5eaee; border-radius:10px; }
  .bp-matrix table { width:max-content; min-width:100%; border-collapse:collapse; }
  .bp-matrix th, .bp-matrix td { border:1px solid #e5eaee; padding:6px; text-align:right; white-space:nowrap; }
  .bp-matrix th:first-child, .bp-matrix td:first-child { text-align:left; position:sticky; left:0; background:#fff; }
  .bp-matrix thead th { position:sticky; top:0; background:#f7f9fb; z-index:2; }

  .bp-charts .chart-area { margin-top: 10px; }
  .bp-charts .chart-box { border: 1px solid #e5eaee; border-radius: 10px; padding: 10px; background: #fff; }
  .bp-charts .chart-note { font-size: 12px; color: #6b7280; margin-top: 6px; }
</style>
"""


def execute(filters: Optional[Dict[str, Any]] = None):
    filters = filters or {}
    fiscal_year = filters.get("fiscal_year")
    company = filters.get("company")

    # Dummy data row (grid hidden via CSS)
    columns: List[Dict[str, Any]] = [{"fieldname": "_", "label": "", "fieldtype": "Data", "width": 1}]
    data: List[Dict[str, Any]] = [{"_": ""}]

    if not fiscal_year or not company:
        msg = HIDE_GRID_CSS + "<div class='text-muted'>Select Fiscal Year and Company.</div>"
        return columns, data, msg

    months = rotate_months_to_fy_start(str(fiscal_year))

    plans = frappe.get_all(
        "Budget Plan",
        filters={"fiscal_year": fiscal_year, "company": company, "docstatus": ["!=", 2]},
        fields=["name", "cost_center"],
        limit_page_length=5000,
    ) or []

    if not plans:
        msg = HIDE_GRID_CSS + "<div class='text-muted'>No Budget Plans found.</div>"
        return columns, data, msg

    plan_cc: Dict[str, str] = {p.name: (p.cost_center or "No Cost Center") for p in plans}
    plan_names = list(plan_cc.keys())

    unique_ccs = sorted({cc for cc in plan_cc.values() if cc})
    cc_to_parent = _get_parent_cost_centers(unique_ccs, str(company))

    rows = frappe.db.sql(
        """
        SELECT parent AS budget_plan, month, item_code, amount
        FROM `tabBudget Plan Line`
        WHERE parenttype='Budget Plan'
          AND parent IN %(plans)s
          AND ifnull(item_code,'') != ''
          AND ifnull(month,'') != ''
        """,
        {"plans": tuple(plan_names)},
        as_dict=True,
    ) or []

    if not rows:
        msg = HIDE_GRID_CSS + "<div class='text-muted'>No Budget Plan Lines found.</div>"
        return columns, data, msg

    item_names: Dict[str, str] = {}
    item_codes = sorted({r.item_code for r in rows if getattr(r, "item_code", None)})
    if item_codes:
        meta = frappe.get_all(
            "Item",
            filters={"name": ["in", item_codes]},
            fields=["name", "item_code", "item_name"],
            limit_page_length=5000,
        ) or []
        for m in meta:
            code = m.item_code or m.name
            nm = m.item_name or ""
            item_names[m.name] = f"{code}{(' - ' + nm) if nm else ''}"

    # tree[root_type][parent_cc][cc][parent_account][account][item][month] -> float
    tree = defaultdict(
        lambda: defaultdict(
            lambda: defaultdict(
                lambda: defaultdict(
                    lambda: defaultdict(
                        lambda: defaultdict(lambda: defaultdict(float))
                    )
                )
            )
        )
    )

    item_to_acc: Dict[str, str] = {}
    acc_meta: Dict[str, Dict[str, str]] = {}

    for r in rows:
        cc = plan_cc.get(r.budget_plan) or "No Cost Center"
        parent_cc = cc_to_parent.get(cc) or "No Parent Cost Center"
        month = r.month
        item = r.item_code
        amt = flt(r.amount or 0)

        if not item or month not in months:
            continue

        acc = item_to_acc.get(item)
        if not acc:
            acc = _get_item_default_account(item, str(company)) or "Unmapped Account"
            item_to_acc[item] = acc

        meta = acc_meta.get(acc)
        if not meta:
            parent_acc = _get_parent_account(acc) or "No Parent"
            rt = _get_root_type(acc) or "Expense"
            if rt not in ("Income", "Expense"):
                rt = "Expense"
            meta = {"parent": parent_acc, "root": rt}
            acc_meta[acc] = meta

        tree[meta["root"]][parent_cc][cc][meta["parent"]][acc][item][month] += amt

    # ---------------- Aggregation helpers ----------------
    def month_total(mm: Dict[str, float]) -> float:
        return sum(flt(mm.get(m, 0)) for m in months)

    def merge_month_maps(target: Dict[str, float], src: Dict[str, float]) -> None:
        for m in months:
            target[m] = flt(target.get(m, 0)) + flt(src.get(m, 0))

    def sum_item(item_map: Dict[str, Dict[str, float]]) -> Dict[str, float]:
        out = {m: 0.0 for m in months}
        for _item, mm in item_map.items():
            merge_month_maps(out, mm)
        return out

    def sum_account(acc_map: Dict[str, Dict[str, Dict[str, float]]]) -> Dict[str, float]:
        out = {m: 0.0 for m in months}
        for _acc, item_map in acc_map.items():
            merge_month_maps(out, sum_item(item_map))
        return out

    def sum_cc_root(root: str, parent_cc: str, cc: str) -> Dict[str, float]:
        out = {m: 0.0 for m in months}
        for _parent_acc, acc_map in tree.get(root, {}).get(parent_cc, {}).get(cc, {}).items():
            merge_month_maps(out, sum_account(acc_map))
        return out

    def sum_parent_cc_root(root: str, parent_cc: str) -> Dict[str, float]:
        out = {m: 0.0 for m in months}
        for cc in tree.get(root, {}).get(parent_cc, {}).keys():
            merge_month_maps(out, sum_cc_root(root, parent_cc, cc))
        return out

    def sum_root(root: str) -> Dict[str, float]:
        out = {m: 0.0 for m in months}
        for pcc in tree.get(root, {}).keys():
            merge_month_maps(out, sum_parent_cc_root(root, pcc))
        return out

    def sum_cc_all_parents(root: str, cc: str) -> Dict[str, float]:
        """Sum a cost center across all parent_cc buckets."""
        out = {m: 0.0 for m in months}
        for pcc in tree.get(root, {}).keys():
            if cc in tree.get(root, {}).get(pcc, {}):
                merge_month_maps(out, sum_cc_root(root, pcc, cc))
        return out

    income = sum_root("Income")
    expense = sum_root("Expense")
    pnl = {m: flt(income.get(m, 0)) - flt(expense.get(m, 0)) for m in months}

    # ---------------- Charts payload (Cost Center based) ----------------
    cc_list = sorted({cc for cc in unique_ccs if cc and cc != "No Cost Center"})
    if not cc_list and unique_ccs:
        cc_list = sorted(unique_ccs)

    charts_payload = {
        "income_expense": {
            "title": "Income vs Expenses by Month",
            "type": "bar",
            "labels": months,
            "datasets": [
                {"name": "Income", "values": [flt(income.get(m, 0)) for m in months]},
                {"name": "Expenses", "values": [flt(expense.get(m, 0)) for m in months]},
            ],
            "options": {"height": 260},
        },
        # Monthly P&L by Cost Center (stacked)
        "pnl_by_cost_center": {
            "title": "Monthly P&L by Cost Center",
            "type": "bar",
            "labels": months,
            "datasets": [],
            "options": {"height": 320, "stacked": True},
        },
        # Annual P&L by Cost Center (sorted)
        "annual_pnl_by_cost_center": {
            "title": "Annual P&L by Cost Center",
            "type": "bar",
            "labels": [],
            "datasets": [{"name": "P&L", "values": []}],
            "options": {"height": 300},
        },
    }

    annual_rows = []
    for cc in cc_list:
        cc_income = sum_cc_all_parents("Income", cc)
        cc_exp = sum_cc_all_parents("Expense", cc)
        cc_pnl_map = {m: flt(cc_income.get(m, 0)) - flt(cc_exp.get(m, 0)) for m in months}

        charts_payload["pnl_by_cost_center"]["datasets"].append(
            {"name": cc, "values": [flt(cc_pnl_map.get(m, 0)) for m in months]}
        )
        annual_rows.append((cc, month_total(cc_pnl_map)))

    annual_rows.sort(key=lambda x: x[1], reverse=True)
    charts_payload["annual_pnl_by_cost_center"]["labels"] = [x[0] for x in annual_rows]
    charts_payload["annual_pnl_by_cost_center"]["datasets"][0]["values"] = [flt(x[1]) for x in annual_rows]

    charts_json = frappe.utils.escape_html(frappe.as_json(charts_payload))

    # ---------------- HTML helpers ----------------
    def render_matrix(rows2: List[Tuple[str, Dict[str, float]]], first_col_label: str) -> str:
        head = "".join(f"<th>{frappe.utils.escape_html(m)}</th>" for m in months) + "<th>Year Total</th>"
        body_parts: List[str] = []
        for label, mm in rows2:
            tds = "".join(f"<td>{_money(str(company), mm.get(m, 0))}</td>" for m in months)
            body_parts.append(
                f"<tr><td>{frappe.utils.escape_html(label)}</td>{tds}<td><b>{_money(str(company), month_total(mm))}</b></td></tr>"
            )
        body = "".join(body_parts)
        return f"""
        <div class="bp-matrix">
          <table>
            <thead><tr><th style="text-align:left;">{frappe.utils.escape_html(first_col_label)}</th>{head}</tr></thead>
            <tbody>{body}</tbody>
          </table>
        </div>
        """

    def render_items(root: str, parent_cc: str, cc: str, parent_acc: str, acc: str) -> str:
        item_rows: List[Tuple[str, Dict[str, float]]] = []
        for item in sorted(tree[root][parent_cc][cc][parent_acc][acc].keys()):
            item_rows.append((item_names.get(item, item), tree[root][parent_cc][cc][parent_acc][acc][item]))
        return render_matrix(item_rows, "Description")

    def render_accounts(root: str, parent_cc: str, cc: str, parent_acc: str) -> str:
        acc_rows: List[Tuple[str, Dict[str, float]]] = []
        for acc in sorted(tree[root][parent_cc][cc][parent_acc].keys()):
            acc_rows.append((acc, sum_item(tree[root][parent_cc][cc][parent_acc][acc])))
        return render_matrix(acc_rows, "Account")

    def render_cc_block(root: str, parent_cc: str, cc: str) -> str:
        cc_total_map = sum_cc_root(root, parent_cc, cc)
        cc_total = month_total(cc_total_map)

        out: List[str] = [f"""
          <details class="lvl3">
            <summary>
              <span>{frappe.utils.escape_html(cc)}</span>
              <span>{_money(str(company), cc_total)}</span>
            </summary>
            {render_matrix([(cc, cc_total_map)], "Cost Center")}
        """]

        for parent_acc in sorted(tree.get(root, {}).get(parent_cc, {}).get(cc, {}).keys()):
            parent_total_map = sum_account(tree[root][parent_cc][cc][parent_acc])
            parent_total = month_total(parent_total_map)

            out.append(f"""
              <details class="lvl4">
                <summary>
                  <span>{frappe.utils.escape_html(parent_acc)}</span>
                  <span>{_money(str(company), parent_total)}</span>
                </summary>
                {render_accounts(root, parent_cc, cc, parent_acc)}
            """)

            for acc in sorted(tree[root][parent_cc][cc][parent_acc].keys()):
                acc_total_map = sum_item(tree[root][parent_cc][cc][parent_acc][acc])
                acc_total = month_total(acc_total_map)
                out.append(f"""
                  <details class="lvl5">
                    <summary>
                      <span>{frappe.utils.escape_html(acc)}</span>
                      <span>{_money(str(company), acc_total)}</span>
                    </summary>
                    {render_items(root, parent_cc, cc, parent_acc, acc)}
                  </details>
                """)

            out.append("</details>")

        out.append("</details>")
        return "\n".join(out)

    def render_parent_cc_block(root: str, parent_cc: str) -> str:
        pcc_total_map = sum_parent_cc_root(root, parent_cc)
        pcc_total = month_total(pcc_total_map)

        out: List[str] = [f"""
          <details class="lvl2">
            <summary>
              <span>{frappe.utils.escape_html(parent_cc)}</span>
              <span>{_money(str(company), pcc_total)}</span>
            </summary>
            {render_matrix([(parent_cc, pcc_total_map)], "Parent Cost Center")}
        """]

        for cc in sorted(tree.get(root, {}).get(parent_cc, {}).keys()):
            out.append(render_cc_block(root, parent_cc, cc))

        out.append("</details>")
        return "\n".join(out)

    def render_parent_cc_pnl_block(parent_cc: str) -> str:
        pcc_income = sum_parent_cc_root("Income", parent_cc)
        pcc_expense = sum_parent_cc_root("Expense", parent_cc)
        pcc_pnl_map = {m: flt(pcc_income.get(m, 0)) - flt(pcc_expense.get(m, 0)) for m in months}
        pcc_pnl_total = month_total(pcc_pnl_map)

        out: List[str] = [f"""
          <details class="lvl2">
            <summary>
              <span>{frappe.utils.escape_html(parent_cc)}</span>
              <span>{_money(str(company), pcc_pnl_total)}</span>
            </summary>
            {render_matrix([(f"{parent_cc} - P&L", pcc_pnl_map)], "Parent Cost Center P&L")}
            {render_matrix([(f"{parent_cc} - Income", pcc_income), (f"{parent_cc} - Expenses", pcc_expense)], "Components")}
        """]

        out.append(f"""
            <details class="lvl3">
              <summary><span>Income</span><span>{_money(str(company), month_total(pcc_income))}</span></summary>
        """)
        for cc in sorted(tree.get("Income", {}).get(parent_cc, {}).keys()):
            out.append(render_cc_block("Income", parent_cc, cc))
        out.append("</details>")

        out.append(f"""
            <details class="lvl3">
              <summary><span>Expenses</span><span>{_money(str(company), month_total(pcc_expense))}</span></summary>
        """)
        for cc in sorted(tree.get("Expense", {}).get(parent_cc, {}).keys()):
            out.append(render_cc_block("Expense", parent_cc, cc))
        out.append("</details>")

        out.append("</details>")
        return "\n".join(out)

    def render_total_group(title: str, total_map: Dict[str, float], root: Optional[str]) -> str:
        total_val = month_total(total_map)

        parts: List[str] = [f"""
          <details open class="lvl1">
            <summary><span>{frappe.utils.escape_html(title)}</span><span>{_money(str(company), total_val)}</span></summary>
            {render_matrix([(title, total_map)], "Group")}
        """]

        if title.startswith("Profit and Loss"):
            pcc_list = sorted(set(list(tree.get("Income", {}).keys()) + list(tree.get("Expense", {}).keys())))
            pcc_rows: List[Tuple[str, Dict[str, float]]] = []
            for pcc in pcc_list:
                pcc_income = sum_parent_cc_root("Income", pcc)
                pcc_exp = sum_parent_cc_root("Expense", pcc)
                pcc_pnl2 = {m: flt(pcc_income.get(m, 0)) - flt(pcc_exp.get(m, 0)) for m in months}
                pcc_rows.append((pcc, pcc_pnl2))

            parts.append(render_matrix(pcc_rows, "Parent Cost Center (Monthly P&L)"))
            for pcc in pcc_list:
                parts.append(render_parent_cc_pnl_block(pcc))
        else:
            root_map = tree.get(root or "", {})
            pcc_keys = sorted(root_map.keys())
            pcc_rows2 = [(pcc, sum_parent_cc_root(root, pcc)) for pcc in pcc_keys]
            parts.append(render_matrix(pcc_rows2, "Parent Cost Center (Monthly Totals)"))
            for pcc in pcc_keys:
                parts.append(render_parent_cc_block(root, pcc))

        parts.append("</details>")
        return "\n".join(parts)

    charts_html = f"""
    <div class="bp-charts">
      <details open>
        <summary><span>Charts</span><span></span></summary>

        <details open class="lvl2">
          <summary><span>Income vs Expenses by Month</span><span></span></summary>
          <div class="chart-area chart-box"><div id="bc_chart_income_expense"></div></div>
          <div class="chart-note">Grouped bars: Income and Expenses for each month.</div>
        </details>

        <details class="lvl2">
          <summary><span>Monthly P&L by Cost Center</span><span></span></summary>
          <div class="chart-area chart-box"><div id="bc_chart_pnl_by_cost_center"></div></div>
          <div class="chart-note">Stacked bars: each stack segment is a Cost Center.</div>
        </details>

        <details class="lvl2">
          <summary><span>Annual P&L by Cost Center</span><span></span></summary>
          <div class="chart-area chart-box"><div id="bc_chart_annual_pnl_by_cost_center"></div></div>
          <div class="chart-note">Total P&L per Cost Center (sorted).</div>
        </details>
      </details>

      <div id="bc_charts_payload_json" style="display:none;">{charts_json}</div>
    </div>
    """

    html_parts: List[str] = [HIDE_GRID_CSS, "<div class='bp-sum'>", charts_html]
    html_parts.append(render_total_group("Total Income", income, "Income"))
    html_parts.append(render_total_group("Total Expenses", expense, "Expense"))
    html_parts.append(render_total_group("Profit and Loss (Total Income - Total Expenses)", pnl, None))
    html_parts.append("</div>")

    return columns, data, "\n".join(html_parts)

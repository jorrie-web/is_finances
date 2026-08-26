# Copyright (c) 2025, Isambane Mining
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import flt, getdate
from collections import defaultdict
from frappe.utils import fmt_money


MONTH_CODES = [
    "01-Jan", "02-Feb", "03-Mar", "04-Apr", "05-May", "06-Jun",
    "07-Jul", "08-Aug", "09-Sep", "10-Oct", "11-Nov", "12-Dec"
]

EQUIPMENT_CATEGORIES = [
    "Diesel Bowsers",
    "Drills",
    "Grader",
    "LDV",
    "Lightning Plant",
    "Service Truck",
    "TLB",
    "ADT",
    "Excavator",
    "Dozer",
]



def _is_bcm_item(item_code: str) -> bool:
    """Return True if the given Item is flagged as a BCM item."""
    if not item_code:
        return False

    return bool(frappe.db.get_value("Item", item_code, "isf_is_bcm"))


def rotate_months_to_fy_start(fiscal_year: str | None) -> list[str]:
    """Return month code list starting at FY start month (default March)."""
    start_idx = 2  # 0=Jan, 1=Feb, 2=Mar
    if fiscal_year:
        start = frappe.db.get_value("Fiscal Year", fiscal_year, "year_start_date")
        if start:
            start_idx = max(0, min(11, getdate(start).month - 1))
    codes = MONTH_CODES[:]
    return codes[start_idx:] + codes[:start_idx]


def get_budget_rate(item_code, cost_center=None):
    """Fetch cost-center-specific rate for an Item, or fallback to the default."""
    if not item_code:
        return 0

    rate = 0
    if cost_center:
        rate = frappe.db.get_value(
            "Item Budget Rate",
            {"item": item_code, "cost_center": cost_center},
            "budget_rate",
        ) or 0

    if not rate:
        rate = frappe.db.get_value("Item", item_code, "isf_budget_rate") or 0

    return flt(rate)


def _line_cost_center(parent_cc, line):
    """Return line.cost_center if it exists, otherwise use parent cost_center."""
    return getattr(line, "cost_center", None) or parent_cc


class BudgetPlan(Document):
    def validate(self):
        self.validate_fiscal_year()
        self.ensure_months_valid()
        # ---------- Equipment Info (location + counts) ----------
        self.set_equipment_location_from_site_code()
        self.sync_equipment_info_rows()
        self.compute_current_counts_for_equipment_info()

        # ✅ removed: ensure_budget_item_group_only()
        self.ensure_bcm_line_rules()
        self.ensure_asset_location_cost_center()
        self.compute_line_amounts()
        self.render_summary_html()

    # ---------- Core validations ----------

    def validate_fiscal_year(self):
        if not self.fiscal_year:
            frappe.throw("Fiscal Year is required.")

    def ensure_months_valid(self):
        allowed = set(MONTH_CODES)
        for d in (self.lines or []):
            if d.month and d.month not in allowed:
                frappe.throw(f"Invalid month '{d.month}' in item lines.")

    def ensure_bcm_line_rules(self):
        for d in (self.lines or []):
            if not getattr(d, "item_code", None):
                continue

            is_bcm = _is_bcm_item(d.item_code)
            if not is_bcm:
                continue

            # BCM line must not reference an Asset
            if getattr(d, "asset", None):
                frappe.throw(f"BCM line {d.item_code} must not reference an Asset.")

            # Parent cost_center is allowed; only set line.cost_center if field exists
            if not getattr(d, "cost_center", None):
                if getattr(self, "cost_center", None):
                    if hasattr(d, "cost_center"):
                        d.cost_center = self.cost_center
                else:
                    frappe.throw(f"BCM line {d.item_code} must specify a Cost Center.")

    def ensure_asset_location_cost_center(self):
        for d in (self.lines or []):
            if not getattr(d, "item_code", None) or not getattr(d, "asset", None):
                continue

            is_bcm = _is_bcm_item(d.item_code)
            if is_bcm:
                continue

            loc = frappe.db.get_value("Asset", d.asset, "location")
            if not loc:
                frappe.throw(f"Asset {d.asset} has no Location set.")

            mapped_cc = frappe.db.get_value("Location", loc, "isf_linked_cost_center")
            if not mapped_cc:
                frappe.throw(f"Location {loc} has no Linked Cost Center (isf_linked_cost_center).")

            line_cc = getattr(d, "cost_center", None)

            # If the line has a cost_center field and it is set, it must match mapping
            if line_cc and line_cc != mapped_cc:
                frappe.throw(
                    f"Line with Asset {d.asset}: Cost Center must match Asset Location mapping ({mapped_cc})."
                )

            # If the line has the field but it's empty, auto-assign it
            if not line_cc and hasattr(d, "cost_center"):
                d.cost_center = mapped_cc

    # ---------- Calculations ----------


    # ---------- Equipment Info (location + counts) ----------

    def set_equipment_location_from_site_code(self):
        """Populate equipment_location by looking up Site Code for this cost center.

        - Finds first submitted Site Code where cost_center == Budget Plan.cost_center.
        - Copies Site Code.location into Budget Plan.equipment_location.
        - Does not overwrite equipment_location if user already set it.
        """
        if not getattr(self, "cost_center", None):
            return
        if not hasattr(self, "equipment_location"):
            return
        if getattr(self, "equipment_location", None):
            return

        sc = frappe.db.get_value(
            "Site Code",
            {"cost_center": self.cost_center, "docstatus": 1},
            ["name", "location"],
            as_dict=True,
        )
        if sc and sc.get("location"):
            self.equipment_location = sc.get("location")

    def sync_equipment_info_rows(self):
        """Ensure equipment_info child table has one row per configured equipment category."""
        if not hasattr(self, "equipment_info"):
            return

        existing = {d.asset_category for d in (self.equipment_info or []) if getattr(d, "asset_category", None)}
        for cat in EQUIPMENT_CATEGORIES:
            if cat in existing:
                continue
            row = self.append("equipment_info", {})
            row.asset_category = cat

    def compute_current_counts_for_equipment_info(self):
        """Populate equipment_info.current_count from submitted Assets per category (optional location filter)."""
        if not hasattr(self, "equipment_info"):
            return

        cats = [d.asset_category for d in (self.equipment_info or []) if getattr(d, "asset_category", None)]
        if not cats:
            return

        counts = get_asset_counts_by_category(
            asset_categories=cats,
            company=getattr(self, "company", None),
            location=getattr(self, "equipment_location", None),
        )

        for d in (self.equipment_info or []):
            if not getattr(d, "asset_category", None):
                continue
            d.current_count = int(counts.get(d.asset_category, 0) or 0)

    def compute_line_amounts(self):
        """Compute per-line rates/amounts (no document-level totals fields)."""
        for d in (self.lines or []):
            cc = _line_cost_center(getattr(self, "cost_center", None), d)
            rate = get_budget_rate(getattr(d, "item_code", None), cc)
            d.custom_budget_rate = flt(rate)
            d.amount = flt(getattr(d, "qty", 0)) * flt(rate)

    def render_summary_html(self):
        """Render summary with top-level collapsibles:
        - Total Income
        - Total Expenses
        - Profit and Loss (Total Income - Total Expenses)

        Under Income/Expenses totals, show parent accounts as nested collapsibles.
        """
        if not self.company or not self.fiscal_year:
            self.summary_html = ""
            return

        months = rotate_months_to_fy_start(self.fiscal_year)

        INCOME_PARENTS = ["Revenue - ISA", "Other Income - ISA"]

        # --- Budget Benchmark (% of revenue) lookup ---
        # Match Budget Benchmark by (fiscal_year, company)
        # Then match Account Benchmark rows by (account, cost_center)
        bench_map = {}  # (account, cost_center) -> benchmark percent
        bb_name = frappe.db.get_value(
            "Budget Benchmark",
            {"fiscal_year": self.fiscal_year, "company": self.company},
            "name",
        )
        if bb_name:
            bb_rows = frappe.get_all(
                "Account Benchmark",
                filters={"parenttype": "Budget Benchmark", "parent": bb_name},
                fields=["account", "cost_center", "benchmark"],
                limit_page_length=5000,
            )
            for r in bb_rows:
                if r.get("account") and r.get("cost_center"):
                    bench_map[(r["account"], r["cost_center"])] = flt(r.get("benchmark") or 0)

        def fmt_pct(x) -> str:
            if x is None:
                return "—"
            return f"{flt(x):.1f}%"

        def get_benchmark_for_account(account: str) -> float | None:
            cc = getattr(self, "cost_center", None)
            if not account or not cc:
                return None
            return bench_map.get((account, cc))

        def actual_pct_of_revenue(amount: float, total_income_amt: float) -> float | None:
            if not total_income_amt:
                return None
            return (flt(amount) / flt(total_income_amt)) * 100.0

        def bench_badge_html(bench: float | None) -> str:
            if bench is None:
                return "—"
            return f'<span class="bp-bench">{fmt_pct(bench)}</span>'

        def actual_badge_html(actual: float | None, bench: float | None) -> str:
            if actual is None:
                return "—"
            cls = ""
            if bench is not None:
                cls = "bp-actual-bad" if flt(actual) > flt(bench) else "bp-actual-good"
            return f'<span class="{cls}">{fmt_pct(actual)}</span>'

        # Build structure: parent -> account -> item -> month -> amount
        tree = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: defaultdict(float))))
        item_names = {}

        # Pull item display names in one go
        item_codes = sorted({d.item_code for d in (self.lines or []) if getattr(d, "item_code", None)})
        if item_codes:
            rows = frappe.get_all(
                "Item",
                filters={"name": ["in", item_codes]},
                fields=["name", "item_code", "item_name"],
                limit_page_length=5000,
            )
            for r in rows:
                code = r.item_code or r.name
                nm = r.item_name or ""
                item_names[r.name] = f"{code}{(' - ' + nm) if nm else ''}"

        # Aggregate item lines
        for d in (self.lines or []):
            item = getattr(d, "item_code", None)
            m = getattr(d, "month", None)
            amt = flt(getattr(d, "amount", 0))
            if not item or not m:
                continue

            # Level 2 account from Item Defaults (company-specific)
            acc = _get_item_default_account(item, self.company) or getattr(d, "account", None) or "Unmapped Account"

            # Level 1 parent account
            parent = _get_parent_account(acc) or "No Parent Account"
            tree[parent][acc][item][m] += amt

        def money(x: float) -> str:
            return fmt_money(x, currency=frappe.db.get_value("Company", self.company, "default_currency"))

        def month_total(month_map: dict) -> float:
            return sum(month_map.get(mm, 0) for mm in months)

        def merge_month_maps(target: dict, src: dict):
            for mm in months:
                target[mm] = flt(target.get(mm, 0)) + flt(src.get(mm, 0))

        def sum_account_to_month_map(acc_item_map: dict) -> dict:
            out = {mm: 0.0 for mm in months}
            for _item, m_map in acc_item_map.items():
                merge_month_maps(out, m_map)
            return out

        def sum_parent_to_month_map(parent_map: dict) -> dict:
            out = {mm: 0.0 for mm in months}
            for _acc, item_map in parent_map.items():
                merge_month_maps(out, sum_account_to_month_map(item_map))
            return out

        def sum_group_month_map(parents: list[str]) -> dict:
            out = {mm: 0.0 for mm in months}
            for p in parents:
                if p in tree:
                    merge_month_maps(out, sum_parent_to_month_map(tree[p]))
            return out

        def render_item_table(rows: list[tuple]):
            """Item-level / generic table (NO benchmark columns)."""
            head = "".join([f"<th>{frappe.utils.escape_html(mm)}</th>" for mm in months]) + "<th>Year Total</th>"
            body = []
            for row in rows:
                if len(row) == 2:
                    label, m_map = row
                    meta = None
                else:
                    label, m_map, meta = row

                year = month_total(m_map)
                tds = "".join([f"<td>{money(m_map.get(mm, 0))}</td>" for mm in months])

                edit_btn = ""
                if meta and meta.get("item") :
                    item_id = meta.get("item")
                    edit_btn = f"""
                      <button type="button"
                              class="btn btn-xs btn-default bp-edit-item"
                              data-item="{frappe.utils.escape_html(item_id)}"
                              data-label="{frappe.utils.escape_html(label)}"
                              style="margin-left:8px;">
                        Edit
                      </button>
                    """

                body.append(f"""
                <tr>
                    <td>
                      {frappe.utils.escape_html(label)}
                      {edit_btn}
                    </td>
                    {tds}
                    <td><b>{money(year)}</b></td>
                </tr>
                """)

            return f"""
            <div class="bp-matrix">
                <table>
                <thead>
                    <tr>
                    <th style="text-align:left;">Description</th>
                    {head}
                    </tr>
                </thead>
                <tbody>
                    {''.join(body)}
                </tbody>
                </table>
            </div>
            """

        def render_account_table(account_rows: list[tuple]):
            """Account-level table (NO benchmark columns). Benchmarks are shown on the account summary line."""
            head = "".join([f"<th>{frappe.utils.escape_html(mm)}</th>" for mm in months]) + "<th>Year Total</th>"
            body = []
            for row in account_rows:
                if len(row) == 2:
                    account, m_map = row
                else:
                    account, m_map, _meta = row

                year = month_total(m_map)
                tds = "".join([f"<td>{money(m_map.get(mm, 0))}</td>" for mm in months])

                body.append(f"""
                <tr>
                    <td>{frappe.utils.escape_html(account)}</td>
                    {tds}
                    <td><b>{money(year)}</b></td>
                </tr>
                """)

            return f"""
            <div class="bp-matrix">
                <table>
                <thead>
                    <tr>
                    <th style="text-align:left;">Account</th>
                    {head}
                    </tr>
                </thead>
                <tbody>
                    {''.join(body)}
                </tbody>
                </table>
            </div>
            """


        def sum_item_months(item_month_map: dict) -> float:
            return sum(item_month_map.get(mm, 0) for mm in months)

        def sum_account(acc_map: dict) -> float:
            total = 0.0
            for _item, month_map in acc_map.items():
                total += sum_item_months(month_map)
            return total

        def sum_parent(parent_map: dict) -> float:
            total = 0.0
            for _acc, item_map in parent_map.items():
                total += sum_account(item_map)
            return total

        # Split Income vs Expenses based on parent_account name
        income_parents = []
        expense_parents = []
        for parent in tree.keys():
            if parent in INCOME_PARENTS:
                income_parents.append(parent)
            else:
                expense_parents.append(parent)

        income_parents_sorted = [p for p in INCOME_PARENTS if p in tree]
        expense_parents_sorted = sorted(expense_parents)

        total_income = sum(sum_parent(tree[p]) for p in income_parents_sorted)
        total_expenses = sum(sum_parent(tree[p]) for p in expense_parents_sorted)
        pnl = total_income - total_expenses

        income_month_map = sum_group_month_map(income_parents_sorted)
        expense_month_map = sum_group_month_map(expense_parents_sorted)
        pnl_month_map = {mm: flt(income_month_map.get(mm, 0)) - flt(expense_month_map.get(mm, 0)) for mm in months}

        css = """
        <style>
          .bp-sum { font-size: 12.5px; }
          .bp-sum details { border:1px solid #e5eaee; border-radius:8px; padding:8px 10px; margin:8px 0; background:#fff; }
          .bp-sum summary { cursor:pointer; font-weight:600; display:flex; justify-content:space-between; gap:12px; }
          .bp-sum .lvl2 { margin-left: 14px; }
          .bp-sum .lvl3 { margin-left: 28px; }
          .bp-sum table { width:100%; border-collapse:collapse; margin-top:8px; }
          .bp-sum th, .bp-sum td { border:1px solid #e5eaee; padding:6px; text-align:right; white-space:nowrap; }
          .bp-sum th:first-child, .bp-sum td:first-child { text-align:left; }
          .bp-matrix { overflow:auto; margin-top:10px; border:1px solid #e5eaee; border-radius:8px; }
          .bp-matrix table { width:max-content; min-width:100%; border-collapse:collapse; }
          .bp-matrix th, .bp-matrix td { border:1px solid #e5eaee; padding:6px; text-align:right; white-space:nowrap; }
          .bp-matrix th:first-child, .bp-matrix td:first-child { text-align:left; position:sticky; left:0; background:#fff; }
          .bp-matrix thead th { position:sticky; top:0; background:#f7f9fb; z-index:2; }
          .bp-bench { color:#1d6fdc; } /* blue */
          .bp-actual-good { color:#1a7f37; } /* green */
          .bp-actual-bad { color:#c92a2a; }  /* red */

        </style>
        """

        def render_parent(parent: str, cls: str = "") -> str:
            parent_total = sum_parent(tree[parent])
            if parent not in INCOME_PARENTS:
                # Sum benchmarks across accounts under this parent for this cost center
                cc = getattr(self, "cost_center", None)
                bench_sum = None
                if cc:
                    s = 0.0
                    any_b = False
                    for acc in tree[parent].keys():
                        b = bench_map.get((acc, cc))
                        if b is None:
                            continue
                        s += flt(b)
                        any_b = True
                    bench_sum = s if any_b else None

                actual = actual_pct_of_revenue(parent_total, total_income)
                parent_bench_html = f'<span class="bp-bench"><b>Benchmark % of Revenue:</b> {fmt_pct(bench_sum) if bench_sum is not None else "—"}</span>'
                # Color actual based on benchmark if available
                cls = ""
                if bench_sum is not None and actual is not None:
                    cls = "bp-actual-bad" if flt(actual) > flt(bench_sum) else "bp-actual-good"
                actual_txt = fmt_pct(actual) if actual is not None else "—"
                parent_actual_html = f'<span class="{cls}"><b>Actual % of Revenue:</b> {actual_txt}</span>'
            cls_attr = f' class="{cls}"' if cls else ""

            out = [f"""
            <details{cls_attr}>
                <summary>
                <span>{frappe.utils.escape_html(parent)}</span>
                <span>{money(parent_total)}</span>
                </summary>
            """]

            # Parent-level matrix: Accounts as rows
            acc_rows = []
            for acc in sorted(tree[parent].keys()):
                acc_rows.append((acc, sum_account_to_month_map(tree[parent][acc])))
            out.append(render_account_table(acc_rows))

            # Account collapsibles: Items matrix
            for acc in sorted(tree[parent].keys()):
                acc_total = sum_account(tree[parent][acc])
                # Benchmark/Actual shown on the account summary line (per Budget Plan cost center)
                bench = get_benchmark_for_account(acc)
                actual = actual_pct_of_revenue(acc_total, total_income)
                acc_bench_html = f'<span class="bp-bench"><b>Benchmark % of Revenue:</b> {fmt_pct(bench) if bench is not None else "—"}</span>'
                cls = ""
                if bench is not None and actual is not None:
                    cls = "bp-actual-bad" if flt(actual) > flt(bench) else "bp-actual-good"
                actual_txt = fmt_pct(actual) if actual is not None else "—"
                acc_actual_html = f'<span class="{cls}"><b>Actual % of Revenue:</b> {actual_txt}</span>'
                out.append(f"""
                <details class="lvl3">
                    <summary>
                    <span>{frappe.utils.escape_html(acc)}</span>
                    <span style="display:flex; gap:12px; align-items:center;">
                      <span>{money(acc_total)}</span>
                      {acc_bench_html}
                      {acc_actual_html}
                    </span>
                    </summary>
                """)

                item_rows = []
                for item in sorted(tree[parent][acc].keys()):
                    label = item_names.get(item, item)
                    item_rows.append((label, tree[parent][acc][item], {"item": item}))

                out.append(render_item_table(item_rows))
                out.append("</details>")  # lvl3

            out.append("</details>")  # parent
            return "\n".join(out)

        def render_total_group(title: str, total: float, month_map: dict, parents: list[str] | None = None) -> str:
            parts = [f"""
            <details>
              <summary>
                <span>{frappe.utils.escape_html(title)}</span>
                <span>{money(total)}</span>
              </summary>
            """]
            parts.append(render_item_table([(title, month_map)]))

            if parents:
                for p in parents:
                    parts.append(render_parent(p, cls="lvl2"))

            parts.append("</details>")
            return "\n".join(parts)

        html_parts = [css, '<div class="bp-sum">']

        # Top-level collapsibles first (requested order)
        html_parts.append(render_total_group("Total Income", total_income, income_month_map, income_parents_sorted))
        html_parts.append(render_total_group("Total Expenses", total_expenses, expense_month_map, expense_parents_sorted))
        html_parts.append(render_total_group("Profit and Loss (Total Income - Total Expenses)", pnl, pnl_month_map))

        html_parts.append("</div>")
        self.summary_html = "\n".join(html_parts)


@frappe.whitelist()
def get_item_rate(item: str, cost_center: str | None = None):
    frappe.has_permission("Budget Plan", "read", throw=True)
    return get_budget_rate(item, cost_center)


@frappe.whitelist()
def get_budget_rates_for_cost_center(fiscal_year: str, company: str, cost_center: str):
    """Returns list of {item, label, budget_rate} for Budget Rates doc matching fiscal_year+company,
    filtered to the given cost_center. Label format matches Budget Rates UI.
    """
    frappe.has_permission("Budget Plan", "read", throw=True)

    if not fiscal_year or not company or not cost_center:
        frappe.throw("Fiscal Year, Company and Cost Center are required.")

    br_name = frappe.db.get_value("Budget Rates", {"fiscal_year": fiscal_year, "company": company}, "name")
    if not br_name:
        return []

    rows = frappe.get_all(
        "Item Budget Rate",
        filters={"parenttype": "Budget Rates", "parent": br_name, "cost_center": cost_center},
        fields=["item", "budget_rate"],
        limit_page_length=5000,
    )

    items = [r.item for r in rows if r.get("item")]
    if not items:
        return []

    item_meta = frappe.get_all(
        "Item",
        filters={"name": ["in", items]},
        fields=["name", "item_code", "item_name"],
        limit_page_length=5000,
    )
    meta_map = {m.name: m for m in item_meta}

    out = []
    for r in rows:
        item = r.get("item")
        if not item:
            continue
        m = meta_map.get(item)
        code = (m.item_code if m and m.item_code else item)
        nm = (m.item_name if m and m.item_name else "")
        label = f"{code}{(' - ' + nm) if nm else ''}"
        out.append({
            "item": item,
            "label": label,
            "budget_rate": flt(r.get("budget_rate")),
            "budget_rates_doc": br_name,
        })

    return out


@frappe.whitelist()
def sync_budget_rates_to_item_budget_rate(fiscal_year: str, company: str, cost_center: str):
    """Copy Budget Rates.item_budget_rates rows into Item Budget Rate for the given cost center."""
    frappe.has_permission("Budget Plan", "write", throw=True)

    if not fiscal_year or not company or not cost_center:
        frappe.throw("Fiscal Year, Company and Cost Center are required.")

    br_name = frappe.db.get_value("Budget Rates", {"fiscal_year": fiscal_year, "company": company}, "name")
    if not br_name:
        frappe.throw(f"No Budget Rates found for Fiscal Year '{fiscal_year}' and Company '{company}'.")

    src_rows = frappe.get_all(
        "Item Budget Rate",
        filters={"parent": br_name, "parenttype": "Budget Rates", "cost_center": cost_center},
        fields=["item", "cost_center", "budget_rate"],
        limit_page_length=5000,
    )

    updated = 0
    created = 0

    for r in src_rows:
        item = r.get("item")
        rate = flt(r.get("budget_rate"))
        if not item:
            continue

        existing = frappe.db.get_value("Item Budget Rate", {"item": item, "cost_center": cost_center}, "name")
        if existing:
            frappe.db.set_value("Item Budget Rate", existing, "budget_rate", rate)
            updated += 1
        else:
            doc = frappe.get_doc({
                "doctype": "Item Budget Rate",
                "item": item,
                "cost_center": cost_center,
                "budget_rate": rate,
            })
            doc.insert(ignore_permissions=True)
            created += 1

    return {"budget_rates": br_name, "created": created, "updated": updated, "count": len(src_rows)}


def _get_item_default_account(item_code: str, company: str) -> str | None:
    """Returns the Item Default account for this company.
    Prefer income_account if set, else expense_account.
    (Item Default is a child table of Item)
    """
    if not item_code or not company:
        return None

    row = frappe.db.get_value(
        "Item Default",
        {"parent": item_code, "parenttype": "Item", "company": company},
        ["income_account", "expense_account"],
        as_dict=True,
    )
    if not row:
        return None

    return row.get("income_account") or row.get("expense_account")


def _get_parent_account(account: str) -> str | None:
    if not account:
        return None
    return frappe.db.get_value("Account", account, "parent_account")



@frappe.whitelist()
def get_item_month_rates(docname: str, item: str):
    """Return per-month budget rates for a specific item within a Budget Plan.

    Rates are taken from existing Budget Plan lines if present (custom_budget_rate),
    otherwise computed via get_budget_rate(item, cost_center).
    """
    if not docname or not item:
        frappe.throw("docname and item are required.")

    doc = frappe.get_doc("Budget Plan", docname)
    doc.check_permission("read")
    months = rotate_months_to_fy_start(doc.fiscal_year)

    # Index existing lines for this item by month
    line_by_month = {}
    for d in (doc.lines or []):
        if getattr(d, "item_code", None) == item and getattr(d, "month", None):
            line_by_month[d.month] = d

    out = []
    for m in months:
        d = line_by_month.get(m)
        cc = _line_cost_center(getattr(doc, "cost_center", None), d) if d else getattr(doc, "cost_center", None)

        # Prefer stored rate if present (supports month-by-month overrides if they exist)
        rate = flt(getattr(d, "custom_budget_rate", 0)) if d else 0

        if not rate:
            rate = get_budget_rate(item, cc)

        out.append({"month": m, "rate": flt(rate)})

    return out

@frappe.whitelist()
def get_budget_plan_summary_html(docname: str):
    doc = frappe.get_doc("Budget Plan", docname)
    doc.check_permission("read")
    # ensure line amounts are up to date
    doc.compute_line_amounts()
    doc.render_summary_html()
    return doc.summary_html or ""

@frappe.whitelist()
def get_asset_counts_by_category(asset_categories, company=None, location=None):
    """Return submitted Asset counts grouped by asset_category.

    Args:
        asset_categories: list/tuple or JSON string list of Asset Category names.
        company: optional Company filter (if Asset has company column).
        location: optional Location filter (if Asset has location column).
    """
    frappe.has_permission("Asset", "read", throw=True)

    if isinstance(asset_categories, str):
        # allow JSON string from JS
        asset_categories = frappe.parse_json(asset_categories)
    asset_categories = [c for c in (asset_categories or []) if c]
    if not asset_categories:
        return {}

    conditions = ["docstatus = 1", "asset_category IN %(cats)s"]
    params = {"cats": tuple(asset_categories)}

    if company and frappe.db.has_column("Asset", "company"):
        conditions.append("company = %(company)s")
        params["company"] = company
    if location and frappe.db.has_column("Asset", "location"):
        conditions.append("location = %(location)s")
        params["location"] = location

    where_clause = " AND ".join(conditions)
    rows = frappe.db.sql(
        f"""
        SELECT asset_category, COUNT(*) AS qty
        FROM `tabAsset`
        WHERE {where_clause}
        GROUP BY asset_category
        """,
        params,
        as_dict=True,
    )
    out = {r.asset_category: int(r.qty or 0) for r in rows}
    # ensure all categories appear, even if zero
    for c in asset_categories:
        out.setdefault(c, 0)
    return out


@frappe.whitelist()
def get_equipment_info_payload(docname: str):
    """Return payload used by Budget Plan JS to render equipment_info_html.

    The client calls this to display a table of Asset Categories with:
      - current_count: computed from submitted Assets (docstatus=1)
      - budgeted_count: stored/editable on the Budget Plan child table

    Also returns a suggested_equipment_location (from Site Code) when the Budget Plan
    doesn't yet have equipment_location set.
    """
    if not docname:
        frappe.throw("docname is required")

    doc = frappe.get_doc("Budget Plan", docname)
    doc.check_permission("read")

    # Suggest location from Site Code (by cost center) if doc is blank
    suggested_loc = None
    if not getattr(doc, "equipment_location", None) and getattr(doc, "cost_center", None):
        suggested_loc = frappe.db.get_value(
            "Site Code",
            {"cost_center": doc.cost_center, "docstatus": 1},
            "location",
        )

    # Categories to show: configured defaults + any already in the child table
    cats = []
    seen = set()
    for c in (EQUIPMENT_CATEGORIES or []):
        if c and c not in seen:
            cats.append(c)
            seen.add(c)
    for d in (getattr(doc, "equipment_info", None) or []):
        c = getattr(d, "asset_category", None)
        if c and c not in seen:
            cats.append(c)
            seen.add(c)

    # Read saved budgeted_count from child table
    budget_map = {}
    for d in (getattr(doc, "equipment_info", None) or []):
        c = getattr(d, "asset_category", None)
        if not c:
            continue
        budget_map[c] = flt(getattr(d, "budgeted_count", 0) or 0)

    # Compute current counts (optionally filter by location)
    loc_for_count = getattr(doc, "equipment_location", None) or suggested_loc
    counts = get_asset_counts_by_category(
        asset_categories=cats,
        company=getattr(doc, "company", None),
        location=loc_for_count,
    )

    rows = []
    for c in cats:
        rows.append(
            {
                "asset_category": c,
                "current_count": int(counts.get(c, 0) or 0),
                "budgeted_count": flt(budget_map.get(c, 0) or 0),
            }
        )

    return {
        "equipment_location": getattr(doc, "equipment_location", None) or "",
        "suggested_equipment_location": suggested_loc,
        "rows": rows,
    }


@frappe.whitelist()
def get_site_code_location(cost_center: str):
    """Return Site Code (name, location) for a given Cost Center.
    Prefers submitted Site Code (docstatus=1), falls back to draft if none exist.
    """
    frappe.has_permission("Budget Plan", "read", throw=True)

    if not cost_center:
        return None

    site = frappe.db.get_value(
        "Site Code",
        {"cost_center": cost_center, "docstatus": 1},
        ["name", "location"],
        as_dict=True,
    )
    if not site:
        site = frappe.db.get_value(
            "Site Code",
            {"cost_center": cost_center},
            ["name", "location"],
            as_dict=True,
        )
    return site

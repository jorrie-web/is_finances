// Copyright (c) 2025, Isambane Mining and contributors
// For license information, please see license.txt

/*
Budget Benchmark - Matrix Editor (Option A)

Rows: Expense Accounts (for selected company)
Columns: Cost Centers (for selected company)
Values: benchmark (%) stored in child table rows: (account, cost_center, benchmark)

Enhancements:
- Frozen header row + frozen first column (sticky)
- Cost Center column headers display ONLY characters before the first space
  e.g. "KRR - ISA" -> "KRR" (display-only; stored values unchanged)
- Per-row bulk set: set the same % across ALL cost centers for that account row
  + optional "Clear row" button (blank all)
- Editing any cell updates the child table and marks the document dirty so it can be saved.
- validate() enforces a final sync from the in-memory matrix to child table (safety net).
*/

frappe.ui.form.on("Budget Benchmark", {
  refresh(frm) {
    frm._bb_matrix = frm._bb_matrix || {}; // { account: { cost_center: benchmark } }
    setup_child_filters(frm);
    build_matrix_from_child(frm);
    render_matrix(frm);
  },

  company(frm) {
    frm._bb_matrix = {};
    setup_child_filters(frm);
    build_matrix_from_child(frm);
    render_matrix(frm);
  },

  validate(frm) {
    sync_child_from_matrix(frm);
  }
});

function setup_child_filters(frm) {
  // Account filter: Expense accounts only for selected company
  frm.set_query("account", "account_benchmark", () => {
    if (!frm.doc.company) return {};
    return {
      filters: {
        company: frm.doc.company,
        root_type: "Expense",
        is_group: 0,
        disabled: 0
      }
    };
  });

  // Cost Center filter: only cost centers for selected company
  frm.set_query("cost_center", "account_benchmark", () => {
    if (!frm.doc.company) return {};
    return {
      filters: {
        company: frm.doc.company,
        is_group: 0,
        disabled: 0
      }
    };
  });
}

function build_matrix_from_child(frm) {
  const matrix = {};
  (frm.doc.account_benchmark || []).forEach(r => {
    if (!r.account || !r.cost_center) return;
    matrix[r.account] = matrix[r.account] || {};
    matrix[r.account][r.cost_center] = flt(r.benchmark || 0);
  });
  frm._bb_matrix = matrix;
}

async function render_matrix(frm) {
  const field = frm.get_field("budget_benchmark_html");
  if (!field || !field.$wrapper) return;

  const $w = field.$wrapper;
  $w.empty();

  if (!frm.doc.company) {
    $w.append(`<div class="text-muted">Select a <b>Company</b> to load the benchmark matrix.</div>`);
    return;
  }

  // Sticky (freeze) CSS
  const sticky_css = `
    <style>
      .bb-matrix-wrap .table-responsive {
        max-height: 70vh;
        overflow: auto;
      }

      .bb-matrix thead th {
        position: sticky;
        top: 0;
        z-index: 3;
        background: #f8f9fa;
      }

      .bb-matrix tbody td:first-child,
      .bb-matrix thead th:first-child {
        position: sticky;
        left: 0;
        z-index: 4;
        background: #ffffff;
        min-width: 360px;
      }

      .bb-matrix thead th:first-child {
        z-index: 5;
        background: #f1f3f5;
      }

      .bb-matrix input.form-control {
        padding: 2px 6px;
        height: 26px;
      }

      .bb-matrix td {
        vertical-align: middle;
      }

      .bb-matrix td input.bb-cell {
        text-align: right;
        min-width: 90px;
      }

      .bb-row-tools {
        display: flex;
        gap: 6px;
        align-items: center;
        margin-top: 6px;
      }

      .bb-row-tools input {
        width: 90px;
      }
    </style>
  `;

  $w.append(sticky_css);
  $w.append(`<div class="text-muted">Loading accounts and cost centers…</div>`);

  // Fetch Expense accounts (company-scoped)
  const accounts = await frappe.db.get_list("Account", {
    fields: ["name", "account_name", "account_number"],
    filters: {
      company: frm.doc.company,
      root_type: "Expense",
      is_group: 0,
      disabled: 0
    },
    limit: 0,
    order_by: "account_number asc, account_name asc"
  });

  // Fetch Cost Centers (company-scoped)
  const cost_centers = await frappe.db.get_list("Cost Center", {
    fields: ["name", "cost_center_name"],
    filters: {
      company: frm.doc.company,
      is_group: 0,
      disabled: 0
    },
    limit: 0,
    order_by: "cost_center_name asc"
  });

  // Clear loading, re-inject CSS
  $w.empty();
  $w.append(sticky_css);

  if (!accounts.length) {
    $w.append(`<div class="text-muted">No <b>Expense</b> accounts found for this company.</div>`);
    return;
  }
  if (!cost_centers.length) {
    $w.append(`<div class="text-muted">No Cost Centers found for this company.</div>`);
    return;
  }

  frm._bb_matrix = frm._bb_matrix || {};
  const safeCompany = frappe.utils.escape_html(frm.doc.company);

  // Toolbar
  const $toolbar = $(`
    <div style="display:flex; gap:12px; align-items:center; justify-content:space-between; margin-bottom:10px;">
      <div>
        <b>Budget Benchmark Matrix</b>
        <span class="text-muted">(${safeCompany})</span>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-xs btn-default" data-action="reset_zeros">Clear all to 0</button>
        <button class="btn btn-xs btn-primary" data-action="sync_now">Sync to child table</button>
      </div>
    </div>
  `);

  $toolbar.find('[data-action="reset_zeros"]').on("click", () => {
    accounts.forEach(a => {
      frm._bb_matrix[a.name] = frm._bb_matrix[a.name] || {};
      cost_centers.forEach(cc => {
        frm._bb_matrix[a.name][cc.name] = 0;
      });
    });
    sync_child_from_matrix(frm);
    render_matrix(frm);
  });

  $toolbar.find('[data-action="sync_now"]').on("click", () => {
    sync_child_from_matrix(frm);
    frappe.show_alert({ message: "Benchmarks synced. Click Save to store.", indicator: "green" });
  });

  // Build table
  const $wrap = $(`<div class="bb-matrix-wrap"></div>`);
  const $table = $(`
    <div class="table-responsive">
      <table class="table table-bordered table-condensed bb-matrix">
        <thead></thead>
        <tbody></tbody>
      </table>
    </div>
  `);

  const $thead = $table.find("thead");
  const $tbody = $table.find("tbody");

  // Header row
  const $hr = $("<tr></tr>");
  $hr.append(`<th style="min-width:360px;">Expense Account</th>`);

  // Cost center headers: display only before first space; full label on hover
  cost_centers.forEach(cc => {
    const full = (cc.cost_center_name || cc.name || "").trim();
    const short = (full.split(" ")[0] || "").trim();  // display-only
    const label = frappe.utils.escape_html(short || full || cc.name);
    const title = frappe.utils.escape_html(full || cc.name);
    $hr.append(`<th style="min-width:140px;" title="${title}">${label}</th>`);
  });

  $thead.append($hr);

  // Body rows: each account
  accounts.forEach(acc => {
    const $tr = $("<tr></tr>");

    const accLabel = acc.account_number
      ? `${acc.account_number} - ${acc.account_name}`
      : `${acc.account_name}`;

    // Account cell + row tools
    const $accCell = $(`
      <td>
        <b>${frappe.utils.escape_html(accLabel)}</b>
        <div class="text-muted" style="font-size: 11px;">${frappe.utils.escape_html(acc.name)}</div>
        <div class="bb-row-tools">
          <input type="number" class="form-control input-xs" step="0.1" min="0" max="100" placeholder="Set %" />
          <button class="btn btn-xs btn-default" data-action="set_row">Set all</button>
          <button class="btn btn-xs btn-default" data-action="clear_row">Clear row</button>
        </div>
      </td>
    `);

    $tr.append($accCell);

    frm._bb_matrix[acc.name] = frm._bb_matrix[acc.name] || {};

    // Keep references to inputs for this row (for bulk actions)
    const cell_inputs = {}; // { cost_center_name: $input }

    cost_centers.forEach(cc => {
      const currentVal = frm._bb_matrix[acc.name][cc.name];

      const $input = $(`<input type="number" class="form-control input-xs bb-cell" step="0.1" min="0" max="100" />`);
      $input.val(currentVal == null ? "" : currentVal);

      // Store reference for row tools
      cell_inputs[cc.name] = $input;

      $input.on("input", () => {
        const v = $input.val();
        const num = v === "" ? null : flt(v);

        if (num == null) {
          delete frm._bb_matrix[acc.name][cc.name];
          remove_child_row(frm, acc.name, cc.name);
        } else {
          frm._bb_matrix[acc.name][cc.name] = num;
          upsert_child_row(frm, acc.name, cc.name, num);
        }

        frm.refresh_field("account_benchmark");
        frm.dirty();
      });

      $tr.append($("<td></td>").append($input));
    });

    // Row tool handlers
    const $rowVal = $accCell.find("input[type='number']");
    $accCell.find("[data-action='set_row']").on("click", () => {
      const raw = $rowVal.val();
      const num = raw === "" ? null : flt(raw);

      if (num == null || isNaN(num)) {
        frappe.msgprint("Enter a benchmark % value to apply across the row.");
        return;
      }

      cost_centers.forEach(cc => {
        frm._bb_matrix[acc.name][cc.name] = num;
        upsert_child_row(frm, acc.name, cc.name, num);
        if (cell_inputs[cc.name]) cell_inputs[cc.name].val(num);
      });

      frm.refresh_field("account_benchmark");
      frm.dirty();
    });

    $accCell.find("[data-action='clear_row']").on("click", () => {
      // Remove all benchmarks for this account across all cost centers
      cost_centers.forEach(cc => {
        delete frm._bb_matrix[acc.name][cc.name];
        remove_child_row(frm, acc.name, cc.name);
        if (cell_inputs[cc.name]) cell_inputs[cc.name].val("");
      });

      frm.refresh_field("account_benchmark");
      frm.dirty();
    });

    $tbody.append($tr);
  });

  $wrap.append($toolbar, $table);
  $w.append($wrap);

  $w.append(`
    <div class="text-muted" style="margin-top:8px;">
      Edits here immediately update the <b>Account Benchmark</b> child table. Click <b>Save</b> to store permanently.
      (Blank a cell to remove that Account+Cost Center benchmark.)
    </div>
  `);
}

// ---------- Child table sync helpers ----------

function upsert_child_row(frm, account, cost_center, benchmark) {
  const rows = frm.doc.account_benchmark || [];
  let row = rows.find(r => r.account === account && r.cost_center === cost_center);

  if (!row) {
    row = frm.add_child("account_benchmark");
    row.account = account;
    row.cost_center = cost_center;
  }
  row.benchmark = flt(benchmark || 0);
}

function remove_child_row(frm, account, cost_center) {
  if (!frm.doc.account_benchmark) return;
  frm.doc.account_benchmark = (frm.doc.account_benchmark || []).filter(
    r => !(r.account === account && r.cost_center === cost_center)
  );
}

function sync_child_from_matrix(frm) {
  const matrix = frm._bb_matrix || {};

  frm.clear_table("account_benchmark");

  Object.keys(matrix).forEach(account => {
    const ccMap = matrix[account] || {};
    Object.keys(ccMap).forEach(cost_center => {
      const val = ccMap[cost_center];
      if (val == null) return;

      const r = frm.add_child("account_benchmark");
      r.account = account;
      r.cost_center = cost_center;
      r.benchmark = flt(val);
    });
  });

  frm.refresh_field("account_benchmark");
  frm.dirty();
}

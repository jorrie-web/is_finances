// Copyright (c) 2025, Isambane Mining and contributors
// For license information, please see license.txt

frappe.ui.form.on("Budget Rates", {
  refresh(frm) {
    frm.trigger("render_matrix_if_ready");
  },

  fiscal_year(frm) {
    frm.trigger("render_matrix_if_ready");
  },

  company(frm) {
    frm.trigger("render_matrix_if_ready");
  },

  async render_matrix_if_ready(frm) {
    const $w = frm.fields_dict.item_budget_rates_display?.$wrapper;
    if (!$w) return;

    if (!frm.doc.fiscal_year || !frm.doc.company) {
      $w.empty();
      $w.html(`<div class="text-muted">Select a <b>Fiscal Year</b> and <b>Company</b> to load the rates grid.</div>`);
      return;
    }

    const cost_centers = await fetch_cost_centers_for_matrix(frm);

    // Existing values (only real rows: must have item + cost_center)
    const existing = new Map();
    (frm.doc.item_budget_rates || []).forEach(r => {
      if (!r.item || !r.cost_center) return; // ignore placeholder rows
      const k = `${r.item}||${r.cost_center}`;
      existing.set(k, r.budget_rate);
    });

    // Selected items = unique items present in child rows (including placeholders)
    const selected_item_names = [...new Set(
      (frm.doc.item_budget_rates || [])
        .map(r => r.item)
        .filter(Boolean)
    )];

    const selected_items = await fetch_items_by_names(selected_item_names);

    render_matrix_html(frm, selected_items, cost_centers, existing);
  },

  before_save(frm) {
    sync_matrix_to_child_table(frm);
  },
});

async function fetch_cost_centers_for_matrix(frm) {
  if (!frm.doc.company) return [];

  const r = await frappe.db.get_list("Cost Center", {
    fields: ["name"],
    filters: {
      company: frm.doc.company,
      is_group: 0,
      disabled: 0
    },
    limit: 500,
    order_by: "name asc",
  });

  return (r || []).map(cc => {
    // Display only first segment before " - "
    const short_label = cc.name.split(" - ")[0];

    return {
      value: cc.name,      // full name used for saving
      label: short_label   // short code used only for display
    };
  });
}


async function fetch_items_by_names(names) {
  if (!names || !names.length) return [];

  const r = await frappe.db.get_list("Item", {
    fields: ["name", "item_code", "item_name"],
    filters: [["name", "in", names]],
    limit: 1000,
  });

  const byName = new Map((r || []).map(it => [it.name, it]));
  return names
    .map(n => byName.get(n))
    .filter(Boolean)
    .map(it => ({
      value: it.name,
      label: `${it.item_code || it.name}${it.item_name ? " - " + it.item_name : ""}`
    }));
}

function render_matrix_html(frm, selected_items, cost_centers, existingMap) {
  const $w = frm.fields_dict.item_budget_rates_display.$wrapper;
  $w.empty();

  const style = `
    <style>
      .bir-wrap { overflow:auto; border: 1px solid #d1d8dd; border-radius: 8px; }
      .bir-table { border-collapse: collapse; width: max-content; min-width: 100%; }
      .bir-table th, .bir-table td { border: 1px solid #e5eaee; padding: 6px; white-space: nowrap; }
      .bir-table th { position: sticky; top: 0; background: #f7f9fb; z-index: 2; }
      .bir-sticky-col {position: sticky; left: 0; background: #fff; z-index: 1; min-width: 260px; max-width: 260px; white-space: normal;       /* ✅ allow wrapping */ word-break: break-word;    /* ✅ break long words */ overflow-wrap: anywhere;   /* ✅ modern browsers */ }
      .bir-item-label { display: block; white-space: normal; line-height: 1.3; }
      .bir-sticky-col.bir-head { z-index: 3; background: #f7f9fb; }
      .bir-input { width: 120px; text-align: right; }
      .bir-toolbar { display:flex; gap:10px; align-items:center; flex-wrap: wrap; margin-bottom: 10px; }
      .bir-muted { opacity: .7; }
      .bir-chip { display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border:1px solid #d1d8dd; border-radius:999px; }
      .bir-chip button { border:0; background:transparent; cursor:pointer; opacity:.8; }
      .bir-warn { margin-top: 10px; }
    </style>
  `;

  const toolbar = `
    <div class="bir-toolbar">
      <button class="btn btn-sm btn-primary bir-add-item">+ Add Item</button>
      <span class="bir-muted">Select items, fill rates, then click <b>Save</b> on the document.</span>
    </div>
  `;

  if (!cost_centers.length) {
    $w.html(`${style}${toolbar}
      <div class="alert alert-warning bir-warn">
        No Cost Centers found for <b>${frappe.utils.escape_html(frm.doc.company)}</b> that are <b>not groups</b> and <b>not disabled</b>.
      </div>`);
    bind_add_item(frm);
    return;
  }

  if (!selected_items.length) {
    $w.html(`${style}${toolbar}
      <div class="alert alert-info bir-warn">
        No items selected yet. Click <b>+ Add Item</b> to start building your grid.
      </div>`);
    bind_add_item(frm);
    return;
  }

  let thead = `<thead><tr>
    <th class="bir-sticky-col bir-head">Item</th>
    ${cost_centers.map(cc => `<th title="${frappe.utils.escape_html(cc.value)}">${frappe.utils.escape_html(cc.label)}</th>`).join("")}
  </tr></thead>`;

  let tbodyRows = selected_items.map(it => {
    const tds = cost_centers.map(cc => {
      const key = `${it.value}||${cc.value}`;
      const val = existingMap.has(key) ? existingMap.get(key) : "";
      return `
        <td>
          <input
            type="text"
            inputmode="decimal"
            class="form-control bir-input bir-rate"
            data-item="${frappe.utils.escape_html(it.value)}"
            data-cc="${frappe.utils.escape_html(cc.value)}"
            value="${val !== "" && val !== null && val !== undefined ? format_rate(parse_rate(val)) : ""}"
            placeholder="0.00"
          />
        </td>
      `;
    }).join("");

    return `
      <tr data-item-row="1" data-item="${frappe.utils.escape_html(it.value)}">
        <td class="bir-sticky-col">
          <div style="display:flex; flex-direction:column; gap:6px;">
            <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
              <b class="bir-item-label">${frappe.utils.escape_html(it.label)}</b>
              <button class="btn btn-xs btn-danger bir-remove-item"
                      data-item="${frappe.utils.escape_html(it.value)}">
                Remove
              </button>
            </div>

            <div style="display:flex; gap:6px; align-items:center;">
              <input
                type="text"
                inputmode="decimal"
                class="form-control input-sm bir-row-set"
                data-item="${frappe.utils.escape_html(it.value)}"
                style="width: 140px;"
                placeholder="Set all…"
              />
              <button class="btn btn-xs btn-default bir-apply-row"
                      data-item="${frappe.utils.escape_html(it.value)}">
                Apply
              </button>
            </div>
          </div>
        </td>

        ${tds}
      </tr>
    `;
  }).join("");

  $w.html(`
    ${style}
    ${toolbar}
    <div class="bir-wrap">
      <table class="bir-table">
        ${thead}
        <tbody>${tbodyRows}</tbody>
      </table>
    </div>
  `);

  bind_add_item(frm);
  bind_remove_item(frm);

  // STEP 4 – add these two lines
  bind_rate_formatting(frm);
  bind_apply_row_value(frm);
}


function bind_add_item(frm) {
  const $w = frm.fields_dict.item_budget_rates_display.$wrapper;

  $w.off("click", ".bir-add-item").on("click", ".bir-add-item", function () {
    open_item_picker(frm);
  });
}

function open_item_picker(frm) {
  const d = new frappe.ui.Dialog({
    title: "Select Items",
    fields: [
      {
        fieldname: "txt",
        fieldtype: "Data",
        label: "Search",
        reqd: 0,
        onchange() {
          load_results();
        }
      },
      {
        fieldname: "results",
        fieldtype: "HTML"
      }
    ],
    primary_action_label: "Add Selected",
    primary_action() {
      const selected = [];
      d.$wrapper.find('input[data-item="1"]:checked').each(function () {
        selected.push($(this).attr("data-value"));
      });

      if (!selected.length) {
        d.hide();
        return;
      }

      const existing_items = new Set((frm.doc.item_budget_rates || []).map(r => r.item));

      selected.forEach(item => {
        if (!item || existing_items.has(item)) return;

        const row = frm.add_child("item_budget_rates");
        row.item = item;
        row.cost_center = null;
        row.budget_rate = 0;
      });

      frm.refresh_field("item_budget_rates");
      frm.trigger("render_matrix_if_ready");
      d.hide();
    }
  });

  function render_rows(rows) {
    const html = `
      <div style="max-height: 420px; overflow:auto; border:1px solid #e5eaee; border-radius: 6px;">
        <table class="table table-bordered table-hover" style="margin:0;">
          <thead>
            <tr>
              <th style="width:40px;"></th>
              <th>Item</th>
            </tr>
          </thead>
          <tbody>
            ${(rows || []).map(r => `
              <tr>
                <td style="text-align:center;">
                  <input type="checkbox" data-item="1"
                         data-value="${frappe.utils.escape_html(r.value)}">
                </td>
                <td>
                  <b>${frappe.utils.escape_html(r.value)}</b>
                  ${r.description ? `<div class="text-muted">${frappe.utils.escape_html(r.description)}</div>` : ""}
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
    d.set_value("results", html);
  }

  const load_results = frappe.utils.debounce(() => {
    const txt = (d.get_value("txt") || "").trim();

    // This is the same backend used for Link-field searching.
    // It returns rows like { value: "ISA_00000001", description: "BCM Volume" }
    frappe.call({
      method: "frappe.desk.search.search_link",
      args: {
        doctype: "Item",
        txt: txt,
        page_length: 50
      },
      callback: (res) => {
        render_rows((res.message || []).map(x => ({
          value: x.value,
          description: x.description
        })));
      }
    });
  }, 250);

  d.show();
  load_results();
}

function bind_remove_item(frm) {
  const $w = frm.fields_dict.item_budget_rates_display.$wrapper;
  $w.find(".bir-remove-item").off("click").on("click", function () {
    const item = $(this).data("item");
    if (!item) return;

    frm.doc.item_budget_rates = (frm.doc.item_budget_rates || []).filter(r => r.item !== item);
    frm.refresh_field("item_budget_rates");
    frm.trigger("render_matrix_if_ready");
  });
}

function sync_matrix_to_child_table(frm) {
  const $w = frm.fields_dict.item_budget_rates_display.$wrapper;
  const $inputs = $w.find("input.bir-input");

  // If matrix not rendered, nothing to sync
  if (!$inputs.length) return;

  // Selected items from rendered rows
  const selected_items = new Set();
  $w.find('tr[data-item-row="1"]').each(function () {
    const it = $(this).attr("data-item");
    if (it) selected_items.add(it);
  });

  // Track which items got at least one real (non-empty & non-zero) rate
  const items_with_real_rates = new Set();

  // Rebuild child table from scratch
  frm.clear_table("item_budget_rates");

  $inputs.each(function () {
    const item = $(this).data("item");
    const cost_center = $(this).data("cc");
    const raw = $(this).val();

    if (!item || !selected_items.has(item)) return;
    if (raw === "" || raw === null || raw === undefined) return;

    const budget_rate = flt(raw);

    // If you want to SAVE zeros, remove this check
    if (!budget_rate) return;

    const row = frm.add_child("item_budget_rates");
    row.item = item;
    row.cost_center = cost_center;
    row.budget_rate = budget_rate;

    items_with_real_rates.add(item);
  });

  // ✅ Persist item selection even if no rates yet:
  // Add a placeholder row per selected item with no real rates.
  selected_items.forEach(item => {
    if (!items_with_real_rates.has(item)) {
      const row = frm.add_child("item_budget_rates");
      row.item = item;
      row.cost_center = null;
      row.budget_rate = 0;
    }
  });

  frm.refresh_field("item_budget_rates");
}

function parse_rate(v) {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (!s) return 0;

  // allow spaces as thousand separators
  s = s.replace(/\s+/g, "");

  // allow comma decimals if user types it
  // If both comma and dot exist, assume comma is thousands and remove it
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/,/g, "");
  } else if (s.includes(",") && !s.includes(".")) {
    s = s.replace(",", ".");
  }

  // keep only digits, minus, dot
  s = s.replace(/[^0-9.\-]/g, "");

  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function format_rate(n) {
  if (n === null || n === undefined || isNaN(n)) return "";
  const fixed = Number(n).toFixed(2); // always 2 decimals
  const [intPart, decPart] = fixed.split(".");
  // space thousand groups
  const withSpaces = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${withSpaces}.${decPart}`;
}

function normalize_rate_input(el) {
  const raw = (el.value || "").trim();
  if (!raw) return;
  const n = parse_rate(raw);
  el.value = format_rate(n);
}

function bind_rate_formatting(frm) {
  const $w = frm.fields_dict.item_budget_rates_display.$wrapper;

  // Normalize formatting on blur (e.g. "12345.6" → "12 345.60")
  $w.find("input.bir-rate").off("blur").on("blur", function () {
    normalize_rate_input(this);
  });
}

function bind_apply_row_value(frm) {
  const $w = frm.fields_dict.item_budget_rates_display.$wrapper;

  $w.find(".bir-apply-row").off("click").on("click", function () {
    const item = $(this).data("item");
    const $set = $w.find(`input.bir-row-set[data-item="${item}"]`);
    const raw = ($set.val() || "").trim();
    if (!raw) return;

    const n = parse_rate(raw);
    const formatted = format_rate(n);

    // Apply to all cost centers in this item row
    $w.find(`input.bir-rate[data-item="${item}"]`).each(function () {
      this.value = formatted;
    });

    // Normalize the "Set all" input itself
    $set.val(formatted);
  });
}


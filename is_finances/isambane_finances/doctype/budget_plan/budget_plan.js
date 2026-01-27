console.log("[Budget Plan JS] loaded (summary-only editing)");

frappe.ui.form.on("Budget Plan", {
  setup(frm) {
    // Summary-only UX; main Budget Presentation HTML is hidden
  },

  refresh(frm) {
    console.log("[Budget Plan JS] refresh");

    // ✅ Hide main Budget Presentation grid (editing is done via Summary drill-down)
    frm.toggle_display("budget_presentation", false);


// ✅ Pull in any newly-added Budget Rates items (creates 12 rows per missing item with qty=0)
frm.add_custom_button("Sync Budget Rates & Benchmarks", async () => {
  if (frm.is_new() || frm.doc.__islocal) {
    frappe.msgprint("Please save the Budget Plan first.");
    return;
  }
  if (!frm.doc.fiscal_year || !frm.doc.company || !frm.doc.cost_center) {
    frappe.msgprint("Please select Fiscal Year, Company and Cost Center first.");
    return;
  }

  const months = await build_fy_months_codes(frm);
  frappe.dom.freeze("Syncing budget rates & benchmarks…");
  try {
    // Fetch the item list from Budget Rates for this FY/Company/Cost Center
    const res = await frappe.call({
      method: "is_finances.isambane_finances.doctype.budget_plan.budget_plan.get_budget_rates_for_cost_center",
      args: {
        fiscal_year: frm.doc.fiscal_year,
        company: frm.doc.company,
        cost_center: frm.doc.cost_center
      }
    });

    const rates = res?.message || [];
    const rateItems = Array.from(new Set(rates.map(r => r.item).filter(Boolean)));

    // Existing items already in this budget plan
    const existingItems = new Set((frm.doc.lines || []).map(d => d.item_code).filter(Boolean));

    const missingItems = rateItems.filter(it => !existingItems.has(it));
    if (!missingItems.length) {
      // Even if there are no new items, benchmarks or other reference data may have changed.
      // Refresh the summary to pull the latest Budget Benchmark / calculations from the server.
      await frm.trigger("render_summary_html");
      frappe.show_alert({ message: "No new items found. Benchmarks refreshed.", indicator: "green" });
      return;
    }

    // Create 12 lines per missing item (qty=0). Rates will be resolved via server logic when needed.
    missingItems.forEach(item => {
      months.forEach(m => {
        frm.add_child("lines", {
          month: m,
          item_code: item,
          qty: 0,
          custom_budget_rate: 0,
          amount: 0,
          cost_center: frm.doc.cost_center || null,
          project: frm.doc.project || null
        });
      });
    });

    frm.refresh_field("lines");

    await frm.save();
    await frm.trigger("render_summary_html");

    frappe.show_alert({
      message: `Synced ${missingItems.length} new item(s) × 12 months and refreshed benchmarks.`,
      indicator: "green"
    });
  } catch (e) {
    console.error("[Budget Plan] Sync New Items failed", e);
    frappe.msgprint("Sync failed. Check console.");
  } finally {
    frappe.dom.unfreeze();
  }
});

    // --- Equipment Info ---
    frm.trigger("sync_equipment_location");
    frm.trigger("render_equipment_info_html");

    // ✅ Render summary on refresh
    frm.trigger("render_summary_html");
  },

  after_save(frm) {
    // ✅ re-render after save
    frm.trigger("sync_equipment_location");
    frm.trigger("render_equipment_info_html");
    frm.trigger("render_summary_html");
  },

  fiscal_year(frm) {
    frm.trigger("render_summary_html");
  },

  company(frm) {
    frm.trigger("render_equipment_info_html");
    frm.trigger("render_summary_html");
  },

  cost_center(frm) {
    frm.trigger("sync_equipment_location");
    frm.trigger("render_equipment_info_html");
    frm.trigger("render_summary_html");
  },

// -------- Equipment Info --------

async sync_equipment_location(frm) {
  // Populate equipment_location from submitted Site Code for the selected cost_center
  if (!frm.doc.cost_center) return;
  if (frm.doc.equipment_location) return; // keep user's override

  try {
    const r = await frappe.call({
      method: "is_finances.isambane_finances.doctype.budget_plan.budget_plan.get_site_code_location",
      args: { cost_center: frm.doc.cost_center }
    });

    const sc = r?.message;
    if (sc?.location) {
      await frm.set_value("equipment_location", sc.location);
    }
  } catch (e) {
    console.warn("[Budget Plan] sync_equipment_location failed", e);
  }
},

async render_equipment_info_html(frm) {
  const $w = frm.fields_dict.equipment_info_html?.$wrapper;
  if (!$w) return;

  if (frm.is_new() || frm.doc.__islocal) {
    $w.html(`<div class="text-muted">Save the document to load equipment info.</div>`);
    return;
  }

  $w.html(`<div class="text-muted">Loading equipment info…</div>`);

  try {
    const res = await frappe.call({
      method: "is_finances.isambane_finances.doctype.budget_plan.budget_plan.get_equipment_info_payload",
      args: { docname: frm.doc.name }
    });

    const payload = res?.message || {};
    const rows = payload.rows || [];

    // If server suggests a location and the doc is blank, set it (no auto-save)
    if (!frm.doc.equipment_location && payload.suggested_equipment_location) {
      await frm.set_value("equipment_location", payload.suggested_equipment_location);
    }

    // Ensure child rows exist so we can persist budgeted_count values
    const existing = new Map((frm.doc.equipment_info || []).map(r => [r.asset_category, r]));
    rows.forEach(r => {
      if (!r.asset_category) return;
      if (!existing.has(r.asset_category)) {
        const child = frm.add_child("equipment_info", {
          asset_category: r.asset_category,
          current_count: flt(r.current_count || 0),
          budgeted_count: flt(r.budgeted_count || 0)
        });
        existing.set(r.asset_category, child);
      }
    });

    // Update current_count in the doc (read-only to user in UI)
    (frm.doc.equipment_info || []).forEach(ch => {
      const rr = rows.find(x => x.asset_category === ch.asset_category);
      if (!rr) return;
      frappe.model.set_value(ch.doctype, ch.name, "current_count", flt(rr.current_count || 0));
    });

    frm.refresh_field("equipment_info");

    const locTxt = esc(payload.equipment_location || frm.doc.equipment_location || "");
    const subtitle = locTxt ? `Location: <b>${locTxt}</b>` : `Location: <span class="text-muted">Not set</span>`;

    const style = `
      <style>
        .bp-eq { font-size: 11px; }
        .bp-eq .bp-eq-top { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
        .bp-eq table { width:auto; min-width:520px; border-collapse:collapse; table-layout:fixed; }
        .bp-eq th, .bp-eq td { border:1px solid #e5eaee; padding:4px 6px; white-space:nowrap; }
        .bp-eq th { background:#f7f9fb; text-align:left; }
        .bp-eq td.num, .bp-eq th.num { text-align:right; }
        .bp-eq th.col-cat { width: 260px; }
        .bp-eq th.col-cur { width: 110px; }
        .bp-eq th.col-bud { width: 130px; }
        .bp-eq th.col-act { width: 120px; }
        .bp-eq input.bp-eq-budget { max-width: 110px; text-align:right; padding:2px 6px; height: 26px; }
        .bp-eq .btn.btn-xs { padding: 2px 6px; font-size: 11px; line-height: 1.2; }
      </style>
    `;


    const body = rows.map(r => {
      const cur = cint(r.current_count || 0);
      const bud = cint(r.budgeted_count || 0);
      return `
      <tr data-cat="${esc(r.asset_category)}" data-current="${cur}">
        <td>${esc(r.asset_category)}</td>
        <td class="num"><b>${cur}</b></td>
        <td class="num">
          <input type="number"
                 class="form-control input-sm bp-eq-budget"
                 value="${bud || 0}"
                 min="0"
                 step="1"
                 inputmode="numeric" />
        </td>
        <td class="num">
          <button type="button" class="btn btn-xs btn-default bp-eq-copy">Copy</button>
        </td>
      </tr>
    `;
    }).join("");;

    $w.html(`
      ${style}
      <div class="bp-eq">
        <div class="bp-eq-top">
          <div>${subtitle}</div>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <button type="button" class="btn btn-sm btn-default bp-eq-refresh">Refresh Counts</button>
            <button type="button" class="btn btn-sm btn-default bp-eq-copyall">Copy Current → Budget</button>
            <button type="button" class="btn btn-sm btn-primary bp-eq-save">Save Budget Counts</button>
            <span class="text-muted" style="margin-left:6px;">Current Count updates from submitted Assets (docstatus=1).</span>
          </div>
        </div>

        <div style="overflow:auto; border:1px solid #e5eaee; border-radius:8px;">
          <table>
            <thead>
              <tr>
                <th class="col-cat">Asset Category</th>
                <th class="num col-cur">Current Count</th>
                <th class="num col-bud">Budget Count</th>
                <th class="num col-act">Action</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
    `);

    // Bind buttons
    $w.off("click", ".bp-eq-refresh").on("click", ".bp-eq-refresh", async () => {
      await frm.trigger("render_equipment_info_html");
    });

    // Copy current count into budget input (per row)
    $w.off("click", ".bp-eq-copy").on("click", ".bp-eq-copy", function () {
      const $tr = $(this).closest("tr[data-cat]");
      const cur = cint($tr.data("current") || 0);
      $tr.find("input.bp-eq-budget").val(cur).trigger("change");
    });

    // Copy current counts into all budget inputs
    $w.off("click", ".bp-eq-copyall").on("click", ".bp-eq-copyall", function () {
      $w.find("tr[data-cat]").each(function () {
        const cur = cint($(this).data("current") || 0);
        $(this).find("input.bp-eq-budget").val(cur).trigger("change");
      });
    });

    $w.off("click", ".bp-eq-save").on("click", ".bp-eq-save", async () => {
      try {
        // Push edited budgeted_count values into child table
        $w.find("tr[data-cat]").each(function () {
          const cat = $(this).data("cat");
          const raw = $(this).find("input.bp-eq-budget").val();
          const n = parseInt(String(raw || '').replace(/\s+/g,''), 10);
          const val = isNaN(n) ? 0 : n;

          const child = (frm.doc.equipment_info || []).find(r => r.asset_category === cat);
          if (child) {
            frappe.model.set_value(child.doctype, child.name, "budgeted_count", cint(val));
          }
        });

        await frm.save();
        frappe.show_alert({ message: "Budgeted counts saved.", indicator: "green" });
      } catch (e) {
        console.error("[Budget Plan] saving budgeted counts failed", e);
        frappe.msgprint("Save failed. Check console.");
      }
    });

    // Normalize budget inputs to whole numbers on blur
    $w.off("blur", "input.bp-eq-budget").on("blur", "input.bp-eq-budget", function () {
      const n = parseInt(String(this.value || "").replace(/\s+/g, ""), 10);
      this.value = isNaN(n) ? 0 : n;
    });

  } catch (e) {
    console.error("[Budget Plan] get_equipment_info_payload failed", e);
    $w.html(`<div class="text-danger">Failed to load equipment info. Check console.</div>`);
  }
},

  equipment_location(frm) {
    frm.trigger("render_equipment_info_html");
  },

  async render_summary_html(frm) {
    console.log("[Budget Plan JS] render_summary_html");

    const $w = frm.fields_dict.summary_html?.$wrapper;
    if (!$w) return;

    // ✅ Prevent server call on unsaved/new documents
    if (frm.is_new() || frm.doc.__islocal) {
      $w.html(`<div class="text-muted">Save the document to load the summary.</div>`);
      return;
    }

    $w.html(`<div class="text-muted">Loading summary…</div>`);

    try {
      const res = await frappe.call({
        method: "is_finances.isambane_finances.doctype.budget_plan.budget_plan.get_budget_plan_summary_html",
        args: { docname: frm.doc.name }
      });

      $w.html(res?.message || `<div class="text-muted">No summary.</div>`);

      // Bind item editor buttons inside the summary HTML
      bind_summary_item_editor(frm);
    } catch (e) {
      console.error("[Budget Plan] get_budget_plan_summary_html failed", e);
      $w.html(`<div class="text-danger">Failed to load summary. Check console.</div>`);
    }
  }
});

/* --------------------- helpers --------------------- */

function flt(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function format_money(n) {
  try {
    return format_currency(n);
  } catch (e) {
    return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
  }
}

function esc(s) {
  return frappe.utils.escape_html(String(s || ""));
}

function parse_qty(v) {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (!s) return 0;

  s = s.replace(/\s+/g, ""); // remove spaces

  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/,/g, "");
  } else if (s.includes(",") && !s.includes(".")) {
    s = s.replace(",", ".");
  }

  s = s.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function format_qty(n) {
  if (n === null || n === undefined || isNaN(n)) return "";
  const fixed = Number(n).toFixed(2);
  const [intPart, decPart] = fixed.split(".");
  const withSpaces = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${withSpaces}.${decPart}`;
}

function normalize_qty_input(el) {
  const raw = (el.value || "").trim();
  if (!raw) return;
  const n = parse_qty(raw);
  el.value = format_qty(n);
}

async function build_fy_months_codes(frm) {
  const codes = ["01-Jan","02-Feb","03-Mar","04-Apr","05-May","06-Jun","07-Jul","08-Aug","09-Sep","10-Oct","11-Nov","12-Dec"];
  let startIdx = 2; // March default

  if (frm.doc.fiscal_year) {
    const fy = await frappe.db.get_value("Fiscal Year", frm.doc.fiscal_year, ["year_start_date"]);
    if (fy?.message?.year_start_date) {
      startIdx = frappe.datetime.str_to_obj(fy.message.year_start_date).getMonth();
    }
  }
  return [...codes.slice(startIdx), ...codes.slice(0, startIdx)];
}

async function build_fy_months_labels(fiscal_year) {
  const r = await frappe.db.get_value("Fiscal Year", fiscal_year, ["year_start_date"]);
  const startStr = r?.message?.year_start_date;

  let start = startStr ? frappe.datetime.str_to_obj(startStr) : new Date(new Date().getFullYear(), 2, 1); // default March
  const codes = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const out = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const mmm = codes[d.getMonth()];
    const yy = String(d.getFullYear()).slice(-2);
    out.push({ code: `${mm}-${mmm}`, label: `${yy}-${mmm}` });
  }
  return out;
}

function upsert_budget_plan_line(frm, item, month, qty, rate, amount) {
  const rows = frm.doc.lines || [];
  let row = rows.find(d => d.item_code === item && d.month === month);

  if (!row) {
    row = frm.add_child("lines", {
      month: month,
      item_code: item,
      qty: qty,
      custom_budget_rate: rate,
      amount: amount,
      cost_center: frm.doc.cost_center || null,
      project: frm.doc.project || null
    });
  }

  frappe.model.set_value(row.doctype, row.name, "qty", qty);
  frappe.model.set_value(row.doctype, row.name, "custom_budget_rate", rate);
  frappe.model.set_value(row.doctype, row.name, "amount", amount);

  frm.dirty();
}

/* ---------------- Summary Item Editor (drill-down) ---------------- */

function bind_summary_item_editor(frm) {
  if (frm._bp_summary_editor_bound) return;
  frm._bp_summary_editor_bound = true;

  const $w = frm.fields_dict.summary_html?.$wrapper;
  if (!$w) return;

  // event delegation (summary HTML is replaced often)
  $w.off("click", ".bp-edit-item").on("click", ".bp-edit-item", function (e) {
    e.preventDefault();
    const item = $(this).data("item");
    const label = $(this).data("label") || item;
    if (!item) return;

    open_item_month_editor(frm, item, label);
  });
}

async function fetch_item_month_rates(frm, item) {
  const res = await frappe.call({
    method: "is_finances.isambane_finances.doctype.budget_plan.budget_plan.get_item_month_rates",
    args: { docname: frm.doc.name, item: item }
  });

  return (res?.message || []).map(r => ({
    month: r.month,
    rate: flt(r.rate)
  }));
}

async function open_item_month_editor(frm, item, label) {
  if (!frm.doc.fiscal_year || !frm.doc.company) {
    frappe.msgprint("Please select Fiscal Year and Company first.");
    return;
  }

  // Always edit all 12 FY-aligned months
  const monthCodes = await build_fy_months_codes(frm); // e.g. ["03-Mar", ...]
  const monthLabels = await build_fy_months_labels(frm.doc.fiscal_year); // [{code,label}]
  const labelMap = new Map((monthLabels || []).map(x => [x.code, x.label]));

  // Snapshot of existing lines for initial display
  const lineMap = new Map();
  (frm.doc.lines || []).forEach(d => {
    if (!d.item_code || !d.month) return;
    lineMap.set(`${d.item_code}||${d.month}`, d);
  });

  let monthRatesList = await fetch_item_month_rates(frm, item);
  let monthRateMap = new Map((monthRatesList || []).map(r => [r.month, flt(r.rate)]));

  const d = new frappe.ui.Dialog({
    title: `Edit Budget Qty: ${label}`,
    fields: [
      { fieldname: "info", fieldtype: "HTML" },
      { fieldname: "grid", fieldtype: "HTML" }
    ],
    primary_action_label: "Save",
    primary_action: async () => {
      try {
        monthCodes.forEach(mc => {
          const $inp = d.$wrapper.find(`input.bp-edit-qty[data-month="${esc(mc)}"]`);
          const qty = parse_qty($inp.val());

          const rate = flt(monthRateMap.get(mc) || 0);
          const amount = qty * rate;

          upsert_budget_plan_line(frm, item, mc, qty, rate, amount);
        });

        await frm.save();
        await frm.trigger("render_summary_html");
        frappe.show_alert({ message: "Saved and updated summary.", indicator: "green" });
        d.hide();
      } catch (e) {
        console.error("[Budget Plan] item editor save failed", e);
        frappe.msgprint("Save failed. Check console.");
      }
    }
  });

  function render() {
    const style = `
      <style>
        .bp-edit-wrap { max-height: 60vh; overflow:auto; border:1px solid #e5eaee; border-radius:8px; }
        .bp-edit-table { width:100%; border-collapse:collapse; }
        .bp-edit-table th, .bp-edit-table td { border:1px solid #e5eaee; padding:8px; white-space:nowrap; }
        .bp-edit-table th { position: sticky; top: 0; background:#f7f9fb; z-index:2; }
        .bp-edit-qty { width: 160px; text-align:right; }
        .bp-edit-amt { font-weight:600; }
        .bp-edit-top { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
        .bp-edit-muted { opacity:.75; }
      </style>
    `;

    d.set_value("info", `
      ${style}
      <div class="bp-edit-top">
        <div>Rates: <b>per month</b></div>
        <button type="button" class="btn btn-sm btn-default bp-edit-update-rate">Update Rates</button>
        <span class="bp-edit-muted">Edit qty for all 12 months. Save to update reporting.</span>
      </div>
    `);

    const rows = monthCodes.map(mc => {
      const key = `${item}||${mc}`;
      const line = lineMap.get(key);

      const qty = flt(line?.qty || 0);
      const rate = flt(monthRateMap.get(mc) || 0);
      const amount = qty * rate;

      return `
        <tr>
          <td>${frappe.utils.escape_html(labelMap.get(mc) || mc)}</td>
          <td style="text-align:right;"><b class="bp-edit-rate" data-month="${esc(mc)}">${format_money(rate)}</b></td>
          <td>
            <input type="text"
                   inputmode="decimal"
                   class="form-control input-sm bp-edit-qty"
                   data-month="${esc(mc)}"
                   value="${format_qty(qty)}"
                   placeholder="0.00" />
          </td>
          <td class="bp-edit-amt">
            <span class="bp-edit-amt-val" data-month="${esc(mc)}">${format_money(amount)}</span>
          </td>
        </tr>
      `;
    }).join("");

    d.set_value("grid", `
      <div class="bp-edit-wrap">
        <table class="bp-edit-table">
          <thead>
            <tr>
              <th style="text-align:left;">Month</th>
              <th style="text-align:right;">Rate</th>
              <th style="text-align:right;">Qty</th>
              <th style="text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);

    // Normalize qty formatting on blur
    d.$wrapper.find("input.bp-edit-qty").off("blur").on("blur", function () {
      normalize_qty_input(this);
    });

    // Live amount calc
    d.$wrapper.off("input", ".bp-edit-qty").on("input", ".bp-edit-qty", function () {
      const mc = $(this).data("month");
      const qty = parse_qty($(this).val());
      const rate = flt(monthRateMap.get(mc) || 0);
      const amt = qty * rate;
      d.$wrapper.find(`.bp-edit-amt-val[data-month="${esc(mc)}"]`).text(format_money(amt));
    });

    // Update Rates button: refresh per-month rates from server
    d.$wrapper.find(".bp-edit-update-rate").off("click").on("click", async () => {
      frappe.dom.freeze("Updating rates…");
      try {
        monthRatesList = await fetch_item_month_rates(frm, item);
        monthRateMap = new Map((monthRatesList || []).map(r => [r.month, flt(r.rate)]));

        // Re-render rate + amount for each month (keep qty as typed)
        d.$wrapper.find("input.bp-edit-qty").each(function () {
          const mc = $(this).data("month");
          const qty = parse_qty($(this).val());
          const rate = flt(monthRateMap.get(mc) || 0);
          const amt = qty * rate;

          d.$wrapper.find(`.bp-edit-rate[data-month="${esc(mc)}"]`).text(format_money(rate));
          d.$wrapper.find(`.bp-edit-amt-val[data-month="${esc(mc)}"]`).text(format_money(amt));
        });

        frappe.show_alert({ message: "Rates updated.", indicator: "green" });
      } finally {
        frappe.dom.unfreeze();
      }
    });
  }

  d.show();
  render();
}

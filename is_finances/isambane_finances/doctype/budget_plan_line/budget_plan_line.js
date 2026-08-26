frappe.ui.form.on("Budget Plan Line", {
  async item_code(frm, cdt, cdn) {
    const row = frappe.get_doc(cdt, cdn);
    if (!row.item_code) return;

    // Pull key fields from Item
    const it = await frappe.db.get_value("Item", row.item_code,
      ["item_group", "stock_uom", "isf_budget_rate", "standard_rate", "isf_is_bcm"]);
    const item = it?.message || {};

    if (item.item_group !== "Budget Items") {
      frappe.msgprint(__("Only Items in Item Group = 'Budget Items' may be budgeted."));
      frappe.model.set_value(cdt, cdn, "item_code", null);
      return;
    }

    // Apply name, UOM, and rate
    frappe.model.set_value(cdt, cdn, "uom", item.stock_uom || "");
    let rate = 0;

    // 1️⃣ Try Cost Center–specific rate first
    if (frm.doc.cost_center) {
      const r = await frappe.db.get_value("Item Budget Rate",
        { item: row.item_code, cost_center: frm.doc.cost_center },
        ["budget_rate"]
      );
      if (r?.message?.budget_rate) rate = flt(r.message.budget_rate);
    }

    // 2️⃣ Fallback to item.isf_budget_rate / standard_rate
    if (!rate) rate = flt(item.isf_budget_rate) || flt(item.standard_rate) || 0;

    if (!row.custom_budget_rate) frappe.model.set_value(cdt, cdn, "custom_budget_rate", rate);
    frappe.model.set_value(cdt, cdn, "amount", (flt(row.qty) || 0) * (flt(row.custom_budget_rate) || rate));

    // BCM guardrails
    if (item.isf_is_bcm) {
      frappe.model.set_value(cdt, cdn, "uom", "BCM");
      frappe.show_alert({ message: __("BCM item: UOM set to BCM."), indicator: "blue" });
      if (row.asset) frappe.model.set_value(cdt, cdn, "asset", null);
      if (!row.cost_center && frm.doc.cost_center)
        frappe.model.set_value(cdt, cdn, "cost_center", frm.doc.cost_center);
    }
  },

  qty(frm, cdt, cdn) {
    const r = frappe.get_doc(cdt, cdn);
    frappe.model.set_value(cdt, cdn, "amount", (flt(r.qty) || 0) * (flt(r.custom_budget_rate) || 0));
  },

  custom_budget_rate(frm, cdt, cdn) {
    const r = frappe.get_doc(cdt, cdn);
    frappe.model.set_value(cdt, cdn, "amount", (flt(r.qty) || 0) * (flt(r.custom_budget_rate) || 0));
  },

  async asset(frm, cdt, cdn) {
    const row = frappe.get_doc(cdt, cdn);
    if (!row.asset) return;

    const a = await frappe.db.get_value("Asset", row.asset, ["location"]);
    const loc = a?.message?.location;
    if (!loc) {
      frappe.msgprint(__("Asset {0} has no Location set.", [row.asset]));
      return;
    }

    const L = await frappe.db.get_value("Location", loc, ["isf_linked_cost_center"]);
    const cc = L?.message?.isf_linked_cost_center;
    if (!cc) {
      frappe.msgprint(__("Location {0} has no Linked Cost Center set.", [loc]));
      return;
    }

    if (!row.cost_center || row.cost_center !== cc) {
      frappe.model.set_value(cdt, cdn, "cost_center", cc);
      frappe.show_alert({ message: __("Cost Center set from Asset Location ({0})", [cc]), indicator: "blue" });
    }
  }
});

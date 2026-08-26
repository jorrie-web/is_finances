frappe.ui.form.on("Budget Headcount Rates", {
  async designation(frm, cdt, cdn) {
    const row = frappe.get_doc(cdt, cdn);
    if (!row.designation) return;

    const d = await frappe.db.get_value("Designation", row.designation, ["isf_monthly_ctc"]);
    const ctc = flt(d?.message?.isf_monthly_ctc) || 0;
    if (!row.average_monthly_ctc) frappe.model.set_value(cdt, cdn, "average_monthly_ctc", ctc);
    frappe.model.set_value(cdt, cdn, "amount", (flt(row.headcount) || 0) * (flt(row.average_monthly_ctc) || ctc));
  },

  headcount(frm, cdt, cdn) {
    const r = frappe.get_doc(cdt, cdn);
    frappe.model.set_value(cdt, cdn, "amount", (flt(r.headcount) || 0) * (flt(r.average_monthly_ctc) || 0));
  },

  average_monthly_ctc(frm, cdt, cdn) {
    const r = frappe.get_doc(cdt, cdn);
    frappe.model.set_value(cdt, cdn, "amount", (flt(r.headcount) || 0) * (flt(r.average_monthly_ctc) || 0));
  }
});

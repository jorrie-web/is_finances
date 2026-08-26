// Copyright (c) 2026, Isambane Mining and contributors
// For license information, please see license.txt

frappe.ui.form.on("IS Forecast Scenario", {
    refresh(frm) {
        set_end_month_preview(frm);
    },

    forecast_start_month(frm) {
        normalise_start_month(frm);
        set_end_month_preview(frm);
    },

    horizon_months(frm) {
        set_end_month_preview(frm);
    }
});

function normalise_start_month(frm) {
    if (!frm.doc.forecast_start_month) return;

    const parts = frm.doc.forecast_start_month.split("-");
    if (parts.length !== 3) return;

    const first_of_month = `${parts[0]}-${parts[1]}-01`;
    if (frm.doc.forecast_start_month !== first_of_month) {
        frm.set_value("forecast_start_month", first_of_month);
    }
}

function set_end_month_preview(frm) {
    if (!frm.doc.forecast_start_month || !frm.doc.horizon_months) return;

    const months = parseInt(frm.doc.horizon_months, 10);
    if (!Number.isFinite(months) || months < 1) return;

    const [year, month] = frm.doc.forecast_start_month.split("-").map(Number);
    const d = new Date(year, month - 1 + months - 1, 1);
    const end_month = [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, "0"),
        "01"
    ].join("-");

    frm.set_value("forecast_end_month", end_month);
}

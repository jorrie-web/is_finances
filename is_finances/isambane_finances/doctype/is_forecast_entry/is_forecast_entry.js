// Copyright (c) 2026, Isambane Mining and contributors
// For license information, please see license.txt

frappe.ui.form.on("IS Forecast Entry", {
    setup(frm) {
        frm.set_query("forecast_scenario", () => ({
            filters: {
                status: "Draft",
                is_active: 1
            }
        }));

        frm.set_query("account", () => ({
            filters: {
                company: frm.doc.company || "",
                is_group: 0,
                report_type: "Profit and Loss"
            }
        }));

        frm.set_query("cost_center", () => ({
            filters: {
                company: frm.doc.company || "",
                is_group: 0
            }
        }));
    },

    refresh(frm) {
        frm.set_df_property("company", "read_only", 1);
        update_driver_fields(frm);
    },

    forecast_scenario(frm) {
        if (!frm.doc.forecast_scenario) {
            frm.set_value("company", null);
            return;
        }

        frappe.db.get_value(
            "IS Forecast Scenario",
            frm.doc.forecast_scenario,
            ["company", "status"]
        ).then(r => {
            const values = r.message || {};
            if (values.company) {
                frm.set_value("company", values.company);
            }
        });
    },

    account(frm) {
        // Fetch From fields are populated by Frappe. Refresh the driver UI
        // after the linked Account metadata has arrived.
        setTimeout(() => update_driver_fields(frm), 100);
    },

    forecast_method(frm) {
        update_driver_fields(frm);
        calculate_amount(frm);
    },

    volume(frm) {
        calculate_amount(frm);
    },

    price_per_unit(frm) {
        calculate_amount(frm);
    }
});

function is_volume_price(frm) {
    const method = (frm.doc.forecast_method || "").trim().toLowerCase();
    return method === "volume x price" || method === "volume × price";
}

function update_driver_fields(frm) {
    const driver_based = is_volume_price(frm);

    frm.toggle_display("volume", driver_based);
    frm.toggle_display("volume_uom", driver_based);
    frm.toggle_display("price_per_unit", driver_based);
    frm.set_df_property("forecast_amount", "read_only", driver_based ? 1 : 0);
    frm.refresh_field("forecast_amount");
}

function calculate_amount(frm) {
    if (!is_volume_price(frm)) return;

    const volume = Number(frm.doc.volume || 0);
    const price = Number(frm.doc.price_per_unit || 0);
    const amount = volume * price;

    frm.set_value("forecast_amount", amount);

    if (!frm.doc.input_source || frm.doc.input_source === "Manual") {
        frm.set_value("input_source", "Volume x Price");
    }
}

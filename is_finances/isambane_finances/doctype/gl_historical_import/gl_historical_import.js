// Copyright (c) 2026, Isambane Mining and contributors
// For license information, please see license.txt

frappe.ui.form.on("GL Historical Import", {
    refresh(frm) {
        frm.trigger("set_line_queries");
        frm.trigger("render_gl_historical_importer");
    },

    import_year(frm) {
        frm.trigger("render_gl_historical_importer");
    },

    excel_file(frm) {
        frm.trigger("render_gl_historical_importer");
    },

    company(frm) {
        frm.trigger("set_line_queries");
    },

    set_line_queries(frm) {
        frm.set_query("account_number", "gl_historical_lines", function () {
            return {
                filters: {
                    company: frm.doc.company,
                    root_type: ["in", ["Income", "Expense"]]
                }
            };
        });

        frm.set_query("cost_center_number", "gl_historical_lines", function () {
            return {
                filters: {
                    company: frm.doc.company
                }
            };
        });
    },

    render_gl_historical_importer(frm) {
        if (!frm.fields_dict.gl_historical_display) return;

        const wrapper = frm.fields_dict.gl_historical_display.$wrapper;
        const year = cint(frm.doc.import_year || new Date().getFullYear());
        const savedMonths = parse_saved_months(frm.doc.import_months);
        const months = [
            [1, "Jan"], [2, "Feb"], [3, "Mar"], [4, "Apr"],
            [5, "May"], [6, "Jun"], [7, "Jul"], [8, "Aug"],
            [9, "Sep"], [10, "Oct"], [11, "Nov"], [12, "Dec"]
        ];

        const monthBoxes = months.map(([value, label]) => {
            const checked = savedMonths.includes(value) ? "checked" : "";
            return `
                <label class="checkbox-inline" style="min-width: 88px; margin: 0 8px 8px 0;">
                    <input type="checkbox" class="glh-month" value="${value}" ${checked}> ${label} ${year}
                </label>
            `;
        }).join("");

        const html = `
            <div class="glh-import-panel" style="border:1px solid #d1d8dd; border-radius:6px; padding:12px; margin-bottom:12px;">
                <h4 style="margin-top:0;">GL Historical Import</h4>
                <p class="text-muted" style="margin-bottom:10px;">
                    Select the month or months to import from the attached Statement of Comprehensive Income file.
                </p>
                <div style="margin-bottom:10px;">${monthBoxes}</div>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button class="btn btn-default btn-sm" data-action="glh-select-all">Select All</button>
                    <button class="btn btn-default btn-sm" data-action="glh-clear">Clear</button>
                    <button class="btn btn-primary btn-sm" data-action="glh-preview">Preview Control Totals</button>
                    <button class="btn btn-success btn-sm" data-action="glh-import">Import Lines</button>
                </div>
                <div class="glh-message" style="margin-top:10px;"></div>
            </div>
            <div class="glh-results"></div>
        `;

        wrapper.html(html);

        wrapper.find('[data-action="glh-select-all"]').on("click", () => {
            wrapper.find(".glh-month").prop("checked", true);
        });

        wrapper.find('[data-action="glh-clear"]').on("click", () => {
            wrapper.find(".glh-month").prop("checked", false);
        });

        wrapper.find('[data-action="glh-preview"]').on("click", () => {
            frm.trigger("preview_gl_historical_import");
        });

        wrapper.find('[data-action="glh-import"]').on("click", () => {
            frm.trigger("import_gl_historical_lines");
        });

        if (frm.doc.excel_file && frm.doc.import_months) {
            frappe.call({
                method: "is_finances.isambane_finances.doctype.gl_historical_import.gl_historical_import.get_gl_historical_summary",
                args: { docname: frm.doc.name },
                callback(r) {
                    if (r.message && r.message.html) {
                        wrapper.find(".glh-results").html(r.message.html);
                    }
                }
            });
        }
    },

    preview_gl_historical_import(frm) {
        const selectedMonths = get_selected_months(frm);
        if (!validate_import_inputs(frm, selectedMonths)) return;

        frm.fields_dict.gl_historical_display.$wrapper.find(".glh-message").html(
            `<div class="text-muted">Reading Excel file and checking control totals...</div>`
        );

        frappe.call({
            method: "is_finances.isambane_finances.doctype.gl_historical_import.gl_historical_import.preview_gl_historical_import",
            args: {
                docname: frm.doc.name,
                selected_months: JSON.stringify(selectedMonths)
            },
            freeze: true,
            freeze_message: "Previewing GL Historical import...",
            callback(r) {
                const wrapper = frm.fields_dict.gl_historical_display.$wrapper;
                if (r.message) {
                    wrapper.find(".glh-results").html(r.message.html || "");
                    wrapper.find(".glh-message").html(`<div class="text-info">Preview complete.</div>`);
                    frm.reload_doc();
                }
            }
        });
    },

    import_gl_historical_lines(frm) {
        const selectedMonths = get_selected_months(frm);
        if (!validate_import_inputs(frm, selectedMonths)) return;

        frappe.call({
            method: "is_finances.isambane_finances.doctype.gl_historical_import.gl_historical_import.check_existing_company_month_data",
            args: {
                docname: frm.doc.name,
                selected_months: JSON.stringify(selectedMonths)
            },
            freeze: true,
            freeze_message: "Checking existing company/month data...",
            callback(r) {
                const duplicateInfo = r.message || {};

                if (duplicateInfo.has_duplicates) {
                    show_duplicate_choice_dialog(frm, selectedMonths, duplicateInfo);
                    return;
                }

                frappe.confirm(
                    "This will clear and rebuild the GL Historical Lines child table for this import record. Continue?",
                    () => run_gl_historical_import(frm, selectedMonths, null)
                );
            }
        });
    }
});

function get_selected_months(frm) {
    const wrapper = frm.fields_dict.gl_historical_display.$wrapper;
    return wrapper.find(".glh-month:checked").map(function () {
        return cint($(this).val());
    }).get();
}

function validate_import_inputs(frm, selectedMonths) {
    if (frm.is_new()) {
        frappe.msgprint("Please save the GL Historical Import record before preview/import.");
        return false;
    }
    if (!frm.doc.company) {
        frappe.msgprint("Please select Company.");
        return false;
    }
    if (!frm.doc.import_year) {
        frappe.msgprint("Please enter Import Year.");
        return false;
    }
    if (!frm.doc.excel_file) {
        frappe.msgprint("Please attach the Excel file.");
        return false;
    }
    if (!selectedMonths.length) {
        frappe.msgprint("Please select at least one month.");
        return false;
    }
    return true;
}

function show_duplicate_choice_dialog(frm, selectedMonths, duplicateInfo) {
    const duplicates = duplicateInfo.duplicates || [];
    const rows = duplicates.map(d => `
        <tr>
            <td>${frappe.utils.escape_html(d.month_label || "")}</td>
            <td>${frappe.utils.escape_html(d.import_name || "")}</td>
            <td>${frappe.utils.escape_html(d.status || "")}</td>
            <td class="text-right">${cint(d.line_count || 0)}</td>
        </tr>
    `).join("");

    const dialog = new frappe.ui.Dialog({
        title: "Existing Company/Month Data Found",
        fields: [
            {
                fieldtype: "HTML",
                fieldname: "duplicate_warning",
                options: `
                    <p>The selected company and month data already exists in another GL Historical Import.</p>
                    <table class="table table-bordered table-condensed">
                        <thead>
                            <tr>
                                <th>Month</th>
                                <th>Existing Import</th>
                                <th>Status</th>
                                <th class="text-right">Lines</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                    <p><b>Keep Existing</b> stops this import and leaves the old data unchanged.</p>
                    <p><b>Replace Existing</b> deletes the matching month lines from the old import batches and imports this file.</p>
                `
            }
        ],
        primary_action_label: "Replace Existing",
        primary_action() {
            dialog.hide();
            frappe.confirm(
                "Replace existing company/month data in the other import records and import this file?",
                () => run_gl_historical_import(frm, selectedMonths, "replace")
            );
        },
        secondary_action_label: "Keep Existing",
        secondary_action() {
            dialog.hide();
            run_gl_historical_import(frm, selectedMonths, "keep");
        }
    });

    dialog.show();
}

function run_gl_historical_import(frm, selectedMonths, duplicateAction) {
    const args = {
        docname: frm.doc.name,
        selected_months: JSON.stringify(selectedMonths)
    };

    if (duplicateAction) {
        args.duplicate_action = duplicateAction;
    }

    frappe.call({
        method: "is_finances.isambane_finances.doctype.gl_historical_import.gl_historical_import.import_gl_historical",
        args: args,
        freeze: true,
        freeze_message: "Importing GL Historical lines...",
        callback(r) {
            const wrapper = frm.fields_dict.gl_historical_display.$wrapper;
            if (!r.message) return;

            wrapper.find(".glh-results").html(r.message.html || "");

            if (r.message.requires_duplicate_decision) {
                show_duplicate_choice_dialog(frm, selectedMonths, r.message);
                return;
            }

            if (r.message.kept_existing) {
                frappe.show_alert({ message: "Existing data kept. Import was not run.", indicator: "orange" });
                frm.reload_doc();
                return;
            }

            const imported = cint(r.message.imported || 0);
            if (r.message.errors && r.message.errors.length) {
                const errorList = (r.message.errors || []).map(e => `<li>${frappe.utils.escape_html(e)}</li>`).join("");
                frappe.msgprint({
                    title: imported > 0 ? "Import Completed With Differences" : "Import Failed",
                    indicator: "red",
                    message: `
                        <p>Imported rows: ${imported}.</p>
                        <p>Please review the details below and in the control-total table.</p>
                        <ul>${errorList}</ul>
                    `
                });
            } else {
                frappe.show_alert({ message: `Imported ${imported} GL Historical lines.`, indicator: "green" });
            }
            frm.reload_doc();
        }
    });
}

function parse_saved_months(importMonths) {
    if (!importMonths) return [];
    const monthMap = {
        jan: 1, january: 1,
        feb: 2, february: 2,
        mar: 3, march: 3,
        apr: 4, april: 4,
        may: 5,
        jun: 6, june: 6,
        jul: 7, july: 7,
        aug: 8, august: 8,
        sep: 9, sept: 9, september: 9,
        oct: 10, october: 10,
        nov: 11, november: 11,
        dec: 12, december: 12
    };

    return importMonths.split(",").map(part => {
        const monthText = (part.trim().split(/\s+/)[0] || "").toLowerCase();
        return monthMap[monthText];
    }).filter(Boolean);
}

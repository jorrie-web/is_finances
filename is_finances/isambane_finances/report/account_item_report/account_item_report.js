// Copyright (c) 2025, Isambane Mining and contributors
// For license information, please see license.txt

// Copyright (c) 2025, Isambane Mining and contributors
// For license information, please see license.txt

// account_item_report.js

frappe.query_reports["Account-Item Report"] = {
    filters: [
        {
            fieldname: "item_group",
            label: __("Item Group"),
            fieldtype: "Link",
            options: "Item Group"
        },
        {
            fieldname: "company",
            label: __("Company"),
            fieldtype: "Link",
            options: "Company"
            // You *can* add a default like:
            // default: frappe.defaults.get_default("Company")
        }
    ]
};

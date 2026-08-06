frappe.query_reports["Annual IS"] = {
    filters: [
        {
            fieldname: "company",
            label: "Company",
            fieldtype: "Link",
            options: "Company",
            default: "Isambane Mining (Pty) Ltd",
            reqd: 1
        },
        {
            fieldname: "fiscal_year",
            label: "Fiscal Year",
            fieldtype: "Link",
            options: "Fiscal Year",
            reqd: 1
        },
        {
            fieldname: "cost_center_group",
            label: "Cost Center Group",
            fieldtype: "Link",
            options: "Cost Center",
            get_query() {
                return {
                    filters: {
                        company: frappe.query_report.get_filter_value("company"),
                        is_group: 1
                    }
                };
            },
            on_change() {
                frappe.query_report.set_filter_value("cost_center", "");
                frappe.query_report.refresh();
            }
        },
        {
            fieldname: "cost_center",
            label: "Cost Center",
            fieldtype: "Link",
            options: "Cost Center",
            get_query() {
                const company = frappe.query_report.get_filter_value("company");
                const group = frappe.query_report.get_filter_value("cost_center_group");

                if (group) {
                    return {
                        query: "is_finances.isambane_finances.report.annual_is.annual_is.get_child_cost_centers",
                        filters: {
                            company: company,
                            cost_center_group: group
                        }
                    };
                }

                return {
                    filters: {
                        company: company,
                        is_group: 0
                    }
                };
            }
        }
    ],

    formatter(value, row, column, data, default_formatter) {
        value = default_formatter(value, row, column, data);

        if (!data) return value;

        const fieldname = column.fieldname;
        const isCurrency = column.fieldtype === "Currency";
        const rawValue = data[fieldname];

        if (isCurrency && rawValue < 0) {
            value = `<span style="color:#b42318;">${value}</span>`;
        }

        if (data.is_group) {
            return `
                <div style="
                    background:#eef2ff;
                    color:#1e3a8a;
                    font-weight:700;
                    padding:7px 10px;
                    border-left:5px solid #2563eb;
                    text-transform:uppercase;
                    letter-spacing:.4px;
                ">${value}</div>
            `;
        }

        if (data.is_total) {
            return `
                <div style="
                    background:#f8fafc;
                    font-weight:700;
                    padding:6px 10px;
                    border-top:1px solid #cbd5e1;
                    border-bottom:1px solid #cbd5e1;
                ">${value}</div>
            `;
        }

        if (data.is_profit) {
            return `
                <div style="
                    background:#ecfdf3;
                    color:#05603a;
                    font-weight:800;
                    padding:7px 10px;
                    border-top:2px solid #12b76a;
                ">${value}</div>
            `;
        }

        if (data.is_ebitda) {
            return `
                <div style="
                    background:#fff7ed;
                    color:#9a3412;
                    font-weight:900;
                    padding:8px 10px;
                    border-top:3px double #f97316;
                    border-bottom:3px double #f97316;
                ">${value}</div>
            `;
        }

        if (fieldname === "account" && data.root_type) {
            value = `<span style="padding-left:18px;">${value}</span>`;
        }

        return value;
    }
};
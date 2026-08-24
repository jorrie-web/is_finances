// Copyright (c) 2026, Isambane Mining and contributors
// For license information, please see license.txt

frappe.query_reports["Sage IS"] = {
	filters: [
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
			reqd: 1,
			default: frappe.datetime.year_start()
		},
		{
			fieldname: "to_date",
			label: __("To Date"),
			fieldtype: "Date",
			reqd: 1,
			default: frappe.datetime.get_today()
		},
		{
			fieldname: "show_budget",
			label: __("Show Budget"),
			fieldtype: "Select",
			options: [
				"Yes",
				"No"
			],
			default: "Yes",
			reqd: 1
		}
	],

	onload: function(report) {
		report.page.set_title(__("Income Statement"));
	},

	formatter: function(
		value,
		row,
		column,
		data,
		default_formatter
	) {
		value = default_formatter(
			value,
			row,
			column,
			data
		);

		if (data && data.is_profit_loss) {
			value = `
				<span style="font-weight: 700;">
					${value}
				</span>
			`;
		}

		return value;
	}
};

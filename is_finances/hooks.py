app_name = "is_finances"
app_title = "Isambane Finances"
app_publisher = "Isambane Mining"
app_description = "Internal Financial Management Suite for Isambane Mining"
app_email = "jorrie@isambane.co.za"
app_license = "mit"

add_to_apps_screen = [
	{
		"name": "is-finances",
		"logo": "/assets/is_finances/desktop_icons/is-logo.png",
		"title": "IS Finance",
		"route": "/desk/is-finance",
	}
]

doctype_js = {
	"Payroll Sheet": "public/js/payroll_sheet.js"
}

doc_events = {
	"Payroll Sheet": {
		"validate": "is_finances.payroll_sheet.events.validate_payroll_sheet"
	}
}

scheduler_events = {
	"daily_long": [
		"is_finances.controllers.sage_sync.run_daily_sage_sync",
	],
}

fixtures = [
	{"dt": "Custom Field", "filters": [["name", "in", [
		"Item-isf_is_bcm",
		"Item-isf_budget_rate",
		"Location-isf_linked_cost_center",
		"Designation-isf_monthly_ctc",
		"Account-isf_default_forecast_uom",
		"Account-isf_sage_account_type",
		"Account-isf_report_dimension",
		"Account-isf_forecast_enabled",
		"Account-isf_ebitda_treatment",
		"Account-isf_forecast_method",
	]]]},
]
(() => {
	if (window.__ifdRunGuardInstalled) return;
	window.__ifdRunGuardInstalled = true;

	const ACTUAL_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.is_fin_dashboard.get_dashboard_data';
	const FORECAST_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.is_fin_dashboard.get_forecast_data';
	const FORECAST_ACTUAL_MONTH_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months.get_forecast_data';

	window.__ifdManualRun = window.__ifdManualRun || { actual: false, forecast: false };

	function selectedActualMonths() {
		const el = document.getElementById('ifd-forecast-actual-months');
		return el ? String(el.value || 'auto') : 'auto';
	}

	function emptyActualResponse() {
		return {
			filters: {},
			performance: {},
			sections: [],
			summary: {},
			monthly: [],
			months: []
		};
	}

	function emptyForecastResponse() {
		const cc = document.getElementById('ifd-forecast-cost-centre');
		const fy = document.getElementById('ifd-forecast-fy');
		const scenario = document.getElementById('ifd-forecast-scenario');
		const costCenter = cc ? String(cc.value || '__all__') : '__all__';
		return {
			scenario: {
				name: scenario ? String(scenario.value || '') : '',
				scenario_name: '',
				status: 'Draft'
			},
			filters: {
				cost_center: costCenter,
				cost_center_label: costCenter === '__all__' ? 'All Cost Centres (Consolidated)' : costCenter,
				financial_year: fy ? String(fy.value || '') : '',
				actual_months: selectedActualMonths(),
				actual_months_applied: 0
			},
			editable: false,
			months: [],
			sections: [],
			summary: {},
			monthly: [],
			fy_summary: {},
			fy_monthly: [],
			actuals: { period_label: 'Waiting for Run Forecast', summary: {}, monthly: [] },
			uoms: [],
			performance: { server_runtime_ms: 0, database_runtime_ms: 0, account_count: 0, entry_count: 0 }
		};
	}

	function resolved(options, message) {
		const response = { message };
		if (typeof options.callback === 'function') {
			queueMicrotask(() => options.callback(response));
		}
		return Promise.resolve(response);
	}

	const install = () => {
		if (!window.frappe || !frappe.call || frappe.call.__ifdRunGuard) return false;
		const originalCall = frappe.call;

		const wrapped = function(...args) {
			const options = args[0];
			if (!options || typeof options !== 'object') {
				return originalCall.apply(this, args);
			}

			if (options.method === ACTUAL_METHOD) {
				if (!window.__ifdManualRun.actual) {
					return resolved(options, emptyActualResponse());
				}
				window.__ifdManualRun.actual = false;
				return originalCall.apply(this, args);
			}

			if (options.method === FORECAST_METHOD || options.method === FORECAST_ACTUAL_MONTH_METHOD) {
				if (!window.__ifdManualRun.forecast) {
					return resolved(options, emptyForecastResponse());
				}
				window.__ifdManualRun.forecast = false;
				args[0] = {
					...options,
					method: FORECAST_ACTUAL_MONTH_METHOD,
					args: {
						...(options.args || {}),
						actual_months: selectedActualMonths()
					}
				};
				return originalCall.apply(this, args);
			}

			return originalCall.apply(this, args);
		};

		wrapped.__ifdRunGuard = true;
		wrapped.__ifdOriginal = originalCall;
		frappe.call = wrapped;
		return true;
	};

	if (!install()) {
		document.addEventListener('DOMContentLoaded', install, { once: true });
	}
})();
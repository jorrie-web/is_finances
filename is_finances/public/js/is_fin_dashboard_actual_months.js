(() => {
	const ACTUAL_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.is_fin_dashboard.get_dashboard_data';
	const FORECAST_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.is_fin_dashboard.get_forecast_data';
	const FORECAST_ACTUAL_MONTH_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months.get_forecast_data';
	const SEED_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months_seed.seed_expense_forecast_from_actual_average';
	const STORAGE_KEY = 'is_fin_dashboard_actual_months';

	let allowActualRun = false;
	let allowForecastRun = false;
	let installed = false;

	function $root() {
		return $('.is-fin-dashboard');
	}

	function selectedActualMonths() {
		const value = String($('#ifd-forecast-actual-months').val() || 'auto').trim();
		return value || 'auto';
	}

	function selectedFinancialYear() {
		return String($('#ifd-forecast-fy').val() || '').trim();
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
		const costCenter = String($('#ifd-forecast-cost-centre').val() || '__all__').trim();
		return {
			scenario: {
				name: String($('#ifd-forecast-scenario').val() || '').trim(),
				scenario_name: '',
				status: 'Draft'
			},
			filters: {
				cost_center: costCenter,
				cost_center_label: costCenter === '__all__' ? 'All Cost Centres (Consolidated)' : costCenter,
				financial_year: selectedFinancialYear(),
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
			actuals: {
				period_label: 'Select parameters, fill expenses if required, then press Run Forecast',
				summary: {},
				monthly: []
			},
			uoms: [],
			performance: { server_runtime_ms: 0, database_runtime_ms: 0, account_count: 0, entry_count: 0 }
		};
	}

	function resolveWithoutServer(options, message) {
		const response = { message };
		if (typeof options.callback === 'function') {
			setTimeout(() => options.callback(response), 0);
		}
		return Promise.resolve(response);
	}

	function enableSeedButton() {
		const button = document.querySelector('.is-fin-dashboard #ifd-seed-expenses');
		if (!button) return;
		button.disabled = false;
		button.removeAttribute('disabled');
		button.removeAttribute('aria-disabled');
		button.classList.remove('disabled');
	}

	function installCallGuard() {
		if (!window.frappe || !frappe.call || frappe.call.__ifdManualRunGuard) return;
		const originalCall = frappe.call;

		const wrapped = function(...args) {
			const options = args[0];
			if (!options || typeof options !== 'object') {
				return originalCall.apply(this, args);
			}

			if (options.method === ACTUAL_METHOD) {
				if (!allowActualRun) {
					return resolveWithoutServer(options, emptyActualResponse());
				}
				allowActualRun = false;
				return originalCall.apply(this, args);
			}

			if (options.method === FORECAST_METHOD || options.method === FORECAST_ACTUAL_MONTH_METHOD) {
				if (!allowForecastRun) {
					const promise = resolveWithoutServer(options, emptyForecastResponse());
					setTimeout(enableSeedButton, 0);
					return promise;
				}

				args[0] = {
					...options,
					method: FORECAST_ACTUAL_MONTH_METHOD,
					args: {
						...(options.args || {}),
						actual_months: selectedActualMonths()
					}
				};
				allowForecastRun = false;
				return originalCall.apply(this, args);
			}

			return originalCall.apply(this, args);
		};

		wrapped.__ifdManualRunGuard = true;
		wrapped.__ifdOriginal = originalCall;
		frappe.call = wrapped;
	}

	function installStyle() {
		if (document.getElementById('ifd-manual-run-style')) return;
		$(`<style id="ifd-manual-run-style">
			.is-fin-dashboard .ifd-forecast-controls {
				grid-template-columns: minmax(190px,1.25fr) minmax(190px,1.15fr) minmax(135px,.7fr) minmax(125px,.65fr) minmax(190px,1.15fr) auto;
			}
			.is-fin-dashboard .ifd-manual-note {
				font-size: 11px;
				line-height: 1.3;
				margin-top: 4px;
				color: var(--text-muted);
			}
			.is-fin-dashboard .ifd-forecast-setup-message {
				padding: 12px 14px;
				margin-top: 8px;
				border: 1px solid var(--border-color);
				border-radius: 6px;
				background: var(--fg-color);
			}
		</style>`).appendTo('head');
	}

	function showActualSetup() {
		if (!$root().length) return;
		$('.is-fin-dashboard .ifd-context').html(
			'<div class="ifd-forecast-setup-message"><strong>Income Statement not run yet.</strong> Select your period and Cost Centre, then press <strong>Run Income Statement</strong>.</div>'
		);
		$('.is-fin-dashboard .ifd-kpis').empty();
		$('.is-fin-dashboard .ifd-table-wrap').empty();
		$('.is-fin-dashboard #ifd-revenue-chart, .is-fin-dashboard #ifd-expenses-chart, .is-fin-dashboard #ifd-profit-chart, .is-fin-dashboard #ifd-ebitda-chart').empty();
	}

	function showForecastSetup() {
		if (!$root().length) return;
		$('.is-fin-dashboard .ifd-forecast-context').html(
			'<div class="ifd-forecast-setup-message"><strong>Forecast not run yet.</strong> Select Scenario, Cost Centre, Financial Year, Actual Months and 3M Actual Base Site. You may then press <strong>Fill Expenses from 3M Avg</strong>, followed by <strong>Run Forecast</strong>.</div>'
		);
		$('.is-fin-dashboard .ifd-forecast-kpis').empty();
		$('.is-fin-dashboard .ifd-forecast-table-wrap').empty();
		$('.is-fin-dashboard .ifd-forecast-charts .ifd-chart').empty();
		setTimeout(enableSeedButton, 0);
	}

	function ensureActualMonthsControl() {
		const $controls = $('.is-fin-dashboard .ifd-forecast-controls');
		if (!$controls.length || $('#ifd-forecast-actual-months').length) return;

		const options = ['<option value="auto">Auto</option>'];
		for (let month = 0; month <= 12; month += 1) {
			options.push(`<option value="${month}">${month}</option>`);
		}
		const $group = $(
			`<div class="ifd-control-group"><label>Actual Months</label><select id="ifd-forecast-actual-months" class="form-control">${options.join('')}</select></div>`
		);
		$group.insertBefore($('#ifd-forecast-actual-source').closest('.ifd-control-group'));

		const stored = window.localStorage ? localStorage.getItem(STORAGE_KEY) : null;
		if (stored === 'auto' || /^(?:[0-9]|1[0-2])$/.test(stored || '')) {
			$('#ifd-forecast-actual-months').val(stored);
		}
	}

	async function seedOne(forecastScenario, targetCostCenter, sourceCostCenter, financialYear, actualMonths) {
		return frappe.call({
			method: SEED_METHOD,
			args: {
				forecast_scenario: forecastScenario,
				target_cost_center: targetCostCenter,
				source_cost_center: sourceCostCenter,
				financial_year: financialYear,
				actual_months: actualMonths
			},
			freeze: false
		});
	}

	async function runSeedExpenses() {
		const forecastScenario = String($('#ifd-forecast-scenario').val() || '').trim();
		const selectedTarget = String($('#ifd-forecast-cost-centre').val() || '').trim();
		const selectedSource = String($('#ifd-forecast-actual-source').val() || '__all__').trim();
		const financialYear = selectedFinancialYear();
		const actualMonths = selectedActualMonths();

		if (!forecastScenario || !selectedTarget || !financialYear) {
			frappe.msgprint(__('Select Forecast Scenario, Cost Centre, Financial Year and Actual Months first.'));
			return;
		}

		const allTargets = $('#ifd-forecast-cost-centre option').map(function() {
			const value = String($(this).val() || '').trim();
			return value && value !== '__all__' ? value : null;
		}).get();
		const targets = selectedTarget === '__all__' ? allTargets : [selectedTarget];
		if (!targets.length) {
			frappe.msgprint(__('No individual Forecast Cost Centres are available.'));
			return;
		}

		const scopeText = selectedTarget === '__all__' ? __('ALL Cost Centres') : $('#ifd-forecast-cost-centre option:selected').text();
		const sourceText = selectedSource === '__all__' ? __('each Cost Centre\'s own 3-month actual average') : $('#ifd-forecast-actual-source option:selected').text();

		frappe.confirm(
			__(`This will forecast all blue F expense months for ${scopeText} using ${sourceText}. Existing forecast expense values in those months will be overwritten. Continue?`),
			async () => {
				frappe.dom.freeze(__('Forecasting expenses from the 3-month actual average...'));
				let created = 0;
				let updated = 0;
				let deleted = 0;
				try {
					for (const target of targets) {
						const source = selectedSource === '__all__' ? target : selectedSource;
						const response = await seedOne(forecastScenario, target, source, financialYear, actualMonths);
						const result = response.message || {};
						created += Number(result.created || 0);
						updated += Number(result.updated || 0);
						deleted += Number(result.deleted || 0);
					}
					frappe.msgprint({
						title: __('Expenses Forecasted'),
						indicator: 'green',
						message: __(`Expenses have been forecasted. ${created} entries created, ${updated} updated and ${deleted} cleared. Press Run Forecast to display the result.`)
					});
					showForecastSetup();
				} finally {
					frappe.dom.unfreeze();
					enableSeedButton();
				}
			}
		);
	}

	function prepareForecastControls() {
		ensureActualMonthsControl();
		const refresh = document.querySelector('.is-fin-dashboard #ifd-refresh-forecast');
		if (refresh) refresh.textContent = 'Run Forecast';
		enableSeedButton();
	}

	function installEvents() {
		// Capture phase sets explicit-run flags before the dashboard's own click handlers execute.
		document.addEventListener('click', event => {
			const button = event.target.closest('button');
			if (!button) return;

			if (button.id === 'ifd-refresh-forecast') {
				allowForecastRun = true;
				return;
			}

			if (button.id === 'ifd-seed-expenses') {
				event.preventDefault();
				event.stopImmediatePropagation();
				runSeedExpenses();
				return;
			}

			if (button.classList.contains('ifd-tab-button') && button.dataset.tab === 'forecast') {
				setTimeout(() => {
					prepareForecastControls();
					showForecastSetup();
				}, 0);
				return;
			}

			const label = String(button.textContent || '').trim();
			if (label.includes('Run Income Statement')) {
				allowActualRun = true;
			}
		}, true);

		document.addEventListener('change', event => {
			const el = event.target;
			if (!el || !el.closest || !el.closest('.is-fin-dashboard')) return;

			if (el.id === 'ifd-forecast-actual-months') {
				if (window.localStorage) localStorage.setItem(STORAGE_KEY, String(el.value || 'auto'));
				allowForecastRun = false;
				showForecastSetup();
				return;
			}

			if (['ifd-forecast-scenario', 'ifd-forecast-cost-centre', 'ifd-forecast-fy', 'ifd-forecast-actual-source'].includes(el.id)) {
				allowForecastRun = false;
				setTimeout(() => {
					prepareForecastControls();
					showForecastSetup();
				}, 0);
			}
		}, true);
	}

	function init() {
		if (installed) return;
		installed = true;
		installCallGuard();
		installStyle();
		installEvents();

		// One-time setup only. No polling interval and no MutationObserver.
		setTimeout(() => {
			if ($root().length) {
				showActualSetup();
				prepareForecastControls();
			}
		}, 0);
	}

	init();
})();

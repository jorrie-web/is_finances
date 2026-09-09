(() => {
	if (window.__ifdDashboardPageControlsInstalled) return;
	window.__ifdDashboardPageControlsInstalled = true;

	const SEED_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months_seed.bulk_seed_expense_forecast_from_actual_average';
	const STORAGE_KEY = 'is_fin_dashboard_actual_months';

	function selectedActualMonths() {
		const el = document.getElementById('ifd-forecast-actual-months');
		return el ? String(el.value || 'auto') : 'auto';
	}

	function selectedFinancialYear() {
		const el = document.getElementById('ifd-forecast-fy');
		return el ? String(el.value || '') : '';
	}

	function ensureActualMonthsControl() {
		const controls = document.querySelector('.is-fin-dashboard .ifd-forecast-controls');
		if (!controls || document.getElementById('ifd-forecast-actual-months')) return;

		const source = document.getElementById('ifd-forecast-actual-source');
		if (!source) return;

		const group = document.createElement('div');
		group.className = 'ifd-control-group';
		group.innerHTML = '<label>Actual Months</label><select id="ifd-forecast-actual-months" class="form-control"></select>';
		source.closest('.ifd-control-group').before(group);

		const select = group.querySelector('select');
		select.add(new Option('Auto', 'auto'));
		for (let i = 0; i <= 12; i += 1) select.add(new Option(String(i), String(i)));

		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'auto' || /^(?:[0-9]|1[0-2])$/.test(stored || '')) select.value = stored;
	}

	function enableSeedButton() {
		const button = document.getElementById('ifd-seed-expenses');
		if (!button) return;
		button.disabled = false;
		button.removeAttribute('disabled');
		button.removeAttribute('aria-disabled');
		button.classList.remove('disabled');
	}

	function prepareForecastUI() {
		ensureActualMonthsControl();
		const run = document.getElementById('ifd-refresh-forecast');
		if (run) run.textContent = 'Run Forecast';
		enableSeedButton();
	}

	function showIncomeSetup() {
		const context = document.querySelector('.is-fin-dashboard .ifd-context');
		if (!context) return;
		context.innerHTML = '<div class="ifd-forecast-setup-message"><strong>Income Statement not run yet.</strong> Select your period and Cost Centre, then press <strong>Run Income Statement</strong>.</div>';
	}

	function showForecastSetup() {
		const context = document.querySelector('.is-fin-dashboard .ifd-forecast-context');
		if (!context) return;
		context.innerHTML = '<div class="ifd-forecast-setup-message"><strong>Forecast not run yet.</strong> Select Scenario, Cost Centre, Financial Year, Actual Months and 3M Actual Base Site. If required, press <strong>Fill Expenses from 3M Avg</strong>, then press <strong>Run Forecast</strong>.</div>';
		enableSeedButton();
	}

	async function fillExpenses() {
		const scenario = String(document.getElementById('ifd-forecast-scenario')?.value || '').trim();
		const target = String(document.getElementById('ifd-forecast-cost-centre')?.value || '').trim();
		const source = String(document.getElementById('ifd-forecast-actual-source')?.value || '__all__').trim();
		const financialYear = selectedFinancialYear();
		const actualMonths = selectedActualMonths();

		if (!scenario || !target || !financialYear) {
			frappe.msgprint(__('Select Forecast Scenario, Cost Centre, Financial Year and Actual Months first.'));
			return;
		}

		const targetSelect = document.getElementById('ifd-forecast-cost-centre');
		const individualTargets = Array.from(targetSelect.options)
			.map(option => String(option.value || '').trim())
			.filter(value => value && value !== '__all__');
		const targets = target === '__all__' ? individualTargets : [target];

		if (!targets.length) {
			frappe.msgprint(__('No individual Forecast Cost Centres are available.'));
			return;
		}

		const confirmed = await new Promise(resolve => {
			frappe.confirm(
				__('This will forecast all blue F expense months from the selected 3-month actual average. Existing forecast expense values in those months will be overwritten. Continue?'),
				() => resolve(true),
				() => resolve(false)
			);
		});
		if (!confirmed) return;

		frappe.dom.freeze(__('Forecasting expenses from the 3-month actual average...'));
		try {
			const response = await frappe.call({
				method: SEED_METHOD,
				args: {
					forecast_scenario: scenario,
					target_cost_centers: targets,
					source_cost_center: source,
					financial_year: financialYear,
					actual_months: actualMonths
				},
				freeze: false
			});
			const result = response.message || {};
			frappe.msgprint({
				title: __('Expenses Forecasted'),
				indicator: 'green',
				message: __(`Expenses have been forecasted for ${result.cost_center_count || targets.length} Cost Centre(s) across ${result.month_count || 0} Forecast month(s). ${result.created || 0} entries created and ${result.deleted || 0} previous entries replaced. Completed in ${Math.round(Number(result.runtime_ms || 0))} ms. Press Run Forecast to display the result.`)
			});
			showForecastSetup();
		} finally {
			frappe.dom.unfreeze();
			enableSeedButton();
		}
	}

	function onClick(event) {
		const button = event.target.closest('button');
		if (!button) return;

		if (String(button.textContent || '').includes('Run Income Statement')) {
			window.__ifdManualRun = window.__ifdManualRun || { actual: false, forecast: false };
			window.__ifdManualRun.actual = true;
			return;
		}

		if (button.id === 'ifd-refresh-forecast') {
			window.__ifdManualRun = window.__ifdManualRun || { actual: false, forecast: false };
			window.__ifdManualRun.forecast = true;
			return;
		}

		if (button.id === 'ifd-seed-expenses') {
			event.preventDefault();
			event.stopImmediatePropagation();
			fillExpenses();
			return;
		}

		if (button.classList.contains('ifd-tab-button') && button.dataset.tab === 'forecast') {
			setTimeout(() => {
				prepareForecastUI();
				showForecastSetup();
			}, 0);
		}
	}

	function onChange(event) {
		const el = event.target;
		if (!el || !el.closest?.('.is-fin-dashboard')) return;

		if (el.id === 'ifd-forecast-actual-months') {
			localStorage.setItem(STORAGE_KEY, String(el.value || 'auto'));
			window.__ifdManualRun.forecast = false;
			showForecastSetup();
			return;
		}

		if (['ifd-forecast-scenario', 'ifd-forecast-cost-centre', 'ifd-forecast-fy', 'ifd-forecast-actual-source'].includes(el.id)) {
			window.__ifdManualRun.forecast = false;
			setTimeout(() => {
				prepareForecastUI();
				showForecastSetup();
			}, 0);
		}
	}

	document.addEventListener('click', onClick, true);
	document.addEventListener('change', onChange, true);

	setTimeout(() => {
		if (!document.querySelector('.is-fin-dashboard')) return;
		showIncomeSetup();
		prepareForecastUI();
	}, 0);
})();
(() => {
	if (window.__ifdDashboardPageControlsInstalled) return;
	window.__ifdDashboardPageControlsInstalled = true;

	const SEED_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months_seed.bulk_seed_expense_forecast_from_actual_average';
	const APPLY_MONTHS_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months.apply_actual_months_to_scenario';
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

	function hideBaseSiteControl() {
		const source = document.getElementById('ifd-forecast-actual-source');
		if (!source) return;
		source.value = '__all__';
		const group = source.closest('.ifd-control-group');
		if (group) group.style.display = 'none';
	}

	function enableSeedButton() {
		const button = document.getElementById('ifd-seed-expenses');
		if (!button) return;
		button.disabled = false;
		button.removeAttribute('disabled');
		button.classList.remove('disabled');
		button.textContent = 'Fill Expenses from Actual Avg';
	}

	function prepareForecastUI() {
		ensureActualMonthsControl();
		hideBaseSiteControl();
		const run = document.getElementById('ifd-refresh-forecast');
		if (run) run.textContent = 'Run Forecast';
		enableSeedButton();
		installCopyButtons();
	}

	function showIncomeSetup() {
		const context = document.querySelector('.is-fin-dashboard .ifd-context');
		if (context) context.innerHTML = '<div class="ifd-forecast-setup-message"><strong>Income Statement not run yet.</strong> Select your period and Cost Centre, then press <strong>Run Income Statement</strong>.</div>';
	}

	function showForecastSetup(message) {
		const context = document.querySelector('.is-fin-dashboard .ifd-forecast-context');
		if (!context) return;
		context.innerHTML = `<div class="ifd-forecast-setup-message"><strong>${message || 'Forecast not run yet.'}</strong> Select Scenario, Cost Centre, Financial Year and Actual Months. Then press <strong>Run Forecast</strong>.</div>`;
		enableSeedButton();
	}

	async function persistActualMonths() {
		const scenario = String(document.getElementById('ifd-forecast-scenario')?.value || '').trim();
		const financialYear = selectedFinancialYear();
		const actualMonths = selectedActualMonths();
		if (!scenario || !financialYear || actualMonths === 'auto') return null;
		const response = await frappe.call({
			method: APPLY_MONTHS_METHOD,
			args: { forecast_scenario: scenario, financial_year: financialYear, actual_months: actualMonths },
			freeze: false
		});
		return response.message || {};
	}

	async function fillExpenses() {
		const scenario = String(document.getElementById('ifd-forecast-scenario')?.value || '').trim();
		const target = String(document.getElementById('ifd-forecast-cost-centre')?.value || '').trim();
		const financialYear = selectedFinancialYear();
		const actualMonths = selectedActualMonths();
		if (!scenario || !target || !financialYear) {
			frappe.msgprint(__('Select Forecast Scenario, Cost Centre, Financial Year and Actual Months first.'));
			return;
		}
		const targetSelect = document.getElementById('ifd-forecast-cost-centre');
		const individualTargets = Array.from(targetSelect.options).map(o => String(o.value || '').trim()).filter(v => v && v !== '__all__');
		const targets = target === '__all__' ? individualTargets : [target];
		if (!targets.length) return;

		const confirmed = await new Promise(resolve => frappe.confirm(
			__('This will forecast all blue F expense months using each Cost Centre\'s own available actual-month average (up to the last 3 months). Existing forecast expense values will be overwritten. Continue?'),
			() => resolve(true), () => resolve(false)
		));
		if (!confirmed) return;

		frappe.dom.freeze(__('Forecasting expenses from actual averages...'));
		try {
			await persistActualMonths();
			const response = await frappe.call({
				method: SEED_METHOD,
				args: { forecast_scenario: scenario, target_cost_centers: targets, source_cost_center: '__all__', financial_year: financialYear, actual_months: actualMonths },
				freeze: false
			});
			const result = response.message || {};
			frappe.msgprint({
				title: __('Expenses Forecasted'), indicator: 'green',
				message: __(`Expenses saved for ${result.cost_center_count || targets.length} Cost Centre(s) across ${result.month_count || 0} Forecast month(s) using the ${result.average_label || 'actual average'}. ${result.created || 0} entries created and ${result.deleted || 0} previous entries replaced. Press Run Forecast to display the saved result.`)
			});
			showForecastSetup('Expense forecast has been saved.');
		} finally {
			frappe.dom.unfreeze();
			enableSeedButton();
		}
	}

	function addCopyButtons(root) {
		(root || document).querySelectorAll('.is-fin-dashboard .ifd-forecast-table-wrap .ifd-fc-input[type="number"]').forEach(input => {
			const cell = input.closest('td');
			if (!cell || cell.querySelector('.ifd-copy-all-forecast')) return;
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'btn btn-xs btn-default ifd-copy-all-forecast';
			button.textContent = 'Copy all F';
			button.title = 'Copy this value to every Forecast month for this account and site';
			button.dataset.account = input.dataset.account || '';
			button.dataset.field = input.dataset.field || '';
			cell.appendChild(button);
		});
	}

	function installCopyButtons() {
		const wrap = document.querySelector('.is-fin-dashboard .ifd-forecast-table-wrap');
		if (!wrap) return;
		addCopyButtons(wrap);
		if (wrap.__ifdCopyObserver) return;
		const observer = new MutationObserver(() => addCopyButtons(wrap));
		observer.observe(wrap, { childList: true, subtree: true });
		wrap.__ifdCopyObserver = observer;
	}

	function copyValueToAllForecastMonths(button) {
		const cell = button.closest('td');
		const source = cell?.querySelector('.ifd-fc-input[type="number"]');
		if (!source) return;
		const account = source.dataset.account;
		const field = source.dataset.field;
		const value = source.value;
		const selector = `.ifd-forecast-table-wrap .ifd-fc-input[type="number"][data-account="${CSS.escape(account)}"][data-field="${CSS.escape(field)}"]`;
		let count = 0;
		document.querySelectorAll(selector).forEach(input => {
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
			count += 1;
		});
		frappe.show_alert({ message: __(`Copied value to ${count} Forecast month(s). Press Save Forecast to save all changes.`), indicator: 'blue' }, 6);
	}

	function onClick(event) {
		const copyButton = event.target.closest('.ifd-copy-all-forecast');
		if (copyButton) {
			event.preventDefault(); event.stopImmediatePropagation();
			copyValueToAllForecastMonths(copyButton);
			return;
		}
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
			event.preventDefault(); event.stopImmediatePropagation(); fillExpenses(); return;
		}
		if (button.classList.contains('ifd-tab-button') && button.dataset.tab === 'forecast') {
			setTimeout(() => { prepareForecastUI(); showForecastSetup(); }, 0);
		}
	}

	async function onChange(event) {
		const el = event.target;
		if (!el || !el.closest?.('.is-fin-dashboard')) return;
		if (el.id === 'ifd-forecast-actual-months') {
			localStorage.setItem(STORAGE_KEY, String(el.value || 'auto'));
			window.__ifdManualRun.forecast = false;
			if (String(el.value || 'auto') !== 'auto') {
				try {
					const result = await persistActualMonths();
					showForecastSetup(result?.forecast_start_month ? `Scenario updated: Forecast starts ${result.forecast_start_month}.` : 'Forecast parameters updated.');
				} catch (e) { showForecastSetup('Could not update scenario dates.'); throw e; }
			} else showForecastSetup();
			return;
		}
		if (['ifd-forecast-scenario', 'ifd-forecast-cost-centre', 'ifd-forecast-fy'].includes(el.id)) {
			window.__ifdManualRun.forecast = false;
			setTimeout(() => { prepareForecastUI(); showForecastSetup(); }, 0);
		}
	}

	const style = document.createElement('style');
	style.textContent = '.ifd-copy-all-forecast{display:block;margin:3px 0 0 auto;padding:1px 4px;font-size:8px;line-height:1.3}.ifd-forecast-month .ifd-fc-input{margin-bottom:1px}';
	document.head.appendChild(style);
	document.addEventListener('click', onClick, true);
	document.addEventListener('change', onChange, true);
	setTimeout(() => {
		if (!document.querySelector('.is-fin-dashboard')) return;
		showIncomeSetup(); prepareForecastUI(); installCopyButtons();
	}, 0);
})();

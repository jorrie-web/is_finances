(() => {
	if (window.__ifdDashboardPageControlsInstalled) return;
	window.__ifdDashboardPageControlsInstalled = true;

	const SEED_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months_seed.bulk_seed_expense_forecast_from_actual_average';
	const APPLY_MONTHS_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months.apply_actual_months_to_scenario';
	const STORAGE_KEY = 'is_fin_dashboard_actual_months';

	function state() {
		window.__ifdManualRun = window.__ifdManualRun || { actual: false, forecast: false };
		return window.__ifdManualRun;
	}
	function actualMonths() { return String(document.getElementById('ifd-forecast-actual-months')?.value || 'auto'); }
	function financialYear() { return String(document.getElementById('ifd-forecast-fy')?.value || ''); }

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
		for (let i = 0; i <= 12; i++) select.add(new Option(String(i), String(i)));
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === 'auto' || /^(?:[0-9]|1[0-2])$/.test(stored || '')) select.value = stored;
	}
	function prepareUI() {
		ensureActualMonthsControl();
		const source = document.getElementById('ifd-forecast-actual-source');
		if (source) {
			source.value = '__all__';
			const group = source.closest('.ifd-control-group');
			if (group) group.style.display = 'none';
		}
		const run = document.getElementById('ifd-refresh-forecast');
		if (run) run.textContent = 'Run Forecast';
		const seed = document.getElementById('ifd-seed-expenses');
		if (seed) { seed.disabled = false; seed.classList.remove('disabled'); seed.textContent = 'Fill Expenses from Actual Avg'; }
		addCopyButtons();
	}
	function setupMessage(text) {
		const el = document.querySelector('.is-fin-dashboard .ifd-forecast-context');
		if (el) el.innerHTML = `<div class="ifd-forecast-setup-message"><strong>${text || 'Forecast not run yet.'}</strong></div>`;
	}
	async function persistActualMonths() {
		const scenario = String(document.getElementById('ifd-forecast-scenario')?.value || '').trim();
		if (!scenario || !financialYear() || actualMonths() === 'auto') return null;
		const r = await frappe.call({ method: APPLY_MONTHS_METHOD, args: { forecast_scenario: scenario, financial_year: financialYear(), actual_months: actualMonths() }, freeze: false });
		return r.message || {};
	}
	async function fillExpenses() {
		const scenario = String(document.getElementById('ifd-forecast-scenario')?.value || '').trim();
		const target = String(document.getElementById('ifd-forecast-cost-centre')?.value || '').trim();
		const targetSelect = document.getElementById('ifd-forecast-cost-centre');
		if (!scenario || !target || !financialYear() || !targetSelect) return frappe.msgprint(__('Select Forecast Scenario, Cost Centre, Financial Year and Actual Months first.'));
		const all = Array.from(targetSelect.options).map(o => String(o.value || '').trim()).filter(v => v && v !== '__all__');
		const targets = target === '__all__' ? all : [target];
		const ok = await new Promise(resolve => frappe.confirm(__('This will overwrite Forecast expense values using each Cost Centre\'s own available actual average. Continue?'), () => resolve(true), () => resolve(false)));
		if (!ok) return;
		frappe.dom.freeze(__('Forecasting expenses from actual averages...'));
		try {
			await persistActualMonths();
			const r = await frappe.call({ method: SEED_METHOD, args: { forecast_scenario: scenario, target_cost_centers: targets, source_cost_center: '__all__', financial_year: financialYear(), actual_months: actualMonths() }, freeze: false });
			const result = r.message || {};
			frappe.msgprint({ title: __('Expenses Forecasted'), indicator: 'green', message: __(`Expenses saved for ${result.cost_center_count || targets.length} Cost Centre(s).`) });
			state().forecast = true;
			document.getElementById('ifd-refresh-forecast')?.click();
		} finally { frappe.dom.unfreeze(); }
	}
	function addCopyButtons() {
		document.querySelectorAll('.is-fin-dashboard .ifd-forecast-table-wrap .ifd-fc-input[type="number"]').forEach(input => {
			const cell = input.closest('td');
			if (!cell || cell.querySelector('.ifd-copy-all-forecast')) return;
			const b = document.createElement('button');
			b.type = 'button'; b.className = 'btn btn-xs btn-default ifd-copy-all-forecast'; b.textContent = 'Copy all F';
			b.title = 'Copy this value to every Forecast month for this account and site';
			cell.appendChild(b);
		});
	}
	function copyAll(button) {
		const source = button.closest('td')?.querySelector('.ifd-fc-input[type="number"]');
		if (!source) return;
		const selector = `.ifd-forecast-table-wrap .ifd-fc-input[type="number"][data-account="${CSS.escape(source.dataset.account)}"][data-field="${CSS.escape(source.dataset.field)}"]`;
		let n = 0;
		document.querySelectorAll(selector).forEach(input => { input.value = source.value; input.dispatchEvent(new Event('input', { bubbles: true })); n++; });
		frappe.show_alert({ message: __(`Copied value to ${n} Forecast month(s). Press Save Forecast to save all changes.`), indicator: 'blue' }, 6);
	}

	document.addEventListener('click', event => {
		const copy = event.target.closest('.ifd-copy-all-forecast');
		if (copy) { event.preventDefault(); event.stopImmediatePropagation(); copyAll(copy); return; }
		const button = event.target.closest('button');
		if (!button) return;
		const text = String(button.textContent || '').trim();
		if (text.includes('Run Income Statement')) state().actual = true;
		if (button.id === 'ifd-refresh-forecast') state().forecast = true;
		if (button.id === 'ifd-save-forecast' || text.includes('Save Forecast')) state().forecast = true;
		if (button.id === 'ifd-seed-expenses') { event.preventDefault(); event.stopImmediatePropagation(); fillExpenses(); }
		if (button.classList.contains('ifd-tab-button') && button.dataset.tab === 'forecast') setTimeout(prepareUI, 0);
	}, true);

	document.addEventListener('change', async event => {
		const el = event.target;
		if (!el?.closest?.('.is-fin-dashboard')) return;
		if (el.id === 'ifd-forecast-scenario') {
			// Selecting a scenario is itself an explicit request to view it. Allow the
			// dashboard's normal change handler to load the last saved database values.
			state().forecast = true;
			return;
		}
		if (el.id === 'ifd-forecast-actual-months') {
			localStorage.setItem(STORAGE_KEY, String(el.value || 'auto'));
			state().forecast = false;
			if (String(el.value || 'auto') !== 'auto') {
				try { await persistActualMonths(); } catch (e) { setupMessage('Could not update scenario dates.'); throw e; }
			}
			setupMessage('Forecast parameters updated. Select the Scenario again to load its saved forecast, or press Run Forecast.');
			return;
		}
		if (['ifd-forecast-cost-centre', 'ifd-forecast-fy'].includes(el.id)) {
			// Once a scenario is open, moving between its site/FY views should show
			// the persisted result immediately rather than an empty placeholder.
			state().forecast = true;
		}
	}, true);

	const style = document.createElement('style');
	style.textContent = '.ifd-copy-all-forecast{display:block;margin:3px 0 0 auto;padding:1px 4px;font-size:8px;line-height:1.3}';
	document.head.appendChild(style);
	setTimeout(() => { if (document.querySelector('.is-fin-dashboard')) prepareUI(); }, 0);
})();

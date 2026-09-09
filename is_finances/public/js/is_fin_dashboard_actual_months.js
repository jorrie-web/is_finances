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

	function keepSeedAvailable() {
		const seed = document.getElementById('ifd-seed-expenses');
		if (!seed) return;
		seed.disabled = false;
		seed.removeAttribute('disabled');
		seed.classList.remove('disabled');
		seed.textContent = 'Fill Expenses from Actual Avg';
	}

	function installSeedAvailabilityGuard() {
		const seed = document.getElementById('ifd-seed-expenses');
		if (!seed || seed.__ifdAvailabilityObserver) return;
		keepSeedAvailable();
		const observer = new MutationObserver(() => {
			if (seed.disabled || seed.hasAttribute('disabled')) keepSeedAvailable();
		});
		observer.observe(seed, { attributes: true, attributeFilter: ['disabled', 'class'] });
		seed.__ifdAvailabilityObserver = observer;
	}

	function addCopyButtons(root) {
		(root || document).querySelectorAll('.is-fin-dashboard .ifd-forecast-table-wrap .ifd-fc-money-input[type="number"]').forEach(input => {
			const cell = input.closest('td');
			if (!cell || cell.querySelector('.ifd-copy-all-forecast')) return;
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'btn btn-xs btn-default ifd-copy-all-forecast';
			b.textContent = 'Copy to all F';
			b.title = 'Copy this expense value to every remaining Forecast month for this account and site';
			cell.appendChild(b);
		});
	}

	function installCopyButtonObserver() {
		const wrap = document.querySelector('.is-fin-dashboard .ifd-forecast-table-wrap');
		if (!wrap) return;
		addCopyButtons(wrap);
		if (wrap.__ifdCopyObserver) return;
		let scheduled = false;
		const observer = new MutationObserver(() => {
			if (scheduled) return;
			scheduled = true;
			requestAnimationFrame(() => {
				scheduled = false;
				addCopyButtons(wrap);
			});
		});
		observer.observe(wrap, { childList: true, subtree: true });
		wrap.__ifdCopyObserver = observer;
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
		keepSeedAvailable();
		installSeedAvailabilityGuard();
		installCopyButtonObserver();
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
		if (!targets.length) return frappe.msgprint(__('No individual Cost Centres are available to populate.'));
		const scopeText = target === '__all__' ? __('ALL Cost Centres in the consolidated forecast') : __('the selected Cost Centre');
		const ok = await new Promise(resolve => frappe.confirm(__(`This will overwrite Forecast expense values for ${scopeText} using each Cost Centre's own available actual average. Continue?`), () => resolve(true), () => resolve(false)));
		if (!ok) return;
		frappe.dom.freeze(__('Forecasting expenses from actual averages...'));
		try {
			await persistActualMonths();
			const r = await frappe.call({ method: SEED_METHOD, args: { forecast_scenario: scenario, target_cost_centers: targets, source_cost_center: '__all__', financial_year: financialYear(), actual_months: actualMonths() }, freeze: false });
			const result = r.message || {};
			frappe.msgprint({ title: __('Expenses Forecasted'), indicator: 'green', message: __(`Expenses saved for ${result.cost_center_count || targets.length} Cost Centre(s).`) });
			state().forecast = true;
			document.getElementById('ifd-refresh-forecast')?.click();
		} finally {
			frappe.dom.unfreeze();
			keepSeedAvailable();
		}
	}

	function copyAll(button) {
		const source = button.closest('td')?.querySelector('.ifd-fc-money-input[type="number"]');
		if (!source) return;
		const account = String(source.dataset.account || '');
		const field = String(source.dataset.field || 'forecast_amount');
		const sourcePeriod = String(source.dataset.period || '');
		const selector = `.ifd-forecast-table-wrap .ifd-fc-money-input[type="number"][data-account="${CSS.escape(account)}"][data-field="${CSS.escape(field)}"]`;
		let n = 0;
		document.querySelectorAll(selector).forEach(input => {
			const period = String(input.dataset.period || '');
			if (sourcePeriod && period && period < sourcePeriod) return;
			input.value = source.value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			n++;
		});
		frappe.show_alert({ message: __(`Copied expense to ${n} Forecast month(s). Press Save Forecast to save the changes.`), indicator: 'blue' }, 6);
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
			state().forecast = true;
			setTimeout(prepareUI, 0);
			return;
		}
		if (el.id === 'ifd-forecast-actual-months') {
			localStorage.setItem(STORAGE_KEY, String(el.value || 'auto'));
			state().forecast = false;
			if (String(el.value || 'auto') !== 'auto') {
				try { await persistActualMonths(); } catch (e) { setupMessage('Could not update scenario dates.'); throw e; }
			}
			setupMessage('Forecast parameters updated. Select the Scenario again to load its saved forecast, or press Run Forecast.');
			keepSeedAvailable();
			return;
		}
		if (['ifd-forecast-cost-centre', 'ifd-forecast-fy'].includes(el.id)) {
			state().forecast = true;
			setTimeout(prepareUI, 0);
		}
	}, true);

	const style = document.createElement('style');
	style.textContent = '.ifd-copy-all-forecast{display:block;margin:3px 0 0 auto;padding:2px 5px;font-size:9px;line-height:1.3;white-space:nowrap}';
	document.head.appendChild(style);
	setTimeout(() => { if (document.querySelector('.is-fin-dashboard')) prepareUI(); }, 0);
})();

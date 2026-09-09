(() => {
	const DASHBOARD_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.is_fin_dashboard.get_forecast_data';
	const ACTUAL_MONTH_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months.get_forecast_data';
	const ACTUAL_MONTH_SEED_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months_seed.seed_expense_forecast_from_actual_average';
	const STORAGE_KEY = 'is_fin_dashboard_actual_months';
	let seedObserver = null;
	let allowForecastBuild = false;
	let forecastWasBuilt = false;

	function selectedActualMonths() {
		const value = String($('#ifd-forecast-actual-months').val() || 'auto').trim();
		return value || 'auto';
	}

	function selectedFinancialYear() {
		return String($('#ifd-forecast-fy').val() || '').trim();
	}

	function emptyForecastResponse() {
		const scenarioName = String($('#ifd-forecast-scenario').val() || '').trim();
		const costCenter = String($('#ifd-forecast-cost-centre').val() || '__all__').trim();
		const financialYear = selectedFinancialYear();
		return {
			scenario: { name: scenarioName, scenario_name: '', status: 'Draft' },
			filters: {
				cost_center: costCenter,
				cost_center_label: costCenter === '__all__' ? 'All Cost Centres (Consolidated)' : costCenter,
				financial_year: financialYear,
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
			actuals: { period_label: 'Set parameters, fill expenses if required, then Run Forecast', summary: {}, monthly: [] },
			uoms: [],
			performance: { server_runtime_ms: 0, database_runtime_ms: 0, account_count: 0, entry_count: 0 }
		};
	}

	function installCallOverride() {
		if (!window.frappe || !frappe.call || frappe.call.__ifdActualMonthsWrapped) return;
		const originalCall = frappe.call;
		const wrapped = function(...args) {
			const options = args[0];
			const isForecastBuild = options && typeof options === 'object' &&
				(options.method === DASHBOARD_METHOD || options.method === ACTUAL_MONTH_METHOD);

			if (isForecastBuild) {
				if (!allowForecastBuild) {
					const response = { message: emptyForecastResponse() };
					if (typeof options.callback === 'function') {
						setTimeout(() => options.callback(response), 0);
					}
					setTimeout(showSetupMessage, 0);
					return Promise.resolve(response);
				}

				args[0] = {
					...options,
					method: ACTUAL_MONTH_METHOD,
					args: {
						...(options.args || {}),
						actual_months: selectedActualMonths()
					}
				};
				allowForecastBuild = false;
				forecastWasBuilt = true;
			}
			return originalCall.apply(this, args);
		};
		wrapped.__ifdActualMonthsWrapped = true;
		wrapped.__ifdActualMonthsOriginal = originalCall;
		frappe.call = wrapped;
	}

	function installStyle() {
		if (document.getElementById('ifd-actual-months-style')) return;
		$(`<style id="ifd-actual-months-style">
			.is-fin-dashboard .ifd-forecast-controls {
				grid-template-columns: minmax(190px, 1.25fr) minmax(190px, 1.15fr) minmax(135px, .7fr) minmax(125px, .65fr) minmax(190px, 1.15fr) auto;
			}
			.is-fin-dashboard #ifd-seed-expenses.ifd-force-enabled {
				opacity: 1 !important;
				pointer-events: auto !important;
				cursor: pointer !important;
			}
			.is-fin-dashboard .ifd-seed-expense-note,
			.is-fin-dashboard .ifd-run-forecast-note {
				font-size: 11px;
				line-height: 1.25;
				margin-top: 4px;
				max-width: 320px;
				color: var(--text-muted);
			}
			.is-fin-dashboard .ifd-forecast-setup-message {
				padding: 14px 16px;
				margin-top: 10px;
				border: 1px solid var(--border-color);
				border-radius: 8px;
				background: var(--fg-color);
				font-size: 13px;
			}
			@media (max-width: 1250px) {
				.is-fin-dashboard .ifd-forecast-controls { grid-template-columns: repeat(3, minmax(170px, 1fr)); }
				.is-fin-dashboard .ifd-forecast-actions { grid-column: 1 / -1; }
			}
			@media (max-width: 800px) {
				.is-fin-dashboard .ifd-forecast-controls { grid-template-columns: 1fr 1fr; }
			}
			@media (max-width: 520px) {
				.is-fin-dashboard .ifd-forecast-controls { grid-template-columns: 1fr; }
			}
		</style>`).appendTo('head');
	}

	function showSetupMessage() {
		const $context = $('.is-fin-dashboard .ifd-forecast-context');
		if (!$context.length) return;
		$context.html(`
			<div class="ifd-forecast-setup-message">
				<strong>Forecast not run yet.</strong><br>
				1. Select Forecast Scenario, Cost Centre, Financial Year and Actual Months.<br>
				2. If required, press <strong>Fill Expenses from 3M Avg</strong>.<br>
				3. Press <strong>Run Forecast</strong> to build the forecast.
			</div>
		`);
		$('.is-fin-dashboard .ifd-forecast-kpis').empty();
		$('.is-fin-dashboard .ifd-forecast-table-wrap').empty();
		$('.is-fin-dashboard .ifd-forecast-charts .ifd-chart').empty();
	}

	function markParametersChanged() {
		forecastWasBuilt = false;
		allowForecastBuild = false;
		setTimeout(showSetupMessage, 0);
	}

	function installRunForecastButton() {
		const button = document.querySelector('.is-fin-dashboard #ifd-refresh-forecast');
		if (!button) return;
		button.textContent = 'Run Forecast';
		const $button = $(button);
		if (!$button.next('.ifd-run-forecast-note').length) {
			$('<div class="ifd-run-forecast-note">Builds the forecast only after you have selected all parameters.</div>').insertAfter($button);
		}
		if (button.__ifdExplicitRunCapture) return;
		button.__ifdExplicitRunCapture = true;
		button.addEventListener('click', () => {
			const scenario = String($('#ifd-forecast-scenario').val() || '').trim();
			const costCenter = String($('#ifd-forecast-cost-centre').val() || '').trim();
			const financialYear = selectedFinancialYear();
			if (!scenario || !costCenter || !financialYear) return;
			allowForecastBuild = true;
		}, true);
	}

	function forceEnableSeedButton() {
		const button = document.querySelector('.is-fin-dashboard #ifd-seed-expenses');
		if (!button) return;
		button.disabled = false;
		button.removeAttribute('disabled');
		button.removeAttribute('aria-disabled');
		button.classList.remove('disabled');
		button.classList.add('ifd-force-enabled');
	}

	function ensureSeedMessage() {
		const $button = $('.is-fin-dashboard #ifd-seed-expenses');
		if (!$button.length || $('.is-fin-dashboard .ifd-seed-expense-note').length) return;
		$('<div class="ifd-seed-expense-note">Pressing this button forecasts all blue F expense months from the selected 3-month actual average.</div>')
			.insertAfter($button);
	}

	function observeSeedButton() {
		const button = document.querySelector('.is-fin-dashboard #ifd-seed-expenses');
		if (!button || (seedObserver && seedObserver.__button === button)) return;
		if (seedObserver) seedObserver.disconnect();
		seedObserver = new MutationObserver(() => forceEnableSeedButton());
		seedObserver.__button = button;
		seedObserver.observe(button, { attributes: true, attributeFilter: ['disabled', 'class', 'aria-disabled'] });
	}

	async function seedOne(forecastScenario, targetCostCenter, sourceCostCenter, financialYear, actualMonths) {
		return frappe.call({
			method: ACTUAL_MONTH_SEED_METHOD,
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

	function installSeedHandler() {
		const $button = $('.is-fin-dashboard #ifd-seed-expenses');
		if (!$button.length) return;

		forceEnableSeedButton();
		ensureSeedMessage();
		observeSeedButton();
		if ($button.data('ifd-actual-months-seed-bound')) return;

		$button.off('click');
		$button.data('ifd-actual-months-seed-bound', true);
		$button.on('click', () => {
			const forecastScenario = String($('#ifd-forecast-scenario').val() || '').trim();
			const selectedTarget = String($('#ifd-forecast-cost-centre').val() || '').trim();
			const selectedSource = String($('#ifd-forecast-actual-source').val() || '__all__').trim();
			const financialYear = selectedFinancialYear();
			const actualMonths = selectedActualMonths();

			if (!forecastScenario || !selectedTarget || !financialYear) {
				frappe.msgprint(__('Select a Forecast Scenario, Cost Centre and Financial Year first.'));
				return;
			}

			const allTargets = $('#ifd-forecast-cost-centre option').map(function() {
				const value = String($(this).val() || '').trim();
				return value && value !== '__all__' ? value : null;
			}).get();
			const targets = selectedTarget === '__all__' ? allTargets : [selectedTarget];

			if (!targets.length) {
				frappe.msgprint(__('No individual Forecast Cost Centres are available to populate.'));
				return;
			}

			const scopeText = selectedTarget === '__all__'
				? __('ALL individual Cost Centres')
				: $('#ifd-forecast-cost-centre option:selected').text();
			const sourceText = selectedSource === '__all__'
				? __('each Cost Centre\'s own last 3-month actual average')
				: $('#ifd-forecast-actual-source option:selected').text();

			frappe.confirm(
				__(`This will FORECAST all blue F expense months for ${scopeText} using ${sourceText}. Existing expense forecast values in those Forecast months will be overwritten. Continue?`),
				async () => {
					$button.prop('disabled', true);
					frappe.dom.freeze(__('Forecasting expenses from the 3-month actual average...'));
					let created = 0;
					let updated = 0;
					let deleted = 0;
					let completed = 0;
					try {
						for (const target of targets) {
							const source = selectedSource === '__all__' ? target : selectedSource;
							const response = await seedOne(forecastScenario, target, source, financialYear, actualMonths);
							const result = response.message || {};
							created += Number(result.created || 0);
							updated += Number(result.updated || 0);
							deleted += Number(result.deleted || 0);
							completed += 1;
						}
						frappe.msgprint({
							title: __('Expenses Forecasted'),
							indicator: 'green',
							message: __(`Expenses have been forecasted for ${completed} Cost Centre(s). All blue F expense months were populated from the selected 3-month actual average. ${created} entries created, ${updated} updated, ${deleted} cleared. Press Run Forecast to display the updated forecast.`)
						});
						forecastWasBuilt = false;
						showSetupMessage();
					} finally {
						frappe.dom.unfreeze();
						forceEnableSeedButton();
					}
				}
			);
		});
	}

	function installParameterHandlers() {
		const selector = '#ifd-forecast-scenario, #ifd-forecast-cost-centre, #ifd-forecast-fy, #ifd-forecast-actual-source, #ifd-forecast-actual-months';
		$(selector).off('change.ifd-explicit-run').on('change.ifd-explicit-run', () => markParametersChanged());
	}

	function enhanceForecastControls() {
		installCallOverride();
		const $controls = $('.is-fin-dashboard .ifd-forecast-controls');
		if (!$controls.length) return;

		if (!$controls.find('#ifd-forecast-actual-months').length) {
			const options = ['<option value="auto">Auto</option>'];
			for (let month = 0; month <= 12; month += 1) {
				options.push(`<option value="${month}">${month}</option>`);
			}

			const $group = $(
				`<div class="ifd-control-group ifd-actual-months-control">
					<label>Actual Months</label>
					<select id="ifd-forecast-actual-months" class="form-control">${options.join('')}</select>
				</div>`
			);
			$group.insertBefore($controls.find('#ifd-forecast-actual-source').closest('.ifd-control-group'));

			const stored = window.localStorage ? localStorage.getItem(STORAGE_KEY) : null;
			if (stored !== null && (stored === 'auto' || /^(?:[0-9]|1[0-2])$/.test(stored))) {
				$group.find('#ifd-forecast-actual-months').val(stored);
			}

			$group.find('#ifd-forecast-actual-months').on('change', function() {
				const value = String($(this).val() || 'auto');
				if (window.localStorage) localStorage.setItem(STORAGE_KEY, value);
				markParametersChanged();
			});
		}

		installRunForecastButton();
		installSeedHandler();
		installParameterHandlers();
		forceEnableSeedButton();

		if (!forecastWasBuilt && $('.is-fin-dashboard .ifd-tab-button[data-tab="forecast"]').hasClass('active')) {
			showSetupMessage();
		}
	}

	installCallOverride();
	installStyle();
	setTimeout(enhanceForecastControls, 0);
	setInterval(enhanceForecastControls, 250);
})();

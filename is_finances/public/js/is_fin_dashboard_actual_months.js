(() => {
	const DASHBOARD_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.is_fin_dashboard.get_forecast_data';
	const ACTUAL_MONTH_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months.get_forecast_data';
	const ACTUAL_MONTH_SEED_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months_seed.seed_expense_forecast_from_actual_average';
	const STORAGE_KEY = 'is_fin_dashboard_actual_months';

	function selectedActualMonths() {
		const value = String($('#ifd-forecast-actual-months').val() || 'auto').trim();
		return value || 'auto';
	}

	function selectedFinancialYear() {
		return String($('#ifd-forecast-fy').val() || '').trim();
	}

	function installCallOverride() {
		if (!window.frappe || !frappe.call || frappe.call.__ifdActualMonthsWrapped) return;
		const originalCall = frappe.call;
		const wrapped = function(...args) {
			const options = args[0];
			if (options && typeof options === 'object' && options.method === DASHBOARD_METHOD) {
				args[0] = {
					...options,
					method: ACTUAL_MONTH_METHOD,
					args: {
						...(options.args || {}),
						actual_months: selectedActualMonths()
					}
				};
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

		// The base dashboard disables this button in consolidated read-only mode.
		// Filling is still valid because the data is written into each underlying
		// individual Cost Center and the consolidated view then reflects the sum.
		$button.prop('disabled', false);
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
				__(`Fill every Forecast expense month for ${scopeText} using ${sourceText}? Existing expense forecast values in the selected Forecast months will be overwritten.`),
				async () => {
					$button.prop('disabled', true);
					frappe.dom.freeze(__('Populating all Forecast expense months...'));
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
						frappe.show_alert({
							message: __(`Forecast expenses populated for ${completed} Cost Centre(s): ${created} created, ${updated} updated, ${deleted} cleared.`),
							indicator: 'green'
						}, 10);
						$('.is-fin-dashboard #ifd-refresh-forecast').trigger('click');
					} finally {
						frappe.dom.unfreeze();
						$button.prop('disabled', false);
					}
				}
			);
		});
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
				const $refresh = $('.is-fin-dashboard #ifd-refresh-forecast');
				if ($refresh.length && $('.is-fin-dashboard .ifd-tab-button[data-tab="forecast"]').hasClass('active')) {
					$refresh.trigger('click');
				}
			});
		}

		installSeedHandler();
	}

	installCallOverride();
	installStyle();
	setTimeout(enhanceForecastControls, 0);
	setInterval(enhanceForecastControls, 750);
})();

(() => {
	const DASHBOARD_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.is_fin_dashboard.get_forecast_data';
	const ACTUAL_MONTH_METHOD = 'is_finances.isambane_finances.page.is_fin_dashboard.forecast_actual_months.get_forecast_data';
	const STORAGE_KEY = 'is_fin_dashboard_actual_months';

	function selectedActualMonths() {
		const value = String($('#ifd-forecast-actual-months').val() || 'auto').trim();
		return value || 'auto';
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

	function enhanceForecastControls() {
		installCallOverride();
		const $controls = $('.is-fin-dashboard .ifd-forecast-controls');
		if (!$controls.length || $controls.find('#ifd-forecast-actual-months').length) return;

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

	installCallOverride();
	installStyle();
	setTimeout(enhanceForecastControls, 0);
	setInterval(enhanceForecastControls, 750);
})();

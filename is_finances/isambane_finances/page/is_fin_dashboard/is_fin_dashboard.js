frappe.pages['is-fin-dashboard'].on_page_load = function(wrapper) {
	var page = frappe.ui.make_app_page({
		parent: wrapper,
		title: 'Isambane Financial Dashboard',
		single_column: true
	});

	new IsFinDashboard(page, wrapper);
};

class IsFinDashboard {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.method_root = 'is_finances.isambane_finances.page.is_fin_dashboard.is_fin_dashboard';
		this.current_data = null;
		this.open_sections = new Set();
		this.drilldown_cache = new Map();
		this.transaction_cache = new Map();
		this.summary_drilldown_cache = new Map();
		this.last_runtime = null;
		this.active_tab = 'actual';
		this.forecast_data = null;
		this.forecast_scenario_map = {};
		this.forecast_cost_centre_map = {};
		this.forecast_state = new Map();
		this.forecast_line_map = new Map();
		this.forecast_dirty = new Set();
		this.forecast_loaded_once = false;
		this.forecast_open_sections = new Set(['IS-Revenue']);
		this._inject_styles();
		this._build_filters();
		this._build_layout();
		this._bind_tabs();
		this._load_financial_years()
			.then(() => this._load_cost_centres())
			.then(() => this.refresh());
	}

	_build_filters() {
		this._setting_period = false;
		this.financial_year_map = {};

		this.financial_year = this.page.add_field({
			fieldname: 'financial_year',
			label: __('Financial Year'),
			fieldtype: 'Select',
			options: ['Custom Date Range'],
			default: 'Custom Date Range',
			change: () => this._apply_financial_year()
		});

		this.from_date = this.page.add_field({
			fieldname: 'from_date',
			label: __('From Date'),
			fieldtype: 'Date',
			reqd: 1,
			default: this._default_financial_year_start(),
			change: () => this._on_date_change()
		});

		this.to_date = this.page.add_field({
			fieldname: 'to_date',
			label: __('To Date'),
			fieldtype: 'Date',
			reqd: 1,
			default: frappe.datetime.get_today(),
			change: () => this._on_date_change()
		});

		this.cost_centre = this.page.add_field({
			fieldname: 'cost_centre',
			label: __('Cost Centre'),
			fieldtype: 'Select',
			options: ['All Cost Centres'],
			default: 'All Cost Centres'
		});

		this.page.set_primary_action(__('Run Income Statement'), () => this.refresh(), 'play');
	}

	async _load_financial_years() {
		const r = await frappe.call({ method: `${this.method_root}.get_financial_years`, freeze: false });
		const payload = r.message || {};
		const years = payload.financial_years || [];
		this.financial_year_map = {};
		years.forEach(year => { this.financial_year_map[year.label] = year; });

		this.financial_year.df.options = ['Custom Date Range', ...years.map(y => y.label)].join('\n');
		this.financial_year.refresh();

		const current = payload.current_financial_year;
		if (current && this.financial_year_map[current]) {
			this._setting_period = true;
			this.financial_year.set_value(current);
			this.from_date.set_value(this.financial_year_map[current].from_date);
			this.to_date.set_value(this.financial_year_map[current].to_date);
			this._setting_period = false;
		}
	}

	async _apply_financial_year() {
		if (this._setting_period) return;
		const year = this.financial_year_map[this.financial_year.get_value()];
		if (!year) return;

		this._setting_period = true;
		this.from_date.set_value(year.from_date);
		this.to_date.set_value(year.to_date);
		this._setting_period = false;
		await this._load_cost_centres();
	}

	async _on_date_change() {
		if (this._setting_period) return;
		if (this.financial_year) {
			this._setting_period = true;
			this.financial_year.set_value('Custom Date Range');
			this._setting_period = false;
		}
		await this._load_cost_centres();
	}

	_build_layout() {
		this.$root = $(
			`<div class="is-fin-dashboard">
				<div class="ifd-tabs" role="tablist">
					<button type="button" class="ifd-tab-button active" data-tab="actual">Income Statement</button>
					<button type="button" class="ifd-tab-button" data-tab="forecast">Forecast</button>
				</div>

				<div class="ifd-tab-pane" data-tab-pane="actual">
					<div class="ifd-context"></div>
					<div class="ifd-kpis"></div>
					<div class="ifd-charts">
						<div class="ifd-panel"><div class="ifd-panel-title">Revenue by Month</div><div class="ifd-subtitle">R'million</div><div id="ifd-revenue-chart" class="ifd-chart"></div></div>
						<div class="ifd-panel"><div class="ifd-panel-title">Expenses by Month</div><div class="ifd-subtitle">Cost of Sales + Other Expenditure | R'million</div><div id="ifd-expenses-chart" class="ifd-chart"></div></div>
						<div class="ifd-panel"><div class="ifd-panel-title">Profit / (Loss) by Month</div><div class="ifd-subtitle">R'million</div><div id="ifd-profit-chart" class="ifd-chart"></div></div>
						<div class="ifd-panel"><div class="ifd-panel-title">EBITDA by Month</div><div class="ifd-subtitle">Profit + interest paid + depreciation - interest received | R'million</div><div id="ifd-ebitda-chart" class="ifd-chart"></div></div>
					</div>
					<div class="ifd-panel ifd-statement-panel">
						<div class="ifd-panel-header">
							<div><div class="ifd-panel-title">Income Statement</div><div class="ifd-subtitle">Open a section for monthly account detail; click an account for further drilldown</div></div>
						</div>
						<div class="ifd-table-wrap"></div>
					</div>
				</div>

				<div class="ifd-tab-pane" data-tab-pane="forecast" style="display:none;">
					<div class="ifd-forecast-controls">
						<div class="ifd-control-group"><label>Forecast Scenario</label><select id="ifd-forecast-scenario" class="form-control"></select></div>
						<div class="ifd-control-group"><label>Forecast Cost Centre</label><select id="ifd-forecast-cost-centre" class="form-control"></select></div>
						<div class="ifd-control-group"><label>Financial Year</label><select id="ifd-forecast-fy" class="form-control"></select></div>
						<div class="ifd-control-group"><label>3M Actual Base Site</label><select id="ifd-forecast-actual-source" class="form-control"></select></div>
						<div class="ifd-forecast-actions">
							<button type="button" class="btn btn-default" id="ifd-edit-forecast-scenario">Edit Scenario</button>
							<button type="button" class="btn btn-default" id="ifd-seed-expenses">Fill Expenses from 3M Avg</button>
							<button type="button" class="btn btn-default" id="ifd-refresh-forecast">Refresh</button>
							<button type="button" class="btn btn-primary" id="ifd-save-forecast">Save Changes</button>
						</div>
					</div>
					<div class="ifd-forecast-context"></div>
					<div class="ifd-forecast-kpis"></div>
					<div class="ifd-panel ifd-statement-panel ifd-forecast-panel">
						<div class="ifd-panel-header">
							<div><div class="ifd-panel-title">Forecast Income Statement</div><div class="ifd-subtitle">March-February is shown as one Actual + Forecast view: A = actual month and F = forecast month. Revenue uses Volume × Price; future expense months can be seeded from a selected site's last 3-month actual average and remain editable.</div></div>
						</div>
						<div class="ifd-forecast-table-wrap"></div>
					</div>
					<div class="ifd-charts ifd-forecast-charts">
						<div class="ifd-panel"><div class="ifd-panel-title">Revenue Actual + Forecast</div><div class="ifd-subtitle">R'million</div><div id="ifd-forecast-revenue-chart" class="ifd-chart"></div></div>
						<div class="ifd-panel"><div class="ifd-panel-title">Expenses Actual + Forecast</div><div class="ifd-subtitle">R'million</div><div id="ifd-forecast-expenses-chart" class="ifd-chart"></div></div>
						<div class="ifd-panel"><div class="ifd-panel-title">Profit / (Loss) Actual + Forecast</div><div class="ifd-subtitle">R'million</div><div id="ifd-forecast-profit-chart" class="ifd-chart"></div></div>
						<div class="ifd-panel"><div class="ifd-panel-title">EBITDA Actual + Forecast</div><div class="ifd-subtitle">R'million</div><div id="ifd-forecast-ebitda-chart" class="ifd-chart"></div></div>
					</div>
				</div>
			</div>`
		).appendTo(this.page.main);
	}

	_bind_tabs() {
		this.$root.find('.ifd-tab-button').on('click', e => this._switch_tab($(e.currentTarget).data('tab')));
		this.$root.find('#ifd-refresh-forecast').on('click', () => this._load_forecast_data());
		this.$root.find('#ifd-save-forecast').on('click', () => this._save_forecast());
		this.$root.find('#ifd-edit-forecast-scenario').on('click', () => this._edit_forecast_scenario());
		this.$root.find('#ifd-seed-expenses').on('click', () => this._seed_expenses_from_actual_average());
		this.$root.find('#ifd-forecast-scenario').on('change', () => this._on_forecast_scenario_change());
		this.$root.find('#ifd-forecast-cost-centre').on('change', () => this._on_forecast_cost_centre_change());
		this.$root.find('#ifd-forecast-fy').on('change', () => this._load_forecast_data());
	}

	async _switch_tab(tab) {
		this.active_tab = tab === 'forecast' ? 'forecast' : 'actual';
		this.$root.find('.ifd-tab-button').removeClass('active');
		this.$root.find(`.ifd-tab-button[data-tab="${this.active_tab}"]`).addClass('active');
		this.$root.find('.ifd-tab-pane').hide();
		this.$root.find(`.ifd-tab-pane[data-tab-pane="${this.active_tab}"]`).show();

		const showActualToolbar = this.active_tab === 'actual';
		[this.financial_year, this.from_date, this.to_date, this.cost_centre].forEach(field => {
			if (field && field.$wrapper) field.$wrapper.toggle(showActualToolbar);
		});

		if (showActualToolbar) {
			this.page.set_primary_action(__('Run Income Statement'), () => this.refresh(), 'play');
			return;
		}

		this.page.set_primary_action(__('Save Forecast'), () => this._save_forecast(), 'save');
		if (!this.forecast_loaded_once) {
			await this._load_forecast_scenarios();
		}
	}

	async _load_cost_centres() {
		const previous = this.cost_centre ? this.cost_centre.get_value() : 'All Cost Centres';
		const r = await frappe.call({
			method: `${this.method_root}.get_cost_centres`,
			args: { from_date: this.from_date.get_value(), to_date: this.to_date.get_value() },
			freeze: false
		});
		const options = (r.message && r.message.cost_centres) || ['All Cost Centres'];
		this.cost_centre.df.options = options.join('\n');
		this.cost_centre.refresh();
		this.cost_centre.set_value(options.includes(previous) ? previous : 'All Cost Centres');
	}

	async refresh() {
		const from_date = this.from_date.get_value();
		const to_date = this.to_date.get_value();
		const cost_centre = this.cost_centre.get_value() || 'All Cost Centres';
		if (!from_date || !to_date) {
			frappe.msgprint(__('Please select both From Date and To Date.'));
			return;
		}

		const runStarted = performance.now();
		this.$root.find('.ifd-context').html(`
			<div class="ifd-context-title">${this._escape(cost_centre)}</div>
			<div class="ifd-context-period">${this._escape(from_date)} to ${this._escape(to_date)}</div>
			<div class="ifd-runtime ifd-runtime-running">Running Income Statement...</div>
		`);

		const r = await frappe.call({
			method: `${this.method_root}.get_dashboard_data`,
			args: { from_date, to_date, cost_centre },
			freeze: true,
			freeze_message: __('Building Income Statement...')
		});

		const responseReceived = performance.now();
		this.current_data = r.message || {};
		this.open_sections.clear();
		this.drilldown_cache.clear();
		this.transaction_cache.clear();
		this.summary_drilldown_cache.clear();

		const renderStarted = performance.now();
		this._render_kpis();
		this._render_statement();
		this._render_charts();
		const renderFinished = performance.now();

		this.last_runtime = {
			total_ms: renderFinished - runStarted,
			request_ms: responseReceived - runStarted,
			render_ms: renderFinished - renderStarted
		};
		this._render_context();
	}

	_render_context() {
		const f = this.current_data.filters || {};
		const p = this.current_data.performance || {};
		const rt = this.last_runtime || {};
		const scope = f.report_scope || (f.cost_centre === 'All Cost Centres' ? 'Consolidated' : 'Site');
		this.$root.find('.ifd-context').html(`
			<div class="ifd-context-title">${this._escape(f.cost_centre || 'All Cost Centres')}</div>
			<div class="ifd-context-period">${this._escape(f.financial_year || '')} &nbsp;|&nbsp; ${this._escape(f.from_date || '')} to ${this._escape(f.to_date || '')} &nbsp;|&nbsp; ${this._escape(scope)}</div>
			<div class="ifd-runtime">
				<span><strong>Run time:</strong> ${this._duration(rt.total_ms)}</span>
				<span>Server ${this._duration(p.server_runtime_ms)}</span>
				<span>DB ${this._duration(p.database_runtime_ms)}</span>
				<span>Render ${this._duration(rt.render_ms)}</span>
				<span>${this._integer(p.dashboard_query_count || 1)} dashboard query</span>
				<span>${this._integer(p.aggregate_rows || 0)} aggregated rows</span>
			</div>
		`);
	}

	_render_kpis() {
		const s = this.current_data.summary || {};
		const cards = [
			['Revenue', s.revenue || 0, ''],
			['Other Income', s.other_income || 0, ''],
			['Cost of Sales', s.cost_of_sales || 0, ''],
			['Other Expenditure', s.other_expenditure || 0, ''],
			['Profit / (Loss)', s.profit_loss || 0, 'profit_loss'],
			['EBITDA', s.ebitda || 0, 'ebitda']
		];

		const $kpis = this.$root.find('.ifd-kpis').html(cards.map(([label, value, metric]) => `
			<div class="ifd-kpi ${metric ? 'ifd-kpi-emphasis ifd-summary-drill-amount' : ''}" ${metric ? `data-summary-metric="${metric}" data-summary-label="${this._escape_attr(label + ' · Selected period')}"` : ''}>
				<div class="ifd-kpi-label">${this._escape(label)}</div>
				<div class="ifd-kpi-value">${this._money(value)}</div>
				${metric ? '<div class="ifd-kpi-hint">Click for cost centre detail</div>' : ''}
			</div>
		`).join(''));
		this._bind_summary_drill_links($kpis);
	}

	_render_statement() {
		const sections = this.current_data.sections || [];
		const months = this.current_data.months || [];
		const monthly = this.current_data.monthly || [];
		const summary = this.current_data.summary || {};
		const monthlyMap = Object.fromEntries(monthly.map(row => [row.key, row]));

		let html = `<table class="ifd-table ifd-summary-table ifd-period-table"><thead><tr><th>Income Statement</th>`;
		months.forEach(month => { html += `<th class="ifd-number">${this._escape(month.label)}</th>`; });
		html += `<th class="ifd-number ifd-total-col">Total</th></tr></thead><tbody>`;

		sections.forEach((section, index) => {
			const key = `section-${index}`;
			html += `<tr class="ifd-section-row" data-section-key="${key}">
				<td><span class="ifd-chevron">›</span>${this._escape(section.label)}</td>`;
			months.forEach(month => { html += `<td class="ifd-number">${this._money(section.month_totals?.[month.key] || 0)}</td>`; });
			html += `<td class="ifd-number ifd-total-col">${this._money(section.total)}</td></tr>
			<tr class="ifd-section-detail-row" data-section-detail="${key}" style="display:none;">
				<td colspan="${months.length + 2}">${this._render_section_detail(section, months)}</td>
			</tr>`;
		});

		html += `<tr class="ifd-profit-row"><td>Profit / (Loss) <span class="ifd-row-hint">click amount for cost centres</span></td>`;
		months.forEach(month => { html += `<td class="ifd-number ifd-summary-drill-amount" data-summary-metric="profit_loss" data-summary-month-key="${this._escape_attr(month.key)}" data-summary-label="${this._escape_attr(`Profit / (Loss) · ${month.label}`)}">${this._money(monthlyMap[month.key]?.profit_loss || 0)}</td>`; });
		html += `<td class="ifd-number ifd-total-col ifd-summary-drill-amount" data-summary-metric="profit_loss" data-summary-label="Profit / (Loss) · Selected period">${this._money(summary.profit_loss || 0)}</td></tr>`;

		html += `<tr class="ifd-ebitda-row"><td>EBITDA <span class="ifd-row-hint">click amount for cost centres</span></td>`;
		months.forEach(month => { html += `<td class="ifd-number ifd-summary-drill-amount" data-summary-metric="ebitda" data-summary-month-key="${this._escape_attr(month.key)}" data-summary-label="${this._escape_attr(`EBITDA · ${month.label}`)}">${this._money(monthlyMap[month.key]?.ebitda || 0)}</td>`; });
		html += `<td class="ifd-number ifd-total-col ifd-summary-drill-amount" data-summary-metric="ebitda" data-summary-label="EBITDA · Selected period">${this._money(summary.ebitda || 0)}</td></tr>`;
		html += `<tr class="ifd-ebitda-note-row"><td colspan="${months.length + 2}">EBITDA adjustments: Interest paid ${this._money(summary.interest_paid || 0)} + Depreciation ${this._money(summary.depreciation || 0)} − Interest received ${this._money(summary.interest_received || 0)}</td></tr>`;
		html += `</tbody></table>`;

		const $wrap = this.$root.find('.ifd-table-wrap').html(html);
		$wrap.find('.ifd-section-row').on('click', e => this._toggle_section($(e.currentTarget)));
		$wrap.find('.ifd-account-row').on('click', e => {
			e.stopPropagation();
			this._toggle_account_drilldown($(e.currentTarget));
		});
		this._bind_transaction_links($wrap);
		this._bind_summary_drill_links($wrap);
	}

	_render_section_detail(section, months) {
		let html = `<div class="ifd-month-table-wrap"><table class="ifd-month-table"><thead><tr><th class="ifd-account-col">Group</th><th>Description</th>`;
		months.forEach(month => { html += `<th class="ifd-number">${this._escape(month.label)}</th>`; });
		html += `<th class="ifd-number ifd-total-col">Total</th></tr></thead><tbody>`;

		(section.lines || []).forEach(line => {
			const key = `${section.report_dimension}-${line.group_account}-${line.account_type}`.replace(/[^A-Za-z0-9_-]/g, '_');
			html += `<tr class="ifd-account-row" data-key="${key}" data-group-account="${this._escape_attr(line.group_account)}" data-account-type="${this._escape_attr(line.account_type)}">
				<td class="ifd-account-col"><span class="ifd-chevron">›</span>${this._escape(line.group_account)}</td>
				<td><div class="ifd-line-description">${this._escape(line.group_description || '')}</div><div class="ifd-line-meta">${this._escape(line.account_type_description || '')}</div></td>`;
			months.forEach(month => {
				html += `<td class="ifd-number ifd-clickable-amount" data-tx-group-account="${this._escape_attr(line.group_account)}" data-tx-account-type="${this._escape_attr(line.account_type)}" data-tx-month-key="${this._escape_attr(month.key)}" data-tx-label="${this._escape_attr(`${line.group_account} · ${month.label}`)}">${this._money(line.months?.[month.key] || 0)}</td>`;
			});
			html += `<td class="ifd-number ifd-total-col ifd-clickable-amount" data-tx-group-account="${this._escape_attr(line.group_account)}" data-tx-account-type="${this._escape_attr(line.account_type)}" data-tx-label="${this._escape_attr(`${line.group_account} · Selected period`)}">${this._money(line.amount || 0)}</td></tr>
			<tr class="ifd-account-drill-row" data-parent-key="${key}" style="display:none;"><td colspan="${months.length + 3}"><div class="ifd-drill-content"></div></td></tr>`;
		});

		html += `<tr class="ifd-section-total-row"><td colspan="2">${this._escape(section.label)} Total</td>`;
		months.forEach(month => { html += `<td class="ifd-number">${this._money(section.month_totals?.[month.key] || 0)}</td>`; });
		html += `<td class="ifd-number ifd-total-col">${this._money(section.total || 0)}</td></tr></tbody></table></div>`;
		return html;
	}

	_toggle_section($row) {
		const key = $row.data('section-key');
		const $detail = this.$root.find(`.ifd-section-detail-row[data-section-detail="${key}"]`);
		const open = $detail.is(':visible');
		$detail.toggle(!open);
		$row.toggleClass('ifd-expanded', !open);
	}

	async _toggle_account_drilldown($row) {
		const key = $row.data('key');
		const $drill = this.$root.find(`.ifd-account-drill-row[data-parent-key="${key}"]`);
		if ($drill.is(':visible')) {
			$drill.hide();
			$row.removeClass('ifd-expanded');
			return;
		}

		$row.addClass('ifd-expanded');
		$drill.show();
		const cacheKey = [
			this.from_date.get_value(),
			this.to_date.get_value(),
			this.cost_centre.get_value() || 'All Cost Centres',
			$row.data('group-account'),
			$row.data('account-type')
		].join('|');

		if (this.drilldown_cache.has(cacheKey)) {
			this._render_drilldown($drill.find('.ifd-drill-content'), this.drilldown_cache.get(cacheKey));
			return;
		}

		$drill.find('.ifd-drill-content').html('<div class="ifd-loading">Loading detail...</div>');
		const started = performance.now();
		const r = await frappe.call({
			method: `${this.method_root}.get_income_statement_drilldown`,
			args: {
				from_date: this.from_date.get_value(),
				to_date: this.to_date.get_value(),
				cost_centre: this.cost_centre.get_value() || 'All Cost Centres',
				group_account: $row.data('group-account'),
				account_type: $row.data('account-type')
			},
			freeze: false
		});
		const detail = r.message || {};
		detail.group_account = $row.data('group-account');
		detail.account_type = $row.data('account-type');
		detail.client_runtime_ms = performance.now() - started;
		this.drilldown_cache.set(cacheKey, detail);
		this._render_drilldown($drill.find('.ifd-drill-content'), detail);
	}

	_render_drilldown($target, detail) {
		const rows = detail.rows || [];
		const months = detail.months || [];
		if (!rows.length) {
			$target.html('<div class="ifd-empty">No detail found for this selection.</div>');
			return;
		}

		const isCostCentre = detail.level === 'cost_centre';
		const dp = detail.performance || {};
		let html = `<div class="ifd-drill-title">${isCostCentre ? 'Cost centre contribution' : `Accounts within ${this._escape(this.cost_centre.get_value())}`}<span class="ifd-drill-runtime">Loaded ${this._duration(detail.client_runtime_ms)} | DB ${this._duration(dp.database_runtime_ms)}</span></div>`;
		html += `<div class="ifd-month-table-wrap"><table class="ifd-drill-table"><thead><tr><th>${isCostCentre ? 'Cost Centre' : 'Master Sub Account'}</th>`;
		if (!isCostCentre) html += '<th>Description</th>';
		months.forEach(month => { html += `<th class="ifd-number">${this._escape(month.label)}</th>`; });
		html += '<th class="ifd-number">Transactions</th><th class="ifd-number">Total</th></tr></thead><tbody>';

		rows.forEach(row => {
			const identity = isCostCentre ? row.cost_centre : row.master_sub_account;
			const txCostCentre = isCostCentre ? row.cost_centre : (this.cost_centre.get_value() || 'All Cost Centres');
			const masterSub = isCostCentre ? '' : row.master_sub_account;
			html += `<tr><td>${this._escape(identity)}</td>`;
			if (!isCostCentre) html += `<td>${this._escape(row.description || '')}</td>`;
			months.forEach(month => {
				html += `<td class="ifd-number ifd-clickable-amount" data-tx-group-account="${this._escape_attr(detail.group_account)}" data-tx-account-type="${this._escape_attr(detail.account_type)}" data-tx-cost-centre="${this._escape_attr(txCostCentre)}" data-tx-master-sub-account="${this._escape_attr(masterSub)}" data-tx-month-key="${this._escape_attr(month.key)}" data-tx-label="${this._escape_attr(`${identity} · ${month.label}`)}">${this._money(row.months?.[month.key] || 0)}</td>`;
			});
			html += `<td class="ifd-number">${this._integer(row.transaction_count)}</td><td class="ifd-number ifd-clickable-amount" data-tx-group-account="${this._escape_attr(detail.group_account)}" data-tx-account-type="${this._escape_attr(detail.account_type)}" data-tx-cost-centre="${this._escape_attr(txCostCentre)}" data-tx-master-sub-account="${this._escape_attr(masterSub)}" data-tx-label="${this._escape_attr(`${identity} · Selected period`)}">${this._money(row.amount)}</td></tr>`;
		});
		html += '</tbody></table></div>';
		$target.html(html);
		this._bind_transaction_links($target);
	}

	_bind_summary_drill_links($scope) {
		$scope.find('.ifd-summary-drill-amount').off('click.ifdsummary').on('click.ifdsummary', e => {
			e.preventDefault();
			e.stopPropagation();
			const $cell = $(e.currentTarget);
			this._show_summary_drilldown({
				metric: $cell.data('summary-metric'),
				month_key: $cell.data('summary-month-key') || '',
				label: $cell.data('summary-label') || 'Cost centre contribution'
			});
		});
	}

	async _show_summary_drilldown(context) {
		const costCentre = this.cost_centre.get_value() || 'All Cost Centres';
		const cacheKey = [
			this.from_date.get_value(),
			this.to_date.get_value(),
			costCentre,
			context.metric,
			context.month_key
		].join('|');

		const dialog = new frappe.ui.Dialog({
			title: __('Cost Centre Drilldown — {0}', [context.label]),
			size: 'extra-large',
			fields: [{ fieldname: 'summary_html', fieldtype: 'HTML' }]
		});
		dialog.show();
		const $body = $(dialog.fields_dict.summary_html.wrapper);
		$body.html('<div class="ifd-loading">Loading cost centre contribution...</div>');

		let detail = this.summary_drilldown_cache.get(cacheKey);
		if (!detail) {
			const started = performance.now();
			const r = await frappe.call({
				method: `${this.method_root}.get_summary_metric_drilldown`,
				args: {
					from_date: this.from_date.get_value(),
					to_date: this.to_date.get_value(),
					cost_centre: costCentre,
					metric: context.metric,
					month_key: context.month_key || null
				},
				freeze: false
			});
			detail = r.message || {};
			detail.client_runtime_ms = performance.now() - started;
			this.summary_drilldown_cache.set(cacheKey, detail);
		}

		const rows = detail.rows || [];
		const months = detail.months || [];
		const perf = detail.performance || {};
		let html = `<div class="ifd-transaction-meta"><span><strong>${this._escape(detail.metric_label || context.label)}</strong></span><span>${this._escape(detail.period_label || 'Selected period')}</span><span>Loaded ${this._duration(detail.client_runtime_ms)} | DB ${this._duration(perf.database_runtime_ms)}</span></div>`;

		if (!rows.length) {
			html += '<div class="ifd-empty">No cost centre detail found for this selection.</div>';
			$body.html(html);
			return;
		}

		html += '<div class="ifd-month-table-wrap"><table class="ifd-drill-table"><thead><tr><th>Cost Centre</th>';
		months.forEach(month => { html += `<th class="ifd-number">${this._escape(month.label)}</th>`; });
		html += '<th class="ifd-number ifd-total-col">Total</th></tr></thead><tbody>';

		const monthTotals = Object.fromEntries(months.map(month => [month.key, 0]));
		let total = 0;
		rows.forEach(row => {
			html += `<tr><td><strong>${this._escape(row.cost_centre || 'Head Office')}</strong></td>`;
			months.forEach(month => {
				const value = Number(row.months?.[month.key] || 0);
				monthTotals[month.key] += value;
				html += `<td class="ifd-number">${this._money(value)}</td>`;
			});
			const rowTotal = Number(row.amount || 0);
			total += rowTotal;
			html += `<td class="ifd-number ifd-total-col">${this._money(rowTotal)}</td></tr>`;
		});

		html += '<tr class="ifd-section-total-row"><td>Consolidated Total</td>';
		months.forEach(month => { html += `<td class="ifd-number">${this._money(monthTotals[month.key] || 0)}</td>`; });
		html += `<td class="ifd-number ifd-total-col">${this._money(total)}</td></tr></tbody></table></div>`;
		$body.html(html);
	}

	_bind_transaction_links($scope) {
		$scope.find('.ifd-clickable-amount').off('click.ifdtx').on('click.ifdtx', e => {
			e.preventDefault();
			e.stopPropagation();
			const $cell = $(e.currentTarget);
			this._show_transactions({
				group_account: $cell.data('tx-group-account'),
				account_type: $cell.data('tx-account-type'),
				cost_centre: $cell.data('tx-cost-centre') || this.cost_centre.get_value() || 'All Cost Centres',
				master_sub_account: $cell.data('tx-master-sub-account') || '',
				month_key: $cell.data('tx-month-key') || '',
				label: $cell.data('tx-label') || 'Transaction detail'
			});
		});
	}

	async _show_transactions(context) {
		const cacheKey = [
			this.from_date.get_value(),
			this.to_date.get_value(),
			context.cost_centre,
			context.group_account,
			context.account_type,
			context.master_sub_account,
			context.month_key
		].join('|');

		const dialog = new frappe.ui.Dialog({
			title: __('Transactions — {0}', [context.label]),
			size: 'extra-large',
			fields: [{ fieldname: 'transaction_html', fieldtype: 'HTML' }]
		});
		dialog.show();
		const $body = $(dialog.fields_dict.transaction_html.wrapper);
		$body.html('<div class="ifd-loading">Loading transactions...</div>');

		let detail = this.transaction_cache.get(cacheKey);
		if (!detail) {
			const started = performance.now();
			const r = await frappe.call({
				method: `${this.method_root}.get_income_statement_transactions`,
				args: {
					from_date: this.from_date.get_value(),
					to_date: this.to_date.get_value(),
					cost_centre: context.cost_centre,
					group_account: context.group_account,
					account_type: context.account_type,
					master_sub_account: context.master_sub_account || null,
					month_key: context.month_key || null
				},
				freeze: false
			});
			detail = r.message || {};
			detail.client_runtime_ms = performance.now() - started;
			this.transaction_cache.set(cacheKey, detail);
		}

		const rows = detail.rows || [];
		const perf = detail.performance || {};
		const metaHtml = `<div class="ifd-transaction-meta"><span><strong>${this._integer(detail.transaction_count || rows.length)}</strong> transactions</span><span><strong>Total:</strong> ${this._money(detail.total_amount || 0)}</span><span>${this._escape(detail.period_label || '')}</span><span>Loaded ${this._duration(detail.client_runtime_ms)} | DB ${this._duration(perf.database_runtime_ms)}</span></div>`;
		if (!rows.length) {
			$body.html(metaHtml + '<div class="ifd-empty">No transactions found for this amount.</div>');
			return;
		}

		const columns = [
			{ key: 'date', label: 'Date' },
			{ key: 'reference', label: 'Reference' },
			{ key: 'order_no', label: 'Order No' },
			{ key: 'cl_sup_name', label: 'Client / Supplier' },
			{ key: 'sage_projectcode', label: 'Project Code' },
			{ key: 'sage_projectname', label: 'Project Name' },
			{ key: 'description', label: 'Description' },
			{ key: 'amount', label: 'Amount', numeric: true }
		];
		let sortState = { key: 'date', direction: 'asc' };

		const renderTransactions = () => {
			const sortedRows = [...rows].sort((a, b) => {
				const column = columns.find(item => item.key === sortState.key) || columns[0];
				let comparison = 0;

				if (column.numeric) {
					comparison = Number(a[column.key] || 0) - Number(b[column.key] || 0);
				} else {
					const aValue = String(a[column.key] || '');
					const bValue = String(b[column.key] || '');
					comparison = aValue.localeCompare(bValue, undefined, { numeric: true, sensitivity: 'base' });
				}

				return sortState.direction === 'asc' ? comparison : -comparison;
			});

			let html = metaHtml + '<div class="ifd-transaction-wrap"><table class="ifd-transaction-table"><thead><tr>';
			columns.forEach(column => {
				const active = sortState.key === column.key;
				const indicator = active ? (sortState.direction === 'asc' ? '▲' : '▼') : '↕';
				const ariaSort = active ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none';
				html += `<th class="ifd-sortable${column.numeric ? ' ifd-number' : ''}" aria-sort="${ariaSort}"><button type="button" class="ifd-sort-button" data-sort-key="${this._escape_attr(column.key)}">${this._escape(column.label)} <span class="ifd-sort-indicator">${indicator}</span></button></th>`;
			});
			html += '</tr></thead><tbody>';

			sortedRows.forEach(row => {
				html += `<tr><td>${this._escape(row.date || '')}</td><td>${this._escape(row.reference || '')}</td><td>${this._escape(row.order_no || '')}</td><td>${this._escape(row.cl_sup_name || '')}</td><td>${this._escape(row.sage_projectcode || '')}</td><td>${this._escape(row.sage_projectname || '')}</td><td>${this._escape(row.description || '')}</td><td class="ifd-number">${this._money(row.amount || 0)}</td></tr>`;
			});

			html += `<tr class="ifd-transaction-total"><td colspan="7">Total</td><td class="ifd-number">${this._money(detail.total_amount || 0)}</td></tr></tbody></table></div>`;
			$body.html(html);

			$body.find('.ifd-sort-button').off('click.ifdsort').on('click.ifdsort', e => {
				const key = String($(e.currentTarget).data('sort-key') || 'date');
				if (sortState.key === key) {
					sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
				} else {
					sortState.key = key;
					sortState.direction = 'asc';
				}
				renderTransactions();
			});
		};

		renderTransactions();
	}

	_render_charts() {
		const monthly = this.current_data.monthly || [];
		const labels = monthly.map(row => row.label);
		this.$root.find('#ifd-revenue-chart, #ifd-expenses-chart, #ifd-profit-chart, #ifd-ebitda-chart').empty();

		if (!monthly.length) {
			this.$root.find('.ifd-chart').html('<div class="ifd-empty">No chart data for this period.</div>');
			return;
		}
		if (!(frappe && frappe.Chart)) {
			this.$root.find('.ifd-chart').html('<div class="ifd-empty">Chart library is not available on this page.</div>');
			return;
		}

		const chartOptions = {
			type: 'line',
			height: 235,
			axisOptions: { xIsSeries: true },
			lineOptions: { hideDots: 0, regionFill: 0 },
			tooltipOptions: { formatTooltipY: d => this._million(d) }
		};

		this._make_chart('#ifd-revenue-chart', chartOptions, labels, 'Revenue', monthly.map(r => this._to_million(r.revenue)));
		this._make_chart('#ifd-expenses-chart', chartOptions, labels, 'Expenses', monthly.map(r => this._to_million(r.total_costs)));
		this._make_chart('#ifd-profit-chart', chartOptions, labels, 'Profit / (Loss)', monthly.map(r => this._to_million(r.profit_loss)));
		this._make_chart('#ifd-ebitda-chart', chartOptions, labels, 'EBITDA', monthly.map(r => this._to_million(r.ebitda)));
	}

	_make_chart(selector, options, labels, name, values) {
		new frappe.Chart(selector, {
			...options,
			data: { labels, datasets: [{ name: __(name), values }] }
		});
	}


	async _load_forecast_scenarios() {
		this.$root.find('.ifd-forecast-context').html('<div class="ifd-loading">Loading forecast scenarios...</div>');
		const r = await frappe.call({
			method: `${this.method_root}.get_forecast_scenarios`,
			freeze: false
		});
		const scenarios = (r.message && r.message.scenarios) || [];
		this.forecast_scenario_map = {};
		scenarios.forEach(row => { this.forecast_scenario_map[row.name] = row; });

		const $select = this.$root.find('#ifd-forecast-scenario');
		$select.html(scenarios.map(row => `<option value="${this._escape_attr(row.name)}">${this._escape(row.scenario_name)} · ${this._escape(row.status || '')}</option>`).join(''));
		if (!scenarios.length) {
			this.$root.find('.ifd-forecast-context').html('<div class="ifd-empty">No active IS Forecast Scenarios found.</div>');
			this.$root.find('#ifd-save-forecast').prop('disabled', true);
			return;
		}

		const preferred = scenarios.find(row => row.status === 'Draft') || scenarios[0];
		$select.val(preferred.name);
		this.forecast_loaded_once = true;
		await this._on_forecast_scenario_change();
	}

	async _on_forecast_scenario_change() {
		const scenarioName = this.$root.find('#ifd-forecast-scenario').val();
		const scenario = this.forecast_scenario_map[scenarioName];
		if (!scenario) return;

		const ccResponse = await frappe.call({
			method: `${this.method_root}.get_forecast_cost_centres`,
			args: { forecast_scenario: scenarioName },
			freeze: false
		});
		const costCentres = (ccResponse.message && ccResponse.message.cost_centres) || [];
		this.forecast_cost_centre_map = {};
		costCentres.forEach(row => { this.forecast_cost_centre_map[row.name] = row; });
		const costCentreOptions = costCentres.map(row => `<option value="${this._escape_attr(row.name)}">${this._escape(row.label)}</option>`).join('');
		this.$root.find('#ifd-forecast-cost-centre').html(costCentreOptions);
		this.$root.find('#ifd-forecast-actual-source').html(costCentreOptions);

		const years = scenario.financial_years || [];
		this.$root.find('#ifd-forecast-fy').html(years.map(year => `<option value="${this._escape_attr(year)}">${this._escape(year)}</option>`).join(''));
		const actualCurrent = this.financial_year ? this.financial_year.get_value() : null;
		this.$root.find('#ifd-forecast-fy').val(years.includes(actualCurrent) ? actualCurrent : years[0]);
		this.$root.find('#ifd-forecast-cost-centre').val('__all__');
		this.$root.find('#ifd-forecast-actual-source').val('__all__');
		await this._load_forecast_data();
	}

	async _on_forecast_cost_centre_change() {
		const target = this.$root.find('#ifd-forecast-cost-centre').val();
		if (target && target !== '__all__') {
			this.$root.find('#ifd-forecast-actual-source').val(target);
		}
		await this._load_forecast_data();
	}

	_edit_forecast_scenario() {
		const scenario = this.$root.find('#ifd-forecast-scenario').val();
		if (!scenario) return;
		frappe.set_route('Form', 'IS Forecast Scenario', scenario);
	}

	async _seed_expenses_from_actual_average() {
		const forecast_scenario = this.$root.find('#ifd-forecast-scenario').val();
		const target_cost_center = this.$root.find('#ifd-forecast-cost-centre').val();
		const source_cost_center = this.$root.find('#ifd-forecast-actual-source').val();
		const scenario = this.forecast_scenario_map[forecast_scenario];
		if (!forecast_scenario || !target_cost_center || !source_cost_center) return;
		if (!scenario || scenario.status !== 'Draft') {
			frappe.msgprint(__('Only Draft Forecast Scenarios can be populated.'));
			return;
		}
		if (target_cost_center === '__all__') {
			frappe.msgprint(__('Select an individual Forecast Cost Centre first.'));
			return;
		}

		const targetLabel = this.forecast_cost_centre_map[target_cost_center]?.label || target_cost_center;
		const sourceLabel = this.forecast_cost_centre_map[source_cost_center]?.label || source_cost_center;
		frappe.confirm(
			__(`Populate ALL expense forecast months in ${targetLabel} from the last 3-month actual average of ${sourceLabel}? Existing expense forecast amounts across the full scenario will be overwritten, but remain editable afterwards.`),
			async () => {
				const r = await frappe.call({
					method: `${this.method_root}.seed_expense_forecast_from_actual_average`,
					args: { forecast_scenario, target_cost_center, source_cost_center },
					freeze: true,
					freeze_message: __('Populating expense forecast from actual averages...')
				});
				const result = r.message || {};
				frappe.show_alert({
					message: __(`Expense forecast populated from ${result.source_label || sourceLabel} (${result.period_label || ''}). ${result.created || 0} created, ${result.updated || 0} updated.`),
					indicator: 'green'
				}, 10);
				await this._load_forecast_data();
			}
		);
	}

	async _load_forecast_data() {
		const forecast_scenario = this.$root.find('#ifd-forecast-scenario').val();
		const cost_center = this.$root.find('#ifd-forecast-cost-centre').val();
		const financial_year = this.$root.find('#ifd-forecast-fy').val();
		if (!forecast_scenario || !cost_center || !financial_year) return;

		this.$root.find('.ifd-forecast-context').html('<div class="ifd-runtime ifd-runtime-running">Loading Forecast...</div>');
		const r = await frappe.call({
			method: `${this.method_root}.get_forecast_data`,
			args: { forecast_scenario, cost_center, financial_year },
			freeze: true,
			freeze_message: __('Building Forecast...')
		});
		this.forecast_data = r.message || {};
		this.forecast_live_monthly = null;
		this.forecast_live_summary = null;
		this.forecast_dirty.clear();
		this._init_forecast_state();
		this._render_forecast_context();
		this._render_forecast_kpis(this.forecast_data.fy_summary || this.forecast_data.summary || {});
		this._render_forecast_statement();
		this._render_forecast_charts();
		this._update_forecast_save_state();
	}

	_init_forecast_state() {
		this.forecast_state = new Map();
		this.forecast_line_map = new Map();
		(this.forecast_data.sections || []).forEach(section => {
			(section.lines || []).forEach(line => {
				this.forecast_line_map.set(line.account, line);
				Object.values(line.months || {}).forEach(cell => {
					const key = `${line.account}|${cell.forecast_period}`;
					this.forecast_state.set(key, {
						account: line.account,
						forecast_period: cell.forecast_period,
						volume: Number(cell.volume || 0),
						volume_uom: cell.volume_uom || line.default_forecast_uom || '',
						price_per_unit: Number(cell.price_per_unit || 0),
						forecast_amount: Number(cell.forecast_amount || 0),
						comments: cell.comments || '',
						available: !!cell.available
					});
				});
			});
		});
	}

	_render_forecast_context() {
		const scenario = this.forecast_data.scenario || {};
		const filters = this.forecast_data.filters || {};
		const perf = this.forecast_data.performance || {};
		const editable = !!this.forecast_data.editable;
		const actuals = this.forecast_data.actuals || {};
		const mode = editable ? 'Editable' : (filters.cost_center === '__all__' ? 'Consolidated · Read only' : `${scenario.status || ''} · Read only`);
		this.$root.find('#ifd-seed-expenses').prop('disabled', !editable);
		this.$root.find('.ifd-forecast-context').html(`
			<div class="ifd-context-title">${this._escape(scenario.scenario_name || '')}</div>
			<div class="ifd-context-period">${this._escape(filters.cost_center_label || '')} &nbsp;|&nbsp; ${this._escape(filters.financial_year || '')} &nbsp;|&nbsp; ${this._escape(mode)}</div>
			<div class="ifd-context-period">Actual YTD: ${this._escape(actuals.period_label || 'No actuals')} · Monthly columns marked A = Actual, F = Forecast</div>
			<div class="ifd-runtime">
				<span>Server ${this._duration(perf.server_runtime_ms)}</span>
				<span>DB ${this._duration(perf.database_runtime_ms)}</span>
				<span>${this._integer(perf.account_count || 0)} forecast accounts</span>
				<span>${this._integer(perf.entry_count || 0)} stored entries in view</span>
				<span class="ifd-forecast-dirty-indicator"></span>
			</div>
		`);
	}

	_render_forecast_kpis(summary) {
		const cards = [
			['FY Revenue', summary.revenue || 0],
			['FY Other Income', summary.other_income || 0],
			['FY Cost of Sales', summary.cost_of_sales || 0],
			['FY Other Expenditure', summary.other_expenditure || 0],
			['FY Profit / (Loss)', summary.profit_loss || 0],
			['FY EBITDA', summary.ebitda || 0]
		];
		this.$root.find('.ifd-forecast-kpis').html(cards.map(([label, value]) => `
			<div class="ifd-kpi ${label.includes('Profit / (Loss)') || label.includes('EBITDA') ? 'ifd-kpi-emphasis' : ''}">
				<div class="ifd-kpi-label">${this._escape(label)}</div>
				<div class="ifd-kpi-value">${this._money(value)}</div>
			</div>
		`).join(''));
	}


	_forecast_colgroup(months) {
		let html = `<colgroup><col class="ifd-col-account"><col class="ifd-col-description"><col class="ifd-col-actual">`;
		(months || []).forEach(() => { html += '<col class="ifd-col-month">'; });
		html += '<col class="ifd-col-total"></colgroup>';
		return html;
	}

	_render_forecast_statement() {
		const data = this.forecast_data || {};
		const months = data.months || [];
		const sections = data.sections || [];
		const fyMonthlyMap = Object.fromEntries((data.fy_monthly || []).map(row => [row.key, row]));
		const fySummary = data.fy_summary || data.summary || {};
		const actualSummary = data.actuals?.summary || {};
		const colgroup = this._forecast_colgroup(months);

		let html = `<table class="ifd-table ifd-summary-table ifd-period-table ifd-forecast-table">${colgroup}<thead><tr>`;
		html += `<th class="ifd-fc-account-sticky">Account</th><th class="ifd-fc-description-sticky">Forecast Income Statement</th><th class="ifd-number ifd-actual-col"><div>Actual YTD</div><div class="ifd-currency-unit">R</div></th>`;
		months.forEach(month => {
			const mode = month.display_mode || (month.actual_available ? 'actual' : (month.available ? 'forecast' : 'none'));
			const tag = mode === 'actual' ? '<span class="ifd-month-tag ifd-month-tag-actual">A</span>' : (mode === 'forecast' ? '<span class="ifd-month-tag ifd-month-tag-forecast">F</span>' : '');
			html += `<th class="ifd-number ifd-${mode}-month">${this._forecast_currency_header(month.short_label || month.label, tag)}</th>`;
		});
		html += `<th class="ifd-number ifd-total-col"><div>FY Total</div><div class="ifd-currency-unit">R</div></th></tr></thead><tbody>`;

		sections.forEach(section => {
			const key = section.report_dimension;
			const open = this.forecast_open_sections.has(key);
			html += `<tr class="ifd-forecast-section-row ${open ? 'ifd-expanded' : ''}" data-fc-section="${this._escape_attr(key)}">`;
			html += `<td class="ifd-fc-account-sticky"></td><td class="ifd-fc-description-sticky"><span class="ifd-chevron">›</span>${this._escape(section.label)}</td><td class="ifd-number ifd-actual-col">${this._forecast_money_html(section.actual_total || 0)}</td>`;
			months.forEach(month => {
				const mode = month.display_mode || 'none';
				const value = section.fy_month_totals?.[month.key] || 0;
				html += `<td class="ifd-number ifd-${mode}-month" data-fc-section-total="${this._escape_attr(key)}" data-fc-period="${this._escape_attr(month.period)}">${mode === 'none' ? '—' : this._forecast_money_html(value)}</td>`;
			});
			html += `<td class="ifd-number ifd-total-col" data-fc-section-period-total="${this._escape_attr(key)}">${this._forecast_money_html(section.fy_total || 0)}</td></tr>`;
			html += `<tr class="ifd-forecast-section-detail" data-fc-section-detail="${this._escape_attr(key)}" style="display:${open ? 'table-row' : 'none'};"><td colspan="${months.length + 4}">${this._render_forecast_section_detail(section, months)}</td></tr>`;
		});

		html += `<tr class="ifd-profit-row"><td class="ifd-fc-account-sticky"></td><td class="ifd-fc-description-sticky">Profit / (Loss)</td><td class="ifd-number ifd-actual-col">${this._forecast_money_html(actualSummary.profit_loss || 0)}</td>`;
		months.forEach(month => {
			const mode = month.display_mode || 'none';
			const value = fyMonthlyMap[month.key]?.profit_loss || 0;
			html += `<td class="ifd-number ifd-${mode}-month" data-fc-profit-period="${this._escape_attr(month.period)}">${mode === 'none' ? '—' : this._forecast_money_html(value)}</td>`;
		});
		html += `<td class="ifd-number ifd-total-col" data-fc-profit-total>${this._forecast_money_html(fySummary.profit_loss || 0)}</td></tr>`;

		html += `<tr class="ifd-ebitda-row"><td class="ifd-fc-account-sticky"></td><td class="ifd-fc-description-sticky">EBITDA</td><td class="ifd-number ifd-actual-col">${this._forecast_money_html(actualSummary.ebitda || 0)}</td>`;
		months.forEach(month => {
			const mode = month.display_mode || 'none';
			const value = fyMonthlyMap[month.key]?.ebitda || 0;
			html += `<td class="ifd-number ifd-${mode}-month" data-fc-ebitda-period="${this._escape_attr(month.period)}">${mode === 'none' ? '—' : this._forecast_money_html(value)}</td>`;
		});
		html += `<td class="ifd-number ifd-total-col" data-fc-ebitda-total>${this._forecast_money_html(fySummary.ebitda || 0)}</td></tr>`;
		html += `</tbody></table>`;

		const $wrap = this.$root.find('.ifd-forecast-table-wrap').html(html);
		$wrap.find('.ifd-forecast-section-row').on('click', e => {
			const $row = $(e.currentTarget);
			const section = $row.data('fc-section');
			const $detail = $wrap.find(`.ifd-forecast-section-detail[data-fc-section-detail="${section}"]`);
			const open = $detail.is(':visible');
			$detail.toggle(!open);
			$row.toggleClass('ifd-expanded', !open);
			if (open) this.forecast_open_sections.delete(section); else this.forecast_open_sections.add(section);
		});
		this._bind_forecast_inputs($wrap);
	}

	_render_forecast_section_detail(section, months) {
		const editable = !!this.forecast_data.editable;
		const uoms = this.forecast_data.uoms || [];
		let html = `<div class="ifd-month-table-wrap ifd-fc-detail-wrap"><table class="ifd-month-table ifd-fc-detail-table">${this._forecast_colgroup(months)}<thead><tr><th class="ifd-account-col ifd-fc-account-sticky">Account</th><th class="ifd-fc-description-sticky">Description / Driver</th><th class="ifd-number ifd-actual-col"><div>Actual YTD</div><div class="ifd-currency-unit">R</div></th>`;
		months.forEach(month => {
			const mode = month.display_mode || 'none';
			const tag = mode === 'actual' ? '<span class="ifd-month-tag ifd-month-tag-actual">A</span>' : (mode === 'forecast' ? '<span class="ifd-month-tag ifd-month-tag-forecast">F</span>' : '');
			html += `<th class="ifd-number ifd-${mode}-month">${this._forecast_currency_header(month.short_label || month.label, tag)}</th>`;
		});
		html += `<th class="ifd-number ifd-total-col"><div>FY Total</div><div class="ifd-currency-unit">R</div></th></tr></thead><tbody>`;

		(section.lines || []).forEach(line => {
			const driverBased = this._is_volume_price_method(line.forecast_method);
			html += `<tr class="ifd-fc-account-value-row"><td class="ifd-account-col ifd-fc-account-sticky">${this._escape(line.account_number)}</td><td class="ifd-fc-description-sticky"><div class="ifd-line-description">${this._escape(line.account_name)}</div><div class="ifd-line-meta">${this._escape(line.forecast_method || '')}${line.ebitda_treatment && line.ebitda_treatment !== 'Normal' ? ` · EBITDA: ${this._escape(line.ebitda_treatment)}` : ''}</div></td><td class="ifd-number ifd-actual-col">${this._forecast_money_html(line.actual_amount || 0)}</td>`;

			months.forEach(month => {
				const cell = line.months?.[month.key] || {};
				const mode = month.display_mode || 'none';
				if (mode === 'actual') {
					html += `<td class="ifd-number ifd-actual-month" title="Actual">${this._forecast_money_html(cell.actual_amount || 0)}</td>`;
				} else if (mode === 'forecast' && month.available && driverBased) {
					html += `<td class="ifd-number ifd-fc-calculated ifd-forecast-month" data-fc-value-account="${this._escape_attr(line.account)}" data-fc-value-period="${this._escape_attr(cell.forecast_period)}">${this._forecast_money_html(cell.forecast_amount || 0)}</td>`;
				} else if (mode === 'forecast' && month.available && editable) {
					html += `<td class="ifd-number ifd-forecast-month"><input class="form-control ifd-fc-input ifd-fc-money-input ${Number(cell.forecast_amount || 0) < 0 ? 'ifd-negative-input' : ''}" type="number" step="1" data-account="${this._escape_attr(line.account)}" data-period="${this._escape_attr(cell.forecast_period)}" data-field="forecast_amount" value="${Math.round(Number(cell.forecast_amount || 0))}"></td>`;
				} else if (mode === 'forecast' && month.available) {
					html += `<td class="ifd-number ifd-forecast-month">${this._forecast_money_html(cell.forecast_amount || 0)}</td>`;
				} else {
					html += '<td class="ifd-number ifd-none-month">—</td>';
				}
			});
			html += `<td class="ifd-number ifd-total-col" data-fc-line-total="${this._escape_attr(line.account)}">${this._forecast_money_html(line.fy_total || 0)}</td></tr>`;

			if (driverBased) {
				for (const driver of ['volume', 'volume_uom', 'price_per_unit']) {
					const labels = { volume: 'Volume', volume_uom: 'Volume UOM', price_per_unit: 'Price / Unit (R)' };
					html += `<tr class="ifd-fc-driver-row"><td class="ifd-fc-account-sticky"></td><td class="ifd-fc-driver-label ifd-fc-description-sticky">${labels[driver]}</td><td class="ifd-actual-col"></td>`;
					months.forEach(month => {
						const cell = line.months?.[month.key] || {};
						const mode = month.display_mode || 'none';
						if (mode !== 'forecast' || !month.available) { html += `<td class="ifd-number ifd-${mode}-month">—</td>`; return; }
						if (driver === 'volume') {
							if (editable) html += `<td class="ifd-forecast-month"><input class="form-control ifd-fc-input" type="number" step="0.01" data-account="${this._escape_attr(line.account)}" data-period="${this._escape_attr(cell.forecast_period)}" data-field="volume" value="${Number(cell.volume || 0)}"></td>`;
							else html += `<td class="ifd-number ifd-forecast-month">${this._number2(cell.volume || 0)}</td>`;
						} else if (driver === 'volume_uom') {
							if (editable) {
								const selected = cell.volume_uom || line.default_forecast_uom || '';
								html += `<td class="ifd-forecast-month"><select class="form-control ifd-fc-input ifd-fc-uom" data-account="${this._escape_attr(line.account)}" data-period="${this._escape_attr(cell.forecast_period)}" data-field="volume_uom"><option value=""></option>${uoms.map(uom => `<option value="${this._escape_attr(uom)}" ${uom === selected ? 'selected' : ''}>${this._escape(uom)}</option>`).join('')}</select></td>`;
							} else html += `<td class="ifd-forecast-month">${this._escape(cell.volume_uom || line.default_forecast_uom || '')}</td>`;
						} else {
							if (editable) html += `<td class="ifd-forecast-month"><input class="form-control ifd-fc-input" type="number" step="0.0001" data-account="${this._escape_attr(line.account)}" data-period="${this._escape_attr(cell.forecast_period)}" data-field="price_per_unit" value="${Number(cell.price_per_unit || 0)}"></td>`;
							else html += `<td class="ifd-number ifd-forecast-month">${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(cell.price_per_unit || 0))}</td>`;
						}
					});
					html += '<td></td></tr>';
				}
			}
		});

		html += `<tr class="ifd-section-total-row"><td class="ifd-fc-account-sticky"></td><td class="ifd-fc-description-sticky">${this._escape(section.label)} Total</td><td class="ifd-number ifd-actual-col">${this._forecast_money_html(section.actual_total || 0)}</td>`;
		months.forEach(month => {
			const mode = month.display_mode || 'none';
			const value = section.fy_month_totals?.[month.key] || 0;
			html += `<td class="ifd-number ifd-${mode}-month" data-fc-section-total-detail="${this._escape_attr(section.report_dimension)}" data-fc-period="${this._escape_attr(month.period)}">${mode === 'none' ? '—' : this._forecast_money_html(value)}</td>`;
		});
		html += `<td class="ifd-number ifd-total-col" data-fc-section-detail-total="${this._escape_attr(section.report_dimension)}">${this._forecast_money_html(section.fy_total || 0)}</td></tr>`;
		html += '</tbody></table></div>';
		return html;
	}

	_bind_forecast_inputs($scope) {
		$scope.find('.ifd-fc-input').on('input change', e => {
			const $input = $(e.currentTarget);
			const account = $input.data('account');
			const period = $input.data('period');
			const field = $input.data('field');
			const key = `${account}|${period}`;
			const state = this.forecast_state.get(key);
			if (!state) return;

			state[field] = field === 'volume_uom' ? $input.val() : Number($input.val() || 0);
			if ($input.hasClass('ifd-fc-money-input')) $input.toggleClass('ifd-negative-input', Number($input.val() || 0) < 0);
			const line = this.forecast_line_map.get(account);
			if (line && this._is_volume_price_method(line.forecast_method)) {
				state.forecast_amount = Number(state.volume || 0) * Number(state.price_per_unit || 0);
			}
			this.forecast_dirty.add(key);
			this._recalculate_forecast_grid();
			this._update_forecast_save_state();
		});
	}

	_recalculate_forecast_grid() {
		const months = this.forecast_data.months || [];
		const actualMonthlyMap = Object.fromEntries(((this.forecast_data.actuals || {}).monthly || []).map(row => [row.key, row]));
		const sectionTotals = {};
		['IS-Revenue', 'IS-Other Income', 'IS-Cost of Sales', 'IS-Other Expenditure'].forEach(d => {
			sectionTotals[d] = Object.fromEntries(months.map(m => [m.period, 0]));
		});
		const adjustments = Object.fromEntries(months.map(m => [m.period, { interest_paid: 0, depreciation: 0, interest_received: 0 }]));

		this.forecast_line_map.forEach(line => {
			let lineTotal = 0;
			months.forEach(month => {
				const mode = month.display_mode || 'none';
				const cell = line.months?.[month.key] || {};
				let amount = 0;
				if (mode === 'actual') {
					amount = Number(cell.actual_amount || 0);
				} else if (mode === 'forecast' && month.available) {
					const state = this.forecast_state.get(`${line.account}|${month.period}`);
					if (state) amount = Number(state.forecast_amount || 0);
					const treatment = String(line.ebitda_treatment || 'Normal').toLowerCase();
					if (treatment === 'depreciation') adjustments[month.period].depreciation += amount;
					if (treatment === 'interest paid') adjustments[month.period].interest_paid += amount;
					if (treatment === 'interest received') adjustments[month.period].interest_received += amount;
					this.$root.find(`[data-fc-value-account="${this._cssEscape(line.account)}"][data-fc-value-period="${month.period}"]`).html(this._forecast_money_html(amount));
				}
				lineTotal += amount;
				sectionTotals[line.report_dimension][month.period] += amount;
			});
			this.$root.find(`[data-fc-line-total="${this._cssEscape(line.account)}"]`).html(this._forecast_money_html(lineTotal));
		});

		const liveMonthly = [];
		const totals = { revenue: 0, other_income: 0, cost_of_sales: 0, other_expenditure: 0, profit_loss: 0, ebitda: 0, interest_paid: 0, depreciation: 0, interest_received: 0 };
		months.forEach(month => {
			const mode = month.display_mode || 'none';
			const revenue = sectionTotals['IS-Revenue'][month.period] || 0;
			const otherIncome = sectionTotals['IS-Other Income'][month.period] || 0;
			const costSales = sectionTotals['IS-Cost of Sales'][month.period] || 0;
			const otherExpense = sectionTotals['IS-Other Expenditure'][month.period] || 0;
			let profit = revenue + otherIncome - costSales - otherExpense;
			let adj = adjustments[month.period];
			let ebitda = profit + adj.interest_paid + adj.depreciation - adj.interest_received;

			if (mode === 'actual') {
				const actual = actualMonthlyMap[month.key] || {};
				profit = Number(actual.profit_loss || profit || 0);
				ebitda = Number(actual.ebitda || 0);
				adj = {
					interest_paid: Number(actual.interest_paid || 0),
					depreciation: Number(actual.depreciation || 0),
					interest_received: Number(actual.interest_received || 0)
				};
			}

			liveMonthly.push({ ...month, mode: mode === 'actual' ? 'Actual' : (mode === 'forecast' ? 'Forecast' : 'None'), revenue, other_income: otherIncome, cost_of_sales: costSales, other_expenditure: otherExpense, total_costs: costSales + otherExpense, profit_loss: profit, ebitda });
			totals.revenue += revenue; totals.other_income += otherIncome; totals.cost_of_sales += costSales; totals.other_expenditure += otherExpense;
			totals.profit_loss += profit; totals.ebitda += ebitda; totals.interest_paid += adj.interest_paid; totals.depreciation += adj.depreciation; totals.interest_received += adj.interest_received;

			Object.entries({ 'IS-Revenue': revenue, 'IS-Other Income': otherIncome, 'IS-Cost of Sales': costSales, 'IS-Other Expenditure': otherExpense }).forEach(([dimension, value]) => {
				this.$root.find(`[data-fc-section-total="${dimension}"][data-fc-period="${month.period}"], [data-fc-section-total-detail="${dimension}"][data-fc-period="${month.period}"]`).html(mode === 'none' ? '—' : this._forecast_money_html(value));
			});
			this.$root.find(`[data-fc-profit-period="${month.period}"]`).html(mode === 'none' ? '—' : this._forecast_money_html(profit));
			this.$root.find(`[data-fc-ebitda-period="${month.period}"]`).html(mode === 'none' ? '—' : this._forecast_money_html(ebitda));
		});

		Object.entries(sectionTotals).forEach(([dimension, values]) => {
			const total = Object.values(values).reduce((a, b) => a + Number(b || 0), 0);
			this.$root.find(`[data-fc-section-period-total="${dimension}"], [data-fc-section-detail-total="${dimension}"]`).html(this._forecast_money_html(total));
		});
		this.$root.find('[data-fc-profit-total]').html(this._forecast_money_html(totals.profit_loss));
		this.$root.find('[data-fc-ebitda-total]').html(this._forecast_money_html(totals.ebitda));
		this._render_forecast_kpis(totals);
		this.forecast_live_monthly = liveMonthly;
		this.forecast_live_summary = totals;
	}

	_update_forecast_save_state() {
		const editable = !!(this.forecast_data && this.forecast_data.editable);
		const dirtyCount = this.forecast_dirty.size;
		this.$root.find('#ifd-save-forecast').prop('disabled', !editable || !dirtyCount);
		this.$root.find('.ifd-forecast-dirty-indicator').text(dirtyCount ? `${dirtyCount} unsaved month${dirtyCount === 1 ? '' : 's'}` : (editable ? 'No unsaved changes' : 'Read only'));
		if (this.active_tab === 'forecast') {
			this.page.set_primary_action(editable ? __('Save Forecast') : __('Refresh Forecast'), editable ? () => this._save_forecast() : () => this._load_forecast_data(), editable ? 'save' : 'refresh');
		}
	}

	async _save_forecast() {
		if (!this.forecast_data || !this.forecast_data.editable) {
			if (this.active_tab === 'forecast') await this._load_forecast_data();
			return;
		}
		if (!this.forecast_dirty.size) {
			frappe.show_alert({ message: __('No forecast changes to save.'), indicator: 'blue' });
			return;
		}

		const changes = [...this.forecast_dirty].map(key => ({ ...this.forecast_state.get(key) }));
		const forecast_scenario = this.$root.find('#ifd-forecast-scenario').val();
		const cost_center = this.$root.find('#ifd-forecast-cost-centre').val();
		const r = await frappe.call({
			method: `${this.method_root}.save_forecast_changes`,
			args: { forecast_scenario, cost_center, changes: JSON.stringify(changes) },
			freeze: true,
			freeze_message: __('Saving Forecast...')
		});
		const result = r.message || {};
		frappe.show_alert({
			message: __(`Forecast saved: ${result.created || 0} created, ${result.updated || 0} updated, ${result.deleted || 0} cleared.`),
			indicator: 'green'
		}, 7);
		await this._load_forecast_data();
	}

	_render_forecast_charts() {
		const monthly = this.forecast_live_monthly || this.forecast_data.fy_monthly || [];
		const labels = monthly.map(row => row.label);
		this.$root.find('#ifd-forecast-revenue-chart, #ifd-forecast-expenses-chart, #ifd-forecast-profit-chart, #ifd-forecast-ebitda-chart').empty();
		if (!monthly.length || !(frappe && frappe.Chart)) return;
		const options = {
			type: 'line', height: 235,
			axisOptions: { xIsSeries: true },
			lineOptions: { hideDots: 0, regionFill: 0 },
			tooltipOptions: { formatTooltipY: d => this._million(d) }
		};
		this._make_chart('#ifd-forecast-revenue-chart', options, labels, 'Revenue Actual + Forecast', monthly.map(r => this._to_million(r.revenue)));
		this._make_chart('#ifd-forecast-expenses-chart', options, labels, 'Expenses Actual + Forecast', monthly.map(r => this._to_million(r.total_costs)));
		this._make_chart('#ifd-forecast-profit-chart', options, labels, 'Profit / (Loss) Actual + Forecast', monthly.map(r => this._to_million(r.profit_loss)));
		this._make_chart('#ifd-forecast-ebitda-chart', options, labels, 'EBITDA Actual + Forecast', monthly.map(r => this._to_million(r.ebitda)));
	}

	_is_volume_price_method(value) {
		const method = String(value || '').trim().toLowerCase();
		return method === 'volume x price' || method === 'volume × price';
	}

	_number2(value) {
		return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value || 0));
	}

	_forecast_money(value) {
		const number = Math.round(Number(value || 0));
		return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(number);
	}

	_forecast_money_html(value) {
		const number = Math.round(Number(value || 0));
		const formatted = this._forecast_money(number);
		return number < 0 ? `<span class="ifd-negative-amount">${formatted}</span>` : formatted;
	}

	_forecast_currency_header(label, tag = '') {
		return `<div>${this._escape(label)}</div><div class="ifd-currency-unit">R</div>${tag}`;
	}

	_money4(value) {
		return `R ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(value || 0))}`;
	}

	_cssEscape(value) {
		if (window.CSS && CSS.escape) return CSS.escape(String(value || ''));
		return String(value || '').replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
	}

	_default_financial_year_start() {
		const parts = frappe.datetime.get_today().split('-').map(Number);
		const year = parts[1] >= 3 ? parts[0] : parts[0] - 1;
		return `${year}-03-01`;
	}

	_to_million(value) {
		return Number(value || 0) / 1000000;
	}

	_million(value) {
		return `R ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))}m`;
	}

	_money(value) {
		const number = Number(value || 0);
		return `R ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(number)}`;
	}

	_integer(value) {
		return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0));
	}

	_duration(ms) {
		const value = Number(ms || 0);
		if (value < 1000) return `${Math.round(value).toLocaleString('en-US')} ms`;
		return `${(value / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`;
	}

	_escape(value) {
		return frappe.utils.escape_html(String(value ?? ''));
	}

	_escape_attr(value) {
		return this._escape(value).replace(/`/g, '&#96;');
	}

	_inject_styles() {
		if (document.getElementById('is-fin-dashboard-styles')) return;
		$(`<style id="is-fin-dashboard-styles">
			.is-fin-dashboard { padding: 8px 0 28px; }
			.ifd-context { margin: 8px 0 18px; }
			.ifd-context-title { font-size: 22px; font-weight: 700; }
			.ifd-context-period { color: var(--text-muted); margin-top: 3px; }
			.ifd-runtime { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 8px; font-size: 11px; color: var(--text-muted); }
			.ifd-runtime span { white-space: nowrap; }
			.ifd-runtime-running { font-size: 12px; }
			.ifd-kpis { display: grid; grid-template-columns: repeat(3, minmax(170px, 1fr)); gap: 12px; margin-bottom: 16px; }
			.ifd-kpi, .ifd-panel { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 10px; }
			.ifd-kpi { padding: 16px; min-height: 92px; }
			.ifd-kpi-label { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); margin-bottom: 8px; }
			.ifd-kpi-value { font-size: 21px; font-weight: 700; white-space: nowrap; }
			.ifd-kpi-emphasis { border-width: 2px; }
			.ifd-summary-drill-amount { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
			.ifd-summary-drill-amount:hover { background: var(--control-bg); }
			.ifd-kpi.ifd-summary-drill-amount { text-decoration: none; }
			.ifd-kpi-hint, .ifd-row-hint { font-size: 10px; font-weight: 400; color: var(--text-muted); }
			.ifd-kpi-hint { margin-top: 5px; }
			.ifd-charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
			.ifd-panel { padding: 16px; overflow: hidden; }
			.ifd-panel-title { font-size: 16px; font-weight: 700; }
			.ifd-subtitle { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
			.ifd-chart { min-height: 245px; margin-top: 8px; }
			.ifd-statement-panel { padding: 0; }
			.ifd-panel-header { padding: 16px 18px; border-bottom: 1px solid var(--border-color); }
			.ifd-table-wrap, .ifd-month-table-wrap { overflow-x: auto; }
			.ifd-table, .ifd-month-table, .ifd-drill-table { width: 100%; border-collapse: collapse; }
			.ifd-summary-table td { padding: 13px 16px; border-bottom: 1px solid var(--border-color); }
			.ifd-section-row { cursor: pointer; font-weight: 700; background: var(--subtle-fg); }
			.ifd-section-row:hover td { background: var(--control-bg); }
			.ifd-section-detail-row > td { padding: 0 !important; }
			.ifd-number { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
			.ifd-chevron { display: inline-block; margin-right: 8px; transition: transform .15s ease; font-size: 18px; line-height: 1; }
			.ifd-expanded > td .ifd-chevron, .ifd-expanded .ifd-chevron { transform: rotate(90deg); }
			.ifd-month-table th, .ifd-drill-table th { padding: 9px 11px; background: var(--subtle-fg); color: var(--text-muted); border-bottom: 1px solid var(--border-color); font-size: 11px; text-transform: uppercase; }
			.ifd-month-table td, .ifd-drill-table td { padding: 9px 11px; border-bottom: 1px solid var(--border-color); }
			.ifd-account-col { min-width: 105px; }
			.ifd-line-description { font-weight: 600; min-width: 190px; }
			.ifd-line-meta { color: var(--text-muted); font-size: 11px; margin-top: 2px; }
			.ifd-account-row { cursor: pointer; }
			.ifd-account-row:hover td, .ifd-account-row.ifd-expanded td { background: var(--control-bg); }
			.ifd-total-col { font-weight: 700; background: var(--subtle-fg); }
			.ifd-section-total-row td { font-weight: 700; border-top: 2px solid var(--border-color); }
			.ifd-account-drill-row > td { padding: 0 14px 14px 36px; background: var(--control-bg); }
			.ifd-drill-content { border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; background: var(--card-bg); }
			.ifd-drill-title { padding: 10px 12px; font-weight: 700; border-bottom: 1px solid var(--border-color); }
			.ifd-drill-runtime { float: right; font-size: 10px; font-weight: 400; color: var(--text-muted); }
			.ifd-profit-row td { font-size: 16px; font-weight: 800; border-top: 2px solid var(--text-color); background: var(--subtle-fg); }
			.ifd-ebitda-row td { font-size: 17px; font-weight: 800; border-top: 1px solid var(--border-color); }
			.ifd-ebitda-note-row td { font-size: 11px; color: var(--text-muted); padding-top: 7px; padding-bottom: 12px; }
			.ifd-period-table thead th { position: sticky; top: 0; z-index: 1; padding: 10px 12px; background: var(--subtle-fg); border-bottom: 1px solid var(--border-color); color: var(--text-muted); font-size: 11px; text-transform: uppercase; }
			.ifd-clickable-amount { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 3px; }
			.ifd-clickable-amount:hover { background: var(--control-bg); font-weight: 700; }
			.ifd-transaction-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; padding: 10px 0 12px; font-size: 12px; color: var(--text-muted); }
			.ifd-transaction-wrap { max-height: 62vh; overflow: auto; border: 1px solid var(--border-color); border-radius: 8px; }
			.ifd-transaction-table { width: 100%; border-collapse: collapse; }
			.ifd-transaction-table th { position: sticky; top: 0; z-index: 1; padding: 0; background: var(--subtle-fg); border-bottom: 1px solid var(--border-color); color: var(--text-muted); font-size: 11px; text-transform: uppercase; }
			.ifd-transaction-table th.ifd-sortable { user-select: none; white-space: nowrap; }
			.ifd-sort-button { width: 100%; padding: 9px 11px; border: 0; background: transparent; color: inherit; font: inherit; font-weight: 700; text-transform: inherit; text-align: left; cursor: pointer; }
			.ifd-number .ifd-sort-button { text-align: right; }
			.ifd-sort-button:hover { background: var(--control-bg); color: var(--text-color); }
			.ifd-sort-button:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
			.ifd-sort-indicator { display: inline-block; margin-left: 4px; font-size: 9px; opacity: .75; }
			.ifd-transaction-table td { padding: 9px 11px; border-bottom: 1px solid var(--border-color); vertical-align: top; }
			.ifd-transaction-total td { position: sticky; bottom: 0; background: var(--card-bg); font-weight: 800; border-top: 2px solid var(--border-color); }
			.ifd-loading, .ifd-empty { padding: 20px; color: var(--text-muted); text-align: center; }
			.ifd-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border-color); margin: 0 0 16px; }
			.ifd-tab-button { border: 0; border-bottom: 3px solid transparent; background: transparent; padding: 10px 16px; font-weight: 700; color: var(--text-muted); cursor: pointer; }
			.ifd-tab-button.active { color: var(--text-color); border-bottom-color: var(--primary); }
			.ifd-forecast-controls { display: grid; grid-template-columns: minmax(210px, 1.3fr) minmax(210px, 1.2fr) minmax(145px, .75fr) minmax(210px, 1.2fr) auto; gap: 12px; align-items: end; margin-bottom: 12px; }
			.ifd-control-group label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); margin-bottom: 5px; }
			.ifd-forecast-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 1px; }
			.ifd-actual-col { background: var(--subtle-fg) !important; font-weight: 700; border-right: 2px solid var(--border-color) !important; }
			.ifd-forecast-context { margin: 8px 0 14px; }
			.ifd-forecast-kpis { display: grid; grid-template-columns: repeat(3, minmax(170px, 1fr)); gap: 12px; margin-bottom: 16px; }
			.ifd-forecast-panel { margin-bottom: 16px; }
			.ifd-forecast-table-wrap {
				position: relative;
				overflow: auto;
				max-height: 68vh;
				min-height: 360px;
				scrollbar-gutter: stable both-edges;
				border-top: 1px solid var(--border-color);
				border-bottom: 1px solid var(--border-color);
				overscroll-behavior: contain;
			}
			.ifd-forecast-table, .ifd-fc-detail-table { min-width: 1920px; width: 100%; table-layout: fixed; font-size: 10px; }
			.ifd-forecast-table col.ifd-col-account, .ifd-fc-detail-table col.ifd-col-account { width: 105px; }
			.ifd-forecast-table col.ifd-col-description, .ifd-fc-detail-table col.ifd-col-description { width: 225px; }
			.ifd-forecast-table col.ifd-col-actual, .ifd-fc-detail-table col.ifd-col-actual { width: 140px; }
			.ifd-forecast-table col.ifd-col-month, .ifd-fc-detail-table col.ifd-col-month { width: 110px; }
			.ifd-forecast-table col.ifd-col-total, .ifd-fc-detail-table col.ifd-col-total { width: 135px; }
			.ifd-forecast-table-wrap .ifd-month-table-wrap { overflow: visible; }
			.ifd-forecast-table thead th { position: sticky; top: 0; z-index: 12; height: 48px; vertical-align: middle; font-size: 9px; padding: 6px 7px; }
			.ifd-fc-detail-table thead th { position: sticky; top: 48px; z-index: 10; height: 40px; vertical-align: middle; background: var(--subtle-fg); font-size: 9px; padding: 5px 7px; }
			.ifd-fc-account-sticky { position: sticky; left: 0; z-index: 7; }
			.ifd-fc-description-sticky { position: sticky; left: 105px; z-index: 7; box-shadow: 2px 0 0 var(--border-color); }
			.ifd-forecast-table thead .ifd-fc-account-sticky, .ifd-forecast-table thead .ifd-fc-description-sticky { z-index: 15; background: var(--subtle-fg); }
			.ifd-fc-detail-table thead .ifd-fc-account-sticky, .ifd-fc-detail-table thead .ifd-fc-description-sticky { z-index: 14; background: var(--subtle-fg); }
			.ifd-forecast-section-row .ifd-fc-account-sticky, .ifd-forecast-section-row .ifd-fc-description-sticky { background: var(--subtle-fg); }
			.ifd-fc-account-value-row .ifd-fc-account-sticky, .ifd-fc-account-value-row .ifd-fc-description-sticky { background: var(--card-bg); }
			.ifd-fc-driver-row .ifd-fc-account-sticky, .ifd-fc-driver-row .ifd-fc-description-sticky { background: var(--subtle-fg); }
			.ifd-section-total-row .ifd-fc-account-sticky, .ifd-section-total-row .ifd-fc-description-sticky { background: var(--card-bg); }
			.ifd-profit-row .ifd-fc-account-sticky, .ifd-profit-row .ifd-fc-description-sticky { background: var(--subtle-fg); }
			.ifd-ebitda-row .ifd-fc-account-sticky, .ifd-ebitda-row .ifd-fc-description-sticky { background: var(--card-bg); }
			.ifd-forecast-section-row { cursor: pointer; font-weight: 800; background: var(--subtle-fg); }
			.ifd-forecast-section-row:hover td { background: var(--control-bg); }
			.ifd-forecast-section-detail > td { padding: 0 !important; }
						.ifd-fc-account-value-row td { background: var(--card-bg); }
			.ifd-fc-driver-row td { background: var(--subtle-fg); font-size: 9.5px; }
			.ifd-fc-driver-label { padding-left: 28px !important; color: var(--text-muted); font-weight: 600; }
			.ifd-fc-input { width: 100%; min-width: 0; height: 26px; padding: 3px 5px; text-align: right; font-size: 10px; font-variant-numeric: tabular-nums; }
			.ifd-fc-uom { text-align: left; min-width: 0; }
			.ifd-fc-calculated { font-weight: 700; }
			.ifd-fc-unavailable { background: var(--subtle-fg) !important; color: var(--text-muted); }
			.ifd-forecast-dirty-indicator { font-weight: 700; }
			.ifd-forecast-table td, .ifd-fc-detail-table td { padding: 6px 7px; font-size: 10px; }
			.ifd-forecast-table .ifd-line-description, .ifd-fc-detail-table .ifd-line-description { font-size: 10.5px; line-height: 1.25; }
			.ifd-forecast-table .ifd-line-meta, .ifd-fc-detail-table .ifd-line-meta { font-size: 8.5px; margin-top: 1px; }
			.ifd-forecast-table .ifd-profit-row td, .ifd-forecast-table .ifd-ebitda-row td { font-size: 11px; }
			.ifd-currency-unit { margin-top: 2px; font-size: 8px; font-weight: 800; color: var(--text-muted); line-height: 1; }
			.ifd-negative-amount { color: var(--red-600, #c92a2a); font-weight: 700; }
			.ifd-negative-input { color: var(--red-600, #c92a2a) !important; font-weight: 700; }
			.ifd-month-tag { display: inline-block; margin-top: 3px; padding: 1px 5px; border-radius: 999px; font-size: 9px; font-weight: 800; line-height: 1.4; }
			.ifd-month-tag-actual { background: var(--green-100, #e9f5ec); color: var(--green-700, #16794a); }
			.ifd-month-tag-forecast { background: var(--blue-100, #e8f1ff); color: var(--blue-700, #2457a7); }
			.ifd-actual-month { background: var(--green-50, #f4fbf6); }
			.ifd-forecast-month { background: var(--blue-50, #f5f8ff); }
			.ifd-none-month { color: var(--text-muted); background: var(--subtle-fg); }
			@media (max-width: 1100px) { .ifd-charts { grid-template-columns: 1fr; } .ifd-kpis, .ifd-forecast-kpis { grid-template-columns: repeat(2, minmax(150px, 1fr)); } .ifd-forecast-controls { grid-template-columns: 1fr 1fr; } }
			@media (max-width: 650px) { .ifd-kpis, .ifd-forecast-kpis { grid-template-columns: 1fr; } .ifd-kpi-value { font-size: 18px; } .ifd-forecast-controls { grid-template-columns: 1fr; } }
		</style>`).appendTo('head');
	}
}

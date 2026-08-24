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
		this._inject_styles();
		this._build_filters();
		this._build_layout();
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
			</div>`
		).appendTo(this.page.main);
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
		let html = `<div class="ifd-transaction-meta"><span><strong>${this._integer(detail.transaction_count || rows.length)}</strong> transactions</span><span><strong>Total:</strong> ${this._money(detail.total_amount || 0)}</span><span>${this._escape(detail.period_label || '')}</span><span>Loaded ${this._duration(detail.client_runtime_ms)} | DB ${this._duration(perf.database_runtime_ms)}</span></div>`;
		if (!rows.length) {
			html += '<div class="ifd-empty">No transactions found for this amount.</div>';
			$body.html(html);
			return;
		}

		html += '<div class="ifd-transaction-wrap"><table class="ifd-transaction-table"><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th class="ifd-number">Amount</th></tr></thead><tbody>';
		rows.forEach(row => {
			html += `<tr><td>${this._escape(row.date || '')}</td><td>${this._escape(row.reference || '')}</td><td>${this._escape(row.description || '')}</td><td class="ifd-number">${this._money(row.amount || 0)}</td></tr>`;
		});
		html += `<tr class="ifd-transaction-total"><td colspan="3">Total</td><td class="ifd-number">${this._money(detail.total_amount || 0)}</td></tr></tbody></table></div>`;
		$body.html(html);
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
			.ifd-transaction-table th { position: sticky; top: 0; z-index: 1; padding: 9px 11px; background: var(--subtle-fg); border-bottom: 1px solid var(--border-color); color: var(--text-muted); font-size: 11px; text-transform: uppercase; }
			.ifd-transaction-table td { padding: 9px 11px; border-bottom: 1px solid var(--border-color); vertical-align: top; }
			.ifd-transaction-total td { position: sticky; bottom: 0; background: var(--card-bg); font-weight: 800; border-top: 2px solid var(--border-color); }
			.ifd-loading, .ifd-empty { padding: 20px; color: var(--text-muted); text-align: center; }
			@media (max-width: 1100px) { .ifd-charts { grid-template-columns: 1fr; } .ifd-kpis { grid-template-columns: repeat(2, minmax(150px, 1fr)); } }
			@media (max-width: 650px) { .ifd-kpis { grid-template-columns: 1fr; } .ifd-kpi-value { font-size: 18px; } }
		</style>`).appendTo('head');
	}
}

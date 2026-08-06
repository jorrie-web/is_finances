// IS Creditors Recon - client script (Frappe v16)
// Renders the report into the HTML field `reconciliation_presentation` on the "Recon Presentation" tab.
// Features
// - Explains how Closing (Calculated) is derived
// - Allows classifying unmatched transactions using DocType-driven lists (IS Recon Category)
// - Allows capturing match-key issue reasons using DocType-driven lists (IS Match Key Issue Type)
// - Displays totals for unmatched items, and separately totals for unmatched items with match-key issues

frappe.ui.form.on('IS Creditors Recon', {
  refresh(frm) {
    // Parser helper: show which statement parser profile was used (if available)
    if (frm.doc.parser_used) {
      frm.dashboard && frm.dashboard.set_headline(__('Statement parser used: {0}', [frm.doc.parser_used]));
    }

    // Helpful actions (these just save; server validate handles import/reconcile)
    if (!frm.is_new()) {
      frm.add_custom_button(__('Import Excel (Save)'), () => {
        if (!frm.doc.sage_transactions) {
          frappe.msgprint(__('Attach the Excel file in "Supplier Sage Transactions" first.'));
          return;
        }
        frm.save();
      });

      frm.add_custom_button(__('Reconcile PDF (Save)'), () => {
        if (!frm.doc.sup_statement) {
          frappe.msgprint(__('Attach the PDF file in "Supplier Statement" first.'));
          return;
        }
        frm.save();
      });

      frm.add_custom_button(__('Refresh Presentation'), () => {
        frm.trigger('render_recon_presentation');
      });

      frm.add_custom_button(__('Re-run All (Save)'), () => {
        if (!frm.doc.sage_transactions) {
          frappe.msgprint(__('Attach the Excel file in "Supplier Sage Transactions" first.'));
          return;
        }
        // Force server to reimport by clearing hash, then save.
        frm.set_value('import_hash', '');
        frm.save();
      });
    }

    // Visual cue if something is missing
    if (!frm.doc.sage_transactions) {
      frm.dashboard.set_headline(__('Step 1: Attach Excel in <b>Supplier Sage Transactions</b> and Save.'));
    } else if (!frm.doc.sup_statement) {
      frm.dashboard.set_headline(__('Step 2: Attach PDF in <b>Supplier Statement</b> and Save to reconcile.'));
    } else {
      frm.dashboard.set_headline(__('Excel + PDF attached. Save will import + reconcile.'));
    }

    // Load DocType-driven option lists (cached on frm)
    frm.trigger('load_reference_lists').then(() => frm.trigger('render_recon_presentation'));
  },

  after_save(frm) {
    frm.trigger('load_reference_lists').then(() => frm.trigger('render_recon_presentation'));
  },

  processed_transactions_add(frm) {
    frm.trigger('render_recon_presentation');
  },
  processed_transactions_remove(frm) {
    frm.trigger('render_recon_presentation');
  },

  async load_reference_lists(frm) {
    // Cache on frm to avoid repeated calls.
    if (!frm._is_recon_lists) frm._is_recon_lists = {};

    const loadReconCats = async () => {
      if (frm._is_recon_lists.recon_categories) return;
      try {
        const rows = await frappe.db.get_list('IS Recon Category', {
          fields: ['name', 'category_name', 'sort_order', 'is_active'],
          filters: { is_active: 1 },
          order_by: 'sort_order asc, category_name asc',
          limit: 1000
        });
        frm._is_recon_lists.recon_categories = (rows || []).map(r => ({
          value: r.name,
          label: r.category_name || r.name,
          sort: Number(r.sort_order || 0)
        }));
      } catch (e) {
        frm._is_recon_lists.recon_categories = [];
      }
    };

    const loadIssueTypes = async () => {
      if (frm._is_recon_lists.match_key_issue_types) return;
      try {
        const rows = await frappe.db.get_list('IS Match Key Issue Type', {
          fields: ['name', 'issue_code', 'issue_label', 'sort_order', 'is_active'],
          filters: { is_active: 1 },
          order_by: 'sort_order asc, issue_label asc',
          limit: 1000
        });

        frm._is_recon_lists.match_key_issue_types = (rows || []).map(r => ({
          value: r.name, // Link fields store the docname
          label: r.issue_label
            ? (r.issue_code ? `${r.issue_label} (${r.issue_code})` : r.issue_label)
            : (r.issue_code || r.name),
          sort: Number(r.sort_order || 0)
        }));
      } catch (e) {
        frm._is_recon_lists.match_key_issue_types = [];
      }
    };

    await Promise.all([loadReconCats(), loadIssueTypes()]);
  },

  render_recon_presentation(frm) {
    // Persist table filter state across re-renders
    frm._recon_filter_state = frm._recon_filter_state || {
      matched: {},
      unmatched: {},
      statement_matched: {},
      statement_unmatched: {}
    };

    // Persist section collapse / expand state across re-renders
    frm._recon_ui_state = frm._recon_ui_state || {
      sections: {
        erp_matched: false,
        erp_unmatched: false,
        statement_matched: false,
        statement_unmatched: false
      }
    };

    const fieldname = 'reconciliation_presentation';
    const f = frm.get_field(fieldname);
    if (!f || !f.$wrapper) return;

    // Capture current section state before replacing the HTML
    const existingErpMatched = f.$wrapper.find('details[data-section="erp_matched"]')[0];
    const existingErpUnmatched = f.$wrapper.find('details[data-section="erp_unmatched"]')[0];
    const existingStatementMatched = f.$wrapper.find('details[data-section="statement_matched"]')[0];
    const existingStatementUnmatched = f.$wrapper.find('details[data-section="statement_unmatched"]')[0];
    if (existingErpMatched) frm._recon_ui_state.sections.erp_matched = !!existingErpMatched.open;
    if (existingErpUnmatched) frm._recon_ui_state.sections.erp_unmatched = !!existingErpUnmatched.open;
    if (existingStatementMatched) frm._recon_ui_state.sections.statement_matched = !!existingStatementMatched.open;
    if (existingStatementUnmatched) frm._recon_ui_state.sections.statement_unmatched = !!existingStatementUnmatched.open;

    const rows = (frm.doc.processed_transactions || []).slice();
    const reconCats = (frm._is_recon_lists && frm._is_recon_lists.recon_categories) ? frm._is_recon_lists.recon_categories : [];
    const issueTypes = (frm._is_recon_lists && frm._is_recon_lists.match_key_issue_types) ? frm._is_recon_lists.match_key_issue_types : [];

    const escapeHtml = (s) => {
      if (s === null || s === undefined) return '';
      return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    };

    const dateOnly = (d) => { if (!d) return ''; return String(d).split(' ')[0]; };

    const fmtMoney = (v) => {
      const n = Number(v || 0);
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const isTrue = (v) => (v === 1 || v === true || v === '1');

    const opening = rows.find(r => isTrue(r.is_opening_balance));
    const closing = rows.find(r => isTrue(r.is_closing_balance));

    const txRows = rows.filter(r => !isTrue(r.is_opening_balance) && !isTrue(r.is_closing_balance));
    const matched = txRows.filter(r => isTrue(r.reconciled));
    const unmatched = txRows.filter(r => !isTrue(r.reconciled));

    const sum = (arr, key) => arr.reduce((acc, r) => acc + Number(r[key] || 0), 0);

    const totalDebit = sum(txRows, 'debit');
    const totalCredit = sum(txRows, 'credit');

    const matchedDebit = sum(matched, 'debit');
    const matchedCredit = sum(matched, 'credit');
    const unmatchedDebit = sum(unmatched, 'debit');
    const unmatchedCredit = sum(unmatched, 'credit');

    const isClassified = (r) => !!(r.unmatched_category && String(r.unmatched_category).trim());
    const classifiedUnmatched = unmatched.filter(isClassified);
    const unclassifiedUnmatched = unmatched.filter(r => !isClassified(r));

    const classifiedDebit = sum(classifiedUnmatched, 'debit');
    const classifiedCredit = sum(classifiedUnmatched, 'credit');
    const unclassifiedDebit = sum(unclassifiedUnmatched, 'debit');
    const unclassifiedCredit = sum(unclassifiedUnmatched, 'credit');

    const groupRowsByCategory = (rowsToGroup) => {
      const groups = {}; // key: category link name or '__unclassified__'
      for (const r of (rowsToGroup || [])) {
        const key = isClassified(r) ? String(r.unmatched_category) : '__unclassified__';
        if (!groups[key]) groups[key] = { rows: 0, debit: 0, credit: 0 };
        groups[key].rows += 1;
        groups[key].debit += Number(r.debit || 0);
        groups[key].credit += Number(r.credit || 0);
      }
      return groups;
    };

    const openingAmt = Number((opening && opening.amount) || 0);
    const closingAmt = Number((closing && closing.amount) || 0);

    const movement = (totalDebit - totalCredit);
    const calculatedClosing = openingAmt + movement;
    const variance = closingAmt - calculatedClosing;
    const statementRows = (frm.doc.statement_transactions || []).slice();
    const statementTxRows = statementRows.filter(r => !isTrue(r.is_opening_balance) && !isTrue(r.is_closing_balance));
    const statementMatched = statementTxRows.filter(r => isTrue(r.reconciled));
    const statementUnmatched = statementTxRows.filter(r => !isTrue(r.reconciled));
    const statementTotalDebit = sum(statementTxRows, 'debit');
    const statementTotalCredit = sum(statementTxRows, 'credit');
    const statementMatchedDebit = sum(statementMatched, 'debit');
    const statementMatchedCredit = sum(statementMatched, 'credit');
    const statementUnmatchedDebit = sum(statementUnmatched, 'debit');
    const statementUnmatchedCredit = sum(statementUnmatched, 'credit');
    const erpMatchedTotalField = Number(frm.doc.erp_matched_total || 0);
    const erpUnmatchedTotalField = Number(frm.doc.erp_unmatched_total || 0);
    const statementMatchedTotalField = Number(frm.doc.statement_matched_total || 0);
    const statementUnmatchedTotalField = Number(frm.doc.statement_unmatched_total || 0);
    const closingVarianceField = Number(frm.doc.closing_variance || variance);

    // Unmatched with match-key issues (reason selected)
    const unmatchedWithIssue = unmatched.filter(r => (r.match_key_issue_type || '').trim());
    const unmatchedWithoutIssue = unmatched.filter(r => !(r.match_key_issue_type || '').trim());

    const unmatchedIssueDebit = sum(unmatchedWithIssue, 'debit');
    const unmatchedIssueCredit = sum(unmatchedWithIssue, 'credit');

    // Group unmatched totals by issue type (Link value)
    const issueTotals = (() => {
      const map = {};
      for (const r of unmatchedWithIssue) {
        const k = (r.match_key_issue_type || '—').trim() || '—';
        if (!map[k]) map[k] = { count: 0, debit: 0, credit: 0 };
        map[k].count += 1;
        map[k].debit += Number(r.debit || 0);
        map[k].credit += Number(r.credit || 0);
      }
      return map;
    })();

    const issueLabel = (name) => {
      const hit = issueTypes.find(x => x.value === name);
      return hit ? hit.label : (name || '—');
    };

    const catLabel = (name) => {
      const hit = reconCats.find(x => x.value === name);
      return hit ? hit.label : (name || '—');
    };

    // Editable controls (persist via frappe.model.set_value on child row)
    const selectHtml = (childName, field, current, opts, placeholder = '— Select —', width = 220) => {
      const options = [''].concat(opts.map(o => o.value));
      const getLabel = (val) => {
        if (!val) return placeholder;
        const hit = opts.find(o => o.value === val);
        return hit ? hit.label : val;
      };
      return `
        <select
          data-child="${escapeHtml(childName)}"
          data-field="${escapeHtml(field)}"
          style="width:${width}px; padding:6px; border:1px solid #e5e7eb; border-radius:8px; background:#fff;"
        >
          ${options.map(v => {
            const selected = String(current || '') === String(v) ? 'selected' : '';
            return `<option value="${escapeHtml(v)}" ${selected}>${escapeHtml(getLabel(v))}</option>`;
          }).join('')}
        </select>
      `;
    };

    const inputHtml = (childName, field, value, placeholder, width = 220) => {
      return `
        <input
          type="text"
          data-child="${escapeHtml(childName)}"
          data-field="${escapeHtml(field)}"
          value="${escapeHtml(value || '')}"
          placeholder="${escapeHtml(placeholder || '')}"
          style="width:${width}px; padding:6px; border:1px solid #e5e7eb; border-radius:8px;"
        />
      `;
    };


    const actionButtonHtml = (childName, action, label) => {
      return `
        <button
          type="button"
          data-child="${escapeHtml(childName)}"
          data-action="${escapeHtml(action)}"
          style="padding:6px 10px; border:1px solid #16a34a; color:#166534; background:#f0fdf4; border-radius:8px; cursor:pointer; font-weight:600; white-space:nowrap;"
        >${escapeHtml(label)}</button>
      `;
    };


    const getStatementLinkOptions = () => {
      return statementUnmatched.map(r => ({
        value: r.name,
        label: `${dateOnly(r.tran_date)} | ${r.reference || 'No Ref'} | ${fmtMoney(Math.abs(Number(r.amount || r.credit || r.debit || 0)))} | ${r.match_key || r.match_key_tracked || ''}`
      }));
    };

    const getErpLinkOptions = () => {
      return unmatched.map(r => ({
        value: r.name,
        label: `${dateOnly(r.tran_date)} | ${r.reference || 'No Ref'} | ${fmtMoney(Math.abs(Number(r.amount || r.credit || r.debit || 0)))} | ${r.match_key || r.match_key_tracked || ''}`
      }));
    };

    const renderIssueTotalsTable = () => {
      const keys = Object.keys(issueTotals);
      if (!keys.length) {
        return `<div style="margin-top:8px; font-size:12px; color:#6b7280;">No match-key issues have been captured yet.</div>`;
      }
      const rowsHtml = keys
        .sort((a, b) => (issueTotals[b].count - issueTotals[a].count))
        .map(k => {
          const t = issueTotals[k];
          return `
            <tr>
              <td style="padding:8px; border-bottom:1px solid #f3f4f6;">${escapeHtml(issueLabel(k))}</td>
              <td style="padding:8px; border-bottom:1px solid #f3f4f6; text-align:right;">${t.count}</td>
              <td style="padding:8px; border-bottom:1px solid #f3f4f6; text-align:right;">${fmtMoney(t.debit)}</td>
              <td style="padding:8px; border-bottom:1px solid #f3f4f6; text-align:right;">${fmtMoney(t.credit)}</td>
            </tr>`;
        }).join('');

      return `
        <div style="margin-top:10px; border:1px solid #e5e7eb; border-radius:12px; overflow:hidden;">
          <div style="padding:10px; background:#f9fafb; font-weight:700; font-size:13px;">Unmatched with match-key issues (by reason)</div>
          <table style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead>
              <tr style="background:#ffffff;">
                <th style="text-align:left; padding:8px; border-bottom:1px solid #e5e7eb;">Reason</th>
                <th style="text-align:right; padding:8px; border-bottom:1px solid #e5e7eb;">Count</th>
                <th style="text-align:right; padding:8px; border-bottom:1px solid #e5e7eb;">Debit</th>
                <th style="text-align:right; padding:8px; border-bottom:1px solid #e5e7eb;">Credit</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      `;
    };

    const renderTable = (title, dataRows, opts = {}) => {
      const {
        maxRows = 1000,
        allowActions = false,
        filterId = null,
        showMatchedKey = false,
        allowStatementLink = false,
        allowErpLink = false,
        childTable = 'processed_transactions'
      } = opts;

      frm._recon_filter_state[filterId] = frm._recon_filter_state[filterId] || {};
      const filters = frm._recon_filter_state[filterId];

      // Column removed: prevent hidden leftover filter from older renders
      delete filters.match_key;

      // Apply filters (empty filters => all rows)
      const filteredRows = (dataRows || []).filter(r => {
        for (const key in filters) {
          const val = String(filters[key] || '').toLowerCase().trim();
          if (!val) continue;

          const txt = String(r[key] || '').toLowerCase();

          // Special-case booleans-ish fields from select filters
          if (key === 'match_key_issue_type' || key === 'unmatched_category') {
            if (!String(r[key] || '').includes(filters[key])) return false;
            continue;
          }

          if (!txt.includes(val)) return false;
        }
        return true;
      });

      const showing = filteredRows.slice(0, maxRows);

      const head = `
        <div style="display:flex; justify-content:space-between; margin:10px 0 6px;">
          <div style="font-size:13px; font-weight:700;">${escapeHtml(title)}</div>
          <div style="font-size:12px; color:#6b7280;">Rows: ${filteredRows.length}</div>
        </div>`;

      // Helper to render select options with selected based on filter state
      const renderFilterSelect = (col, list) => {
        const current = String(filters[col] || '');
        return `
          <select data-col="${escapeHtml(col)}" style="width:160px; padding:4px;">
            <option value="">All</option>
            ${list.map(x => {
              const sel = String(x.value) === current ? 'selected' : '';
              return `<option value="${escapeHtml(x.value)}" ${sel}>${escapeHtml(x.label)}</option>`;
            }).join('')}
          </select>
        `;
      };

      const thead = `
        <div style="overflow:auto; border:1px solid #e5e7eb; border-radius:10px;">
        <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead>

          <tr style="background:#f9fafb;">
            <th style="padding:6px 8px; text-align:left; position:sticky; left:0; z-index:4; background:#f9fafb; border-right:1px solid #e5e7eb;">Date</th>
            <th style="padding:6px 8px; text-align:left;">Ref</th>
            <th style="padding:6px 8px; text-align:left;">Code</th>
            <th style="padding:6px 8px; text-align:left;">Audit</th>
            <th style="padding:6px 8px; text-align:left;">Description</th>
            <th style="padding:6px 8px; text-align:right;">Debit</th>
            <th style="padding:6px 8px; text-align:right;">Credit</th>
            <th style="padding:6px 8px; text-align:right;">Amount</th>
            ${allowActions ? `<th style="padding:6px 8px; text-align:left;">Issue</th>` : ``}
            ${allowActions ? `<th style="padding:6px 8px; text-align:left;">Category</th>` : ``}
            ${allowStatementLink ? `<th style="padding:6px 8px; text-align:left;">Statement Row</th>` : ``}
            ${allowErpLink ? `<th style="padding:6px 8px; text-align:left;">ERP Row</th>` : ``}
            ${allowActions ? `<th style="padding:6px 8px; text-align:center;">Action</th>` : ``}
            ${allowActions ? `<th style="padding:6px 8px; text-align:left;">Issue Notes</th>` : ``}
            ${allowActions ? `<th style="padding:6px 8px; text-align:left;">Recon Notes</th>` : ``}
            ${showMatchedKey ? `<th style="padding:6px 8px; text-align:left;">Matched Key</th>` : ``}
            ${allowActions ? `<th style="padding:6px 8px; text-align:left;">Matched Key</th>` : ``}
            <th style="padding:6px 8px; text-align:center;">✓</th>
          </tr>

          <!-- Column Filters (type freely; filter applies on blur / Enter) -->
          <tr style="background:#ffffff;">
            <td style="padding:6px 8px; position:sticky; left:0; z-index:3; background:#ffffff; border-right:1px solid #e5e7eb;"><input data-col="tran_date" value="${escapeHtml(filters.tran_date || '')}" style="width:110px"></td>
            <td style="padding:6px 8px;"><input data-col="reference" value="${escapeHtml(filters.reference || '')}" style="width:90px"></td>
            <td style="padding:6px 8px;"><input data-col="tr_code" value="${escapeHtml(filters.tr_code || '')}" style="width:70px"></td>
            <td style="padding:6px 8px;"><input data-col="audit_no" value="${escapeHtml(filters.audit_no || '')}" style="width:90px"></td>
            <td style="padding:6px 8px;"><input data-col="description" value="${escapeHtml(filters.description || '')}" style="width:220px"></td>

            <td style="padding:6px 8px;"><input data-col="debit" value="${escapeHtml(filters.debit || '')}" style="width:90px"></td>
            <td style="padding:6px 8px;"><input data-col="credit" value="${escapeHtml(filters.credit || '')}" style="width:90px"></td>
            <td style="padding:6px 8px;"></td>

            ${allowActions ? `<td style="padding:6px 8px;">${renderFilterSelect('match_key_issue_type', issueTypes)}</td>` : ``}
            ${allowActions ? `<td style="padding:6px 8px;">${renderFilterSelect('unmatched_category', reconCats)}</td>` : ``}
            ${allowStatementLink ? `<td style="padding:6px 8px;"></td>` : ``}
            ${allowErpLink ? `<td style="padding:6px 8px;"></td>` : ``}
            ${allowActions ? `<td style="padding:6px 8px;"></td>` : ``}
            ${allowActions ? `<td style="padding:6px 8px;"></td>` : ``}
            ${allowActions ? `<td style="padding:6px 8px;"></td>` : ``}
            ${showMatchedKey ? `<td style="padding:6px 8px;"><input data-col="match_key_tracked" value="${escapeHtml(filters.match_key_tracked || '')}" style="width:120px"></td>` : ``}
            ${allowActions ? `<td style="padding:6px 8px;"><input data-col="match_key_tracked" value="${escapeHtml(filters.match_key_tracked || '')}" style="width:120px"></td>` : ``}

            <td style="padding:6px 8px;"></td>
          </tr>

        </thead>
        <tbody>
      `;

      const bodyRows = showing.map(r => {
        const reconciled = isTrue(r.reconciled);
        const bg = reconciled ? "#ecfdf5" : "#fff7ed";

        // Editable columns only for unmatched table
        const trackedCell = allowActions
          ? inputHtml(r.name, 'match_key_tracked', r.match_key_tracked, 'e.g. Yes/No', 120)
          : escapeHtml(r.match_key_tracked);

        const issueCell = allowActions
          ? selectHtml(r.name, 'match_key_issue_type', r.match_key_issue_type, issueTypes, '— Select —', 160)
          : escapeHtml(issueLabel(r.match_key_issue_type));

        const issueNotesCell = allowActions
          ? inputHtml(r.name, 'match_key_issue_notes', r.match_key_issue_notes, 'Notes…', 220)
          : escapeHtml(r.match_key_issue_notes);

        const catCell = allowActions
          ? selectHtml(r.name, 'unmatched_category', r.unmatched_category, reconCats, '— Select —', 180)
          : escapeHtml(catLabel(r.unmatched_category));

        const reconNotesCell = allowActions
          ? inputHtml(r.name, 'unmatched_notes', r.unmatched_notes, 'Notes…', 220)
          : escapeHtml(r.unmatched_notes);

        const statementLinkCell = allowStatementLink
          ? selectHtml(r.name, 'statement_link_name', r.statement_link_name, getStatementLinkOptions(), '— Link statement row —', 320)
              .replace('<select', `<select data-link-child="${escapeHtml(r.name)}"`)
          : '';

        const erpLinkCell = allowErpLink
          ? selectHtml(r.name, 'erp_link_name', r.erp_link_name, getErpLinkOptions(), '— Link ERP row —', 320)
              .replace('<select', `<select data-link-child="${escapeHtml(r.name)}"`)
          : '';

        const manualMatchCell = allowActions
          ? actionButtonHtml(r.name, 'manual-match', (allowStatementLink || allowErpLink) ? 'Link + Match' : 'Manual Match')
          : '';

        return `
          <tr style="background:${bg};">
            <td style="padding:6px 8px; position:sticky; left:0; z-index:1; background:${bg}; border-right:1px solid #e5e7eb;">${escapeHtml(dateOnly(r.tran_date))}</td>
            <td style="padding:6px 8px;">${escapeHtml(r.reference)}</td>
            <td style="padding:6px 8px;">${escapeHtml(r.tr_code)}</td>
            <td style="padding:6px 8px;">${escapeHtml(r.audit_no)}</td>
            <td style="padding:6px 8px;">${escapeHtml(r.description)}</td>
            <td style="padding:6px 8px; text-align:right;">${fmtMoney(r.debit)}</td>
            <td style="padding:6px 8px; text-align:right;">${fmtMoney(r.credit)}</td>
            <td style="padding:6px 8px; text-align:right;">${fmtMoney(r.amount)}</td>
            ${allowActions ? `<td style="padding:6px 8px;">${issueCell}</td>` : ``}
            ${allowActions ? `<td style="padding:6px 8px;">${catCell}</td>` : ``}
            ${allowStatementLink ? `<td style="padding:6px 8px;">${statementLinkCell}</td>` : ``}
            ${allowErpLink ? `<td style="padding:6px 8px;">${erpLinkCell}</td>` : ``}
            ${allowActions ? `<td style="padding:6px 8px; text-align:center;">${manualMatchCell}</td>` : ``}
            ${allowActions ? `<td style="padding:6px 8px;">${issueNotesCell}</td>` : ``}
            ${allowActions ? `<td style="padding:6px 8px;">${reconNotesCell}</td>` : ``}
            ${showMatchedKey ? `<td style="padding:6px 8px;">${escapeHtml(r.match_key_tracked)}</td>` : ``}
            ${allowActions ? `<td style="padding:6px 8px;">${trackedCell}</td>` : ``}

            <td style="padding:6px 8px; text-align:center;">${reconciled ? "✓" : ""}</td>
          </tr>`;
      }).join("");

      const tail = `
        </tbody>
        </table>
        </div>`;

      return head + thead + bodyRows + tail;
    };

    const statCard = (title, lines) => {
      return `
        <div style="flex:1; min-width:260px; border:1px solid #e5e7eb; border-radius:12px; padding:10px; background:#fff;">
          <div style="font-size:12px; color:#6b7280;">${escapeHtml(title)}</div>
          <div style="margin-top:6px; font-size:13px; color:#111827;">
            ${lines.join('<br>')}
          </div>
        </div>
      `;
    };

    const reconCatLabelByName = {};
    (reconCats || []).forEach(c => {
      reconCatLabelByName[String(c.value)] = c.label || c.value;
    });

    const renderCategorySummaryTable = (title, rowsToGroup) => {
      const groups = groupRowsByCategory(rowsToGroup);
      const keys = Object.keys(groups);

      const sortOrderByKey = {};
      (reconCats || []).forEach(c => {
        sortOrderByKey[String(c.value)] = Number(c.sort || 0);
      });

      keys.sort((a, b) => {
        if (a === '__unclassified__') return -1;
        if (b === '__unclassified__') return 1;
        const sa = (sortOrderByKey[a] ?? 999999);
        const sb = (sortOrderByKey[b] ?? 999999);
        if (sa !== sb) return sa - sb;
        const la = reconCatLabelByName[a] || a;
        const lb = reconCatLabelByName[b] || b;
        return String(la).localeCompare(String(lb));
      });

      const rowsHtml = !keys.length
        ? `<tr><td colspan="4" style="padding:8px; color:#6b7280;">No unmatched entries.</td></tr>`
        : keys.map(k => {
            const g = groups[k];
            const label = (k === '__unclassified__') ? 'Unclassified' : (reconCatLabelByName[k] || k);
            return `
              <tr>
                <td style="padding:8px; border-top:1px solid #f3f4f6; white-space:nowrap;">${escapeHtml(label)}</td>
                <td style="padding:8px; border-top:1px solid #f3f4f6; text-align:right;">${g.rows}</td>
                <td style="padding:8px; border-top:1px solid #f3f4f6; text-align:right; white-space:nowrap;">${fmtMoney(g.debit)}</td>
                <td style="padding:8px; border-top:1px solid #f3f4f6; text-align:right; white-space:nowrap;">${fmtMoney(g.credit)}</td>
              </tr>`;
          }).join('');

      return `
        <div style="flex:1; min-width:320px;">
          <div style="font-size:13px; font-weight:700; margin-bottom:6px;">${escapeHtml(title)}</div>
          <div style="overflow:auto; border:1px solid #e5e7eb; border-radius:10px; background:#fff;">
            <table style="width:100%; border-collapse:collapse; font-size:12px;">
              <thead>
                <tr style="background:#f9fafb;">
                  <th style="text-align:left; padding:8px; border-bottom:1px solid #e5e7eb;">Recon Category</th>
                  <th style="text-align:right; padding:8px; border-bottom:1px solid #e5e7eb;">Rows</th>
                  <th style="text-align:right; padding:8px; border-bottom:1px solid #e5e7eb;">Debit</th>
                  <th style="text-align:right; padding:8px; border-bottom:1px solid #e5e7eb;">Credit</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        </div>
      `;
    };

    const html = `
      <div style="border:1px solid #e5e7eb; border-radius: 14px; padding: 14px; background:#ffffff;">
        <div style="display:flex; justify-content:space-between; gap: 16px; flex-wrap: wrap;">
          <div>
            <div style="font-size: 16px; font-weight: 800; color:#111827;">Creditors Reconciliation</div>
            <div style="font-size: 12px; color:#6b7280; margin-top:2px;">
              Supplier: <b>${escapeHtml(frm.doc.supplier)}</b> &nbsp; Code: <b>${escapeHtml(frm.doc.supplier_code)}</b>
            </div>
            <div style="font-size: 12px; color:#6b7280; margin-top:2px;">
              Recon Date: <b>${escapeHtml(dateOnly(frm.doc.recon_date))}</b>
            </div>
          </div>

          <div style="min-width: 380px;">
            <div style="font-size: 12px; color:#6b7280;">Balances</div>
            <div style="font-size: 13px; margin-top:2px;">
              <b>Opening:</b> ${fmtMoney(openingAmt)} &nbsp;
              <b>Closing (Statement):</b> ${fmtMoney(closingAmt)}<br>
              <b>Closing (Calculated):</b> ${fmtMoney(calculatedClosing)} &nbsp;
              <b>Variance:</b> ${fmtMoney(variance)}
            </div>

            <div style="margin-top:8px; padding:10px; border:1px dashed #e5e7eb; border-radius:12px; background:#fafafa; font-size:12px; color:#374151;">
              <div style="font-weight:700; margin-bottom:4px;">How “Closing (Calculated)” is calculated</div>
              <div>Closing (Calculated) = Opening + (Total Debit − Total Credit)</div>
              <div style="margin-top:4px;">= ${fmtMoney(openingAmt)} + (${fmtMoney(totalDebit)} − ${fmtMoney(totalCredit)})</div>
              <div style="margin-top:4px;">= ${fmtMoney(openingAmt)} + ${fmtMoney(movement)} = <b>${fmtMoney(calculatedClosing)}</b></div>
            </div>
          </div>
        </div>

        <hr style="margin: 12px 0; border:none; border-top:1px solid #e5e7eb;">

        <div style="display:flex; gap: 12px; flex-wrap: wrap;">
          ${statCard('Overall totals', [
            `<b>Transactions:</b> ${txRows.length}`,
            `<b>Total Debit:</b> ${fmtMoney(totalDebit)}`,
            `<b>Total Credit:</b> ${fmtMoney(totalCredit)}`
          ])}
          ${statCard('Matched', [
            `<b>Rows:</b> ${matched.length}`,
            `<b>Debit:</b> ${fmtMoney(matchedDebit)}`,
            `<b>Credit:</b> ${fmtMoney(matchedCredit)}`
          ])}
          ${statCard('Unmatched', [
            `<b>Rows:</b> ${unmatched.length}`,
            `<b>Debit:</b> ${fmtMoney(unmatchedDebit)}`,
            `<b>Credit:</b> ${fmtMoney(unmatchedCredit)}`
          ])}
          ${statCard('Unmatched with match-key issues', [
            `<b>Rows:</b> ${unmatchedWithIssue.length}`,
            `<b>Debit:</b> ${fmtMoney(unmatchedIssueDebit)}`,
            `<b>Credit:</b> ${fmtMoney(unmatchedIssueCredit)}`
          ])}
          ${statCard('ERP matched totals', [
            `<b>Matched Total:</b> ${fmtMoney(erpMatchedTotalField)}`,
            `<b>Unmatched Total:</b> ${fmtMoney(erpUnmatchedTotalField)}`,
            `<b>Rows Matched:</b> ${matched.length}`
          ])}
          ${statCard('Statement matched totals', [
            `<b>Matched Total:</b> ${fmtMoney(statementMatchedTotalField)}`,
            `<b>Unmatched Total:</b> ${fmtMoney(statementUnmatchedTotalField)}`,
            `<b>Rows Matched:</b> ${statementMatched.length}`
          ])}
          ${statCard('Statement totals', [
            `<b>Transactions:</b> ${statementTxRows.length}`,
            `<b>Total Debit:</b> ${fmtMoney(statementTotalDebit)}`,
            `<b>Total Credit:</b> ${fmtMoney(statementTotalCredit)}`,
            `<b>Closing Variance:</b> ${fmtMoney(closingVarianceField)}`
          ])}
        </div>

        ${renderIssueTotalsTable()}

        <div style="margin-top: 14px; border:1px solid #e5e7eb; border-radius: 12px; padding: 12px; background:#ffffff;">
          <div style="font-size:13px; font-weight:700; margin-bottom:6px;">Unmatched by recon category</div>
          <div style="margin-top:6px; font-size:12px; color:#6b7280;">
            Totals update as you classify rows. Click <b>Save</b> to store the classifications.
          </div>
          <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:10px;">
            ${renderCategorySummaryTable('ERP unmatched category totals', unmatched)}
            ${renderCategorySummaryTable('Statement unmatched category totals', statementUnmatched)}
          </div>
        </div>

        <div style="margin-top: 10px; font-size: 12px; color:#6b7280;">
          Green rows are reconciled. Orange rows are still outstanding (unmatched). Issue, category, link and manual-match controls now appear immediately after <b>Amount</b>. Then click <b>Save</b>.
        </div>

        <details style="margin-top: 12px;" data-section="erp_matched" ${frm._recon_ui_state.sections.erp_matched ? 'open' : ''}>
          <summary style="cursor:pointer; font-weight:700;">
            ERP Matched (${matched.length})
            <span style="font-weight:400; color:#6b7280;">
              &nbsp; • &nbsp; Debit ${fmtMoney(matchedDebit)} &nbsp; • &nbsp; Credit ${fmtMoney(matchedCredit)}
            </span>
          </summary>
          <div style="margin-top: 8px;">
            ${renderTable('ERP Matched Transactions', matched, { allowActions: false, filterId: 'matched', showMatchedKey: true, childTable: 'processed_transactions' })}
          </div>
        </details>

        <details style="margin-top: 12px;" data-section="erp_unmatched" ${frm._recon_ui_state.sections.erp_unmatched ? 'open' : ''}>
          <summary style="cursor:pointer; font-weight:700;">
            ERP Unmatched (${unmatched.length})
            <span style="font-weight:400; color:#6b7280;">
              &nbsp; • &nbsp; Debit ${fmtMoney(unmatchedDebit)} &nbsp; • &nbsp; Credit ${fmtMoney(unmatchedCredit)}
            </span>
          </summary>
          <div style="margin-top: 8px;">
            ${renderTable('ERP Unmatched Transactions (classify + capture match issues)', unmatched, { allowActions: true, allowStatementLink: true, filterId: 'unmatched', childTable: 'processed_transactions' })}
          </div>
        </details>

        <details style="margin-top: 12px;" data-section="statement_matched" ${frm._recon_ui_state.sections.statement_matched ? 'open' : ''}>
          <summary style="cursor:pointer; font-weight:700;">
            Statement Matched (${statementMatched.length})
            <span style="font-weight:400; color:#6b7280;">
              &nbsp; • &nbsp; Debit ${fmtMoney(statementMatchedDebit)} &nbsp; • &nbsp; Credit ${fmtMoney(statementMatchedCredit)}
            </span>
          </summary>
          <div style="margin-top: 8px;">
            ${renderTable('Statement Matched Transactions', statementMatched, { allowActions: false, filterId: 'statement_matched', showMatchedKey: true, childTable: 'statement_transactions' })}
          </div>
        </details>

        <details style="margin-top: 12px;" data-section="statement_unmatched" ${frm._recon_ui_state.sections.statement_unmatched ? 'open' : ''}>
          <summary style="cursor:pointer; font-weight:700;">
            Statement Unmatched (${statementUnmatched.length})
            <span style="font-weight:400; color:#6b7280;">
              &nbsp; • &nbsp; Debit ${fmtMoney(statementUnmatchedDebit)} &nbsp; • &nbsp; Credit ${fmtMoney(statementUnmatchedCredit)}
            </span>
          </summary>
          <div style="margin-top: 8px;">
            ${renderTable('Statement Unmatched Transactions', statementUnmatched, { allowActions: true, allowErpLink: true, filterId: 'statement_unmatched', childTable: 'statement_transactions' })}
          </div>
        </details>

        <div style="margin-top: 10px; font-size: 12px; color:#6b7280;">
          Tip: Attach Excel in <b>Supplier Sage Transactions</b> and PDF in <b>Supplier Statement</b>, then Save.
        </div>
      </div>
    `;

    // Write into HTML field wrapper
    f.$wrapper.empty().html(html);

    // ----------------------------
    // Column filter binding (stable)
    // - User can type freely (no re-render while typing)
    // - Filter applies on blur OR Enter
    // ----------------------------
    f.$wrapper.find('[data-col]').off('input.reconfilter keydown.reconfilter change.reconfilter blur.reconfilter');

    // Keep state updated while typing, but do NOT re-render yet
    f.$wrapper.find('input[data-col]').on('input.reconfilter', function () {
      const field = this.getAttribute('data-col');
      const table = this.closest('table');
      if (!field || !table) return;

      const details = table.closest('details');
      const filterId = details ? String(details.getAttribute('data-section') || '').replace('erp_', '') : 'unmatched';
      if (!frm._recon_filter_state[filterId]) frm._recon_filter_state[filterId] = {};
      frm._recon_filter_state[filterId][field] = this.value;
    });

    // Select filters apply immediately (because you select a final value)
    f.$wrapper.find('select[data-col]').on('change.reconfilter', function () {
      const field = this.getAttribute('data-col');
      const table = this.closest('table');
      if (!field || !table) return;

      const details = table.closest('details');
      const filterId = details ? String(details.getAttribute('data-section') || '').replace('erp_', '') : 'unmatched';
      if (!frm._recon_filter_state[filterId]) frm._recon_filter_state[filterId] = {};
      frm._recon_filter_state[filterId][field] = this.value;
      frm.trigger('render_recon_presentation');
    });

    // Apply on Enter
    f.$wrapper.find('input[data-col]').on('keydown.reconfilter', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        frm.trigger('render_recon_presentation');
      }
    });

    // Apply on blur (leaving field)
    f.$wrapper.find('input[data-col]').on('blur.reconfilter', function () {
      frm.trigger('render_recon_presentation');
    });

    // Persist details state when user manually expands/collapses sections
    f.$wrapper.find('details[data-section]').off('toggle.isrecondetails').on('toggle.isrecondetails', function () {
      const section = this.getAttribute('data-section');
      if (!section) return;
      frm._recon_ui_state.sections[section] = !!this.open;
    });

    // ----------------------------
    // Wire inputs/selects to child rows (so a normal Save persists)
    // ----------------------------
    f.$wrapper.find('[data-action="manual-match"]').off('click.ismanualmatch').on('click.ismanualmatch', function () {
      const childname = this.getAttribute('data-child');
      const erpChild = (frm.doc.processed_transactions || []).find(r => r.name === childname);
      const statementChild = (frm.doc.statement_transactions || []).find(r => r.name === childname);
      const child = erpChild || statementChild;
      if (!child) return;

      const linkSelect = f.$wrapper.find(`select[data-link-child="${childname}"]`)[0];
      const linkedName = linkSelect ? String(linkSelect.value || '').trim() : '';
      const linkedErpRow = linkedName
        ? (frm.doc.processed_transactions || []).find(r => r.name === linkedName)
        : null;
      const linkedStatementRow = linkedName
        ? (frm.doc.statement_transactions || []).find(r => r.name === linkedName)
        : null;

      const matchedKeySource = linkedStatementRow || linkedErpRow || child;
      const matchedKey = String(
        (matchedKeySource && (matchedKeySource.match_key || matchedKeySource.match_key_tracked)) || ''
      ).trim() || 'manually matched';

      const updates = [
        frappe.model.set_value(child.doctype, child.name, 'manual_matched', 1),
        frappe.model.set_value(child.doctype, child.name, 'reconciled', 1),
        frappe.model.set_value(child.doctype, child.name, 'match_key_tracked', matchedKey),
        frappe.model.set_value(child.doctype, child.name, 'match_key_issue_type', ''),
        frappe.model.set_value(child.doctype, child.name, 'match_key_issue_notes', ''),
        frappe.model.set_value(child.doctype, child.name, 'unmatched_category', '')
      ];

      const linkedRow = linkedStatementRow || linkedErpRow;
      if (linkedRow) {
        updates.push(
          frappe.model.set_value(linkedRow.doctype, linkedRow.name, 'manual_matched', 1),
          frappe.model.set_value(linkedRow.doctype, linkedRow.name, 'reconciled', 1),
          frappe.model.set_value(linkedRow.doctype, linkedRow.name, 'match_key_tracked', matchedKey),
          frappe.model.set_value(linkedRow.doctype, linkedRow.name, 'match_key_issue_type', ''),
          frappe.model.set_value(linkedRow.doctype, linkedRow.name, 'match_key_issue_notes', ''),
          frappe.model.set_value(linkedRow.doctype, linkedRow.name, 'unmatched_category', '')
        );
      }

      Promise.all(updates).then(() => {
        frm.trigger('render_recon_presentation');
      });
    });

    const bindInputs = () => {
      f.$wrapper.find('select[data-child], input[data-child]').off('change.isrecon input.isrecon');

      f.$wrapper.find('select[data-child]').on('change.isrecon', function () {
        const childname = this.getAttribute('data-child');
        const field = this.getAttribute('data-field');
        const value = this.value;
        if (field === 'statement_link_name') return;

        const child = (frm.doc.processed_transactions || []).find(r => r.name === childname)
          || (frm.doc.statement_transactions || []).find(r => r.name === childname);
        if (!child) return;

        frappe.model.set_value(child.doctype, child.name, field, value);
        frm.trigger('render_recon_presentation'); // refresh totals immediately
      });

      // Debounced notes/tracked typing (no re-render while typing)
      f.$wrapper.find('input[data-child]').on('input.isrecon', frappe.utils.debounce(function () {
        const childname = this.getAttribute('data-child');
        const field = this.getAttribute('data-field');
        const value = this.value;

        const child = (frm.doc.processed_transactions || []).find(r => r.name === childname)
          || (frm.doc.statement_transactions || []).find(r => r.name === childname);
        if (!child) return;

        frappe.model.set_value(child.doctype, child.name, field, value);
      }, 250));
    };

    bindInputs();
  }
});
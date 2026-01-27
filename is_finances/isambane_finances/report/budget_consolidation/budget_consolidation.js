// Copyright (c) 2026, Isambane Mining and contributors
// For license information, please see license.txt

/* global frappe */

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

function getChartsPayload() {
  const el = document.getElementById("bc_charts_payload_json");
  if (!el) return null;

  const raw = (el.textContent || "").trim();
  if (!raw) return null;

  const decoded = frappe.utils.unescape_html(raw);
  return safeJsonParse(decoded);
}

function showChartError(el, msg) {
  if (!el) return;
  el.innerHTML = `<div class="text-muted" style="padding:8px;">${frappe.utils.escape_html(msg)}</div>`;
}

function ensureChart(id, spec) {
  const el = document.getElementById(id);
  if (!el) return;

  if (!spec) {
    showChartError(el, "No chart data.");
    return;
  }

  if (!frappe || !frappe.Chart) {
    showChartError(el, "frappe.Chart is not available on this page.");
    return;
  }

  try {
    el.innerHTML = "";
    const options = spec.options || {};
    const args = {
      title: spec.title || "",
      data: { labels: spec.labels || [], datasets: spec.datasets || [] },
      type: spec.type || "bar",
      height: options.height || 260
    };
    if (options.stacked) args.barOptions = { stacked: true };
    // eslint-disable-next-line no-new
    new frappe.Chart(el, args);
  } catch (e) {
    showChartError(el, `Chart render failed: ${e.message || e}`);
  }
}

function renderBudgetConsolidationCharts() {
  const payload = getChartsPayload();
  if (!payload) return;

  ensureChart("bc_chart_income_expense", payload.income_expense);
  ensureChart("bc_chart_pnl_by_cost_center", payload.pnl_by_cost_center);
  ensureChart("bc_chart_annual_pnl_by_cost_center", payload.annual_pnl_by_cost_center);
}

function hookRender(report) {
  const schedule = () => setTimeout(renderBudgetConsolidationCharts, 250);

  schedule();
  setTimeout(schedule, 700);
  setTimeout(schedule, 1500);

  if (report && typeof report.on === "function") {
    report.on("render", schedule);
    report.on("after_refresh", schedule);
  }
}

frappe.query_reports["Budget Consolidation"] = {
  filters: [
    {
      fieldname: "fiscal_year",
      label: "Fiscal Year",
      fieldtype: "Link",
      options: "Fiscal Year",
      reqd: 1,
      default: frappe.defaults.get_default("fiscal_year")
    },
    {
      fieldname: "company",
      label: "Company",
      fieldtype: "Link",
      options: "Company",
      reqd: 1,
      default: frappe.defaults.get_default("company")
    }
  ],

  onload: function (report) {
    hookRender(report);

    try {
      const target = document.querySelector(".query-report");
      if (!target) return;

      const obs = new MutationObserver(function () {
        if (document.getElementById("bc_charts_payload_json")) {
          setTimeout(renderBudgetConsolidationCharts, 120);
        }
      });

      obs.observe(target, { childList: true, subtree: true });
    } catch (e) {
      // ignore
    }
  }
};

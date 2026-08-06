# Copyright (c) 2026, Isambane Mining and contributors
# For license information, please see license.txt

import calendar
import re
from collections import defaultdict

import frappe
from frappe import _
from frappe.utils import flt, getdate


def execute(filters=None):
	filters = frappe._dict(filters or {})
	_validate_filters(filters)

	fiscal_year = frappe.db.get_value(
		"Fiscal Year",
		filters.fiscal_year,
		["year_start_date", "year_end_date"],
		as_dict=True,
	)

	if not fiscal_year:
		frappe.throw(_("Fiscal Year {0} was not found.").format(filters.fiscal_year))

	start_date = getdate(fiscal_year.year_start_date)
	end_date = getdate(fiscal_year.year_end_date)
	months = _get_financial_months(start_date, end_date)

	columns = _get_columns(months)
	data = _get_report_data(filters, start_date, end_date, months)
	message = _get_message(filters, start_date, end_date)

	return columns, data, message


@frappe.whitelist()
@frappe.validate_and_sanitize_search_inputs
def get_child_cost_centers(doctype, txt, searchfield, start, page_len, filters):
	group = filters.get("cost_center_group")
	company = filters.get("company")

	if not group:
		return []

	group_bounds = frappe.db.get_value("Cost Center", group, ["lft", "rgt"], as_dict=True)
	if not group_bounds:
		return []

	return frappe.db.sql(
		"""
		select name, cost_center_name
		from `tabCost Center`
		where company = %(company)s
		  and is_group = 0
		  and lft > %(lft)s
		  and rgt < %(rgt)s
		  and name like %(txt)s
		order by lft
		limit %(start)s, %(page_len)s
		""",
		{
			"company": company,
			"lft": group_bounds.lft,
			"rgt": group_bounds.rgt,
			"txt": f"%{txt}%",
			"start": start,
			"page_len": page_len,
		},
	)


def _validate_filters(filters):
	if not filters.company:
		frappe.throw(_("Please select Company."))

	if not filters.fiscal_year:
		frappe.throw(_("Please select Fiscal Year."))


def _get_financial_months(start_date, end_date):
	months = []
	year = start_date.year
	month = start_date.month

	while True:
		last_day = calendar.monthrange(year, month)[1]
		month_end_date = getdate(f"{year}-{month:02d}-{last_day:02d}")

		months.append({
			"fieldname": f"m_{year}_{month:02d}",
			"label": f"{calendar.month_abbr[month]} {str(year)[-2:]}",
			"month_end_date": month_end_date,
		})

		if year == end_date.year and month == end_date.month:
			break

		month += 1
		if month > 12:
			month = 1
			year += 1

	return months


def _get_columns(months):
	columns = [
		{"label": _("Account"), "fieldname": "account", "fieldtype": "Data", "width": 320},
		{"label": _("Root Type"), "fieldname": "root_type", "fieldtype": "Data", "width": 100},
	]

	for month in months:
		columns.append({
			"label": month["label"],
			"fieldname": month["fieldname"],
			"fieldtype": "Currency",
			"width": 115,
		})

	columns.append({
		"label": _("Annual Total"),
		"fieldname": "annual_total",
		"fieldtype": "Currency",
		"width": 130,
	})

	return columns


def _get_report_data(filters, start_date, end_date, months):
	source_rows = _get_source_rows(filters, start_date, end_date)
	grouped = _group_source_rows(source_rows)

	income_rows, income_total = _build_account_rows(grouped, months, "Income")
	expense_rows, expense_total = _build_account_rows(grouped, months, "Expense")

	profit_row = _profit_row(income_total, expense_total, months)
	depreciation_row = _special_total_row(grouped, months, "Depreciation", _is_depreciation_account)
	interest_paid_row = _special_total_row(grouped, months, "Interest Paid", _is_interest_paid_account)
	ebitda_row = _ebitda_row(profit_row, depreciation_row, interest_paid_row, months)

	data = []

	if income_rows:
		data.append(_group_row("Income", months))
		data.extend(income_rows)
		data.append(income_total)
		data.append({})

	if expense_rows:
		data.append(_group_row("Expense", months))
		data.extend(expense_rows)
		data.append(expense_total)
		data.append({})

	data.extend([
		profit_row,
		depreciation_row,
		interest_paid_row,
		ebitda_row,
	])

	return data


def _get_source_rows(filters, start_date, end_date):
	conditions = [
		"parent.company = %(company)s",
		"child.month_end_date between %(start_date)s and %(end_date)s",
	]

	values = {
		"company": filters.company,
		"start_date": start_date,
		"end_date": end_date,
	}

	if filters.cost_center:
		conditions.append("child.cost_center_number = %(cost_center)s")
		values["cost_center"] = filters.cost_center

	elif filters.cost_center_group:
		child_cost_centers = _get_child_cost_center_names(filters.cost_center_group, filters.company)

		if child_cost_centers:
			conditions.append("child.cost_center_number in %(child_cost_centers)s")
			values["child_cost_centers"] = tuple(child_cost_centers)
		else:
			conditions.append("1 = 0")

	return frappe.db.sql(
		f"""
		select
			child.account_number,
			child.root_type,
			child.month_end_date,
			sum(child.actual) as actual,
			account.account_number as account_code,
			account.account_name
		from `tabGL Historical Line` child
		inner join `tabGL Historical Import` parent
			on parent.name = child.parent
		left join `tabAccount` account
			on account.name = child.account_number
		where {" and ".join(conditions)}
		group by
			child.account_number,
			child.root_type,
			child.month_end_date,
			account.account_number,
			account.account_name
		order by
			child.root_type desc,
			account.account_number asc,
			account.account_name asc
		""",
		values,
		as_dict=True,
	)


def _get_child_cost_center_names(cost_center_group, company):
	group_bounds = frappe.db.get_value("Cost Center", cost_center_group, ["lft", "rgt"], as_dict=True)
	if not group_bounds:
		return []

	return [
		row.name for row in frappe.get_all(
			"Cost Center",
			filters={
				"company": company,
				"is_group": 0,
				"lft": [">", group_bounds.lft],
				"rgt": ["<", group_bounds.rgt],
			},
			fields=["name"],
			order_by="lft asc",
		)
	]


def _group_source_rows(source_rows):
	grouped = {}

	for row in source_rows:
		account = row.account_number
		month_end_date = getdate(row.month_end_date)

		if account not in grouped:
			grouped[account] = {
				"account_number": row.account_number,
				"account_code": row.account_code,
				"account_name": row.account_name,
				"root_type": row.root_type,
				"months": defaultdict(float),
			}

		grouped[account]["months"][month_end_date] += flt(row.actual, 2)

	return grouped


def _build_account_rows(grouped, months, root_type):
	rows = []
	total_row = _total_row(f"Total {root_type}", months)

	for account in grouped.values():
		if account["root_type"] != root_type:
			continue

		row = {
			"account": _account_label(account),
			"root_type": root_type,
			"annual_total": 0,
		}

		for month in months:
			amount = flt(account["months"].get(month["month_end_date"]), 2)
			row[month["fieldname"]] = amount
			row["annual_total"] += amount
			total_row[month["fieldname"]] += amount
			total_row["annual_total"] += amount

		rows.append(row)

	return rows, total_row


def _special_total_row(grouped, months, label, matcher):
	row = _total_row(label, months)

	for account in grouped.values():
		if not matcher(account):
			continue

		for month in months:
			amount = flt(account["months"].get(month["month_end_date"]), 2)
			row[month["fieldname"]] += amount
			row["annual_total"] += amount

	return row


def _profit_row(income_total, expense_total, months):
	row = {
		"account": "Profit / (Loss)",
		"root_type": "",
		"annual_total": flt(income_total["annual_total"] - expense_total["annual_total"], 2),
		"is_profit": 1,
	}

	for month in months:
		fieldname = month["fieldname"]
		row[fieldname] = flt(income_total[fieldname] - expense_total[fieldname], 2)

	return row


def _ebitda_row(profit_row, depreciation_row, interest_paid_row, months):
	row = {
		"account": "EBITDA",
		"root_type": "",
		"annual_total": flt(
			profit_row["annual_total"]
			+ depreciation_row["annual_total"]
			+ interest_paid_row["annual_total"],
			2,
		),
		"is_ebitda": 1,
	}

	for month in months:
		fieldname = month["fieldname"]
		row[fieldname] = flt(
			profit_row[fieldname]
			+ depreciation_row[fieldname]
			+ interest_paid_row[fieldname],
			2,
		)

	return row


def _is_depreciation_account(account):
	code = _account_code(account)
	name = (account.get("account_name") or "").lower()
	return code.startswith("345") or "depreciation" in name


def _is_interest_paid_account(account):
	code = _account_code(account)
	name = (account.get("account_name") or "").lower()
	return code == "3900" or "interest paid" in name


def _account_code(account):
	code = account.get("account_code")

	if code:
		return str(code).strip()

	text = account.get("account_number") or ""
	match = re.match(r"^(\d+)", str(text).strip())

	return match.group(1) if match else ""


def _account_label(account):
	code = _account_code(account)
	name = account.get("account_name") or account.get("account_number") or ""
	return f"{code} - {name}".strip(" -")


def _group_row(label, months):
	row = {
		"account": label,
		"root_type": "",
		"annual_total": None,
		"is_group": 1,
	}

	for month in months:
		row[month["fieldname"]] = None

	return row


def _total_row(label, months):
	row = {
		"account": label,
		"root_type": "",
		"annual_total": 0,
		"is_total": 1,
	}

	for month in months:
		row[month["fieldname"]] = 0

	return row


def _get_message(filters, start_date, end_date):
	cost_center_text = ""

	if filters.cost_center:
		cost_center_text = f" Cost Center: {filters.cost_center}."
	elif filters.cost_center_group:
		cost_center_text = f" Cost Center Group: {filters.cost_center_group}."

	return _(
		"Annual Income Statement for {0}, Fiscal Year {1}: {2} to {3}.{4}"
	).format(
		filters.company,
		filters.fiscal_year,
		start_date.strftime("%d %b %Y"),
		end_date.strftime("%d %b %Y"),
		cost_center_text,
	)
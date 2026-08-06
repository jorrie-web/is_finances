import frappe


MODULE_NAME = "Isambane Finances"


def f(label, fieldname, fieldtype, **kwargs):
    d = {
        "label": label,
        "fieldname": fieldname,
        "fieldtype": fieldtype,
    }
    d.update(kwargs)
    return d


def ensure_module_def():
    if frappe.db.exists("Module Def", MODULE_NAME):
        return

    frappe.get_doc({
        "doctype": "Module Def",
        "module_name": MODULE_NAME,
        "app_name": "is_finances",
    }).insert(ignore_permissions=True)


def ensure_doctype(name, istable, fields):
    if frappe.db.exists("DocType", name):
        return

    doc = frappe.get_doc({
        "doctype": "DocType",
        "name": name,
        "module": MODULE_NAME,
        "custom": 1,
        "istable": 1 if istable else 0,
        "editable_grid": 1 if istable else 0,
        "engine": "InnoDB",
        "track_changes": 1 if not istable else 0,
        "autoname": "hash" if not istable else "",
        "field_order": [x["fieldname"] for x in fields],
        "fields": fields,
        "permissions": [] if istable else [
            {
                "role": "System Manager",
                "read": 1,
                "write": 1,
                "create": 1,
                "delete": 1,
                "print": 1,
                "report": 1,
                "export": 1,
                "share": 1,
            }
        ],
    })
    doc.insert(ignore_permissions=True)


def execute():
    ensure_module_def()

    employee_fields = [
        f("Employee", "employee", "Link", options="Employee", in_list_view=1),
        f("Surname", "surname", "Data", in_list_view=1),
        f("Coy", "coy", "Data", in_list_view=1),
        f("Name", "employee_name", "Data", in_list_view=1),
        f("ID", "id_number", "Data", in_list_view=1),
        f("Occupation", "occupation", "Data", in_list_view=1),
        f("N/T", "normal_time_hours", "Float", read_only=1, precision="2", in_list_view=1),
        f("Total Calculated Hours", "total_calculated_hours", "Float", read_only=1, precision="2", in_list_view=1),
        f("A/Leave", "a_leave_hours", "Float", read_only=1, precision="2"),
        f("S/Leave", "s_leave_hours", "Float", read_only=1, precision="2"),
        f("F/Leave", "f_leave_hours", "Float", read_only=1, precision="2"),
        f("O/Time 1.5 After 195", "overtime_1_5_after_195", "Float", read_only=1, precision="2"),
        f("O/Time 2.0", "overtime_2_0", "Float", read_only=1, precision="2"),
        f("WPPH 2.0", "wpph_2_0", "Float", read_only=1, precision="2"),

        f("16 Wed", "d16_wed", "Data"),
        f("17 Thu", "d17_thu", "Data"),
        f("18 Fri PPH", "d18_fri_pph", "Data"),
        f("18 Fri WPPH", "d18_fri_wpph", "Data"),
        f("19 Sat", "d19_sat", "Data"),
        f("20 Sun PPH", "d20_sun_pph", "Data"),
        f("21 Mon PPH", "d21_mon_pph", "Data"),
        f("21 Mon WPPH", "d21_mon_wpph", "Data"),
        f("22 Tue", "d22_tue", "Data"),
        f("23 Wed", "d23_wed", "Data"),
        f("24 Thu", "d24_thu", "Data"),
        f("25 Fri", "d25_fri", "Data"),
        f("26 Sat", "d26_sat", "Data"),
        f("27 Sun PPH", "d27_sun_pph", "Data"),
        f("28 Mon PPH", "d28_mon_pph", "Data"),
        f("28 Mon WPPH", "d28_mon_wpph", "Data"),
        f("29 Tue", "d29_tue", "Data"),
        f("30 Wed", "d30_wed", "Data"),
        f("1 Thu PPH", "d1_thu_pph", "Data"),
        f("1 Thu WPPH", "d1_thu_wpph", "Data"),
        f("2 Fri", "d2_fri", "Data"),
        f("3 Sat", "d3_sat", "Data"),
        f("4 Sun PPH", "d4_sun_pph", "Data"),
        f("5 Mon", "d5_mon", "Data"),
        f("6 Tue", "d6_tue", "Data"),
        f("7 Wed", "d7_wed", "Data"),
        f("8 Thu", "d8_thu", "Data"),
        f("9 Fri", "d9_fri", "Data"),
        f("10 Sat", "d10_sat", "Data"),
        f("11 Sun PPH", "d11_sun_pph", "Data"),
        f("12 Mon", "d12_mon", "Data"),
        f("13 Tue", "d13_tue", "Data"),
        f("14 Wed", "d14_wed", "Data"),
        f("15 Thu", "d15_thu", "Data"),

        f("A/Leave 12 Hrs", "a_leave_12_count", "Float", precision="2"),
        f("A/Leave 9 Hrs", "a_leave_9_count", "Float", precision="2"),
        f("S/Leave 12 Hrs", "s_leave_12_count", "Float", precision="2"),
        f("S/Leave 9 Hrs", "s_leave_9_count", "Float", precision="2"),
        f("F/Leave 12 Hrs", "f_leave_12_count", "Float", precision="2"),
        f("F/Leave 9 Hrs", "f_leave_9_count", "Float", precision="2"),
    ]

    ensure_doctype("Payroll Sheet Employee", 1, employee_fields)

    parent_fields = [
        f("Site", "site", "Link", options="Branch", reqd=1),
        f(
            "Month",
            "month",
            "Select",
            reqd=1,
            options="\nJanuary\nFebruary\nMarch\nApril\nMay\nJune\nJuly\nAugust\nSeptember\nOctober\nNovember\nDecember",
        ),
        f("Year", "year", "Int", reqd=1),
        f("Occupation", "occupation", "Data"),
        f("Employees", "employee_rows", "Table", options="Payroll Sheet Employee", reqd=1),
    ]

    ensure_doctype("Payroll Sheet", 0, parent_fields)

    frappe.db.commit()
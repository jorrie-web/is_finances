import re
import frappe
from frappe.utils import flt


EMPLOYEE_SITE_FIELD = "branch"
EMPLOYEE_OCCUPATION_FIELD = "designation"


def _hours(value):
    if value in (None, "", 0):
        return 0.0

    if isinstance(value, (int, float)):
        return flt(value)

    text = str(value).strip().upper()
    match = re.search(r"-?\d+(\.\d+)?", text)
    if match:
        return flt(match.group(0))

    return 0.0


def _clean_coy(value):
    if not value:
        return ""

    text = str(value).strip()
    return re.sub(r"^IS", "", text, flags=re.IGNORECASE).strip()


def _first_existing_employee_field(candidates):
    meta = frappe.get_meta("Employee")
    for fieldname in candidates:
        if meta.has_field(fieldname):
            return fieldname
    return None


def _first_non_empty_value(doc, fieldnames):
    for fieldname in fieldnames:
        if fieldname == "name":
            value = doc.get("name")
        else:
            value = doc.get(fieldname)

        if value not in (None, ""):
            text = str(value).strip()
            if text:
                return text

    return ""


@frappe.whitelist()
def get_site_employee_rows(site, occupation=None):
    if not site:
        return []

    employee_meta = frappe.get_meta("Employee")

    if not employee_meta.has_field(EMPLOYEE_SITE_FIELD):
        frappe.throw(f"Employee field '{EMPLOYEE_SITE_FIELD}' was not found.")

    id_field = _first_existing_employee_field([
        "za_id_number",
        "id_number",
        "custom_id_number",
        "national_id_number",
        "custom_national_id_number",
        "sa_id_number",
        "custom_sa_id_number",
        "identity_number",
        "custom_identity_number",
        "passport_number",
        "custom_passport_number",
    ])

    designation_field = _first_existing_employee_field([
        "designation",
        "custom_designation",
    ])

    last_name_field = _first_existing_employee_field([
        "last_name",
        "custom_last_name",
    ])

    coy_candidates = [
        "employee_number",
        "custom_employee_number",
        "code",
        "name",
    ]

    filters = {
        EMPLOYEE_SITE_FIELD: site,
    }

    if occupation:
        filters[EMPLOYEE_OCCUPATION_FIELD] = occupation

    if employee_meta.has_field("status"):
        filters["status"] = "Active"

    fields = ["name", "employee_name"]

    if last_name_field:
        fields.append(last_name_field)

    if designation_field:
        fields.append(designation_field)

    if id_field:
        fields.append(id_field)

    for fieldname in coy_candidates:
        if fieldname != "name" and employee_meta.has_field(fieldname):
            fields.append(fieldname)

    employees = frappe.get_all(
        "Employee",
        filters=filters,
        fields=fields,
        order_by="employee_name asc",
    )

    rows = []
    for emp in employees:
        raw_coy = _first_non_empty_value(emp, coy_candidates)

        rows.append({
            "employee": emp.get("name"),
            "surname": emp.get(last_name_field) if last_name_field else "",
            "coy": _clean_coy(raw_coy),
            "employee_name": emp.get("employee_name") or "",
            "id_number": emp.get(id_field) if id_field else "",
            "occupation": emp.get(designation_field) if designation_field else "",
        })

    return rows


def rebuild_employee_rows(doc):
    if not doc.site:
        doc.set("employee_rows", [])
        return

    rows = get_site_employee_rows(doc.site, doc.occupation)

    doc.set("employee_rows", [])

    for emp in rows:
        doc.append("employee_rows", emp)


def calculate_row(row):
    normal_hour_fields = [
        "d16_wed",
        "d17_thu",
        "d18_fri_pph",
        "d19_sat",
        "d21_mon_pph",
        "d22_tue",
        "d23_wed",
        "d24_thu",
        "d25_fri",
        "d26_sat",
        "d28_mon_pph",
        "d29_tue",
        "d30_wed",
        "d1_thu_pph",
        "d2_fri",
        "d3_sat",
        "d5_mon",
        "d6_tue",
        "d7_wed",
        "d8_thu",
        "d9_fri",
        "d10_sat",
        "d12_mon",
        "d13_tue",
        "d14_wed",
        "d15_thu",
    ]

    overtime_2_fields = [
        "d20_sun_pph",
        "d27_sun_pph",
        "d4_sun_pph",
        "d11_sun_pph",
    ]

    wpph_2_fields = [
        "d18_fri_wpph",
        "d21_mon_wpph",
        "d28_mon_wpph",
        "d1_thu_wpph",
    ]

    total_calculated_hours = sum(
        _hours(getattr(row, fieldname, 0)) for fieldname in normal_hour_fields
    )

    row.total_calculated_hours = total_calculated_hours
    row.normal_time_hours = min(total_calculated_hours, 195)

    row.a_leave_hours = (flt(row.a_leave_12_count) * 12) + (flt(row.a_leave_9_count) * 9)
    row.s_leave_hours = (flt(row.s_leave_12_count) * 12) + (flt(row.s_leave_9_count) * 9)
    row.f_leave_hours = (flt(row.f_leave_12_count) * 12) + (flt(row.f_leave_9_count) * 9)

    if total_calculated_hours >= 195:
        row.overtime_1_5_after_195 = total_calculated_hours - 195
    else:
        row.overtime_1_5_after_195 = 0

    row.overtime_2_0 = sum(
        _hours(getattr(row, fieldname, 0)) for fieldname in overtime_2_fields
    ) * 2

    row.wpph_2_0 = sum(
        _hours(getattr(row, fieldname, 0)) for fieldname in wpph_2_fields
    ) * 2


def validate_payroll_sheet(doc, method=None):
    rebuild_employee_rows(doc)

    for row in doc.employee_rows or []:
        calculate_row(row)
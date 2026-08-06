function monthNameToNumber(monthName) {
    const months = {
        January: 1,
        February: 2,
        March: 3,
        April: 4,
        May: 5,
        June: 6,
        July: 7,
        August: 8,
        September: 9,
        October: 10,
        November: 11,
        December: 12
    };
    return months[monthName] || null;
}

function getDayName(year, month, day) {
    const d = new Date(year, month - 1, day);
    return new Intl.DateTimeFormat("en-ZA", { weekday: "long" }).format(d);
}

function renderPayrollCalendarBanner(frm) {
    if (!frm.doc.month || !frm.doc.year) {
        frm.set_intro("");
        return;
    }

    const currentMonth = monthNameToNumber(frm.doc.month);
    const currentYear = parseInt(frm.doc.year, 10);

    if (!currentMonth || !currentYear) {
        frm.set_intro("");
        return;
    }

    let previousMonth = currentMonth - 1;
    let previousYear = currentYear;

    if (previousMonth === 0) {
        previousMonth = 12;
        previousYear = currentYear - 1;
    }

    const items = [];

    for (let day = 16; day <= 30; day++) {
        items.push(`${day} (${getDayName(previousYear, previousMonth, day)})`);
    }

    for (let day = 1; day <= 15; day++) {
        items.push(`${day} (${getDayName(currentYear, currentMonth, day)})`);
    }

    frm.set_intro(
        "Payroll Calendar: " + items.join(" | "),
        "blue"
    );
}

function load_filtered_employees(frm) {
    if (!frm.doc.site) {
        frm.clear_table("employee_rows");
        frm.refresh_field("employee_rows");
        return;
    }

    frappe.call({
        method: "is_finances.payroll_sheet.events.get_site_employee_rows",
        args: {
            site: frm.doc.site,
            occupation: frm.doc.occupation || ""
        },
        freeze: true,
        freeze_message: __("Loading employees..."),
        callback: function (r) {
            frm.clear_table("employee_rows");

            (r.message || []).forEach(function (emp) {
                let row = frm.add_child("employee_rows");
                row.employee = emp.employee || "";
                row.surname = emp.surname || "";
                row.coy = emp.coy || "";
                row.employee_name = emp.employee_name || "";
                row.id_number = emp.id_number || "";
                row.occupation = emp.occupation || "";
            });

            frm.refresh_field("employee_rows");
        }
    });
}

frappe.ui.form.on("Payroll Sheet", {
    onload(frm) {
        renderPayrollCalendarBanner(frm);
    },

    refresh(frm) {
        renderPayrollCalendarBanner(frm);

        frm.add_custom_button(__("Reload Employees"), function () {
            load_filtered_employees(frm);
        });
    },

    month(frm) {
        renderPayrollCalendarBanner(frm);
    },

    year(frm) {
        renderPayrollCalendarBanner(frm);
    },

    site(frm) {
        load_filtered_employees(frm);
    },

    occupation(frm) {
        load_filtered_employees(frm);
    }
});
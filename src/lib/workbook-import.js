const SHEETS = {
  quickProjects: {
    name: "Quick Project Upload",
    headers: [
      "client_id", "client_name", "cluster", "client_status",
      "project_id", "project_name", "project_status", "start_date", "end_date", "feedback_interval_days",
      "poc_name", "designation", "whatsapp_number", "email", "birth_date", "salutation", "honorific", "poc_level", "weight_percent", "poc_active",
      "service_name", "internal_owner_email", "kpis"
    ]
  },
  clients: { name: "Clients", headers: ["client_id", "client_name", "cluster", "status"] },
  projects: {
    name: "Projects",
    headers: ["client_id", "project_id", "project_name", "status", "start_date", "end_date", "feedback_interval_days"]
  },
  clientPocs: {
    name: "Client POCs",
    headers: ["project_id", "poc_name", "designation", "whatsapp_number", "email", "birth_date", "salutation", "honorific", "poc_level", "weight_percent", "active"]
  },
  services: {
    name: "Services",
    headers: ["project_id", "service_name", "internal_owner_email", "kpis"]
  },
  internalPocs: {
    name: "Internal POCs",
    headers: ["name", "email", "phone", "cluster", "department", "sub_department", "reporting_manager_email", "active"]
  }
};

function headerName(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function cellValue(cell) {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if (value.result !== undefined && value.result !== null) return value.result;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    if (value.text !== undefined) return value.text;
    if (value.hyperlink !== undefined) return value.text || value.hyperlink;
  }
  return value;
}

function isoDate(value, sheetName, rowNumber, field) {
  if (value === "" || value === null || value === undefined) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${sheetName} row ${rowNumber}: ${field} must be an Excel date or YYYY-MM-DD`);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${sheetName} row ${rowNumber}: ${field} is not a valid date`);
  }
  return text;
}

function rowsFromSheet(workbook, definition) {
  const sheet = workbook.getWorksheet(definition.name);
  if (!sheet) throw new Error(`Workbook is missing the "${definition.name}" sheet`);

  let headerRow = null;
  let headerMap = null;
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 12); rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const map = new Map();
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const name = headerName(cellValue(cell));
      if (name) map.set(name, columnNumber);
    });
    if (definition.headers.every((name) => map.has(name))) {
      headerRow = rowNumber;
      headerMap = map;
      break;
    }
  }
  if (!headerRow) {
    throw new Error(`${definition.name}: keep the template header names unchanged`);
  }

  const rows = [];
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const item = { __row: rowNumber };
    let hasValue = false;
    for (const field of definition.headers) {
      const value = cellValue(row.getCell(headerMap.get(field)));
      item[field] = value;
      if (value !== "" && value !== null && value !== undefined) hasValue = true;
    }
    if (hasValue) rows.push(item);
  }
  return rows;
}

function rowsFromSheetOptional(workbook, definition) {
  return workbook.getWorksheet(definition.name) ? rowsFromSheet(workbook, definition) : [];
}

function quickRowsToSheets(rows) {
  const clients = new Map();
  const projects = new Map();
  const clientPocs = new Map();
  const services = new Map();

  for (const row of rows) {
    const clientKey = String(row.client_id || "").trim().toLowerCase();
    const projectKey = String(row.project_id || "").trim();
    if (clientKey && !clients.has(clientKey)) {
      clients.set(clientKey, {
        row: row.__row,
        key: clientKey,
        name: String(row.client_name || "").trim(),
        clusterName: String(row.cluster || "").trim(),
        activeStatus: String(row.client_status || "").trim().toLowerCase()
      });
    }
    if (projectKey && !projects.has(projectKey.toLowerCase())) {
      projects.set(projectKey.toLowerCase(), {
        row: row.__row,
        clientKey,
        key: projectKey,
        name: String(row.project_name || "").trim(),
        activeStatus: String(row.project_status || "").trim().toLowerCase(),
        startDate: isoDate(row.start_date, "Quick Project Upload", row.__row, "start_date"),
        endDate: isoDate(row.end_date, "Quick Project Upload", row.__row, "end_date"),
        feedbackIntervalDays: row.feedback_interval_days === "" ? "" : Number(row.feedback_interval_days)
      });
    }

    const hasPoc = ["poc_name", "designation", "whatsapp_number", "email", "birth_date", "salutation", "honorific", "poc_level", "weight_percent", "poc_active"]
      .some((field) => row[field] !== "" && row[field] !== null && row[field] !== undefined);
    if (hasPoc) {
      const phoneKey = String(row.whatsapp_number || "").replace(/\D/g, "") || `row-${row.__row}`;
      const key = `${projectKey.toLowerCase()}|${phoneKey}`;
      if (!clientPocs.has(key)) clientPocs.set(key, {
        row: row.__row,
        projectKey,
        name: String(row.poc_name || "").trim(),
        designation: String(row.designation || "").trim(),
        contactWhatsapp: String(row.whatsapp_number || "").trim(),
        contactEmail: String(row.email || "").trim(),
        birthDate: isoDate(row.birth_date, "Quick Project Upload", row.__row, "birth_date"),
        salutation: String(row.salutation || "").trim(),
        honorific: String(row.honorific || "").trim(),
        levelName: String(row.poc_level || "").trim(),
        weightPercentage: row.weight_percent === "" ? "" : Number(row.weight_percent),
        active: String(row.poc_active || "").trim().toLowerCase()
      });
    }

    const hasService = ["service_name", "internal_owner_email", "kpis"]
      .some((field) => row[field] !== "" && row[field] !== null && row[field] !== undefined);
    if (hasService) {
      const name = String(row.service_name || "").trim();
      const key = `${projectKey.toLowerCase()}|${headerName(name) || `row-${row.__row}`}`;
      if (!services.has(key)) services.set(key, {
        row: row.__row,
        projectKey,
        serviceKey: "",
        name,
        internalOwnerEmail: String(row.internal_owner_email || "").trim().toLowerCase(),
        kpis: String(row.kpis || "").trim()
      });
    }
  }
  return {
    clients: [...clients.values()], projects: [...projects.values()],
    clientPocs: [...clientPocs.values()], services: [...services.values()]
  };
}

export async function parseCsatWorkbook(file) {
  if (!file || !/\.xlsx$/i.test(file.name || "")) {
    throw new Error("Please select the .xlsx template file.");
  }
  if (file.size > 12 * 1024 * 1024) throw new Error("The workbook must be smaller than 12 MB.");

  // ExcelJS is sizeable, so load it only when the user actually selects a
  // workbook instead of adding it to every dashboard visit.
  const excelModule = await import("exceljs");
  const ExcelJS = excelModule.default || excelModule;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());

  let clients = rowsFromSheet(workbook, SHEETS.clients).map((row) => ({
    row: row.__row,
    key: String(row.client_id || "").trim().toLowerCase(),
    name: String(row.client_name || "").trim(),
    clusterName: String(row.cluster || "").trim(),
    activeStatus: String(row.status || "").trim().toLowerCase()
  }));
  let projects = rowsFromSheet(workbook, SHEETS.projects).map((row) => ({
    row: row.__row,
    clientKey: String(row.client_id || "").trim().toLowerCase(),
    key: String(row.project_id || "").trim(),
    name: String(row.project_name || "").trim(),
    activeStatus: String(row.status || "").trim().toLowerCase(),
    startDate: isoDate(row.start_date, "Projects", row.__row, "start_date"),
    endDate: isoDate(row.end_date, "Projects", row.__row, "end_date"),
    feedbackIntervalDays: row.feedback_interval_days === "" ? "" : Number(row.feedback_interval_days)
  }));
  let clientPocs = rowsFromSheet(workbook, SHEETS.clientPocs).map((row) => ({
    row: row.__row,
    projectKey: String(row.project_id || "").trim(),
    name: String(row.poc_name || "").trim(),
    designation: String(row.designation || "").trim(),
    contactWhatsapp: String(row.whatsapp_number || "").trim(),
    contactEmail: String(row.email || "").trim(),
    birthDate: isoDate(row.birth_date, "Client POCs", row.__row, "birth_date"),
    salutation: String(row.salutation || "").trim(),
    honorific: String(row.honorific || "").trim(),
    levelName: String(row.poc_level || "").trim(),
    weightPercentage: row.weight_percent === "" ? "" : Number(row.weight_percent),
    active: String(row.active || "").trim().toLowerCase()
  }));
  let services = rowsFromSheet(workbook, SHEETS.services).map((row) => ({
    row: row.__row,
    projectKey: String(row.project_id || "").trim(),
    serviceKey: "",
    name: String(row.service_name || "").trim(),
    internalOwnerEmail: String(row.internal_owner_email || "").trim().toLowerCase(),
    kpis: String(row.kpis || "").trim()
  }));
  const internalPocs = rowsFromSheet(workbook, SHEETS.internalPocs).map((row) => ({
    row: row.__row,
    name: String(row.name || "").trim(),
    email: String(row.email || "").trim().toLowerCase(),
    phone: String(row.phone || "").trim(),
    clusterName: String(row.cluster || "").trim(),
    departmentName: String(row.department || "").trim(),
    subDepartmentName: String(row.sub_department || "").trim(),
    reportingManagerEmail: String(row.reporting_manager_email || "").trim().toLowerCase(),
    active: String(row.active || "").trim().toLowerCase()
  }));

  const quickRows = rowsFromSheetOptional(workbook, SHEETS.quickProjects);
  if (quickRows.length) {
    if (clients.length || projects.length || clientPocs.length || services.length) {
      throw new Error("Use either Quick Project Upload or the four detailed Clients/Projects/Client POCs/Services sheets in one upload, not both. Internal POCs may be used with either method.");
    }
    ({ clients, projects, clientPocs, services } = quickRowsToSheets(quickRows));
  }

  const total = clients.length + projects.length + clientPocs.length + services.length + internalPocs.length;
  if (!total) throw new Error("The workbook has no data rows to import.");
  return { clients, projects, clientPocs, services, internalPocs };
}

export { SHEETS };

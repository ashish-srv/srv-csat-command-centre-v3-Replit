const ExcelJS = require("exceljs");

const MAX_ROWS = 250;
const COLORS = {
  headerFill: "FFDCEAF7",
  headerText: "FF17365D",
  titleFill: "FF153B5B",
  titleText: "FFFFFFFF",
  noteFill: "FFEAF2F8",
  noteText: "FF44576A",
  inputFill: "FFFFF8D8",
  referenceFill: "FFF1F5F9",
  border: "FFD7DEE5"
};

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function setTitle(sheet, title, subtitle, columnCount) {
  sheet.mergeCells(1, 1, 1, columnCount);
  sheet.getCell(1, 1).value = title;
  sheet.getCell(1, 1).font = { name: "Arial", size: 15, bold: true, color: { argb: COLORS.titleText } };
  sheet.getCell(1, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.titleFill } };
  sheet.getCell(1, 1).alignment = { vertical: "middle" };
  sheet.getRow(1).height = 30;
  sheet.mergeCells(2, 1, 2, columnCount);
  sheet.getCell(2, 1).value = subtitle;
  sheet.getCell(2, 1).font = { name: "Arial", size: 10, italic: true, color: { argb: COLORS.noteText } };
  sheet.getCell(2, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.noteFill } };
  sheet.getCell(2, 1).alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(2).height = 34;
}

function setupInputSheet(sheet, { title, subtitle, columns, requiredKeys = [], referenceKeys = [] }) {
  setTitle(sheet, title, subtitle, columns.length);
  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width }));
  const header = sheet.getRow(4);
  header.values = columns.map((column) => column.label);
  header.height = 32;
  header.eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: COLORS.headerText } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerFill } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "medium", color: { argb: COLORS.border } } };
  });
  for (let row = 5; row <= MAX_ROWS + 4; row += 1) {
    for (let column = 1; column <= columns.length; column += 1) {
      const cell = sheet.getCell(row, column);
      const definition = columns[column - 1];
      cell.font = { name: "Arial", size: 10, color: { argb: "FF17212B" } };
      cell.alignment = { vertical: "top", wrapText: ["services", "designation"].includes(definition.key) };
      if (referenceKeys.includes(definition.key)) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.referenceFill } };
      } else if (requiredKeys.includes(definition.key)) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.inputFill } };
      }
    }
  }
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: MAX_ROWS + 4, column: columns.length } };
  sheet.views = [{ state: "frozen", ySplit: 4, xSplit: Math.min(3, columns.length), topLeftCell: `${sheet.getColumn(Math.min(4, columns.length)).letter}5`, showGridLines: false }];
}

function addSourceList(sheet, startColumn, label, values) {
  const list = unique(values);
  if (!list.length) return { formula: "", nextColumn: startColumn };
  const column = sheet.getColumn(startColumn);
  column.hidden = true;
  sheet.getCell(1, startColumn).value = `Validation: ${label}`;
  list.forEach((value, index) => { sheet.getCell(index + 2, startColumn).value = value; });
  return { formula: `$${column.letter}$2:$${column.letter}$${list.length + 1}`, nextColumn: startColumn + 1 };
}

function applyList(sheet, columnNumber, formula) {
  if (!formula) return;
  for (let row = 5; row <= MAX_ROWS + 4; row += 1) {
    sheet.getCell(row, columnNumber).dataValidation = { type: "list", allowBlank: true, formulae: [formula] };
  }
}

function setColumnFormat(sheet, columnNumber, format) {
  for (let row = 5; row <= MAX_ROWS + 4; row += 1) sheet.getCell(row, columnNumber).numFmt = format;
}

async function buildCsatImportWorkbook(directory = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SRV CSAT Command Centre";
  workbook.created = new Date();

  const clusters = unique((directory.clusters || []).map((item) => item.name));
  const services = unique((directory.serviceCatalog || []).filter((item) => item.active !== false).map((item) => item.name));
  const ownerEmails = unique((directory.internalPocs || []).filter((item) => item.email).map((item) => item.email));
  const pocLevels = unique((directory.pocLevels || []).map((item) => item.name));

  const instructions = workbook.addWorksheet("Instructions", { views: [{ state: "frozen", ySplit: 4, showGridLines: false }] });
  setTitle(instructions, "SRV CSAT client and project upload", "Use Client and Projects for one row per project. Client POCs and Internal POCs remain separate because each project may have multiple contacts and the agency directory is shared.", 6);
  instructions.getRow(4).values = ["Step", "Sheet", "What to enter", "Match key", "Allowed format", "Important note"];
  instructions.getRow(4).eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: COLORS.headerText } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerFill } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  instructions.addRows([
    [1, "Client and Projects", "One project per row, including its client, services and one owner email", "client_id and project_id", "Dates: YYYY-MM-DD; interval: 1-365", "Separate multiple services with |. Every service on that row receives the same internal_owner_email."],
    [2, "Client POCs", "One row per project contact", "project_id + WhatsApp number", "birth_date: YYYY-MM-DD; active: yes/no", "The same person may appear on different projects or clients."],
    [3, "Internal POCs", "Agency people and reporting lines", "email", "active: yes/no", "Add a new owner here before using that email in Client and Projects."],
    [4, "Upload", "Upload the saved .xlsx file in Manage", "Whole workbook", "Do not rename sheets or headers", "Missing rows do not delete existing data. Validation stops all writes if any row is invalid."],
    [5, "Service selection", "Use exact names shown on Lookups", "Standard service name", "Service A | Service B", "Excel cannot multi-select into one normal dropdown cell, so type or paste exact names separated by |."],
    [6, "Date entry", "Use an Excel date or type the date", "—", "YYYY-MM-DD, for example 2026-10-08", "The same format applies to start_date, end_date and birth_date."]
  ]);
  instructions.columns = [18, 22, 42, 28, 30, 58].map((width) => ({ width }));
  for (let row = 5; row <= 10; row += 1) {
    instructions.getRow(row).height = 58;
    instructions.getRow(row).alignment = { vertical: "top", wrapText: true };
  }

  const clientProjectColumns = [
    { key: "client_id", label: "client_id", width: 20 },
    { key: "client_name", label: "client_name", width: 30 },
    { key: "cluster", label: "cluster", width: 22 },
    { key: "client_status", label: "client_status", width: 16 },
    { key: "project_id", label: "project_id", width: 20 },
    { key: "project_name", label: "project_name", width: 32 },
    { key: "project_status", label: "project_status", width: 16 },
    { key: "start_date", label: "start_date (YYYY-MM-DD)", width: 22 },
    { key: "end_date", label: "end_date (YYYY-MM-DD)", width: 22 },
    { key: "feedback_interval_days", label: "feedback_interval_days", width: 23 },
    { key: "services", label: "services (use | between names)", width: 44 },
    { key: "internal_owner_email", label: "internal_owner_email", width: 34 }
  ];
  const clientProjects = workbook.addWorksheet("Client and Projects");
  setupInputSheet(clientProjects, {
    title: "Client and Projects",
    subtitle: "One project per row. Use exact standard service names separated by |. The selected internal owner is applied to every service listed on that row.",
    columns: clientProjectColumns,
    requiredKeys: clientProjectColumns.map((item) => item.key)
  });
  let sourceColumn = clientProjectColumns.length + 2;
  let source = addSourceList(clientProjects, sourceColumn, "Cluster", clusters); sourceColumn = source.nextColumn;
  applyList(clientProjects, 3, source.formula);
  source = addSourceList(clientProjects, sourceColumn, "Status", ["active", "paused", "closed"]); sourceColumn = source.nextColumn;
  applyList(clientProjects, 4, source.formula); applyList(clientProjects, 7, source.formula);
  source = addSourceList(clientProjects, sourceColumn, "Internal owner email", ownerEmails); sourceColumn = source.nextColumn;
  applyList(clientProjects, 12, source.formula);
  setColumnFormat(clientProjects, 8, "yyyy-mm-dd");
  setColumnFormat(clientProjects, 9, "yyyy-mm-dd");
  for (let row = 5; row <= MAX_ROWS + 4; row += 1) {
    clientProjects.getCell(row, 10).dataValidation = { type: "whole", operator: "between", allowBlank: false, formulae: [1, 365] };
  }
  clientProjects.getCell(4, 11).note = "Enter one or more exact Standard Service names from Lookups, separated by |. Example: SEO | Account Management";

  const clientPocColumns = [
    { key: "project_id", label: "project_id", width: 22 },
    { key: "poc_name", label: "poc_name", width: 26 },
    { key: "designation", label: "designation", width: 26 },
    { key: "whatsapp_number", label: "whatsapp_number", width: 23 },
    { key: "email", label: "email", width: 30 },
    { key: "birth_date", label: "birth_date (YYYY-MM-DD)", width: 22 },
    { key: "salutation", label: "salutation", width: 24 },
    { key: "honorific", label: "honorific", width: 14 },
    { key: "poc_level", label: "poc_level", width: 18 },
    { key: "weight_percent", label: "weight_percent", width: 18 },
    { key: "active", label: "active", width: 13 }
  ];
  const clientPocs = workbook.addWorksheet("Client POCs");
  setupInputSheet(clientPocs, {
    title: "Client POCs",
    subtitle: "One row per project contact. A contact may be repeated for different projects or clients. Active POC weights on each project must total 100%.",
    columns: clientPocColumns,
    requiredKeys: ["project_id", "poc_name", "poc_level", "weight_percent", "active"]
  });
  sourceColumn = clientPocColumns.length + 2;
  source = addSourceList(clientPocs, sourceColumn, "POC level", pocLevels); sourceColumn = source.nextColumn;
  applyList(clientPocs, 9, source.formula);
  source = addSourceList(clientPocs, sourceColumn, "Yes / No", ["yes", "no"]); sourceColumn = source.nextColumn;
  applyList(clientPocs, 11, source.formula);
  setColumnFormat(clientPocs, 4, "@");
  setColumnFormat(clientPocs, 6, "yyyy-mm-dd");
  for (let row = 5; row <= MAX_ROWS + 4; row += 1) {
    clientPocs.getCell(row, 10).dataValidation = { type: "decimal", operator: "between", allowBlank: false, formulae: [0, 100] };
  }

  const internalColumns = [
    { key: "name", label: "name", width: 26 },
    { key: "email", label: "email", width: 32 },
    { key: "phone", label: "phone", width: 22 },
    { key: "cluster", label: "cluster", width: 22 },
    { key: "department", label: "department", width: 24 },
    { key: "sub_department", label: "sub_department", width: 26 },
    { key: "reporting_manager_email", label: "reporting_manager_email", width: 32 },
    { key: "active", label: "active", width: 13 }
  ];
  const internalPocs = workbook.addWorksheet("Internal POCs");
  setupInputSheet(internalPocs, {
    title: "Internal POCs",
    subtitle: "Agency-wide directory. Email is the stable update key. Existing owners can be selected in the Client and Projects sheet.",
    columns: internalColumns,
    requiredKeys: ["name", "email", "cluster", "department", "active"]
  });
  sourceColumn = internalColumns.length + 2;
  source = addSourceList(internalPocs, sourceColumn, "Cluster", clusters); sourceColumn = source.nextColumn;
  applyList(internalPocs, 4, source.formula);
  source = addSourceList(internalPocs, sourceColumn, "Reporting manager email", ownerEmails); sourceColumn = source.nextColumn;
  applyList(internalPocs, 7, source.formula);
  source = addSourceList(internalPocs, sourceColumn, "Yes / No", ["yes", "no"]); sourceColumn = source.nextColumn;
  applyList(internalPocs, 8, source.formula);
  setColumnFormat(internalPocs, 3, "@");

  const lookups = workbook.addWorksheet("Lookups", { views: [{ state: "frozen", ySplit: 4, showGridLines: false }] });
  setTitle(lookups, "Current allowed values", "Reference only. Service names and owner emails are generated from the current application database whenever you download this workbook.", 5);
  lookups.getRow(4).values = ["Standard Service", "Internal Owner Email", "Cluster", "POC Level", "Status"];
  lookups.getRow(4).eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: COLORS.headerText } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerFill } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  const count = Math.max(services.length, ownerEmails.length, clusters.length, pocLevels.length, 3);
  for (let index = 0; index < count; index += 1) {
    lookups.addRow([services[index] || "", ownerEmails[index] || "", clusters[index] || "", pocLevels[index] || "", ["active", "paused", "closed"][index] || ""]);
  }
  lookups.columns = [36, 38, 28, 22, 18].map((width) => ({ width }));
  lookups.getColumn(1).alignment = { vertical: "top", wrapText: true };

  return workbook;
}

module.exports = { buildCsatImportWorkbook };

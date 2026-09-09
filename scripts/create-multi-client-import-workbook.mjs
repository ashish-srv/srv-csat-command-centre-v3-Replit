import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SpreadsheetFile, Workbook } = require("@oai/artifact-tool");
const JSZip = require("jszip");

const THREAD_ID = "019fff4c-f9f9-76f2-ac3f-cb8e6e5d3e9c";
const outputDir = path.resolve("outputs", THREAD_ID);
const publicDir = path.resolve("public", "templates");
const fileName = "csat-multi-client-import.xlsx";
const outputPath = path.join(outputDir, fileName);
const publicPath = path.join(publicDir, fileName);

const COLORS = {
  navy: "#153B5B",
  blue: "#2367A8",
  teal: "#0F7C78",
  paleBlue: "#EAF2F8",
  paleTeal: "#E8F5F3",
  paleYellow: "#FFF4CC",
  paleRed: "#FDECEC",
  paleGreen: "#E5F4EA",
  paleGray: "#F3F5F7",
  border: "#D7DEE5",
  text: "#17212B",
  muted: "#546574",
  white: "#FFFFFF",
};

const workbook = Workbook.create();
const instructions = workbook.worksheets.add("Instructions");
const quickProjects = workbook.worksheets.add("Quick Project Upload");
const clients = workbook.worksheets.add("Clients");
const projects = workbook.worksheets.add("Projects");
const clientPocs = workbook.worksheets.add("Client POCs");
const services = workbook.worksheets.add("Services");
const internalPocs = workbook.worksheets.add("Internal POCs");
const examples = workbook.worksheets.add("Examples");
const lookups = workbook.worksheets.add("Lookups");

function titleBand(sheet, title, subtitle, lastColumn) {
  sheet.showGridLines = false;
  sheet.getRange(`A1:${lastColumn}1`).merge();
  sheet.getRange("A1").values = [[title]];
  sheet.getRange(`A1:${lastColumn}1`).format = {
    fill: COLORS.navy,
    font: { bold: true, color: COLORS.white, size: 16 },
    verticalAlignment: "center",
    rowHeight: 31,
  };
  sheet.getRange(`A2:${lastColumn}2`).merge();
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange(`A2:${lastColumn}2`).format = {
    fill: COLORS.paleBlue,
    font: { color: COLORS.muted, italic: true, size: 10 },
    wrapText: true,
    verticalAlignment: "center",
    rowHeight: 34,
  };
}

function setupInputSheet(sheet, { title, subtitle, headers, widths, requiredColumns = [], statusColumn = null }) {
  const lastColumn = String.fromCharCode(64 + headers.length);
  titleBand(sheet, title, subtitle, lastColumn);
  sheet.getRange(`A4:${lastColumn}4`).values = [headers];
  sheet.getRange(`A4:${lastColumn}4`).format = {
    fill: COLORS.blue,
    font: { bold: true, color: COLORS.white, size: 10 },
    wrapText: true,
    verticalAlignment: "center",
    rowHeight: 30,
    borders: { preset: "all", style: "thin", color: COLORS.border },
  };
  sheet.getRange(`A5:${lastColumn}204`).format = {
    font: { color: COLORS.text, size: 10 },
    verticalAlignment: "center",
    borders: { preset: "all", style: "thin", color: COLORS.border },
  };
  headers.forEach((_, index) => {
    const col = String.fromCharCode(65 + index);
    sheet.getRange(`${col}1:${col}204`).format.columnWidth = widths[index];
  });
  requiredColumns.forEach((col) => {
    sheet.getRange(`${col}5:${col}204`).conditionalFormats.addCustom(
      `=AND(COUNTA($A5:$${lastColumn}5)>0,LEN(TRIM(${col}5))=0)`,
      { fill: COLORS.paleRed, font: { color: "#A62A2A" } },
    );
  });
  if (statusColumn) {
    sheet.getRange(`${statusColumn}5:${statusColumn}204`).conditionalFormats.addCustom(
      `=${statusColumn}5="active"`,
      { fill: COLORS.paleGreen, font: { color: "#17613B", bold: true } },
    );
    sheet.getRange(`${statusColumn}5:${statusColumn}204`).conditionalFormats.addCustom(
      `=${statusColumn}5="paused"`,
      { fill: COLORS.paleYellow, font: { color: "#8A6110", bold: true } },
    );
    sheet.getRange(`${statusColumn}5:${statusColumn}204`).conditionalFormats.addCustom(
      `=${statusColumn}5="closed"`,
      { fill: COLORS.paleGray, font: { color: COLORS.muted } },
    );
  }
  sheet.freezePanes.freezeRows(4);
}

titleBand(
  instructions,
  "SRV CSAT multi-client onboarding and update workbook",
  "Fastest option: fill only Quick Project Upload (plus Internal POCs when adding new owners). Alternatively use the four detailed client/project/POC/service sheets. Do not use both methods in one upload.",
  "H",
);
instructions.getRange("A4:H4").values = [["Step", "What to do", "Required", "Identifier / match rule", "Allowed values", "Date / number format", "Scheduling effect", "Important note"]];
instructions.getRange("A4:H4").format = {
  fill: COLORS.blue,
  font: { bold: true, color: COLORS.white, size: 10 },
  wrapText: true,
  rowHeight: 32,
  borders: { preset: "all", style: "thin", color: COLORS.border },
};
instructions.getRange("A5:H10").values = [
  [1, "Choose one project-data method", "Yes", "Quick sheet OR four detailed sheets", "Do not fill both methods", "Text", "No direct cycle", "Quick Project Upload repeats the client/project values on each POC or service row so you never need to move between tabs."],
  [2, "Add or update projects and clients", "Yes", "client_id and project_id", "status: active / paused / closed", "Dates: yyyy-mm-dd; interval: 1-365", "First pulse = start date + interval", "Project ID is any stable letters/numbers/hyphens identifier and need not contain dates."],
  [3, "Add or update client POCs", "Optional; may be inactive", "project_id + WhatsApp number", "POC tag: Normal / Important; active: yes / no", "Birthday: yyyy-mm-dd; weight_percent: 0-100", "Only active reachable POCs receive sessions", "An inactive POC is accepted. If active POCs exist, their direct weight_percent values must total exactly 100%."],
  [4, "Add or update internal POCs", "Required when adding a new service owner", "email", "active: yes / no", "Phone: country code + digits", "No direct cycle", "A reporting manager may be the same person. Multi-person reporting loops are still blocked."],
  [5, "Add or update services", "At least one service per active project", "project_id + generated service key", "service key is automatic", "Text", "Defines bot questions and ownership", "Enter service_name and owner email; the app creates the key."],
  [6, "Upload in Manage", "Yes", "One validated workbook", "Only .xlsx", "Workbook", "Creates/updates records; workflow 8 creates due cycles", "Missing rows never delete records. Correct all reported errors and upload again."],
];
instructions.getRange("A5:H10").format = {
  wrapText: true,
  verticalAlignment: "top",
  rowHeight: 74,
  borders: { preset: "all", style: "thin", color: COLORS.border },
};
instructions.getRange("A12:H12").merge();
instructions.getRange("A12").values = [["Update behavior"]];
instructions.getRange("A12:H12").format = { fill: COLORS.teal, font: { bold: true, color: COLORS.white, size: 11 } };
instructions.getRange("A13:H15").values = [
  ["Clients", "matched by client_id", "Projects", "matched by project_id", "Client POCs", "matched by WhatsApp", "Services", "matched by project_id + service_key"],
  ["Internal POCs", "matched by email", "Blank optional cells", "clear the corresponding optional value", "Omitted rows", "leave existing records unchanged", "Conflicts", "stop the whole import before writes"],
  ["Active project rule", "must have a service; POCs may all be inactive", "No active reachable POC", "stored safely but no feedback can be sent", "Existing history", "never deleted", "Project IDs", "treated case-insensitively for duplicate checking"],
];
instructions.getRange("A13:H15").format = { wrapText: true, borders: { preset: "all", style: "thin", color: COLORS.border }, rowHeight: 44 };
instructions.getRange("A1:A15").format.columnWidth = 14;
instructions.getRange("B1:B15").format.columnWidth = 28;
instructions.getRange("C1:C15").format.columnWidth = 23;
instructions.getRange("D1:D15").format.columnWidth = 25;
instructions.getRange("E1:E15").format.columnWidth = 26;
instructions.getRange("F1:F15").format.columnWidth = 23;
instructions.getRange("G1:G15").format.columnWidth = 30;
instructions.getRange("H1:H15").format.columnWidth = 34;
instructions.freezePanes.freezeRows(4);

setupInputSheet(quickProjects, {
  title: "Quick Project Upload",
  subtitle: "One-sheet option. Repeat client and project details on every row; add one POC and one service per row as needed. Use blank POC/service cells when that row adds only the other record type.",
  headers: [
    "client_id", "client_name", "cluster", "client_status", "project_id", "project_name", "project_status", "start_date", "end_date", "feedback_interval_days",
    "poc_name", "designation", "whatsapp_number", "email", "birth_date", "salutation", "honorific", "poc_level", "weight_percent", "poc_active",
    "service_name", "internal_owner_email", "kpis"
  ],
  widths: [20, 28, 22, 15, 20, 30, 15, 16, 16, 21, 24, 23, 22, 29, 16, 23, 14, 18, 17, 14, 25, 31, 42],
  requiredColumns: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
  statusColumn: "G",
});
quickProjects.getRange("D5:D204").dataValidation = { rule: { type: "list", values: ["active", "paused", "closed"] } };
quickProjects.getRange("G5:G204").dataValidation = { rule: { type: "list", values: ["active", "paused", "closed"] } };
quickProjects.getRange("H5:I204").setNumberFormat("yyyy-mm-dd");
quickProjects.getRange("J5:J204").dataValidation = { rule: { type: "whole", operator: "between", formula1: 1, formula2: 365 } };
quickProjects.getRange("M5:M204").setNumberFormat("@");
quickProjects.getRange("O5:O204").setNumberFormat("yyyy-mm-dd");
quickProjects.getRange("R5:R204").dataValidation = { rule: { type: "list", values: ["Normal", "Important"] } };
quickProjects.getRange("S5:S204").dataValidation = { rule: { type: "decimal", operator: "between", formula1: 0, formula2: 100 } };
quickProjects.getRange("T5:T204").dataValidation = { rule: { type: "list", values: ["yes", "no"] } };
quickProjects.freezePanes.freezeColumns(4);

setupInputSheet(clients, {
  title: "Clients",
  subtitle: "One row per client. client_id is the stable match key; use lowercase letters, numbers and hyphens.",
  headers: ["client_id", "client_name", "cluster", "status"],
  widths: [22, 32, 24, 14],
  requiredColumns: ["A", "B", "D"],
  statusColumn: "D",
});
clients.getRange("D5:D204").dataValidation = { rule: { type: "list", values: ["active", "paused", "closed"] } };

setupInputSheet(projects, {
  title: "Projects",
  subtitle: "One row per project. project_id is any stable letters/numbers/hyphens identifier. Dates must be real Excel dates or yyyy-mm-dd.",
  headers: ["client_id", "project_id", "project_name", "status", "start_date", "end_date", "feedback_interval_days"],
  widths: [22, 22, 32, 14, 16, 16, 24],
  requiredColumns: ["A", "B", "C", "D", "E", "F", "G"],
  statusColumn: "D",
});
projects.getRange("D5:D204").dataValidation = { rule: { type: "list", values: ["active", "paused", "closed"] } };
projects.getRange("E5:F204").setNumberFormat("yyyy-mm-dd");
projects.getRange("G5:G204").dataValidation = { rule: { type: "whole", operator: "between", formula1: 1, formula2: 365 } };

setupInputSheet(clientPocs, {
  title: "Client POCs",
  subtitle: "One row per project contact. Normal/Important is only a tag; weight_percent is that POC's direct influence and active POCs per project must total 100%.",
  headers: ["project_id", "poc_name", "designation", "whatsapp_number", "email", "birth_date", "salutation", "honorific", "poc_level", "weight_percent", "active"],
  widths: [22, 26, 24, 23, 30, 16, 24, 14, 20, 18, 12],
  requiredColumns: ["A", "B", "D", "I", "J", "K"],
});
clientPocs.getRange("D5:D204").setNumberFormat("@");
clientPocs.getRange("F5:F204").setNumberFormat("yyyy-mm-dd");
clientPocs.getRange("I5:I204").dataValidation = { rule: { type: "list", values: ["Normal", "Important"] } };
clientPocs.getRange("J5:J204").dataValidation = { rule: { type: "decimal", operator: "between", formula1: 0, formula2: 100 } };
clientPocs.getRange("K5:K204").dataValidation = { rule: { type: "list", values: ["yes", "no"] } };

setupInputSheet(services, {
  title: "Services",
  subtitle: "One row per service. Enter the service name; the service key is generated automatically and is not an input field.",
  headers: ["project_id", "service_name", "internal_owner_email", "kpis"],
  widths: [22, 28, 32, 48],
  requiredColumns: ["A", "B", "C"],
});

setupInputSheet(internalPocs, {
  title: "Internal POCs",
  subtitle: "Agency-wide directory. Email is the stable update key. A person may select their own email as reporting manager.",
  headers: ["name", "email", "phone", "cluster", "department", "sub_department", "reporting_manager_email", "active"],
  widths: [26, 32, 22, 22, 24, 26, 32, 12],
  requiredColumns: ["A", "B", "D", "E", "H"],
});
internalPocs.getRange("C5:C204").setNumberFormat("@");
internalPocs.getRange("H5:H204").dataValidation = { rule: { type: "list", values: ["yes", "no"] } };

titleBand(examples, "Completed examples", "Copy the pattern into the matching data sheet. This sheet is documentation only and is never imported.", "K");
const exampleRows = [
  ["Clients", "client_id", "client_name", "cluster", "status", null, null, null, null, null, null],
  [null, "mitwpu", "MIT World Peace University", "Education", "active", null, null, null, null, null, null],
  ["Projects", "client_id", "project_id", "project_name", "status", "start_date", "end_date", "feedback_interval_days", null, null, null],
  [null, "mitwpu", "MITWPU2627", "MIT-WPU Digital Marketing", "active", new Date("2026-07-01T00:00:00Z"), new Date("2027-06-30T00:00:00Z"), 30, null, null, null],
  ["Client POCs", "project_id", "poc_name", "designation", "whatsapp_number", "email", "birth_date", "salutation", "poc_level", "weight_percent", "active"],
  [null, "MITWPU2627", "Aashish", "Marketing Head", "+91 98765 43210", "aashish@example.com", new Date("1988-04-18T00:00:00Z"), "Aashish Sir", "Important", 100, "yes"],
  ["Internal POCs", "name", "email", "phone", "cluster", "department", "sub_department", "reporting_manager_email", "active", null, null],
  [null, "Priya Sharma", "priya.sharma@srvmedia.com", "+91 98000 00001", "Education", "Performance Marketing", "PPC", "priya.sharma@srvmedia.com", "yes", null, null],
  ["Services", "project_id", "service_name", "internal_owner_email", "kpis", null, null, null, null, null, null],
  [null, "MITWPU2627", "PPC / Media", "priya.sharma@srvmedia.com", "Lead volume; CPL; lead quality", null, null, null, null, null, null],
];
examples.getRange("A4:K13").values = exampleRows;
for (const row of [4, 6, 8, 10, 12]) {
  examples.getRange(`A${row}:K${row}`).format = { fill: COLORS.teal, font: { bold: true, color: COLORS.white }, wrapText: true };
}
examples.getRange("A4:K13").format.borders = { preset: "all", style: "thin", color: COLORS.border };
examples.getRange("A4:K13").format.wrapText = true;
examples.getRange("E9").setNumberFormat("@");
examples.getRange("D11").setNumberFormat("@");
examples.getRange("A4:A13").format.columnWidth = 18;
examples.getRange("B4:B13").format.columnWidth = 24;
examples.getRange("C4:C13").format.columnWidth = 28;
examples.getRange("D4:D13").format.columnWidth = 28;
examples.getRange("E4:E13").format.columnWidth = 24;
examples.getRange("F4:F13").format.columnWidth = 30;
examples.getRange("G4:G13").format.columnWidth = 26;
examples.getRange("H4:H13").format.columnWidth = 24;
examples.getRange("I4:I13").format.columnWidth = 18;
examples.getRange("J4:J13").format.columnWidth = 14;
examples.getRange("K4:K13").format.columnWidth = 14;
examples.getRange("F7:G7").setNumberFormat("yyyy-mm-dd");
examples.getRange("G9:G9").setNumberFormat("yyyy-mm-dd");
examples.freezePanes.freezeRows(3);

titleBand(lookups, "Allowed values and key reference", "Do not rename this sheet. Data-entry dropdowns read these lists.", "E");
lookups.getRange("A4:E4").values = [["Project/client status", "POC level", "Boolean", "Standard service", "service_key"]];
lookups.getRange("A4:E4").format = { fill: COLORS.blue, font: { bold: true, color: COLORS.white }, borders: { preset: "all", style: "thin", color: COLORS.border } };
lookups.getRange("A5:E9").values = [
  ["active", "Normal", "yes", "Account Management", "account"],
  ["paused", "Important", "no", "Design", "design"],
  ["closed", null, null, "PPC / Media", "ppc"],
  [null, null, null, "SEO", "seo"],
  [null, null, null, "Website", "website"],
];
lookups.getRange("A4:E9").format.borders = { preset: "all", style: "thin", color: COLORS.border };
lookups.getRange("A1:A9").format.columnWidth = 24;
lookups.getRange("B1:B9").format.columnWidth = 30;
lookups.getRange("C1:C9").format.columnWidth = 16;
lookups.getRange("D1:D9").format.columnWidth = 28;
lookups.getRange("E1:E9").format.columnWidth = 22;

// Keep editable blank rows readable without making the workbook enormous.
for (const sheet of [quickProjects, clients, projects, clientPocs, services, internalPocs]) {
  sheet.getRange("A5:A204").format.rowHeight = 21;
}

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(publicDir, { recursive: true });
await workbook.recalculate();
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

// artifact-tool writes SpreadsheetML elements with an `x:` namespace prefix.
// Excel accepts that form, but ExcelJS's upload parser expects the same
// namespace as the default namespace. Normalise only those tag prefixes after
// authoring; workbook content, formulas, styling and relationships stay intact.
const zip = await JSZip.loadAsync(await fs.readFile(outputPath));
for (const [entryName, entry] of Object.entries(zip.files)) {
  if (entry.dir || !entryName.endsWith(".xml")) continue;
  const xml = await entry.async("string");
  if (!xml.includes('xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')) continue;
  zip.file(
    entryName,
    xml
      .replace(
        'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
        'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
      )
      .replace(/<x:/g, "<")
      .replace(/<\/x:/g, "</"),
  );
}
await fs.writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
await fs.copyFile(outputPath, publicPath);

const overview = await workbook.inspect({
  kind: "workbook,sheet",
  maxChars: 9000,
  tableMaxRows: 8,
  tableMaxCols: 10,
  tableMaxCellChars: 100,
});
console.log("WORKBOOK_OVERVIEW");
console.log(overview.ndjson || overview);

const errors = [];
const errorTokens = new Set(["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A"]);
for (const sheetName of ["Instructions", "Quick Project Upload", "Clients", "Projects", "Client POCs", "Services", "Internal POCs", "Examples", "Lookups"]) {
  const sheet = workbook.worksheets.getItem(sheetName);
  const used = sheet.getUsedRange();
  for (const row of used.values || []) {
    for (const value of row || []) {
      if (errorTokens.has(String(value))) errors.push(`${sheetName}: ${value}`);
    }
  }
  const preview = await workbook.render({ sheetName, autoCrop: "all", scale: 1, format: "png" });
  await fs.writeFile(
    path.join(outputDir, `preview-${sheetName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`),
    new Uint8Array(await preview.arrayBuffer()),
  );
}
console.log(`FORMULA_ERROR_SCAN=${errors.length ? errors.join("; ") : "clean (workbook contains no formulas)"}`);
console.log(`OUTPUT=${outputPath}`);
console.log(`PUBLIC_TEMPLATE=${publicPath}`);

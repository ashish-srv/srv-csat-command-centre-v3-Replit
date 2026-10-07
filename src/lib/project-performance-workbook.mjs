const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_ROWS = 1000;
const MIN_KPI_SLOTS = 5;

const BASE_COLUMNS = [
  { key: "cluster_name", label: "Project Cluster (Reference Only)", width: 20, aliases: ["project_cluster", "cluster"] },
  { key: "client_group", label: "Client Group", width: 18 },
  { key: "client_category", label: "Client Category", width: 18 },
  { key: "client_name", label: "Client Name (Reference Only)", width: 30, aliases: ["client_name"] },
  { key: "project_id", label: "Project ID (Required Match Key)", width: 22, aliases: ["project_id"] },
  { key: "project_name", label: "Project Name (Reference Only)", width: 30, aliases: ["project_name"] },
  { key: "financial_year", label: "Financial Year", width: 16, aliases: ["year"] },
  { key: "project_type", label: "Project Type", width: 22 },
  { key: "revenue_category", label: "Revenue Category", width: 18 },
  { key: "portfolio_type", label: "Portfolio Type", width: 22 },
  { key: "project_director", label: "Project Director", width: 22 },
  { key: "am", label: "AM", width: 22 },
  { key: "tl", label: "TL", width: 22 },
  { key: "ad", label: "AD", width: 22, aliases: ["account_director_ad"] },
  { key: "avp", label: "AVP", width: 22 },
  { key: "start_date", label: "Start Date (Reference Only)", width: 16, aliases: ["start_date"] },
  { key: "end_date", label: "End Date (Reference Only)", width: 16, aliases: ["end_date"] },
  { key: "campaign_status", label: "Campaign Status", width: 18 },
  { key: "current_phase", label: "Current Phase", width: 20 },
  { key: "performance_status", label: "Project Performance Status", width: 22, aliases: ["project_status", "performance_status"] },
  { key: "currency", label: "Currency", width: 12 },
  { key: "fx_rate_to_inr", label: "FX Rate to INR", width: 16 },
  { key: "po_amount_local", label: "PO Amount (Local)", width: 18, aliases: ["total_po_amount_ex_gst_local"] },
  { key: "budget_allocated_local", label: "Budget Allocated (Local)", width: 22, aliases: ["total_budget_allocated_local"] },
  { key: "budget_spent_local", label: "Budget Spent (Local)", width: 20, aliases: ["total_budget_spend_local"] },
  { key: "revenue_generated_local", label: "Revenue Generated (Local)", width: 22 },
  { key: "services", label: "Services (Reference Only)", width: 32 },
  { key: "mandates", label: "Mandates, Targets and Service Details", width: 42, aliases: ["deliverables_target_mandate", "deliverables_target_and_mandate"] },
  { key: "deliverables_status", label: "Deliverables Status", width: 38, aliases: ["current_status_of_deliverable_what_we_delivered"] }
];

const TRAILING_COLUMNS = [
  { key: "relationship_strength", label: "Relationship Strength", width: 20, aliases: ["relationship_with_spoc"] },
  { key: "meeting_cadence", label: "Meeting Cadence", width: 18 },
  { key: "last_meeting_date", label: "Last Meeting Date", width: 16 },
  { key: "suggestion_frequency", label: "Suggestion Frequency", width: 20, aliases: ["frequency_of_suggestions"] },
  { key: "last_suggestion_date", label: "Last Suggestion Date", width: 18 },
  { key: "client_sentiment", label: "Client Sentiment", width: 18 },
  { key: "client_feedback", label: "Client Feedback", width: 42 },
  { key: "next_steps", label: "Next Steps", width: 42 },
  { key: "comments", label: "Comments", width: 36 },
  { key: "mom_link", label: "MoM Link", width: 32, aliases: ["most_recent_mom_doc_link"] },
  { key: "consolidated_sheet_link", label: "Consolidated Sheet Link", width: 32 },
  { key: "project_drive_folder_link", label: "Project Drive Folder Link", width: 32 },
  { key: "project_data_sheet_link", label: "Project Data Sheet Link", width: 32 },
  { key: "last_updated_by", label: "Last Updated By (Reference Only)", width: 26, aliases: ["updated_by"] },
  { key: "last_updated_on", label: "Last Updated On (Reference Only)", width: 22, aliases: ["updated_on"] }
];

const FIELD_MAP = {
  client_group: ["clientProfile", "clientGroup"],
  client_category: ["clientProfile", "clientCategory"],
  financial_year: ["profile", "financialYear"],
  project_type: ["profile", "projectType"],
  revenue_category: ["profile", "revenueCategory"],
  portfolio_type: ["profile", "portfolioType"],
  campaign_status: ["profile", "campaignStatus"],
  current_phase: ["profile", "currentPhase"],
  performance_status: ["profile", "performanceStatus"],
  currency: ["profile", "currency"],
  fx_rate_to_inr: ["profile", "fxRateToInr"],
  po_amount_local: ["profile", "poAmountLocal"],
  budget_allocated_local: ["profile", "budgetAllocatedLocal"],
  budget_spent_local: ["profile", "budgetSpentLocal"],
  revenue_generated_local: ["profile", "revenueGeneratedLocal"],
  mandates: ["profile", "mandates"],
  deliverables_status: ["profile", "deliverablesStatus"],
  relationship_strength: ["profile", "relationshipStrength"],
  meeting_cadence: ["profile", "meetingCadence"],
  last_meeting_date: ["profile", "lastMeetingDate"],
  suggestion_frequency: ["profile", "suggestionFrequency"],
  last_suggestion_date: ["profile", "lastSuggestionDate"],
  client_sentiment: ["profile", "clientSentiment"],
  client_feedback: ["profile", "clientFeedback"],
  next_steps: ["profile", "nextSteps"],
  comments: ["profile", "comments"],
  mom_link: ["profile", "links", "mom"],
  consolidated_sheet_link: ["profile", "links", "consolidatedSheet"],
  project_drive_folder_link: ["profile", "links", "projectDriveFolder"],
  project_data_sheet_link: ["profile", "links", "projectDataSheet"]
};

const NUMBER_FIELDS = new Set([
  "fx_rate_to_inr", "po_amount_local", "budget_allocated_local", "budget_spent_local", "revenue_generated_local"
]);
const DATE_FIELDS = new Set(["last_meeting_date", "last_suggestion_date"]);
const REFERENCE_FIELDS = {
  client_group: "client_group",
  client_category: "client_category",
  project_type: "project_type",
  revenue_category: "revenue_category",
  portfolio_type: "portfolio_type",
  campaign_status: "campaign_status",
  current_phase: "current_phase",
  performance_status: "performance_status",
  currency: "currency",
  relationship_strength: "relationship_strength",
  meeting_cadence: "meeting_cadence",
  suggestion_frequency: "suggestion_frequency",
  client_sentiment: "client_sentiment"
};

function headerKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function cellValue(cell) {
  const value = cell?.value;
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

function textValue(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function dateValue(value) {
  if (value === "" || value === null || value === undefined) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = textValue(value);
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    const local = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (local) match = [local[0], local[3], local[2].padStart(2, "0"), local[1].padStart(2, "0")];
  }
  if (!match) throw new Error("Use an Excel date or YYYY-MM-DD");
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) throw new Error("Enter a valid date");
  return iso;
}

function numberValue(value, label, { positive = false } = {}) {
  if (value === "" || value === null || value === undefined) return "";
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  if (positive && number <= 0) throw new Error(`${label} must be greater than zero`);
  return number;
}

function boolValue(value) {
  if (value === true || value === 1) return true;
  return /^(?:yes|y|true|1|primary)$/i.test(textValue(value));
}

function financialYearValue(value) {
  const text = textValue(value);
  if (!text) return "";
  let match = text.match(/^(\d{4})-(\d{4})$/);
  if (match && Number(match[2]) === Number(match[1]) + 1) return text;
  match = text.match(/^(\d{2})-(\d{2})$/);
  if (match) {
    const start = 2000 + Number(match[1]);
    const end = 2000 + Number(match[2]);
    if (end === start + 1) return `${start}-${end}`;
  }
  match = text.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const start = Number(match[1]);
    const end = Math.floor(start / 100) * 100 + Number(match[2]);
    if (end === start + 1) return `${start}-${end}`;
  }
  throw new Error("Financial Year must use 2026-2027");
}

function canonicalReference(data, category, value) {
  const text = textValue(value);
  if (!text) return "";
  const found = (data?.referenceValues?.[category] || []).find((item) => item.value.toLowerCase() === text.toLowerCase());
  if (!found) throw new Error(`must be selected from the ${category.replace(/_/g, " ")} list`);
  return found.value;
}

function nestedSet(target, path, value) {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!cursor[path[index]]) cursor[path[index]] = {};
    cursor = cursor[path[index]];
  }
  cursor[path[path.length - 1]] = value;
}

function teamValue(project, role) {
  const member = project?.team?.[role];
  return member?.email || member?.name || "";
}

function projectPayload(project) {
  return {
    expectedVersion: Number(project.version) || 0,
    clientProfile: {
      clientGroup: project.clientGroup || "",
      clientCategory: project.clientCategory || ""
    },
    profile: {
      financialYear: project.financialYear || "",
      projectType: project.projectType || "",
      revenueCategory: project.revenueCategory || "",
      portfolioType: project.portfolioType || "",
      team: {
        projectDirectorId: project.team?.projectDirectorId || "",
        amId: project.team?.amId || "",
        tlId: project.team?.tlId || "",
        adId: project.team?.adId || "",
        avpId: project.team?.avpId || ""
      },
      currency: project.currency || "INR",
      fxRateToInr: project.fxRateToInr ?? "",
      poAmountLocal: project.poAmountLocal ?? "",
      budgetAllocatedLocal: project.budgetAllocatedLocal ?? "",
      budgetSpentLocal: project.budgetSpentLocal ?? "",
      revenueGeneratedLocal: project.revenueGeneratedLocal ?? "",
      performanceStatus: project.performanceStatus || "",
      currentPhase: project.currentPhase || "",
      campaignStatus: project.campaignStatus || "",
      clientSentiment: project.clientSentiment || "",
      mandates: project.mandates || "",
      deliverablesStatus: project.deliverablesStatus || "",
      relationshipStrength: project.relationshipStrength || "",
      meetingCadence: project.meetingCadence || "",
      lastMeetingDate: project.lastMeetingDate ? String(project.lastMeetingDate).slice(0, 10) : "",
      suggestionFrequency: project.suggestionFrequency || "",
      lastSuggestionDate: project.lastSuggestionDate ? String(project.lastSuggestionDate).slice(0, 10) : "",
      clientFeedback: project.clientFeedback || "",
      nextSteps: project.nextSteps || "",
      comments: project.comments || "",
      links: {
        mom: project.links?.mom || "",
        consolidatedSheet: project.links?.consolidatedSheet || "",
        projectDriveFolder: project.links?.projectDriveFolder || "",
        projectDataSheet: project.links?.projectDataSheet || ""
      }
    },
    kpis: (project.kpis || []).map((kpi) => ({
      kpiName: kpi.kpiName || "",
      unit: kpi.unit || "number",
      direction: kpi.direction || "higher_better",
      target: kpi.target ?? "",
      actual: kpi.actual ?? "",
      previousYearActual: kpi.previousYearActual ?? "",
      isPrimary: Boolean(kpi.isPrimary)
    }))
  };
}

function comparablePayload(payload) {
  const normalized = JSON.parse(JSON.stringify(payload));
  delete normalized.expectedVersion;
  return normalized;
}

function samePayload(left, right) {
  return JSON.stringify(comparablePayload(left)) === JSON.stringify(comparablePayload(right));
}

function kpiColumns(count) {
  const columns = [];
  for (let index = 1; index <= count; index += 1) {
    columns.push(
      { key: `kpi_${index}_name`, label: `KPI ${index} Name${index === 1 ? " (Primary)" : ""}`, width: 22 },
      { key: `kpi_${index}_unit`, label: `KPI ${index} Unit`, width: 14 },
      { key: `kpi_${index}_direction`, label: `KPI ${index} Direction`, width: 18 },
      { key: `kpi_${index}_target`, label: `KPI ${index} Target`, width: 15 },
      { key: `kpi_${index}_actual`, label: `KPI ${index} Actual`, width: 15 },
      { key: `kpi_${index}_previous_year_actual`, label: `KPI ${index} Previous Year Actual`, width: 20, aliases: [`kpi_${index}_ly_actual`] },
      { key: `kpi_${index}_primary`, label: `KPI ${index} Primary (Yes/No)`, width: 18 }
    );
  }
  return columns;
}

function columnDefinitions(kpiCount) {
  return [...BASE_COLUMNS, ...kpiColumns(kpiCount), ...TRAILING_COLUMNS];
}

function rowForProject(project, kpiCount) {
  const row = {
    cluster_name: project.clusterName || "",
    client_group: project.clientGroup || "",
    client_category: project.clientCategory || "",
    client_name: project.clientName || "",
    project_id: project.key || "",
    project_name: project.name || "",
    financial_year: project.financialYear || "",
    project_type: project.projectType || "",
    revenue_category: project.revenueCategory || "",
    portfolio_type: project.portfolioType || "",
    project_director: teamValue(project, "projectDirector"),
    am: teamValue(project, "am"),
    tl: teamValue(project, "tl"),
    ad: teamValue(project, "ad"),
    avp: teamValue(project, "avp"),
    start_date: project.startDate ? new Date(`${String(project.startDate).slice(0, 10)}T12:00:00`) : "",
    end_date: project.endDate ? new Date(`${String(project.endDate).slice(0, 10)}T12:00:00`) : "",
    campaign_status: project.campaignStatus || "",
    current_phase: project.currentPhase || "",
    performance_status: project.performanceStatus || "",
    currency: project.currency || "INR",
    fx_rate_to_inr: project.fxRateToInr ?? "",
    po_amount_local: project.poAmountLocal ?? "",
    budget_allocated_local: project.budgetAllocatedLocal ?? "",
    budget_spent_local: project.budgetSpentLocal ?? "",
    revenue_generated_local: project.revenueGeneratedLocal ?? "",
    services: (project.services || []).map((service) => service.name).filter(Boolean).join(", "),
    mandates: project.mandates || "",
    deliverables_status: project.deliverablesStatus || "",
    relationship_strength: project.relationshipStrength || "",
    meeting_cadence: project.meetingCadence || "",
    last_meeting_date: project.lastMeetingDate ? new Date(`${String(project.lastMeetingDate).slice(0, 10)}T12:00:00`) : "",
    suggestion_frequency: project.suggestionFrequency || "",
    last_suggestion_date: project.lastSuggestionDate ? new Date(`${String(project.lastSuggestionDate).slice(0, 10)}T12:00:00`) : "",
    client_sentiment: project.clientSentiment || "",
    client_feedback: project.clientFeedback || "",
    next_steps: project.nextSteps || "",
    comments: project.comments || "",
    mom_link: project.links?.mom || "",
    consolidated_sheet_link: project.links?.consolidatedSheet || "",
    project_drive_folder_link: project.links?.projectDriveFolder || "",
    project_data_sheet_link: project.links?.projectDataSheet || "",
    last_updated_by: project.updatedBy || "",
    last_updated_on: project.performanceUpdatedAt ? new Date(project.performanceUpdatedAt) : ""
  };
  for (let index = 0; index < kpiCount; index += 1) {
    const kpi = project.kpis?.[index] || {};
    const slot = index + 1;
    row[`kpi_${slot}_name`] = kpi.kpiName || "";
    row[`kpi_${slot}_unit`] = kpi.unit || "";
    row[`kpi_${slot}_direction`] = kpi.direction === "lower_better" ? "Lower is better" : kpi.kpiName ? "Higher is better" : "";
    row[`kpi_${slot}_target`] = kpi.target ?? "";
    row[`kpi_${slot}_actual`] = kpi.actual ?? "";
    row[`kpi_${slot}_previous_year_actual`] = kpi.previousYearActual ?? "";
    row[`kpi_${slot}_primary`] = kpi.kpiName ? (kpi.isPrimary ? "Yes" : "No") : "";
  }
  return row;
}

function addListValidation(sheet, columnNumber, values, endRow) {
  const list = values.map((value) => String(value).replace(/"/g, '""'));
  const formula = `"${list.join(",")}"`;
  if (!list.length || formula.length > 250) return;
  for (let row = 2; row <= endRow; row += 1) {
    sheet.getCell(row, columnNumber).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [formula]
    };
  }
}

export async function buildProjectPerformanceWorkbook(data, suppliedExcelJs = null) {
  const excelModule = suppliedExcelJs || await import("exceljs");
  const ExcelJS = excelModule.default || excelModule;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SRV CSAT Command Centre";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("Project Performance", {
    views: [{ state: "frozen", ySplit: 1, xSplit: 5, topLeftCell: "F2" }]
  });
  const projects = data?.projects || [];
  const kpiCount = Math.max(MIN_KPI_SLOTS, ...projects.map((project) => project.kpis?.length || 0));
  const columns = columnDefinitions(kpiCount);
  sheet.columns = columns.map((column) => ({ header: column.label, key: column.key, width: column.width }));
  projects.forEach((project) => sheet.addRow(rowForProject(project, kpiCount)));

  const header = sheet.getRow(1);
  header.height = 32;
  header.eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17365D" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "medium", color: { argb: "FF9FBAD0" } } };
  });
  sheet.properties.defaultRowHeight = 22;
  sheet.views[0].showGridLines = false;
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(projects.length + 1, 2), column: columns.length } };

  const referenceKeys = new Set(["cluster_name", "client_name", "project_id", "project_name", "start_date", "end_date", "services", "last_updated_by", "last_updated_on"]);
  for (let columnNumber = 1; columnNumber <= columns.length; columnNumber += 1) {
    const definition = columns[columnNumber - 1];
    const excelColumn = sheet.getColumn(columnNumber);
    excelColumn.font = { name: "Arial", size: 10 };
    excelColumn.alignment = { vertical: "top", wrapText: ["mandates", "deliverables_status", "client_feedback", "next_steps", "comments", "services"].includes(definition.key) };
    if (referenceKeys.has(definition.key)) {
      excelColumn.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
        if (rowNumber > 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
      });
    }
    if (definition.key.endsWith("_date") || definition.key === "start_date" || definition.key === "end_date") {
      excelColumn.numFmt = "yyyy-mm-dd";
    }
    if (definition.key === "last_updated_on") excelColumn.numFmt = "yyyy-mm-dd hh:mm";
    if (NUMBER_FIELDS.has(definition.key) || /kpi_\d+_(?:target|actual|previous_year_actual)/.test(definition.key)) {
      excelColumn.numFmt = "#,##0.00####";
    }
  }

  const validationEndRow = Math.max(projects.length + 200, 250);
  const validationCategories = {
    client_group: "client_group", client_category: "client_category", project_type: "project_type",
    revenue_category: "revenue_category", portfolio_type: "portfolio_type", campaign_status: "campaign_status",
    current_phase: "current_phase", performance_status: "performance_status", currency: "currency",
    relationship_strength: "relationship_strength", meeting_cadence: "meeting_cadence",
    suggestion_frequency: "suggestion_frequency", client_sentiment: "client_sentiment"
  };
  for (const [key, category] of Object.entries(validationCategories)) {
    const columnNumber = columns.findIndex((column) => column.key === key) + 1;
    addListValidation(sheet, columnNumber, (data?.referenceValues?.[category] || []).map((item) => item.value), validationEndRow);
  }
  const financialYearColumn = columns.findIndex((column) => column.key === "financial_year") + 1;
  addListValidation(sheet, financialYearColumn, data?.financialYears || [], validationEndRow);
  for (let slot = 1; slot <= kpiCount; slot += 1) {
    addListValidation(sheet, columns.findIndex((column) => column.key === `kpi_${slot}_name`) + 1, (data?.referenceValues?.kpi_name || []).map((item) => item.value), validationEndRow);
    addListValidation(sheet, columns.findIndex((column) => column.key === `kpi_${slot}_unit`) + 1, ["number", "percent", "currency", "ratio"], validationEndRow);
    addListValidation(sheet, columns.findIndex((column) => column.key === `kpi_${slot}_direction`) + 1, ["Higher is better", "Lower is better"], validationEndRow);
    addListValidation(sheet, columns.findIndex((column) => column.key === `kpi_${slot}_primary`) + 1, ["Yes", "No"], validationEndRow);
  }
  return workbook;
}

export async function downloadProjectPerformanceWorkbook(data) {
  const workbook = await buildProjectPerformanceWorkbook(data);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `SRV_Project_Performance_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function headerMapFor(sheet) {
  const aliases = new Map();
  for (const column of [...BASE_COLUMNS, ...TRAILING_COLUMNS]) {
    aliases.set(headerKey(column.label), column.key);
    aliases.set(headerKey(column.key), column.key);
    for (const alias of column.aliases || []) aliases.set(headerKey(alias), column.key);
  }
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 12); rowNumber += 1) {
    const map = new Map();
    const row = sheet.getRow(rowNumber);
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const normalized = headerKey(cellValue(cell));
      if (!normalized) return;
      const genericKpi = normalized.match(/^kpi_(\d+)_(name(?:_primary)?|unit|direction|target|actual|ly_actual|previous_year_actual|primary(?:_yes_no)?)$/);
      if (genericKpi) {
        const suffixMap = {
          name: "name", name_primary: "name", unit: "unit", direction: "direction", target: "target", actual: "actual",
          ly_actual: "previous_year_actual", previous_year_actual: "previous_year_actual", primary: "primary", primary_yes_no: "primary"
        };
        map.set(`kpi_${genericKpi[1]}_${suffixMap[genericKpi[2]]}`, columnNumber);
        if (genericKpi[2] === "name_primary") map.set(`kpi_${genericKpi[1]}_name_implies_primary`, true);
        return;
      }
      const key = aliases.get(normalized);
      if (key) map.set(key, columnNumber);
    });
    if (map.has("project_id")) return { rowNumber, map };
  }
  throw new Error('Keep the "Project ID" header unchanged so projects can be matched safely.');
}

function resolveInternalPoc(data, value, label) {
  const text = textValue(value);
  if (!text) return "";
  const lower = text.toLowerCase();
  const pocs = data?.internalPocs || [];
  const exactId = pocs.find((item) => String(item.id).toLowerCase() === lower);
  if (exactId) return exactId.id;
  const byEmail = pocs.find((item) => String(item.email || "").toLowerCase() === lower);
  if (byEmail) return byEmail.id;
  const byName = pocs.filter((item) => String(item.name || "").trim().toLowerCase() === lower);
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) throw new Error(`${label} matches multiple Internal POCs; use the email address`);
  throw new Error(`${label} must match an Internal POC name or email`);
}

function defaultKpiDirection(name) {
  return /^(?:cpl|cpa|cost per\b)/i.test(name) ? "lower_better" : "higher_better";
}

function defaultKpiUnit(name) {
  if (/%|rate/i.test(name)) return "percent";
  if (/^(?:cpl|cpa|cost per\b|media spend)/i.test(name)) return "currency";
  if (/roas|ratio/i.test(name)) return "ratio";
  return "number";
}

function parseKpis(row, headerMap, project, data, errors) {
  const slots = [...headerMap.keys()]
    .map((key) => String(key).match(/^kpi_(\d+)_/))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  if (!slots.length) return projectPayload(project).kpis;
  const maxSlot = Math.max(...slots);
  const allowedNames = new Map((data?.referenceValues?.kpi_name || []).map((item) => [item.value.toLowerCase(), item.value]));
  const existingByName = new Map((project.kpis || []).map((item) => [item.kpiName.toLowerCase(), item]));
  const kpis = [];
  for (let slot = 1; slot <= maxSlot; slot += 1) {
    const read = (suffix) => headerMap.has(`kpi_${slot}_${suffix}`) ? cellValue(row.getCell(headerMap.get(`kpi_${slot}_${suffix}`))) : "";
    const nameInput = textValue(read("name"));
    const hasAny = ["name", "unit", "direction", "target", "actual", "previous_year_actual", "primary"]
      .some((suffix) => textValue(read(suffix)) !== "");
    if (!hasAny) continue;
    if (!nameInput) {
      errors.push(`KPI ${slot} needs a name`);
      continue;
    }
    const canonicalName = allowedNames.get(nameInput.toLowerCase());
    if (!canonicalName) {
      errors.push(`KPI ${slot} name must be selected from the standard KPI list`);
      continue;
    }
    const existing = existingByName.get(canonicalName.toLowerCase());
    const unitInput = textValue(read("unit")).toLowerCase();
    const unit = unitInput || existing?.unit || defaultKpiUnit(canonicalName);
    if (!["number", "percent", "currency", "ratio"].includes(unit)) errors.push(`KPI ${slot} unit must be number, percent, currency or ratio`);
    const directionInput = textValue(read("direction")).toLowerCase().replace(/[\s-]+/g, "_");
    const direction = directionInput
      ? directionInput === "lower_is_better" || directionInput === "lower_better" ? "lower_better" : directionInput === "higher_is_better" || directionInput === "higher_better" ? "higher_better" : ""
      : existing?.direction || defaultKpiDirection(canonicalName);
    if (!direction) errors.push(`KPI ${slot} direction must be Higher is better or Lower is better`);
    try {
      kpis.push({
        kpiName: canonicalName,
        unit,
        direction: direction || "higher_better",
        target: numberValue(read("target"), `KPI ${slot} target`),
        actual: numberValue(read("actual"), `KPI ${slot} actual`),
        previousYearActual: numberValue(read("previous_year_actual"), `KPI ${slot} previous year actual`),
        isPrimary: headerMap.get(`kpi_${slot}_name_implies_primary`) === true || boolValue(read("primary"))
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (kpis.filter((item) => item.isPrimary).length > 1) errors.push("Only one KPI can be marked Primary");
  if (kpis.length && !kpis.some((item) => item.isPrimary)) kpis[0].isPrimary = true;
  return kpis;
}

function projectIdentityWarnings(project, row, headerMap) {
  const warnings = [];
  const checks = [
    ["project_name", project.name, "Project Name"],
    ["client_name", project.clientName, "Client Name"],
    ["cluster_name", project.clusterName, "Cluster"]
  ];
  for (const [key, expected, label] of checks) {
    if (!headerMap.has(key)) continue;
    const supplied = textValue(cellValue(row.getCell(headerMap.get(key))));
    if (supplied && supplied.toLowerCase() !== textValue(expected).toLowerCase()) {
      warnings.push(`${label} differs from the application; the application value will be kept`);
    }
  }
  return warnings;
}

function parseProjectRow(row, headerMap, project, data) {
  const errors = [];
  const warnings = projectIdentityWarnings(project, row, headerMap);
  const payload = projectPayload(project);
  const read = (key) => cellValue(row.getCell(headerMap.get(key)));

  for (const [key, path] of Object.entries(FIELD_MAP)) {
    if (!headerMap.has(key)) continue;
    try {
      let value = read(key);
      if (key === "financial_year") {
        value = financialYearValue(value);
        if (value && !(data?.financialYears || []).includes(value)) throw new Error("is outside the available Financial Year list");
      } else if (REFERENCE_FIELDS[key]) {
        value = canonicalReference(data, REFERENCE_FIELDS[key], value);
      } else if (NUMBER_FIELDS.has(key)) {
        value = numberValue(value, BASE_COLUMNS.find((column) => column.key === key)?.label || key, { positive: key === "fx_rate_to_inr" });
      } else if (DATE_FIELDS.has(key)) {
        value = dateValue(value);
      } else {
        value = textValue(value);
      }
      nestedSet(payload, path, value);
    } catch (error) {
      errors.push(`${BASE_COLUMNS.concat(TRAILING_COLUMNS).find((column) => column.key === key)?.label || key}: ${error.message}`);
    }
  }

  const teamFields = [
    ["project_director", "projectDirectorId", "Project Director"],
    ["am", "amId", "AM"], ["tl", "tlId", "TL"], ["ad", "adId", "AD"], ["avp", "avpId", "AVP"]
  ];
  for (const [key, role, label] of teamFields) {
    if (!headerMap.has(key)) continue;
    try {
      payload.profile.team[role] = resolveInternalPoc(data, read(key), label);
    } catch (error) {
      errors.push(error.message);
    }
  }

  for (const [label, value] of Object.entries(payload.profile.links || {})) {
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid");
    } catch {
      errors.push(`${label} must be a valid http or https URL`);
    }
  }
  payload.kpis = parseKpis(row, headerMap, project, data, errors);
  return { payload, errors, warnings, changed: !samePayload(payload, projectPayload(project)) };
}

export async function parseProjectPerformanceBuffer(arrayBuffer, data, fileName = "workbook.xlsx") {
  const excelModule = await import("exceljs");
  const ExcelJS = excelModule.default || excelModule;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(arrayBuffer);
  if (!workbook.worksheets.length) throw new Error("The workbook has no worksheet.");
  const sheet = workbook.worksheets[0];
  const { rowNumber: headerRow, map: headerMap } = headerMapFor(sheet);
  const projectByKey = new Map((data?.projects || []).map((project) => [String(project.key || "").trim().toLowerCase(), project]));
  const seenProjectKeys = new Set();
  const rows = [];
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const projectKey = textValue(cellValue(row.getCell(headerMap.get("project_id"))));
    const hasAnyValue = row.values.slice(1).some((value) => textValue(value?.result ?? value?.text ?? value) !== "");
    if (!hasAnyValue) continue;
    const errors = [];
    const warnings = [];
    let project = null;
    let parsed = null;
    if (!projectKey) errors.push("Project ID is required");
    else {
      project = projectByKey.get(projectKey.toLowerCase()) || null;
      if (!project) errors.push(`Project ID ${projectKey} was not found in the application`);
      if (seenProjectKeys.has(projectKey.toLowerCase())) errors.push(`Project ID ${projectKey} appears more than once in the workbook`);
      seenProjectKeys.add(projectKey.toLowerCase());
    }
    if (project) {
      parsed = parseProjectRow(row, headerMap, project, data);
      errors.push(...parsed.errors);
      warnings.push(...parsed.warnings);
    }
    rows.push({
      rowNumber,
      projectId: project?.id || "",
      projectKey,
      projectName: project?.name || textValue(headerMap.has("project_name") ? cellValue(row.getCell(headerMap.get("project_name"))) : ""),
      clientName: project?.clientName || "",
      errors,
      warnings,
      changed: Boolean(parsed?.changed),
      eligible: Boolean(project && parsed?.changed && !errors.length),
      payload: parsed?.payload || null
    });
  }
  if (!rows.length) throw new Error("The worksheet has no project rows.");
  if (rows.length > MAX_UPLOAD_ROWS) throw new Error(`Upload at most ${MAX_UPLOAD_ROWS} project rows at a time.`);

  const clientProfiles = new Map();
  for (const row of rows.filter((item) => item.projectId && item.payload)) {
    const project = (data.projects || []).find((item) => item.id === row.projectId);
    const signature = JSON.stringify(row.payload.clientProfile);
    const existing = clientProfiles.get(project.clientId);
    if (existing && existing.signature !== signature) {
      const message = `Client Group and Client Category must be the same for every ${project.clientName} project row`;
      row.errors.push(message);
      row.eligible = false;
      existing.row.errors.push(message);
      existing.row.eligible = false;
    } else if (!existing) clientProfiles.set(project.clientId, { signature, row });
  }
  return {
    fileName,
    sheetName: sheet.name,
    ignoredSheets: workbook.worksheets.slice(1).map((item) => item.name),
    rows
  };
}

export async function parseProjectPerformanceWorkbook(file, data) {
  if (!file || !/\.xlsx$/i.test(file.name || "")) throw new Error("Please select an .xlsx workbook.");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("The workbook must be smaller than 12 MB.");
  return parseProjectPerformanceBuffer(await file.arrayBuffer(), data, file.name);
}

export { columnDefinitions, projectPayload };

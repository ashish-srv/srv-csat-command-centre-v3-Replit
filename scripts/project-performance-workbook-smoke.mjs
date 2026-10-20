import ExcelJS from "exceljs";
import { buildProjectPerformanceWorkbook, parseProjectPerformanceBuffer } from "../src/lib/project-performance-workbook.mjs";

const internalPoc = { id: "p1", name: "Asha", email: "asha@example.com" };
const project = {
  id: "project-uuid",
  key: "PRJ-1",
  name: "Project One",
  clientId: "client-uuid",
  clientName: "Client One",
  clusterName: "Orion",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  activeStatus: "active",
  clientGroup: "Group",
  clientCriticality: "Critical",
  financialYear: "2026-2027",
  projectType: "Performance Only",
  revenueCategory: "Below 1 CR",
  portfolioType: "Portfolio",
  team: {
    projectDirectorId: internalPoc.id, amId: internalPoc.id, tlId: internalPoc.id, adId: internalPoc.id, avpId: internalPoc.id,
    projectDirector: internalPoc, am: internalPoc, tl: internalPoc, ad: internalPoc, avp: internalPoc
  },
  currency: "INR",
  fxRateToInr: 1,
  poAmountLocal: 100,
  budgetAllocatedLocal: 80,
  budgetSpentLocal: 20,
  revenueGeneratedLocal: 50,
  performanceStatus: "On Track",
  currentPhase: "Execution",
  campaignStatus: "LIVE",
  clientSentiment: "Positive",
  mandates: "Target",
  deliverablesStatus: "Done",
  relationshipStrength: "Strong",
  meetingCadence: "Monthly",
  lastMeetingDate: "2026-09-01",
  suggestionFrequency: "Monthly",
  lastSuggestionDate: "2026-09-02",
  clientFeedback: "Good",
  nextSteps: "Continue",
  comments: "",
  links: { mom: "https://example.com/mom", consolidatedSheet: "", projectDriveFolder: "", projectDataSheet: "" },
  version: 2,
  updatedBy: "asha@example.com",
  performanceUpdatedAt: "2026-09-03T00:00:00Z",
  services: [{ name: "SEO" }],
  zohoPasswordSet: true,
  zohoDashboardLink: "https://example.com/zoho",
  kpis: [{ kpiName: "Leads", comment: "MBA IT", unit: "number", direction: "higher_better", target: 10, actual: 12, previousYearActual: 8, isPrimary: true }, { kpiName: "Leads", comment: "Technology Management", unit: "number", direction: "higher_better", target: 10, actual: 12, previousYearActual: 8, isPrimary: false }]
};

const data = {
  financialYears: ["2026-2027"],
  referenceValues: {
    client_group: [{ value: "Group" }],
    client_criticality: [{ value: "Critical" }], project_type: [{ value: "Performance Only" }], revenue_category: [{ value: "Below 1 CR" }],
    portfolio_type: [{ value: "Portfolio" }], campaign_status: [{ value: "LIVE" }], current_phase: [{ value: "Execution" }],
    performance_status: [{ value: "On Track" }], currency: [{ value: "INR" }], relationship_strength: [{ value: "Strong" }],
    meeting_cadence: [{ value: "Monthly" }], suggestion_frequency: [{ value: "Monthly" }], client_sentiment: [{ value: "Positive" }],
    kpi_name: [{ value: "Leads" }, { value: "CPL" }]
  },
  internalPocs: [internalPoc],
  projects: [project]
};

const workbook = await buildProjectPerformanceWorkbook(data, ExcelJS);
const buffer = await workbook.xlsx.writeBuffer();
const parsed = await parseProjectPerformanceBuffer(buffer, data, "roundtrip.xlsx");
const row = parsed.rows[0];
if (workbook.worksheets.length !== 1 || workbook.worksheets[0].name !== "Project Performance") throw new Error("Expected exactly one worksheet");
if (!row || row.projectKey !== "PRJ-1" || row.errors.length || row.eligible) throw new Error(`Round-trip mismatch: ${JSON.stringify(row)}`);
if (row.payload.kpis.length !== 2 || row.payload.kpis[0].comment !== "MBA IT" || row.payload.kpis[1].comment !== "Technology Management") throw new Error("Repeated KPI comments did not round trip");
if (Object.keys(row.payload.profile).some((key) => /zohoPassword/i.test(key))) throw new Error("Workbook import must not touch credentials");
const actualColumn = workbook.worksheets[0].getRow(1).values.findIndex((value) => value === "KPI 1 Actual");
if (actualColumn < 1) throw new Error("KPI 1 Actual column was not generated");
workbook.worksheets[0].getCell(2, actualColumn).value = 14;
const changedBuffer = await workbook.xlsx.writeBuffer();
const changed = await parseProjectPerformanceBuffer(changedBuffer, data, "changed.xlsx");
if (!changed.rows[0]?.eligible || changed.rows[0]?.errors.length) throw new Error(`Changed-row mismatch: ${JSON.stringify(changed.rows[0])}`);
// Older templates without comment columns must preserve each slot's own label.
const sheet = workbook.worksheets[0];
for (let column = sheet.columnCount; column >= 1; column -= 1) if (/KPI \d+ Comment/.test(String(sheet.getCell(1, column).value))) sheet.spliceColumns(column, 1);
const legacy = await parseProjectPerformanceBuffer(await workbook.xlsx.writeBuffer(), data, "old-template.xlsx");
if (legacy.rows[0].payload.kpis[0].comment !== "MBA IT" || legacy.rows[0].payload.kpis[1].comment !== "Technology Management") throw new Error("Legacy upload erased or mixed KPI comments");
console.log(JSON.stringify({ sheets: workbook.worksheets.map((sheet) => sheet.name), rows: parsed.rows.length, projectId: row.projectKey, errors: row.errors, unchanged: !row.changed, changedEligible: changed.rows[0].eligible, bytes: buffer.length }));

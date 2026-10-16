import ExcelJS from "exceljs";
import { buildPocControlWorkbook } from "../src/lib/poc-control-workbook.mjs";

const rows = [
  {
    id: "poc-record-1",
    clusterId: "cluster-1",
    clientId: "client-record-1",
    clientKey: "client-one",
    clientName: "Client One",
    clientStatus: "active",
    projectId: "project-record-1",
    projectKey: "PROJECT-1",
    projectName: "Project One",
    projectStatus: "active",
    name: "Ashish",
    salutation: "Ashish Sir",
    honorific: "Sir",
    designation: "Director",
    contactWhatsapp: "+919876543210",
    contactEmail: "ashish@example.com",
    birthDate: "1990-05-20",
    levelName: "Important",
    active: true,
    weightPercentage: 37.5
  },
  {
    id: "poc-record-2",
    clusterId: "cluster-1",
    clientId: "client-record-1",
    clientKey: "client-one",
    clientName: "Client One",
    clientStatus: "active",
    projectId: "project-record-1",
    projectKey: "PROJECT-1",
    projectName: "Project One",
    projectStatus: "active",
    name: "Pooja",
    active: false,
    weightPercentage: 0
  }
];

const workbook = await buildPocControlWorkbook(rows, {
  clusterNames: new Map([["cluster-1", "Orion"]]),
  filterSummary: "Clusters: Orion; Statuses: All"
}, ExcelJS);
const sheet = workbook.getWorksheet("POC Details");
if (!sheet || workbook.worksheets.length !== 1) throw new Error("Expected one POC Details worksheet");
if (sheet.getCell("A5").value !== "Cluster") throw new Error("Cluster header is missing");
if (sheet.getCell("C5").value !== "Client ID") throw new Error("Client ID header is missing");
if (sheet.getCell("F5").value !== "Project ID") throw new Error("Project ID header is missing");
if (sheet.getCell("A6").value !== "Orion") throw new Error("Cluster value was not exported");
if (sheet.getCell("C6").value !== "client-one") throw new Error("Client ID value was not exported");
if (sheet.getCell("F6").value !== "PROJECT-1") throw new Error("Project ID value was not exported");
if (sheet.getCell("S6").value !== "cluster-1") throw new Error("Cluster record ID was not exported");
if (sheet.getCell("Q6").value !== 0.375 || sheet.getCell("Q6").numFmt !== "0.00%") {
  throw new Error("POC influence must be a numeric Excel percentage");
}
if (!(sheet.getCell("N6").value instanceof Date)) throw new Error("Birth Date must be a typed Excel date");
if (sheet.getCell("P7").value !== "Inactive") throw new Error("Inactive POC status was not exported");
if (sheet.getCell("B3").value !== "Clusters: Orion; Statuses: All") throw new Error("Filter summary was not exported");

const buffer = await workbook.xlsx.writeBuffer();
const reopened = new ExcelJS.Workbook();
await reopened.xlsx.load(buffer);
if (reopened.getWorksheet("POC Details")?.rowCount !== 7) throw new Error("Exported POC row count is incorrect");
console.log(`POC Control Excel export smoke test passed (${buffer.length} bytes).`);

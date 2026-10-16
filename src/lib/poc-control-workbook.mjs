const COLUMN_DEFINITIONS = [
  { key: "cluster", label: "Cluster", width: 20 },
  { key: "client", label: "Client", width: 30 },
  { key: "clientKey", label: "Client ID", width: 20 },
  { key: "clientStatus", label: "Client Status", width: 16 },
  { key: "project", label: "Project", width: 32 },
  { key: "projectKey", label: "Project ID", width: 22 },
  { key: "projectStatus", label: "Project Status", width: 16 },
  { key: "pocName", label: "POC Name", width: 24 },
  { key: "salutation", label: "Salutation", width: 24 },
  { key: "honorific", label: "Honorific", width: 14 },
  { key: "designation", label: "Designation", width: 24 },
  { key: "whatsapp", label: "WhatsApp Number", width: 20 },
  { key: "email", label: "Email", width: 30 },
  { key: "birthDate", label: "Birth Date", width: 16 },
  { key: "tag", label: "POC Tag", width: 16 },
  { key: "status", label: "POC Status", width: 14 },
  { key: "influence", label: "Influence (%)", width: 16 },
  { key: "pocRecordId", label: "POC Record ID", width: 38 },
  { key: "clusterRecordId", label: "Cluster Record ID", width: 38 },
  { key: "clientRecordId", label: "Client Record ID", width: 38 },
  { key: "projectRecordId", label: "Project Record ID", width: 38 }
];

function dateValue(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function clusterName(clusterNames, clusterId) {
  if (clusterNames instanceof Map) return clusterNames.get(clusterId) || "";
  return clusterNames?.[clusterId] || "";
}

function workbookRow(row, clusterNames) {
  return {
    cluster: row.clusterName || clusterName(clusterNames, row.clusterId),
    client: row.clientName || "",
    clientKey: row.clientKey || "",
    clientStatus: row.clientStatus || "",
    project: row.projectName || "",
    projectKey: row.projectKey || "",
    projectStatus: row.projectStatus || "",
    pocName: row.name || "",
    salutation: row.salutation || "",
    honorific: row.honorific || "",
    designation: row.designation || "",
    whatsapp: row.contactWhatsapp || "",
    email: row.contactEmail || "",
    birthDate: dateValue(row.birthDate),
    tag: row.levelName || "",
    status: row.active === false ? "Inactive" : "Active",
    influence: (Number(row.weightPercentage) || 0) / 100,
    pocRecordId: row.id || "",
    clusterRecordId: row.clusterId || "",
    clientRecordId: row.clientId || "",
    projectRecordId: row.projectId || ""
  };
}

export async function buildPocControlWorkbook(rows, options = {}, suppliedExcelJs = null) {
  const excelModule = suppliedExcelJs || await import("exceljs");
  const ExcelJS = excelModule.default || excelModule;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SRV CSAT Command Centre";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("POC Details", {
    views: [{ state: "frozen", ySplit: 5, xSplit: 7, topLeftCell: "H6", showGridLines: false }]
  });
  COLUMN_DEFINITIONS.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
  });

  const lastColumn = COLUMN_DEFINITIONS.length;
  sheet.mergeCells(1, 1, 1, lastColumn);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = "Client POC Details";
  titleCell.font = { name: "Arial", size: 15, bold: true, color: { argb: "FF101828" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 28;

  sheet.getCell("A2").value = "Exported";
  sheet.getCell("B2").value = new Date();
  sheet.getCell("B2").numFmt = "dd-mmm-yyyy hh:mm";
  sheet.getCell("D2").value = "Assignments";
  sheet.getCell("E2").value = rows.length;
  sheet.getCell("A3").value = "Applied filters";
  sheet.mergeCells(3, 2, 3, lastColumn);
  sheet.getCell("B3").value = options.filterSummary || "All POC assignments";
  for (const address of ["A2", "D2", "A3"]) {
    sheet.getCell(address).font = { name: "Arial", size: 10, bold: true, color: { argb: "FF475467" } };
  }
  sheet.getCell("B3").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF475467" } };

  const headerRowNumber = 5;
  const header = sheet.getRow(headerRowNumber);
  COLUMN_DEFINITIONS.forEach((column, index) => {
    header.getCell(index + 1).value = column.label;
  });
  header.height = 30;
  header.eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF263B64" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FFD8E0EA" } } };
  });

  for (const sourceRow of rows) {
    const data = workbookRow(sourceRow, options.clusterNames || new Map());
    const row = sheet.addRow(COLUMN_DEFINITIONS.map((column) => data[column.key]));
    row.height = 22;
    row.font = { name: "Arial", size: 10, color: { argb: "FF172033" } };
    row.alignment = { vertical: "middle" };
    row.eachCell((cell) => {
      cell.border = { bottom: { style: "hair", color: { argb: "FFE6EBF2" } } };
    });
    const statusCell = row.getCell(COLUMN_DEFINITIONS.findIndex((column) => column.key === "status") + 1);
    const active = data.status === "Active";
    statusCell.font = { name: "Arial", size: 10, bold: true, color: { argb: active ? "FF067647" : "FFB42318" } };
    statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: active ? "FFECFDF3" : "FFFEF3F2" } };
  }

  const finalRow = Math.max(headerRowNumber, headerRowNumber + rows.length);
  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: finalRow, column: lastColumn }
  };
  const dateColumn = COLUMN_DEFINITIONS.findIndex((column) => column.key === "birthDate") + 1;
  const influenceColumn = COLUMN_DEFINITIONS.findIndex((column) => column.key === "influence") + 1;
  const textColumns = ["clientKey", "projectKey", "whatsapp", "pocRecordId", "clusterRecordId", "clientRecordId", "projectRecordId"]
    .map((key) => COLUMN_DEFINITIONS.findIndex((column) => column.key === key) + 1);
  if (rows.length) {
    sheet.getColumn(dateColumn).numFmt = "dd-mmm-yyyy";
    sheet.getColumn(influenceColumn).numFmt = "0.00%";
    textColumns.forEach((columnNumber) => { sheet.getColumn(columnNumber).numFmt = "@"; });
  }
  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
  };
  return workbook;
}

export async function downloadPocControlWorkbook(rows, options = {}) {
  const workbook = await buildPocControlWorkbook(rows, options);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `SRV_Client_POC_Details_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export { COLUMN_DEFINITIONS, workbookRow };

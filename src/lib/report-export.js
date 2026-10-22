function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "--";
  if (value instanceof Date) return value.toLocaleString("en-IN");
  if (Array.isArray(value)) return value.length ? value.join(", ") : "--";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function safeFileName(value) {
  return String(value || "csat-report")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 110) || "csat-report";
}

function downloadBlob(blob, fileName) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportStyles() {
  return `
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #172033; background: #eef2f7; font: 13px/1.45 Arial, Helvetica, sans-serif; }
    .report { width: min(1180px, calc(100% - 32px)); margin: 24px auto 60px; }
    .report-head, .section { background: #fff; border: 1px solid #d8e0ea; border-radius: 14px; box-shadow: 0 8px 24px rgba(31,42,68,.06); }
    .report-head { padding: 24px; border-top: 5px solid #1f5ed6; }
    h1 { margin: 0; color: #101828; font-size: 26px; line-height: 1.15; }
    .subtitle { margin: 6px 0 0; color: #536179; font-size: 14px; }
    .generated { margin: 14px 0 0; color: #68758a; font-size: 11px; }
    .report-actions { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 12px; }
    .report-actions button { padding: 8px 12px; border: 1px solid #1f5ed6; border-radius: 8px; background: #1f5ed6; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    .filters { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 16px; }
    .filter { padding: 5px 9px; border-radius: 999px; background: #edf4ff; color: #164cae; font-size: 11px; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 10px; margin-top: 18px; }
    .metric { padding: 12px; border: 1px solid #dde5ef; border-radius: 10px; background: #f8fafc; }
    .metric span { display: block; color: #5d6a7e; font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
    .metric strong { display: block; margin-top: 4px; color: #101828; font-size: 22px; }
    .metric small { display: block; margin-top: 2px; color: #6b778c; }
    .section { margin-top: 16px; overflow: hidden; }
    .section-head { padding: 14px 16px; border-bottom: 1px solid #e2e8f0; background: #f8fafc; }
    h2 { margin: 0; color: #243149; font-size: 16px; }
    .section-note { margin: 3px 0 0; color: #68758a; font-size: 11px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 9px 10px; color: #fff; background: #263b64; font-size: 10px; letter-spacing: .04em; text-align: left; text-transform: uppercase; }
    td { padding: 9px 10px; border-bottom: 1px solid #e6ebf2; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere; }
    tbody tr:nth-child(even) { background: #fafcff; }
    tbody tr:last-child td { border-bottom: 0; }
    .empty { padding: 18px 16px; color: #68758a; }
    .chat-session { padding: 16px; background: #f1f5f9; border-bottom: 3px solid #cbd5e1; }
    .chat-session h3 { margin: 0 0 16px; color: #1e3a5f; }
    .chat-message { width: fit-content; max-width: 85%; margin: 10px auto 10px 0; padding: 12px 16px; border: 1px solid #d5deeb; border-radius: 12px; background: #fff; break-inside: avoid; }
    .chat-message.srv { margin-left: auto; margin-right: 0; background: #e3f1ff; }
    .chat-body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0; }
    .chat-time { font-size: 11px; color: #4b5563; }
    @media print {
      @page { size: A4 landscape; margin: 10mm; }
      body { background: #fff; font-size: 9px; }
      .report { width: 100%; margin: 0; }
      .report-actions { display: none; }
      .report-head, .section { break-inside: avoid; box-shadow: none; border-radius: 0; }
      .section { break-inside: auto; page-break-before: auto; }
      thead { display: table-header-group; }
      tr { break-inside: avoid; }
      h1 { font-size: 20px; }
      th, td { padding: 6px; }
    }
  `;
}

export function reportToHtml(report, { autoPrint = false } = {}) {
  const filters = (report.filters || []).map((item) => (
    `<span class="filter"><b>${escapeHtml(item.label)}:</b> ${escapeHtml(displayValue(item.value))}</span>`
  )).join("");
  const metrics = (report.metrics || []).map((item) => `
    <div class="metric">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(displayValue(item.value))}</strong>
      ${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}
    </div>
  `).join("");
  const sections = (report.sections || []).map((section) => {
    const columns = section.columns || [];
    const rows = section.rows || [];
    return `
      <section class="section">
        <div class="section-head">
          <h2>${escapeHtml(section.title)}</h2>
          ${section.note ? `<p class="section-note">${escapeHtml(section.note)}</p>` : ""}
        </div>
        ${section.chatSessions ? section.chatSessions.map((chat) => `
          <div class="chat-session">
            <h3>${escapeHtml(chat.title)}</h3>
            ${chat.messages.length ? chat.messages.map((message) => `
              <article class="chat-message ${message.side === "client" ? "client" : "srv"}">
                <strong>${escapeHtml(message.speaker)}</strong>
                <div class="chat-body">${escapeHtml(message.message)}</div>
                <time class="chat-time">${escapeHtml(message.time)}</time>
              </article>`).join("") : '<p class="empty">No messages saved for this session.</p>'}
          </div>`).join("") : rows.length ? `
          <div class="table-wrap"><table>
            <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
            <tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(displayValue(row[column.key]))}</td>`).join("")}</tr>`).join("")}</tbody>
          </table></div>
        ` : `<div class="empty">No records match the current report filters.</div>`}
      </section>
    `;
  }).join("");
  const generated = report.generatedAt ? new Date(report.generatedAt) : new Date();
  return `<!doctype html>
    <html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(report.title || "CSAT report")}</title><style>${reportStyles()}</style></head>
    <body><main class="report">
      <div class="report-actions"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
      <header class="report-head">
        <h1>${escapeHtml(report.title || "CSAT report")}</h1>
        ${report.subtitle ? `<p class="subtitle">${escapeHtml(report.subtitle)}</p>` : ""}
        <p class="generated">Generated ${escapeHtml(generated.toLocaleString("en-IN"))}</p>
        ${filters ? `<div class="filters">${filters}</div>` : ""}
        ${metrics ? `<div class="metrics">${metrics}</div>` : ""}
      </header>
      ${sections}
    </main>${autoPrint ? "<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));<\/script>" : ""}</body></html>`;
}

export function downloadHtmlReport(report, fileName) {
  downloadBlob(
    new Blob([reportToHtml(report)], { type: "text/html;charset=utf-8" }),
    `${safeFileName(fileName)}.html`
  );
}

export function openPdfReport(report, targetWindow) {
  const reportWindow = targetWindow || window.open("", "_blank");
  if (!reportWindow) throw new Error("Allow pop-ups for this site, then try the PDF report again.");
  reportWindow.document.open();
  reportWindow.document.write(reportToHtml(report, { autoPrint: true }));
  reportWindow.document.close();
  return reportWindow;
}

function uniqueSheetName(workbook, requestedName) {
  const base = String(requestedName || "Report")
    .replace(/[\\/*?:\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31) || "Report";
  let name = base;
  let suffix = 2;
  while (workbook.getWorksheet(name)) {
    const ending = ` ${suffix}`;
    name = `${base.slice(0, 31 - ending.length)}${ending}`;
    suffix += 1;
  }
  return name;
}

function styleWorksheetHeader(row) {
  row.height = 24;
  row.eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF263B64" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FFD8E0EA" } } };
  });
}

export async function buildExcelReport(report) {
  const excelModule = await import("exceljs");
  const ExcelJS = excelModule.default || excelModule;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "SRV CSAT Command Centre";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Summary", { views: [{ showGridLines: false }] });
  summary.columns = [
    { key: "a", width: 28 }, { key: "b", width: 24 }, { key: "c", width: 24 },
    { key: "d", width: 24 }, { key: "e", width: 24 }, { key: "f", width: 24 }
  ];
  summary.mergeCells("A1:F1");
  summary.getCell("A1").value = report.title || "CSAT report";
  summary.getCell("A1").font = { name: "Arial", size: 16, bold: true, color: { argb: "FF101828" } };
  summary.getCell("A1").alignment = { vertical: "middle" };
  summary.getRow(1).height = 28;
  summary.mergeCells("A2:F2");
  summary.getCell("A2").value = report.subtitle || "";
  summary.getCell("A2").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF536179" } };
  summary.getCell("A3").value = "Generated";
  summary.getCell("B3").value = report.generatedAt ? new Date(report.generatedAt) : new Date();
  summary.getCell("B3").numFmt = "dd-mmm-yyyy hh:mm";

  let rowNumber = 5;
  if ((report.filters || []).length) {
    summary.getCell(`A${rowNumber}`).value = "Report filters";
    summary.getCell(`A${rowNumber}`).font = { name: "Arial", bold: true, color: { argb: "FF1F5ED6" } };
    rowNumber += 1;
    for (const item of report.filters) {
      summary.getCell(`A${rowNumber}`).value = item.label;
      summary.getCell(`B${rowNumber}`).value = displayValue(item.value);
      rowNumber += 1;
    }
    rowNumber += 1;
  }

  if ((report.metrics || []).length) {
    summary.getCell(`A${rowNumber}`).value = "Key scores and counts";
    summary.getCell(`A${rowNumber}`).font = { name: "Arial", bold: true, color: { argb: "FF1F5ED6" } };
    rowNumber += 1;
    const metricHeader = summary.getRow(rowNumber);
    (report.metrics || []).slice(0, 6).forEach((metric, index) => { metricHeader.getCell(index + 1).value = metric.label; });
    styleWorksheetHeader(metricHeader);
    rowNumber += 1;
    const metricValues = summary.getRow(rowNumber);
    (report.metrics || []).slice(0, 6).forEach((metric, index) => {
      metricValues.getCell(index + 1).value = metric.value ?? "--";
      metricValues.getCell(index + 1).font = { name: "Arial", size: 14, bold: true, color: { argb: "FF101828" } };
      metricValues.getCell(index + 1).alignment = { vertical: "middle", horizontal: "center" };
    });
    metricValues.height = 30;
  }

  for (const section of report.sections || []) {
    const worksheet = workbook.addWorksheet(uniqueSheetName(workbook, section.sheetName || section.title), {
      views: [{ state: "frozen", ySplit: 1, showGridLines: false }]
    });
    const columns = section.columns || [];
    worksheet.columns = columns.map((column) => ({
      key: column.key,
      header: column.label,
      width: Math.max(10, Math.min(section.chatSessions ? 100 : 55, column.width || 18))
    }));
    styleWorksheetHeader(worksheet.getRow(1));
    for (const dataRow of section.rows || []) {
      if (dataRow.conversationHeading) {
        const heading = worksheet.addRow([dataRow.conversationHeading]);
        worksheet.mergeCells(heading.number, 1, heading.number, columns.length);
        heading.font = { name: "Arial", size: 11, bold: true, color: { argb: "FF163B64" } };
        heading.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3F1FF" } };
        heading.alignment = { vertical: "middle", wrapText: true };
        heading.height = 38;
        continue;
      }
      const row = worksheet.addRow(columns.reduce((values, column) => {
        values[column.key] = dataRow[column.key] ?? null;
        return values;
      }, {}));
      row.alignment = { vertical: "top", wrapText: true };
      row.font = { name: "Arial", size: 10, color: { argb: "FF172033" } };
      if (section.chatSessions) {
        row.height = Math.min(409, Math.max(30, String(dataRow.message || "").split("\n")
          .reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / 85)), 0) * 15 + 12));
      }
      row.eachCell((cell) => {
        cell.border = { bottom: { style: "hair", color: { argb: "FFE6EBF2" } } };
      });
      columns.forEach((column, index) => {
        if (column.numberFormat) row.getCell(index + 1).numFmt = column.numberFormat;
      });
    }
    if ((section.rows || []).length && !section.chatSessions) {
      worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    } else if (!(section.rows || []).length) {
      worksheet.addRow(["No records match the current report filters."]);
    }
  }

  return workbook;
}

export async function downloadExcelReport(report, fileName) {
  const workbook = await buildExcelReport(report);
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    `${safeFileName(fileName)}.xlsx`
  );
}

export { safeFileName };

function excelMessageParts(text) {
  const parts = [];
  let chunk = "", lines = 1, column = 0;
  for (const character of Array.from(text)) {
    chunk += character;
    column += 1;
    if (character === "\n" || column >= 85) { lines += 1; column = 0; }
    if (lines >= 23 || chunk.length >= 1400) {
      parts.push(chunk); chunk = ""; lines = 1; column = 0;
    }
  }
  if (chunk || !parts.length) parts.push(chunk);
  return parts;
}

export function conversationReportSections(groups, { pocNameById = new Map(), cycleLabel, dateLabel }) {
  const byPoc = new Map();
  for (const { session, messages } of groups) {
    const identity = session.clientPocId || session.id;
    const poc = session.pocName || pocNameById.get(session.clientPocId) || "Unknown POC";
    if (!byPoc.has(identity)) byPoc.set(identity, { poc, sessions: [] });
    byPoc.get(identity).sessions.push({ session, messages });
  }
  return [...byPoc.values()].map(({ poc, sessions }) => {
    const chatSessions = sessions.sort((a, b) => (Date.parse(a.session.startedAt) || 0) - (Date.parse(b.session.startedAt) || 0))
      .map(({ session, messages }) => ({
        title: `${cycleLabel(session.reportCycle.cycleType)} · ${dateLabel(session.startedAt)} · Session ${session.id}`,
        messages: [...messages].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0))
          .map((message) => ({ side: message.side, speaker: message.speaker || (message.side === "client" ? poc : "SRV Media Directors' Office"),
            time: dateLabel(message.createdAt), message: String(message.body || "") }))
      }));
    return { title: `Conversation — ${poc}`, sheetName: `Chat ${poc}`,
      note: "Saved messages grouped by POC and feedback session.", chatSessions,
      columns: [{ key: "time", label: "Time", width: 24 }, { key: "speaker", label: "Speaker", width: 30 },
        { key: "message", label: "Message", width: 100 }],
      rows: chatSessions.flatMap((chat) => [
        { conversationHeading: chat.title },
        ...chat.messages.flatMap((message) => {
          // Excel has a finite visible row height. Continue long messages on
          // subsequent rows without dropping or rewriting any characters.
          return excelMessageParts(message.message).map((part, index) => ({
            time: index ? "Continued" : message.time, speaker: message.speaker, message: part
          }));
        }),
        ...(!chat.messages.length ? [{ message: "No messages saved for this session." }] : [])
      ]) };
  });
}

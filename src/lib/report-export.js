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
    body { margin: 0; color: #172033; background: #eef2f7; font: 13px/1.55 Verdana, Arial, sans-serif; }
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
    .chat-scroll { max-height: 520px; overflow-y: auto; overscroll-behavior: contain; padding: 4px; }
    .client-group { --accent: #9b2335; --tint: #fff1f3; margin-top: 30px; border: 2px solid var(--accent); border-radius: 14px; background: #fff; overflow: hidden; }
    .client-group:nth-of-type(even) { --accent: #17606b; --tint: #effafa; }
    .client-heading { padding: 20px; background: var(--accent); color: #fff; }
    .client-heading h2 { color: #fff; font-size: 23px; }
    .client-heading small { display: block; margin-top: 6px; }
    .project-group { margin: 20px; border: 1px solid var(--accent); border-radius: 10px; overflow: hidden; }
    .project-group:nth-of-type(even) { --accent: #265985; --tint: #eef4fc; }
    .project-heading { padding: 18px; background: var(--tint); border-left: 6px solid var(--accent); }
    .project-heading h3 { margin: 4px 0; font-size: 20px; color: var(--accent); }
    .cycle-group { margin: 16px; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; }
    .cycle-heading { padding: 14px; background: #263744; color: #fff; }
    .cycle-heading h4 { margin: 0 0 4px; font-size: 16px; }
    .poc-group { margin: 16px; padding: 14px; border: 1px solid #9cabbc; border-left: 4px solid var(--accent); border-radius: 8px; background: #f8fafc; }
    .poc-heading h5 { font-size: 19px; margin: 0 0 5px; color: #172033; }
    .poc-heading small { overflow-wrap: anywhere; }
    .context-line { margin: 0 0 8px; color: #4b5563; font-size: 10px; overflow-wrap: anywhere; }
    .consolidated .report-head { border-top-color: #b52336; }
    .consolidated h1 { font-size: 38px; font-weight: 800; color: #9b2335; }
    .report-dates { display: flex; flex-wrap: wrap; gap: 10px 32px; margin-top: 18px; }
    .report-dates p { margin: 0; color: #172033; font-size: 15px; font-weight: 700; }
    .report-dates span { display: block; margin-bottom: 3px; color: #536179; font-size: 11px; font-weight: 400; }
    .consolidated .section { border-radius: 8px; box-shadow: none; }
    .consolidated .section-head { background: #f2f5f8; }
    .consolidated table { table-layout: fixed; }
    .consolidated th:last-child { width: 42%; }
    .consolidated .chat-session h3 { font-size: 12px; overflow-wrap: anywhere; }
    .section-empty { padding: 10px 14px; display: flex; flex-wrap: wrap; gap: 6px 16px; color: #536179; }
    .section-empty strong { color: #243149; }
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
      .consolidated h1 { font-size: 28px; }
      .report-dates { margin-top: 12px; }
      .report-dates p { font-size: 12px; }
      th, td { padding: 6px; }
      * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .chat-scroll { max-height: none !important; height: auto !important; overflow: visible !important; }
      .client-group, .project-group, .cycle-group, .poc-group, .table-wrap, .section { overflow: visible; }
      .client-group { border-radius: 0; margin-top: 12px; }
      .client-group + .client-group, .project-group + .project-group { break-before: page; }
      .project-group { margin: 10px 0; border-radius: 0; }
      .cycle-group, .poc-group { margin: 10px; }
      .client-heading, .project-heading, .cycle-heading, .poc-heading, .section-head { break-after: avoid; }
      .chat-message { break-inside: auto; }
      .chat-session { padding: 10px; }
      .consolidated .section { margin-top: 8px; }
      .consolidated .section-head { padding: 8px 10px; }
      .consolidated .empty { padding: 8px 10px; }
      .client-heading { padding: 12px; }
      .client-heading h2 { font-size: 18px; }
      .project-heading { padding: 10px; }
      .project-heading h3 { font-size: 16px; }
      .cycle-heading { padding: 8px; }
      .cycle-heading h4 { font-size: 13px; }
      .poc-heading h5 { font-size: 14px; }
      .consolidated h2 { font-size: 12px; }
      .consolidated .section-note { font-size: 9px; }
      .section-empty { padding: 6px 10px; }
    }
  `;
}

function groupedReportHtml(sections, renderSection) {
  const clients = new Map();
  for (const section of sections) {
    const context = section.context;
    if (!clients.has(context.clientId)) clients.set(context.clientId, { context, projects: new Map() });
    const projects = clients.get(context.clientId).projects;
    if (!projects.has(context.projectId)) projects.set(context.projectId, { context, sections: [] });
    projects.get(context.projectId).sections.push(section);
  }
  return [...clients.values()].map(client => `<article class="client-group">
    <header class="client-heading"><small>CLIENT</small><h2>${escapeHtml(client.context.client)}</h2><small>Client ID: ${escapeHtml(client.context.clientId)}</small></header>
    ${[...client.projects.values()].map(project => {
      const cycles = new Map();
      for (const section of project.sections) {
        const key = section.context.cycleId || '';
        if (!cycles.has(key)) cycles.set(key, { context: section.context, sections: [] });
        cycles.get(key).sections.push(section);
      }
      return `<article class="project-group"><header class="project-heading"><small>PROJECT · ${escapeHtml(project.context.cluster)}</small><h3>${escapeHtml(project.context.project)}</h3><small>${escapeHtml(project.context.projectKey)} · ${escapeHtml(project.context.projectStatus)}</small></header>
        ${[...cycles.values()].map(cycle => {
          if (!cycle.context.cycleId) return cycle.sections.map(renderSection).join('');
          const pocs = new Map();
          for (const section of cycle.sections) {
            const key = section.context.sessionId || '';
            if (!pocs.has(key)) pocs.set(key, { context: section.context, sections: [] });
            pocs.get(key).sections.push(section);
          }
          return `<section class="cycle-group"><header class="cycle-heading"><h4>${escapeHtml(cycle.context.cycle)}</h4><small>${escapeHtml(cycle.context.cycleStatus)} · Cycle ID: ${escapeHtml(cycle.context.cycleId)}</small></header>
            ${[...pocs.values()].map(poc => poc.context.sessionId ? `<article class="poc-group"><header class="poc-heading"><h5>POC · ${escapeHtml(poc.context.poc)}</h5><small>Session ID: ${escapeHtml(poc.context.sessionId)}</small></header>${poc.sections.map(renderSection).join('')}</article>` : poc.sections.map(renderSection).join('')).join('')}
          </section>`;
        }).join('')}</article>`;
    }).join('')}</article>`).join('');
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
  const renderSection = (section) => {
    const columns = section.columns || [];
    const rows = section.rows || [];
    if (report.consolidated && !section.chatSessions && !rows.length) return `<section class="section section-empty"><strong>${escapeHtml(section.title)}</strong><span>${escapeHtml(section.emptyText || 'No records saved.')}</span></section>`;
    return `
      <section class="section">
        <div class="section-head">
          <h2>${escapeHtml(section.title)}</h2>
          ${section.note ? `<p class="section-note">${escapeHtml(section.note)}</p>` : ""}
          ${section.context ? `<p class="context-line">${escapeHtml([section.context.client, section.context.project, section.context.cycle, section.context.poc].filter(Boolean).join(' / '))}</p>` : ''}
        </div>
        ${section.chatSessions ? section.chatSessions.map((chat) => `
          <div class="chat-session">
            <h3>${escapeHtml(chat.title)}</h3>
            <div class="chat-scroll" tabindex="0" role="region" aria-label="Conversation messages">
            ${chat.messages.length ? chat.messages.map((message) => `
              <article class="chat-message ${message.side === "client" ? "client" : "srv"}">
                <strong>${escapeHtml(message.speaker)}</strong>
                <div class="chat-body">${escapeHtml(message.message)}</div>
                <time class="chat-time">${escapeHtml(message.time)}</time>
              </article>`).join("") : '<p class="empty">No messages saved for this session.</p>'}
            </div>
          </div>`).join("") : rows.length ? `
          <div class="table-wrap"><table>
            <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
            <tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(displayValue(row[column.key]))}</td>`).join("")}</tr>`).join("")}</tbody>
          </table></div>
        ` : `<div class="empty">${escapeHtml(section.emptyText || 'No records match the current report filters.')}</div>`}
      </section>
    `;
  };
  const sections = report.consolidated ? groupedReportHtml(report.sections || [], renderSection) : (report.sections || []).map(renderSection).join('');
  const generated = report.generatedAt ? new Date(report.generatedAt) : new Date();
  const reportDate = generated.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  return `<!doctype html>
    <html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(report.title || "CSAT report")}</title><style>${reportStyles()}</style></head>
    <body class="${report.consolidated ? 'consolidated' : ''}"><main class="report">
      <div class="report-actions"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
      <header class="report-head">
        <h1>${escapeHtml(report.title || "CSAT report")}</h1>
        ${report.subtitle ? `<p class="subtitle">${escapeHtml(report.subtitle)}</p>` : ""}
        ${report.consolidated ? `<div class="report-dates"><p><span>Report Date (IST)</span>${escapeHtml(reportDate)}</p><p><span>Reporting Period (Cycle Start Dates)</span>${escapeHtml(report.reportingPeriod || 'All Dates')}</p></div>` : ''}
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
    cell.font = { name: "Verdana", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
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
  summary.getCell("A1").font = { name: "Verdana", size: report.consolidated ? 28 : 16, bold: true, color: { argb: report.consolidated ? "FF9B2335" : "FF101828" } };
  summary.getCell("A1").alignment = { vertical: "middle" };
  summary.getRow(1).height = report.consolidated ? 48 : 28;
  summary.mergeCells("A2:F2");
  summary.getCell("A2").value = report.subtitle || "";
  summary.getCell("A2").font = { name: "Verdana", size: 10, italic: true, color: { argb: "FF536179" } };
  summary.getCell("A3").value = "Generated";
  summary.getCell("B3").value = report.generatedAt ? new Date(report.generatedAt) : new Date();
  summary.getCell("B3").numFmt = "dd-mmm-yyyy hh:mm";
  if (report.consolidated) {
    const generated = report.generatedAt ? new Date(report.generatedAt) : new Date();
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(generated);
    const part = type => parts.find(item => item.type === type).value;
    summary.getCell('A3').value = 'Report Date (IST)';
    summary.getCell('B3').value = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
    summary.getCell('B3').numFmt = 'dd mmm yyyy';
    summary.getCell('A4').value = 'Reporting Period';
    summary.mergeCells('B4:F4');
    summary.getCell('B4').value = `${report.reportingPeriod || 'All Dates'} (Cycle Start Dates)`;
    for (const address of ['A3', 'B3', 'A4', 'B4']) {
      summary.getCell(address).font = { name: 'Verdana', size: 12, bold: true, color: { argb: 'FF243149' } };
      summary.getCell(address).alignment = { vertical: 'middle', wrapText: true };
    }
    summary.getRow(3).height = 26;
    summary.getRow(4).height = 28;
  }

  let rowNumber = report.consolidated ? 6 : 5;
  if ((report.filters || []).length) {
    summary.getCell(`A${rowNumber}`).value = "Report filters";
    summary.getCell(`A${rowNumber}`).font = { name: "Verdana", bold: true, color: { argb: "FF1F5ED6" } };
    rowNumber += 1;
    for (const item of report.filters) {
      summary.getCell(`A${rowNumber}`).value = item.label;
      summary.getCell(`B${rowNumber}`).value = displayValue(item.value);
      summary.mergeCells(rowNumber, 2, rowNumber, 6);
      summary.getCell(`B${rowNumber}`).alignment = { wrapText: true, vertical: 'top' };
      summary.getRow(rowNumber).height = Math.max(24, Math.ceil(displayValue(item.value).length / 130) * 16 + 8);
      rowNumber += 1;
    }
    rowNumber += 1;
  }

  if ((report.metrics || []).length) {
    summary.getCell(`A${rowNumber}`).value = "Key scores and counts";
    summary.getCell(`A${rowNumber}`).font = { name: "Verdana", bold: true, color: { argb: "FF1F5ED6" } };
    rowNumber += 1;
    const metricHeader = summary.getRow(rowNumber);
    (report.metrics || []).slice(0, 6).forEach((metric, index) => { metricHeader.getCell(index + 1).value = metric.label; });
    styleWorksheetHeader(metricHeader);
    rowNumber += 1;
    const metricValues = summary.getRow(rowNumber);
    (report.metrics || []).slice(0, 6).forEach((metric, index) => {
      metricValues.getCell(index + 1).value = metric.value ?? "--";
      metricValues.getCell(index + 1).font = { name: "Verdana", size: 14, bold: true, color: { argb: "FF101828" } };
      metricValues.getCell(index + 1).alignment = { vertical: "middle", horizontal: "center" };
    });
    metricValues.height = 30;
  }

  if (report.consolidated) {
    addGroupedExcelSheets(workbook, report.sections || []);
    return workbook;
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
        heading.font = { name: "Verdana", size: 11, bold: true, color: { argb: "FF163B64" } };
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
      row.font = { name: "Verdana", size: 10, color: { argb: "FF172033" } };
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

function addGroupedExcelSheets(workbook, sections) {
  const projects = new Map();
  for (const section of sections) {
    const key = section.context.projectId;
    if (!projects.has(key)) projects.set(key, []);
    projects.get(key).push(section);
  }
  const index = workbook.addWorksheet('Project Index', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  index.columns = [{ header: 'Client', width: 40 }, { header: 'Project', width: 45 }, { header: 'Cluster', width: 25 }, { header: 'Open Report', width: 32 }];
  styleWorksheetHeader(index.getRow(1));
  let projectNumber = 0;
  for (const projectSections of projects.values()) {
    projectNumber += 1;
    const context = projectSections[0].context;
    const accent = projectNumber % 2 ? 'FF9B2335' : 'FF17606B';
    const worksheet = workbook.addWorksheet(uniqueSheetName(workbook, context.projectKey || context.project), {
      views: [{ state: 'frozen', ySplit: 3, showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:3' }
    });
    worksheet.columns = [{ width: 28 }, { width: 30 }, { width: 24 }, { width: 100 }];
    worksheet.headerFooter.oddFooter = '&L' + String(context.projectKey || '').replace(/&/g, '&&') + '&RPage &P of &N';
    const indexRow = index.addRow([context.client, context.project, context.cluster, { text: worksheet.name, hyperlink: `#'${worksheet.name.replace(/'/g, "''")}'!A1` }]);
    indexRow.font = { name: 'Verdana', size: 11 };
    indexRow.alignment = { wrapText: true, vertical: 'middle' }; indexRow.height = 48;
    indexRow.getCell(4).font = { name: 'Verdana', size: 11, underline: true, color: { argb: 'FF1D4ED8' } };
    const band = (text, color, fill, size = 11) => {
      const row = worksheet.addRow([text]);
      worksheet.mergeCells(row.number, 1, row.number, 4);
      row.font = { name: 'Verdana', size, bold: true, color: { argb: color } };
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      row.alignment = { wrapText: true, vertical: 'middle' };
      row.height = Math.max(30, Math.ceil(String(text).length / 140) * 19 + 10);
      return row;
    };
    band(`Client: ${context.client}`, 'FFFFFFFF', accent, 15);
    band(`Project: ${context.project} · ${context.projectKey}`, accent, 'FFF1F5F9', 13);
    band(`Cluster: ${context.cluster || '--'} · Project Status: ${context.projectStatus || '--'} · Client ID: ${context.clientId}`, 'FF334155', 'FFF1F5F9');
    let cycleId, sessionId;
    for (const section of projectSections) {
      const scope = section.context;
      if (cycleId !== scope.cycleId) {
        band(`Feedback Cycle: ${scope.cycle || 'No Matching Cycles'} · ${scope.cycleStatus || ''} · ${scope.cycleId || ''}`, 'FFFFFFFF', 'FF263744', 12);
        cycleId = scope.cycleId; sessionId = undefined;
      }
      if (sessionId !== scope.sessionId) {
        band(`POC: ${scope.poc} · Session: ${scope.sessionId}`, accent, 'FFEAF1F5', 12);
        sessionId = scope.sessionId;
      }
      band(section.title, accent, 'FFF1F5F9');
      const header = worksheet.addRow(section.columns.map(column => column.label));
      styleWorksheetHeader(header);
      for (const data of section.rows || []) {
        if (data.conversationHeading) { band(data.conversationHeading, 'FF334155', 'FFF8FAFC', 10); continue; }
        // Split long saved record details too, so Excel's row-height limit
        // never hides the second half of a concern or client message.
        const last = section.columns[3]?.key;
        const parts = typeof data[last] === 'string' ? excelMessageParts(data[last]) : [data[last]];
        parts.forEach((part, partIndex) => {
          const values = section.columns.map((column, i) => i === 3 ? part ?? null : partIndex ? (i === 0 ? 'Continued' : null) : data[column.key] ?? null);
          const row = worksheet.addRow(values);
          row.font = { name: 'Verdana', size: 11, color: { argb: 'FF172033' } };
          row.alignment = { wrapText: true, vertical: 'top' };
          row.height = Math.min(409, Math.max(32, ...values.map((value, i) => String(value ?? '').split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / [23, 25, 20, 85][i])), 0) * 16 + 10)));
          row.eachCell({ includeEmpty: true }, cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: row.number % 2 ? 'FFF8FAFC' : 'FFFFFFFF' } };
            cell.border = { bottom: { style: 'hair', color: { argb: 'FFD8E0EA' } } };
          });
        });
      }
      if (!section.rows?.length) band(section.emptyText || 'No records.', 'FF64748B', 'FFFFFFFF', 10);
      worksheet.addRow([]);
    }
  }
  index.autoFilter = 'A1:D1';
}

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

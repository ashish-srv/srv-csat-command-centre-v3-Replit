const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');
const React = require('react');

function load(relative, mocks = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const harness = new Module(filename, module);
  harness.filename = filename;
  harness.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = harness.require.bind(harness);
  harness.require = name => Object.hasOwn(mocks, name) ? mocks[name] : original(name);
  harness._compile(transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, filename);
  return harness.exports;
}
const exporter = load('src/lib/report-export.js');
const filters = load('src/components/Filters.jsx');
const format = load('src/format.js');
const model = load('src/lib/consolidated-report.js', { './report-export': exporter, '../format': format });
const requests = [];
let values = [];
let failSession = false;
const projects = ['a', 'b'].map(id => ({ id, key: id, name: `Project ${id}`, clientName: `Client ${id}`, clientId: `client-${id}`, clusterId: `cluster-${id}`, clusterName: `Cluster ${id}`, activeStatus: id === 'a' ? 'active' : 'closed', password: 'NEVER EXPORT SECRET' }));
const apiGet = async url => {
  requests.push(url);
  if (url.includes('/workspace')) {
    const id = url.split('/')[3];
    return { pocs: [{ id: 'same-poc', name: 'Shared Name' }], issues: [{ sessionId: `${id}-s`, title: `Issue ${id}`, rootCause: 'Late reports', status: 'open' }, { sessionId: 'unselected', title: 'MUST NOT APPEAR' }], observations: [{ sessionId: `${id}-s`, topic: 'Office Visit', sentiment: 'neutral', detail: 'Student visit request' }, { sessionId: `${id}-qs`, topic: 'Team', sentiment: 'positive', detail: 'Great support' }], cycles: [
      { id: `${id}-c`, cycleType: 'project_end', startedAt: '2026-10-24', sessions: [{ id: `${id}-s`, clientPocId: 'same-poc', csatScore: 9, npsScore: 10, csatSource: id === 'b' ? 'predicted' : 'stated', startedAt: '2026-10-24', status: 'completed' }] },
      { id: `${id}-q`, cycleType: 'quick_checkin', startedAt: '2026-10-01', sessions: [{ id: `${id}-qs`, clientPocId: 'same-poc', csatScore: 1, npsScore: 1, startedAt: '2026-10-01', status: 'completed' }] }
    ] };
  }
  assert.match(url, /^\/api\/sessions\/[^/]+$/);
  if (failSession) throw new Error('Transcript unavailable');
  return { messages: [{ body: `Original words ${url} <tag>`, side: 'client', createdAt: '2026-10-24', metadata: { interpretation: 'PRIVATE DEBUG' } }] };
};
function DownloadFixture() { return null; }
const Component = load('src/components/ConsolidatedFeedbackExport.jsx', {
  react: { ...React, useState: initial => [values.length ? values.shift() : initial, () => {}] },
  '../api': { apiGet }, '../lib/consolidated-report': model, '../format': format,
  './Filters.jsx': filters, './ReportDownloads.jsx': { default: DownloadFixture, __esModule: true }
}).default;
function findDownload(node) {
  if (node?.type === DownloadFixture) return node;
  for (const child of React.Children.toArray(node?.props?.children)) { const found = findDownload(child); if (found) return found; }
  return null;
}
async function report(selection = [[], [], [], [], { from: '', to: '', basis: 'started' }, '']) {
  values = [...selection]; requests.length = 0;
  return findDownload(Component({ projects })).props.getReport();
}
async function main() {
  const all = await report();
  assert.equal(all.title, 'CSAT Report');
  assert.equal(all.reportingPeriod, 'All Dates');
  assert.equal(all.sections.length, 24);
  const rating = (session, metric) => all.sections.find(section => section.context.sessionId === session && section.title === 'Ratings and Response').rows.find(row => row.metric === metric).value;
  assert.equal(rating('a-s', 'Client CSAT / 10'), 9);
  assert.equal(rating('a-s', 'NPS / 10'), 10);
  assert.equal(rating('b-s', 'Client CSAT / 10'), 'Not provided');
  assert.equal(rating('b-s', 'Estimated CSAT / 10'), 9);
  assert.equal(rating('a-qs', 'Client CSAT / 10'), 'Not collected');
  const html = exporter.reportToHtml(all);
  assert.match(html, /<h1>CSAT Report<\/h1>/);
  assert.match(html, /Report Date \(IST\)/);
  assert.match(html, /Reporting Period \(Cycle Start Dates\)/);
  assert.ok(html.includes('Original words'));
  assert.ok(html.includes('&lt;tag&gt;'));
  assert.ok(!html.includes('PRIVATE DEBUG'));
  assert.ok(!html.includes('NEVER EXPORT SECRET'));
  assert.ok(!html.includes('MUST NOT APPEAR'));
  assert.ok(html.includes('Student visit request') && html.includes('Great support'));
  for (const className of ['client-group', 'project-group', 'cycle-group', 'poc-group', 'chat-scroll']) assert.ok(html.includes(`class="${className}"`));
  assert.match(html, /max-height: none !important/);
  assert.equal((html.match(/class="client-group"/g) || []).length, 2);
  const chats = all.sections.filter(section => section.chatSessions);
  assert.equal(chats.length, 4);
  assert.equal(chats[0].context.project, 'Project a');
  assert.equal(chats[2].context.project, 'Project b');
  assert.equal(chats[0].chatSessions.length, 1);
  const selected = await report([['cluster-a'], ['client-a'], ['a'], ['project_end'], { from: '2026-10-20', to: '2026-10-24', basis: 'started' }, '']);
  assert.equal(selected.sections.length, 6);
  assert.equal(selected.reportingPeriod, '20 Oct 2026 to 24 Oct 2026');
  assert.deepEqual(requests, ['/api/projects/a/workspace', '/api/sessions/a-s']);
  const closed = await report([[], [], [], [], { from: '', to: '' }, '', ['closed']]);
  assert.ok(closed.sections.every(section => section.context.projectId === 'b'));
  assert.deepEqual(requests, ['/api/projects/b/workspace', '/api/sessions/b-s', '/api/sessions/b-qs']);
  assert.equal((await report([[], [], [], [], { from: '2026-10-20', to: '' }, ''])).reportingPeriod, 'From 20 Oct 2026');
  assert.equal((await report([[], [], [], [], { from: '', to: '2026-10-24' }, ''])).reportingPeriod, 'Up to 24 Oct 2026');
  await assert.rejects(report([[], [], [], [], { from: '2026-10-25', to: '2026-10-01' }, '', []]), /start date/);
  const workbook = await exporter.buildExcelReport(all);
  assert.equal(workbook.worksheets.length, 4, 'Summary, index and one sheet per project, not per POC');
  assert.equal(workbook.getWorksheet('a').views[0].ySplit, 3);
  const bytes = await workbook.xlsx.writeBuffer();
  assert.ok(bytes.byteLength > 1000);
  const ExcelJS = require('exceljs');
  const reopened = await new ExcelJS.Workbook().xlsx.load(bytes);
  assert.equal(reopened.getWorksheet('Summary').getCell('A1').value, 'CSAT Report');
  assert.equal(reopened.getWorksheet('Summary').getCell('A1').font.size, 28);
  assert.equal(reopened.getWorksheet('Summary').getCell('B4').value, 'All Dates (Cycle Start Dates)');
  const lateReport = { ...selected, generatedAt: '2026-10-24T20:00:00Z' };
  assert.match(exporter.reportToHtml(lateReport), /25 Oct 2026/);
  const lateWorkbook = await exporter.buildExcelReport(lateReport);
  assert.equal(lateWorkbook.getWorksheet('Summary').getCell('B3').value.toISOString(), '2026-10-25T00:00:00.000Z');
  assert.equal(reopened.getWorksheet('b').getCell('A1').value, 'Client: Client b');
  const messages = [];
  reopened.getWorksheet('a').eachRow(row => { if (row.getCell(4).value?.startsWith?.('Original words')) messages.push(row.getCell(4).value); });
  assert.equal(messages.length, 2);
  if (process.argv.includes('--fixtures')) {
    const dir = path.resolve('.local/report-qa'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.html'), html);
    fs.writeFileSync(path.join(dir, 'report.xlsx'), bytes);
  }
  failSession = true;
  await assert.rejects(report(), /Transcript unavailable/);
  console.log('PASS consolidated export: client/project/cycle/POC grouping, session-scoped records, project status/date filters, ratings, HTML escaping, Excel round-trip and failure handling.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

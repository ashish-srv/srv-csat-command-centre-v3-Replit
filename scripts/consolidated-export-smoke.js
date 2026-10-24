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
const requests = [];
let values = [];
let failSession = false;
const projects = ['a', 'b'].map(id => ({ id, key: id, name: `Project ${id}`, clientName: `Client ${id}`, clientId: `client-${id}`, clusterId: `cluster-${id}`, clusterName: `Cluster ${id}`, password: 'NEVER EXPORT SECRET' }));
const apiGet = async url => {
  requests.push(url);
  if (url.includes('/workspace')) {
    const id = url.split('/')[3];
    return { pocs: [{ id: 'same-poc', name: 'Shared Name' }], cycles: [
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
  '../api': { apiGet }, '../lib/report-export': exporter, '../format': format,
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
  assert.equal(all.sections.length, 4);
  const ratings = all.sections.filter(section => section.rows[0]?.project);
  assert.equal(ratings[0].rows[0].csat, 9);
  assert.equal(ratings[0].rows[0].nps, 10);
  assert.equal(ratings[1].rows[0].csat, 'Not provided');
  assert.equal(ratings[1].rows[0].estimatedCsat, 9);
  assert.equal(ratings[0].rows[1].csat, 'Not collected');
  const html = exporter.reportToHtml(all);
  assert.ok(html.includes('Original words'));
  assert.ok(html.includes('&lt;tag&gt;'));
  assert.ok(!html.includes('PRIVATE DEBUG'));
  assert.ok(!html.includes('NEVER EXPORT SECRET'));
  const chats = all.sections.filter(section => section.chatSessions);
  assert.equal(chats.length, 2);
  assert.ok(chats[0].title.startsWith('Project a'));
  assert.ok(chats[1].title.startsWith('Project b'));
  assert.equal(chats[0].chatSessions.length, 2);
  const selected = await report([['cluster-a'], ['client-a'], ['a'], ['project_end'], { from: '2026-10-20', to: '2026-10-24', basis: 'started' }, '']);
  assert.equal(selected.sections[0].rows.length, 1);
  assert.deepEqual(requests, ['/api/projects/a/workspace', '/api/sessions/a-s']);
  failSession = true;
  await assert.rejects(report(), /Transcript unavailable/);
  console.log('All consolidated export checks passed (real component, grouping, filters, ratings, HTML escaping and failures).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

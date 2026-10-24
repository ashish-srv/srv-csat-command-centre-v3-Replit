const assert = require('node:assert/strict');
const { scopeDirectory, scopeProjectData, normalizeClusterAccess, authorizeClusterRequest, scopedBrowserStore } = require('../src/lib/cluster-access');
const { emailRecipients, emailReport, prepareCsatEmail, SAVED_ONLY } = require('../src/lib/csat-email-policy');

async function main() {
  let checks = 0;
  const check = (value, expected) => { assert.deepEqual(value, expected); checks++; };
  const access = { role: 'admin', clusterAccess: [{ clusterId: 'a', emailEnabled: true }] };
  const directory = {
    clusters: [{ id: 'a' }, { id: 'b' }], clients: [{ id: 'ca', clusterId: 'a' }, { id: 'cb', clusterId: 'b' }],
    projects: [{ id: 'pa', clientId: 'ca', key: 'alpha' }, { id: 'pb', clientId: 'cb', key: 'beta' }],
    internalPocs: [{ id: 'ia', clusterId: 'a', reportingManagerId: 'ib' }, { id: 'ib', clusterId: 'b' }],
    clientPocs: [{ id: 'poca', projectId: 'pa' }, { id: 'pocb', projectId: 'pb' }],
    removedClientPocs: [], projectServices: [{ id: 'sa', projectId: 'pa' }, { id: 'sb', projectId: 'pb' }]
  };
  const users = [
    { email: 'super@example.com', role: 'super_admin', active: true },
    { email: 'a@example.com', role: 'admin', active: true, clusterAccess: access.clusterAccess },
    { email: 'muted@example.com', role: 'admin', active: true, clusterAccess: [{ clusterId: 'a', emailEnabled: false }] },
    { email: 'b@example.com', role: 'admin', active: true, clusterAccess: [{ clusterId: 'b', emailEnabled: true }] },
    { email: 'inactive@example.com', role: 'admin', active: false, clusterAccess: access.clusterAccess },
    { id: 'ua', email: 'pu@example.com', role: 'project_user', internalPocId: 'ia', active: true, clusterAccess: access.clusterAccess }
  ];
  const store = {
    getDirectory: async () => directory,
    getProjectPerformanceData: async () => ({ ...directory, projects: directory.projects.map(project => ({ ...project, team: {} })) }),
    listAppUsers: async () => users,
    getProject: async key => directory.projects.find(project => project.key === key),
    getProjectById: async id => ({ ...directory.projects.find(project => project.id === id), clusterId: id === 'pa' ? 'a' : 'b' }),
    getSession: async id => ({ projectId: id === 'session-a' ? 'pa' : 'pb' }),
    getCycle: async id => ({ projectId: id === 'cycle-a' ? 'pa' : 'pb' }),
    getIssue: async id => ({ projectId: id === 'issue-a' ? 'pa' : 'pb' }),
    getMessagesForSession: async () => [{ side: 'client', body: 'Please help with this <request>', metadata: { interpretation: 'PRIVATE DEBUG' } }]
  };
  const scoped = scopeDirectory(directory, access);
  check(scoped.projects.map(row => row.id), ['pa']);
  check(scoped.internalPocs.map(row => row.id), ['ia']);
  check(scoped.internalPocs[0].reportingManagerId, null);
  check(scopeDirectory(directory, { role: 'admin' }).projects, []);
  check(normalizeClusterAccess(access.clusterAccess, 'project_user')[0].emailEnabled, false);
  const context = await authorizeClusterRequest(store, access, 'GET', '/api/admin/directory');
  check((await scopedBrowserStore(store, access, context).getProjectPerformanceData()).projects.map(row => row.id), ['pa']);
  const dashboard = scopeProjectData({ ...directory, metrics: { projectCount: 900 },
    openIssues: [{ project_id: 'pa' }, { project_id: 'pb' }], openCycles: [{ projectId: 'pb' }],
    responseTracker: [{ projectId: 'pa' }, { projectId: 'pb' }], projectPocCounts: { pa: 2, pb: 4 }, scheduleEvents: [{ projectKey: 'alpha' }, { projectKey: 'beta' }] }, access, directory);
  check(dashboard.metrics.projectCount, 1); check(dashboard.openIssues.length, 1); check(dashboard.openCycles.length, 0);
  check(dashboard.responseTracker.length, 1); check(dashboard.projectPocCounts, { pa: 2 }); check(dashboard.scheduleEvents.length, 1);
  for (const path of ['/api/projects/alpha/workspace', '/api/sessions/session-a/messages', '/api/cycles/cycle-a/sessions', '/api/issues/issue-a', '/api/project-performance/pa/zoho-password']) {
    await authorizeClusterRequest(store, access, 'GET', path); checks++;
  }
  const denied = [
    ['GET', '/api/projects/beta/workspace', {}], ['GET', '/api/sessions/session-b/messages', {}], ['GET', '/api/cycles/cycle-b/sessions', {}],
    ['GET', '/api/issues/issue-b', {}], ['PUT', '/api/project-performance/pb', {}], ['DELETE', '/api/admin/services/sb', {}],
    ['PUT', '/api/admin/projects/bulk-status', { projectIds: ['pa', 'pb'] }], ['PUT', '/api/admin/pocs/bulk-control', { updates: [{ id: 'poca' }, { id: 'pocb' }] }],
    ['PUT', '/api/admin/project-teams', { rows: [{ projectId: 'pa', team: { amId: 'ib' } }] }],
    ['POST', '/api/admin/projects', { clientId: 'cb' }], ['PATCH', '/api/admin/clients/ca', { clusterId: 'b' }],
    ['POST', '/api/admin/bulk-feedback/send', { projectIds: ['pa', 'pb'] }], ['PUT', '/api/admin/project-automation/bulk', { projectIds: ['pb'] }],
    ['DELETE', '/api/admin/clients', { clientIds: ['cb'] }], ['DELETE', '/api/admin/client-pocs', { clientId: 'ca', pocIds: ['pocb'] }],
    ['POST', '/api/admin/import-workbook', {}], ['PATCH', '/api/admin/messaging', {}], ['POST', '/api/admin/service-catalog', {}],
    ['POST', '/api/admin/organization-standards/bulk', {}], ['POST', '/api/admin/unknown-future-endpoint', {}],
    ['POST', '/api/admin/app-users', { role: 'admin', internalPocId: 'ia', clusterAccess: access.clusterAccess }],
    ['POST', '/api/admin/app-users', { role: 'project_user', internalPocId: 'ia', clusterAccess: [] }],
    ['PATCH', '/api/admin/app-users/ua', { role: 'project_user', internalPocId: 'ia', externalLoginAllowed: true }]
  ];
  for (const [method, path, body] of denied) { await assert.rejects(authorizeClusterRequest(store, access, method, path, body), /outside/); checks++; }
  await authorizeClusterRequest(store, access, 'POST', '/api/admin/app-users', { role: 'project_user', internalPocId: 'ia', clusterAccess: access.clusterAccess }); checks++;
  const shared = { ...store, getProjectPerformanceData: async () => ({ projects: [{ id: 'pb', team: { amId: 'ia' } }] }) };
  await assert.rejects(authorizeClusterRequest(shared, access, 'POST', '/api/admin/app-users', { role: 'project_user', internalPocId: 'ia', clusterAccess: access.clusterAccess }), /outside/); checks++;
  await assert.rejects(authorizeClusterRequest(shared, access, 'PATCH', '/api/admin/internal-pocs/ia', { active: false }), /outside/); checks++;
  check(emailRecipients(users, 'a'), ['super@example.com', 'a@example.com']);
  check(emailRecipients(users, 'b'), ['super@example.com', 'b@example.com']);
  check(emailRecipients(users, null), ['super@example.com']);
  check(emailRecipients(users, 'a', true), ['super@example.com']);
  for (const type of SAVED_ONLY) check((await prepareCsatEmail(store, type, {})).suppressed, true);
  const handoff = await prepareCsatEmail(store, 'handoff', { project: { id: 'pa' }, session: { id: 'session-a' }, clientText: 'Please help' });
  check(handoff.payload.recipients, ['super@example.com']);
  assert.ok(handoff.payload.email.html.includes('&lt;request&gt;')); checks++;
  assert.ok(!handoff.payload.email.html.includes('PRIVATE DEBUG')); checks++;
  const summary = await prepareCsatEmail(store, 'cycle_completed', { project: { id: 'pa' }, summaryType: 'feedback_poc', csatScore: 9, npsScore: 10 });
  check(summary.payload.recipients, ['super@example.com', 'a@example.com']);
  assert.match(summary.payload.email.text, /CSAT: 9\/10\nNPS: 10\/10/); checks++;
  assert.match(emailReport('cycle_completed', { summaryType: 'quick_checkin_poc', csatScore: 9 }).text, /CSAT: Not collected/); checks++;
  assert.match(emailReport('cycle_completed', { summaryType: 'feedback_poc', csatScore: 9, sessions: [{ csatSource: 'predicted', csatScore: 9 }] }).text, /CSAT: Not provided/); checks++;
  check((await prepareCsatEmail(store, 'feedback_session_closed', { reason: 'partial_after_three_reminders' })).payload.reason, 'partial_after_three_reminders');
  check((await prepareCsatEmail({ ...store, listAppUsers: async () => users.filter(user => user.role !== 'super_admin') }, 'handoff', { project: { id: 'pa' } })).blocked, true);
  check((await prepareCsatEmail(store, 'cycle_completed', { summaryType: 'whole_cycle' })).suppressed, true);
  console.log(`${checks} cluster-access and email-policy checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

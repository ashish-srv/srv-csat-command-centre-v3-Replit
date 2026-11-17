const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { ComponentHarness, elements } = require('./workspace-navigation-smoke');

const permissionModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/permissions.js'), 'utf8'), { format: 'cjs' }).code,
  { module: permissionModule, exports: permissionModule.exports });
const permissions = permissionModule.exports;
const dashboard = { projects: [], messaging: { enabled: true } };
const admin = flags => ({ role: 'admin', email: 'admin@example.com', permissions: flags });
const page = (user, url = '/dashboard') => new ComponentHarness('src/App.jsx', { currentUser: user, onLogout: () => {} }, url,
  async () => dashboard, null, { modules: { './permissions': permissions } });
const tabs = h => elements(h.tree, node => node.type === 'button' && String(node.props.className || '').split(' ').includes('tab'));
const label = node => [node.props.children].flat().filter(value => typeof value === 'string').join('').trim();
const tabLabels = h => tabs(h).map(label);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  for (const [permission, title, url] of [
    ['dashboard', 'Dashboard', '/dashboard'], ['project_workspace', 'Project workspace', '/project'],
    ['directory', 'Directory', '/directory'], ['project_performance', 'Project Performance', '/project-performance'],
    ['manage_records', 'Manage', '/manage'], ['birthday_centre', 'Birthday Centre', '/birthdays'],
    ['broadcast_view', 'WhatsApp Broadcasts', '/broadcasts']
  ]) {
    const h = page(admin({ [permission]: true }), url);
    await h.settle();
    assert.deepEqual(tabLabels(h), [title, 'Sign out'], `Only the enabled ${title} page is rendered, without empty tab slots`);
    assert.equal(h.window.location.pathname, url);
  }
  const h = page(admin({ project_performance: true }), '/project-performance');
  await h.settle();
  h.props = { ...h.props, currentUser: admin({ project_performance: true, broadcast_view: true, broadcast_send: true }) };
  h.dirty = true; await h.settle();
  assert.deepEqual(tabLabels(h), ['Project Performance', 'WhatsApp Broadcasts', 'Sign out']);
  tabs(h).find(node => label(node) === 'WhatsApp Broadcasts').props.onClick(); await h.settle();
  assert.ok(h.find(node => node.type === 'WhatsAppBroadcasts'));
  h.props = { ...h.props, currentUser: admin({ project_performance: true }) }; h.dirty = true; await h.settle();
  assert.equal(h.window.location.pathname, '/project-performance', 'Revoking the current page opens an allowed page');
  assert.ok(!h.find(node => node.type === 'WhatsAppBroadcasts'));
  h.props = { ...h.props, currentUser: admin({}) }; h.dirty = true; await h.settle();
  assert.deepEqual(tabLabels(h), ['Sign out']);
  assert.ok(h.find(node => node.type === 'h1' && node.props.children === 'No Application Pages Assigned'));
  assert.ok(!h.find(node => node.type === 'ProjectPerformance'), 'All pages disabled must not expose Project Performance as a fallback');
  h.props = { ...h.props, currentUser: admin({ birthday_centre: true }) }; h.dirty = true; await h.settle();
  assert.deepEqual(tabLabels(h), ['Birthday Centre', 'Sign out']);
  assert.equal(h.window.location.pathname, '/birthdays');
  assert.ok(!h.calls.includes('/api/dashboard'), 'Performance, birthdays and broadcasts do not require Dashboard access');
  const failedDashboard = new ComponentHarness('src/App.jsx', { currentUser: admin({ dashboard: true, project_performance: true }) }, '/dashboard',
    async () => { throw new Error('Fixture dashboard access changed'); }, null, { modules: { './permissions': permissions } });
  await failedDashboard.settle();
  assert.ok(failedDashboard.find(node => node.type === 'strong' && node.props.children === 'Could not load data'));
  failedDashboard.props = { currentUser: admin({ project_performance: true }) }; failedDashboard.dirty = true;
  await failedDashboard.settle();
  assert.ok(failedDashboard.find(node => node.type === 'ProjectPerformance'), 'An old Dashboard error cannot block a newly allowed page');
  assert.ok(!failedDashboard.find(node => node.type === 'strong' && node.props.children === 'Could not load data'));
  const projectUser = page({ role: 'project_user', permissions: { project_performance: true, broadcast_view: true, birthday_centre: true } }, '/broadcasts');
  await projectUser.settle();
  assert.deepEqual(tabLabels(projectUser), ['Project Performance', 'Sign out']);
  const superAdmin = page({ role: 'super_admin' }); await superAdmin.settle();
  assert.equal(tabLabels(superAdmin).length, 8, 'Super Admin sees all seven pages and Sign out');

  let status = { configured: true, authenticated: true, accessAuthorized: true, passwordConfigured: true, googleConfigured: false,
    user: admin({ project_performance: true }) };
  const pending = [];
  let poll, pollMs, cleared = 0, nextFailure = false;
  const auth = new ComponentHarness('src/main.jsx', {}, '/project-performance', async () => {
    if (nextFailure) { nextFailure = false; throw new Error('Temporary fixture network failure'); }
    return pending.length ? pending.shift().promise : status;
  }, 'AuthenticatedApplication', { modules: { 'react-dom/client': { createRoot: () => ({ render: () => {} }) } }, write: async () => ({}) });
  auth.window.setInterval = (fn, ms) => { poll = fn; pollMs = ms; return 1; };
  auth.window.clearInterval = () => { cleared++; };
  await auth.settle();
  assert.equal(pollMs, 30000);
  const currentUser = auth.find(node => node.type === 'App').props.currentUser;
  await poll(); await auth.settle();
  assert.equal(auth.find(node => node.type === 'App').props.currentUser, currentUser, 'Unchanged permission refresh preserves the user object and page drafts');
  status = { ...status, user: admin({ project_performance: true, broadcast_view: true }) };
  auth.dispatch('focus'); await auth.settle();
  assert.equal(auth.find(node => node.type === 'App').props.currentUser.permissions.broadcast_view, true);
  status = { ...status, user: admin({ project_performance: true, broadcast_view: false }) };
  await poll(); await auth.settle();
  assert.equal(auth.find(node => node.type === 'App').props.currentUser.permissions.broadcast_view, false);
  auth.document.hidden = true;
  const reads = auth.calls.length;
  auth.dispatch('focus'); auth.dispatch('visibilitychange'); await poll(); await auth.settle();
  assert.equal(auth.calls.length, reads, 'Hidden pages do not poll access');
  auth.document.hidden = false; nextFailure = true;
  auth.dispatch('focus'); await auth.settle();
  assert.ok(auth.find(node => node.type === 'App'), 'A recoverable refresh error must not blank the current page');
  const older = deferred(), newer = deferred(); pending.push(older, newer);
  auth.dispatch('focus'); auth.dispatch('csat:access-changed');
  newer.resolve(status); await auth.settle();
  older.resolve({ ...status, user: admin({ broadcast_view: true }) }); await auth.settle();
  assert.equal(auth.find(node => node.type === 'App').props.currentUser.permissions.broadcast_view, false, 'A stale response cannot restore revoked access');
  const late = deferred(); pending.push(late); auth.dispatch('focus');
  await auth.find(node => node.type === 'App').props.onLogout(); await auth.settle();
  late.resolve(status); await auth.settle();
  assert.ok(!auth.find(node => node.type === 'App'), 'An access refresh cannot sign the user back in after logout');
  assert.ok(cleared > 0, 'The polling timer is removed after logout');
  console.log('Application access UI checks passed: each page grant, live grant/revoke, safe fallback, all pages disabled, role restrictions, focus/poll refresh, draft preservation, hidden-page pause, network recovery, stale responses and logout.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
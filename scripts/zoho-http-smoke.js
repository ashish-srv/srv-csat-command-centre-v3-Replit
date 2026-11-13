const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { ComponentHarness, elements } = require('./workspace-navigation-smoke');
const { ZohoError } = require('../src/lib/zoho-analytics');
const permissionModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/permissions.js'), 'utf8'), { format: 'cjs' }).code,
  { module: permissionModule, exports: permissionModule.exports });
const permissions = permissionModule.exports;

process.env.APP_LOGIN_PASSWORD = 'zoho-http-fixture';
process.env.APP_SESSION_SECRET = 'zoho-http-fixture-session-secret-at-least-32';
process.env.GOOGLE_CLIENT_ID = 'fixture.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'fixture-google-secret';
process.env.GOOGLE_ALLOWED_DOMAINS = 'srvmedia.com';
process.env.ADMIN_PIN = 'zoho-fixture-manage-pin';
const users = [
  { id: 'super', email: 'super@srvmedia.com', role: 'super_admin', active: true },
  { id: 'admin', email: 'admin@srvmedia.com', role: 'admin', active: true, clusterAccess: [{ clusterId: 'a' }] },
  { id: 'user', email: 'user@srvmedia.com', role: 'project_user', active: true, internalPocId: 'ia' }
];
const projects = [
  { id: 'pa', key: 'a', name: 'Project A', clientId: 'ca', clusterId: 'a', team: { amId: 'ia' }, services: [], kpis: [] },
  { id: 'pb', key: 'b', name: 'Project B', clientId: 'cb', clusterId: 'b', team: { amId: 'ib' }, services: [], kpis: [] }
];
const data = { projects, clients: [{ id: 'ca', clusterId: 'a' }, { id: 'cb', clusterId: 'b' }],
  clusters: [{ id: 'a' }, { id: 'b' }], internalPocs: [{ id: 'ia', clusterId: 'a' }, { id: 'ib', clusterId: 'b' }],
  projectServices: [], clientPocs: [], serviceChangeRequests: [], serviceCatalog: [], referenceValues: {}, financialYears: [] };
let operations = [], fail = false;
const store = { getAppUserByEmail: async email => users.find(user => user.email === email), listAppUsers: async () => users,
  getDirectory: async () => data, getProjectPerformanceData: async () => data,
  internalPocById: async id => data.internalPocs.find(row => row.id === id),
  updateAppUser: async (id, update) => Object.assign(users.find(row => row.id === id), update) };
const storePath = require.resolve('../src/lib/store');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { createStore: () => store } };
const zohoPath = require.resolve('../src/lib/zoho-analytics');
require.cache[zohoPath] = { id: zohoPath, filename: zohoPath, loaded: true, exports: {
  ZohoError,
  ZohoAnalytics: class {
    async checkConnection() { operations.push('check'); return { connected: true, columnCount: 26, tokenReused: true, missingColumns: [] }; }
    async push(rows) {
      operations.push(rows.map(row => row.id));
      if (fail) throw new ZohoError('Fixture failure', 502);
      return { updated: rows.length, added: 0, confirmed: rows.length, skipped: [] };
    }
  }
} };
const filename = require.resolve('../src/server/api-handler');
const harness = new Module(filename, module);
harness.filename = filename; harness.paths = Module._nodeModulePaths(path.dirname(filename));
harness._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testAuth = { createAppSessionToken, APP_SESSION_COOKIE };', filename);
const { handleApiRequest, testAuth } = harness.exports;
const cookies = Object.fromEntries(users.map(({ email }) => [email, `${testAuth.APP_SESSION_COOKIE}=${testAuth.createAppSessionToken(Date.now(), { provider: 'google', sub: email, email, hostedDomain: 'srvmedia.com' })}`]));
const http = (method, path, email, body = {}) => handleApiRequest({ method, path,
  headers: { cookie: cookies[email] || '', 'x-admin-pin': process.env.ADMIN_PIN },
  body, searchParams: new URLSearchParams(), baseUrl: 'https://fixture.invalid' });
const request = (suffix, email, body = {}) => http('POST', `/api/project-performance/zoho/${suffix}`, email, body);
const savePermissions = async (user, value) => {
  const response = await http('PATCH', `/api/admin/app-users/${user.id}`, users[0].email, { permissions: value });
  assert.equal(response.statusCode, 200, response.body);
};

async function main() {
  assert.equal(operations.length, 0);
  assert.equal((await request('push', '')).statusCode, 401);
  assert.equal(operations.length, 0);
  assert.equal((await request('connection-check', users[0].email)).statusCode, 200);
  assert.equal((await request('connection-check', users[1].email)).statusCode, 403);
  assert.equal((await request('connection-check', users[2].email)).statusCode, 403);
  for (const user of users.slice(1)) {
    assert.equal((await request('push', user.email)).statusCode, 403, 'Legacy users start without Zoho grants');
    await savePermissions(user, { zoho_push: true, zoho_connection_check: true });
    assert.equal(user.permissions.zoho_push, true);
    assert.equal(user.permissions.zoho_connection_check, true);
    assert.equal((await request('connection-check', user.email)).statusCode, 200);
  }
  assert.equal((await request('push', users[0].email, { rows: [{ name: 'forged' }], filters: { project: 'a' } })).statusCode, 200);
  assert.deepEqual(operations.at(-1), ['pa', 'pb']);
  assert.equal((await request('push', users[1].email)).statusCode, 200);
  assert.deepEqual(operations.at(-1), ['pa']);
  assert.equal((await request('push', users[2].email, { rows: projects })).statusCode, 200);
  assert.deepEqual(operations.at(-1), ['pa']);
  const beforeDenied = operations.length;
  await savePermissions(users[1], { zoho_push: false, zoho_connection_check: true });
  await savePermissions(users[2], { zoho_push: false, zoho_connection_check: true });
  assert.equal((await request('push', users[1].email)).statusCode, 403);
  assert.equal((await request('push', users[2].email)).statusCode, 403);
  assert.equal(operations.length, beforeDenied);
  for (const user of users.slice(1)) {
    assert.equal((await request('connection-check', user.email)).statusCode, 200, 'Check remains granted after push is revoked');
    await savePermissions(user, { zoho_push: true, zoho_connection_check: false, edit_project_performance: false });
    assert.equal((await request('connection-check', user.email)).statusCode, 403);
    assert.equal((await request('push', user.email)).statusCode, 200, 'Dedicated push grant does not require application-edit access');
    await savePermissions(user, { zoho_push: true, zoho_connection_check: true, project_performance: false });
    assert.equal((await request('push', user.email)).statusCode, 403, 'Project Performance page access is also required');
    assert.equal((await request('connection-check', user.email)).statusCode, 403);
  }
  fail = true;
  assert.equal((await request('push', users[0].email)).statusCode, 502);
  console.log('PASS HTTP authentication, saved per-user grants/revocations with existing cookies, independent controls and cluster/team scope');

  for (const role of ['super_admin', 'admin', 'project_user']) {
    const writes = [];
    let finish;
    const h = new ComponentHarness('src/components/ProjectPerformance.jsx', { currentUser: { role,
      permissions: { ...permissions.defaultPermissions(role), zoho_push: true, zoho_connection_check: true } } }, '/project-performance',
      async () => data, null, { modules: { '../permissions': permissions }, write: (url, body) => { writes.push({ url, body }); return new Promise(resolve => { finish = resolve; }); } });
    await h.settle();
    assert.equal(writes.length, 0, 'Rendering never generates an access token');
    const push = h.find(node => node.type === 'Button' && node.props.children === 'Push to Zoho Analytics');
    assert.ok(push);
    const check = h.find(node => node.type === 'Button' && node.props.children === 'Check Zoho Connection');
    assert.equal(Boolean(check), true);
    const clicked = push.props.onClick();
    h.flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, '/api/project-performance/zoho/push');
    assert.equal(writes[0].body, undefined);
    assert.ok(h.find(node => node.type === 'Button' && node.props.children === 'Working with Zoho…').props.disabled);
    finish({ updated: 1, added: 2, skipped: [{ project: 'Project C', reason: 'Missing Financial Year' }] });
    await clicked; await h.settle();
    const messages = JSON.stringify(elements(h.tree, node => node.props.role === 'status' || node.type === 'details'));
    assert.match(messages, /1 updated, 2 added, 1 skipped/);
    assert.match(messages, /Missing Financial Year/);
    if (check) {
      const checking = check.props.onClick();
      finish({ columnCount: 26, tokenReused: true, missingColumns: [] });
      await checking; await h.settle();
      assert.match(JSON.stringify(h.tree), /Existing access token reused/);
    }
  }
  for (const role of ['admin', 'project_user']) {
    assert.equal(permissions.defaultPermissions(role).zoho_push, false);
    assert.equal(permissions.defaultPermissions(role).zoho_connection_check, false);
    assert.ok(permissions.permissionsForRole(role).includes('zoho_push'));
    assert.ok(permissions.permissionsForRole(role).includes('zoho_connection_check'));
    for (const [pushEnabled, checkEnabled, viewEnabled] of [[false, false, true], [true, false, true], [false, true, true], [true, true, false]]) {
      const p = { ...permissions.defaultPermissions(role), edit_project_performance: false,
        zoho_push: pushEnabled, zoho_connection_check: checkEnabled, project_performance: viewEnabled };
      const h = new ComponentHarness('src/components/ProjectPerformance.jsx', { currentUser: { role, permissions: p } }, '/project-performance',
        async () => data, null, { modules: { '../permissions': permissions } });
      await h.settle();
      assert.equal(Boolean(h.find(node => node.type === 'Button' && node.props.children === 'Push to Zoho Analytics')), pushEnabled && viewEnabled);
      assert.equal(Boolean(h.find(node => node.type === 'Button' && node.props.children === 'Check Zoho Connection')), checkEnabled && viewEnabled);
      assert.equal(h.find(node => node.type === 'input' && node.props.type === 'file'), undefined);
    }
  }
  console.log('PASS independent button visibility, default-off permissions and access without application editing; no automatic requests');

  let managedUsers = users.map(user => ({ ...user, name: user.id, permissions: permissions.defaultPermissions(user.role) }));
  const written = [];
  const directory = { ...data, departments: [], subDepartments: [], pocLevels: [] };
  const manager = new ComponentHarness('src/components/Manage.jsx', { currentUser: { role: 'super_admin' }, onReload() {} }, '/manage',
    async url => url === '/api/admin/directory' ? directory : url === '/api/admin/app-users'
      ? { users: structuredClone(managedUsers) } : { values: [], projects: [], requests: [] }, null,
    { modules: { '../permissions': permissions }, write: async (url, body) => {
      written.push({ url, body });
      const id = url.split('/').pop();
      const user = { ...managedUsers.find(item => item.id === id), ...body };
      managedUsers = managedUsers.map(item => item.id === id ? user : item);
      return { user };
    } });
  await manager.settle();
  const save = () => manager.find(node => node.props.onClick && node.props.children === 'Save existing user changes');
  await save().props.onClick(); await manager.settle();
  assert.equal(written.length, 0);
  for (const enabled of [true, false]) {
    const card = manager.find(node => node.props.className === 'app-user-card' && JSON.stringify(node.props.children[0]).includes('admin@srvmedia.com'));
    const label = elements(card, node => node.type === 'label' && node.props.children?.[1]?.props?.children === 'Push to Zoho Analytics')[0];
    assert.ok(label);
    label.props.children[0].props.onChange({ target: { checked: enabled } });
    await manager.settle();
    await save().props.onClick(); await manager.settle();
    assert.equal(written.at(-1).url, '/api/admin/app-users/admin');
    assert.equal(written.at(-1).body.permissions.zoho_push, enabled);
    assert.equal(written.at(-1).body.permissions.zoho_connection_check, false);
  }
  assert.equal(written.length, 2, 'Only the changed user is saved once per toggle');
  console.log('PASS Manage Application Users renders the controls and saves only the changed user on grant/revoke');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

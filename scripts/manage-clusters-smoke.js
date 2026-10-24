const assert = require('node:assert/strict');
const { ComponentHarness, elements } = require('./workspace-navigation-smoke');
const { SupabaseStore } = require('../src/lib/supabase-store');
const { scopeDirectory, authorizeClusterRequest } = require('../src/lib/cluster-access');

async function main() {
  const clusters = [{ id: 'a', name: 'Orion' }, { id: 'b', name: 'Spectra' }];
  const people = [{ id: 'i1', name: 'Shared POC', clusterId: 'a', clusterIds: ['a', 'b'], active: true }];
  const directory = { clusters, clients: [], projects: [], internalPocs: people, clientPocs: [], projectServices: [], departments: [], subDepartments: [], pocLevels: [], serviceCatalog: [] };
  const access = { role: 'admin', clusterAccess: [{ clusterId: 'b', emailEnabled: false }] };
  assert.equal(scopeDirectory(directory, access).internalPocs.length, 1, 'Secondary membership must match the cluster filter');
  const store = { getDirectory: async () => directory, getProjectPerformanceData: async () => ({ projects: [] }) };
  // The real authorizer receives request paths, method and authenticated role.
  await assert.rejects(authorizeClusterRequest(store, access, 'PATCH', '/api/admin/internal-pocs/i1', { name: 'Changed' }), /cluster/i);

  let written;
  const persistence = new SupabaseStore({ skipEnv: true });
  persistence.request = async (_table, options) => { written = options.body; return [{ id: 'i1', ...((Array.isArray(written) ? written[0] : written) || {}) }]; };
  const added = await persistence.createInternalPoc({ name: 'New POC', clusterIds: ['a', 'b', 'a'] });
  assert.deepEqual(added.clusterIds, ['a', 'b']);
  assert.equal(added.clusterId, 'a');
  await persistence.updateInternalPoc('i1', { clusterIds: ['b'] });
  assert.deepEqual(written.cluster_ids, ['b']);
  await persistence.updateInternalPoc('i1', { active: false });
  assert.ok(!('cluster_ids' in written), 'Status-only save preserves memberships');
  await persistence.updateInternalPoc('i1', { clusterIds: [] });
  assert.deepEqual(written.cluster_ids, []);
  assert.equal(written.cluster_id, null);

  let users = Array.from({ length: 17 }, (_, i) => ({ id: `u${i}`, name: `Admin ${i}`, email: `user${i}@example.com`, role: 'admin', active: true, permissions: {}, clusterAccess: [] }));
  const writes = [];
  const manage = new ComponentHarness('src/components/Manage.jsx', { currentUser: { role: 'super_admin', appUserId: 'root' }, onReload() {} }, '/manage',
    async url => url === '/api/admin/directory' ? directory : url === '/api/admin/app-users' ? { users: structuredClone(users) } : { values: [], projects: [], requests: [] }, null,
    { modules: { '../permissions': { hasPermission: () => true, permissionsForRole: () => [], defaultPermissions: () => ({}), APP_PERMISSION_LABELS: {} } }, write: async (url, body) => {
      writes.push({ url, body });
      const id = url.split('/').pop();
      const user = { ...users.find(row => row.id === id), ...body };
      users = users.map(row => row.id === id ? user : row);
      return { user };
    } });
  await manage.settle();
  const save = () => manage.find(node => node.props.onClick && node.props.children === 'Save existing user changes');
  await save().props.onClick(); await manage.settle();
  assert.equal(writes.length, 0, 'Untouched save sends no requests');
  manage.find(node => node.props['aria-label'] === 'Name for user3@example.com').props.onChange({ target: { value: 'Changed Admin' } });
  await manage.settle();
  await save().props.onClick(); await manage.settle();
  assert.equal(writes.length, 1, 'Only one of seventeen accounts is written');
  assert.equal(writes[0].url, '/api/admin/app-users/u3');
  await save().props.onClick(); await manage.settle();
  assert.equal(writes.length, 1, 'Successful save resets only its own dirty baseline');

  let selected = [];
  const multi = new ComponentHarness('src/components/Filters.jsx', { label: 'Assigned Clusters', options: clusters.map(row => row.id), selected, onChange: value => { selected = value; multi.props = { ...multi.props, selected }; multi.dirty = true; } }, '/', async () => ({}), 'MultiSelect');
  await multi.settle();
  multi.find(node => node.props['aria-expanded'] === false).props.onClick(); await multi.settle();
  const options = () => elements(multi.tree, node => node.props.role === 'option');
  options()[0].props.onClick(); await multi.settle();
  options()[1].props.onClick(); await multi.settle();
  assert.deepEqual(Array.from(selected), ['a', 'b']);
  assert.ok(multi.find(node => node.props.className?.includes('filter-menu-portal')));
  multi.find(node => node.props.children === 'Clear').props.onClick(); await multi.settle();
  assert.equal(selected.length, 0);
  multi.find(node => node.props.children === 'OK').props.onClick(); await multi.settle();
  assert.ok(!multi.find(node => node.props.role === 'listbox'));
  console.log('PASS Manage: multi-cluster persistence, secondary-cluster visibility, shared-record authorization, changed-only saving (1 of 17), repeated save, portalled multi-select Clear/OK.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

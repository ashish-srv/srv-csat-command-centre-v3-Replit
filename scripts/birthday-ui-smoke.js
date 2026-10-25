const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { ComponentHarness, elements } = require('./workspace-navigation-smoke');
const { SupabaseStore } = require('../src/lib/supabase-store');

const permissions = { hasPermission: (user, name) => user.role === 'super_admin' || user.permissions?.[name] === true };
const directory = { clusters: [{ id: 'c1', name: 'Orion' }], internalPocs: [{ id: 'p1', name: 'Existing Owner', email: 'owner@example.com', active: true }], clientPocs: [] };
const settings = { enabled: false, deskEmails: [], notificationEmails: [], giftOptions: ['Plant', 'No Gift', 'Special Gift'], whatsappTemplate: '', whatsappLanguage: 'en' };
const event = { preventDefault() {} };
const labelInput = (h, label) => elements(h.find(n => n.type === 'label' && Array.isArray(n.props.children) && n.props.children[0] === label), n => n.type === 'input')[0];

async function main() {
  const writes = [], navigated = [];
  let fail = false;
  const h = new ComponentHarness('src/components/BirthdayCentre.jsx', { currentUser: { role: 'super_admin' } }, '/birthdays',
    async () => ({ directory, contacts: [], occasions: [], jobs: [], events: [], settings, year: 2026 }), null,
    { modules: { '../permissions': permissions, './BirthdaySection.jsx': { __esModule: true, default: 'BirthdaySection', revealBirthdaySection: id => navigated.push(id) } },
      write: async (url, body) => { writes.push({ url, body }); if (fail) throw new Error('Fixture save failed'); return { settings: body }; } });
  h.window.setInterval = () => 1; h.window.clearInterval = () => {};
  await h.settle();
  const section = () => h.find(n => n.props.id === 'birthday-settings');
  let focused = false, scrolled = false;
  const dom = { open: true, scrollIntoView: () => { scrolled = true; }, querySelector: () => ({ focus: () => { focused = true; } }) };
  section().props.sectionRef.current = dom;
  await h.find(n => n.props.className === 'birthday-settings-form').props.onSubmit(event);
  await h.settle();
  assert.equal(writes[0].url, '/api/birthdays/settings');
  assert.equal(dom.open, false, 'successful save collapses only Settings');
  assert.match(section().props.notice, /saved successfully/i);
  assert.ok(focused && scrolled, 'confirmation stays in view with keyboard focus');
  assert.equal(h.find(n => n.props.id === 'birthday-list').props.defaultOpen, true);
  h.find(n => n.props.onClick && n.props.children === 'Settings').props.onClick();
  assert.deepEqual(navigated, ['birthday-settings']);
  h.find(n => n.props.className === 'birthday-settings-form').props.onChange();
  await h.settle(); assert.equal(section().props.notice, '');
  fail = true; dom.open = true;
  await h.find(n => n.props.className === 'birthday-settings-form').props.onSubmit(event);
  await h.settle();
  assert.equal(dom.open, true, 'failed save must leave settings visible');
  assert.equal(section().props.notice, '');
  assert.match(h.find(n => n.props.role === 'alert').props.children, /save failed/);

  const pane = new ComponentHarness('src/components/BirthdaySection.jsx', { title: 'Settings', children: 'Unsaved draft', notice: 'Saved' }, '/', async () => ({}));
  await pane.settle(); assert.equal(pane.tree.type, 'details'); assert.equal(pane.tree.props.open, false);
  pane.tree.props.onToggle({ currentTarget: { open: true } }); await pane.settle();
  assert.equal(pane.tree.props.open, true);
  pane.tree.props.onToggle({ currentTarget: { open: false } }); await pane.settle();
  assert.ok(pane.find(n => n.props.children === 'Unsaved draft'), 'minimising preserves mounted form state');
  assert.equal(pane.find(n => n.props.role === 'status').props.children, 'Saved');
  // Exercise the real section-navigation helper rather than just its click
  // binding: open both direct sections and wrappers before scrolling.
  const child = { open: false }, direct = { tagName: 'DETAILS', open: false }, wrapper = { tagName: 'DIV', querySelector: () => child };
  for (const [id, target] of Object.entries({ direct, wrapper })) target.scrollIntoView = () => {
    assert.equal(id === 'direct' ? direct.open : child.open, true);
    navigated.push(id);
  };
  const helpers = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/components/BirthdaySection.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, {
    module: helpers, exports: helpers.exports, require: () => ({}),
    document: { getElementById: id => ({ direct, wrapper }[id]) }, window: { requestAnimationFrame: fn => fn() }
  });
  helpers.exports.revealBirthdaySection('direct'); helpers.exports.revealBirthdaySection('wrapper'); helpers.exports.revealBirthdaySection('missing');
  assert.deepEqual(navigated, ['birthday-settings', 'direct', 'wrapper']);

  const added = [], ownerWrites = [];
  let ownerFail = false;
  const owners = new ComponentHarness('src/components/BirthdayInternalPocs.jsx', { directory, canAdd: true, onCreated: row => added.push(row) }, '/', async () => ({}), null,
    { modules: { '../api': { apiWriteWithAdminPin: async (url, body, method, password) => {
      ownerWrites.push({ url, body, method, password }); if (ownerFail) throw new Error('Incorrect Manage password');
      return { internalPoc: { id: 'p2', ...body } };
    } } } });
  await owners.settle();
  const openOwner = async () => { owners.find(n => n.props.children === 'Add Internal POC Without App Access').props.onClick(); await owners.settle(); };
  const fill = async (email) => {
    labelInput(owners, 'Name').props.onChange({ target: { value: 'Gift Coordinator' } });
    labelInput(owners, 'Email').props.onChange({ target: { value: email } });
    labelInput(owners, 'Manage Password').props.onChange({ target: { value: 'fixture-pin' } });
    owners.find(n => n.props.label === 'Assigned Clusters').props.onChange(['c1']); await owners.settle();
  };
  await openOwner(); await fill(' OWNER@example.com ');
  await owners.find(n => n.type === 'form').props.onSubmit(event); await owners.settle();
  assert.equal(ownerWrites.length, 0, 'existing POC is not re-created');
  await fill('coordinator@gmail.com'); ownerFail = true;
  await owners.find(n => n.type === 'form').props.onSubmit(event); await owners.settle();
  assert.equal(added.length, 0); assert.ok(owners.find(n => n.type === 'form'));
  ownerFail = false;
  await owners.find(n => n.type === 'form').props.onSubmit(event); await owners.settle();
  assert.equal(added.length, 1); assert.equal(added[0].email, 'coordinator@gmail.com');
  assert.ok(!owners.find(n => n.type === 'form'));
  assert.ok(ownerWrites.every(w => w.url === '/api/admin/internal-pocs' && w.method === 'POST' && w.password === 'fixture-pin'));
  assert.ok(ownerWrites.every(w => !('role' in w.body) && !('permissions' in w.body)), 'no application access fields');
  await openOwner(); assert.equal(labelInput(owners, 'Manage Password').props.value, '', 'password cleared after saving');
  owners.props = { ...owners.props, canAdd: false }; owners.dirty = true; await owners.settle();
  assert.ok(!owners.find(n => n.type === 'form'), 'unauthorised users cannot add internal contacts');

  const tables = [];
  const persistence = new SupabaseStore({ skipEnv: true });
  persistence.request = async (table, options) => { tables.push(table); return [{ id: 'p2', ...options.body[0] }]; };
  await persistence.createInternalPoc(ownerWrites.at(-1).body);
  assert.deepEqual(tables, ['internal_pocs'], 'gift owner creation does not write app_users');
  console.log('Birthday UI: settings success/failure, collapse/draft preservation, navigation, duplicate owners, permissions and no-app-access checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

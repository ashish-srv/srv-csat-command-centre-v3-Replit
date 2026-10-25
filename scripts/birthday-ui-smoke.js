const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { ComponentHarness, elements } = require('./workspace-navigation-smoke');
const { SupabaseStore } = require('../src/lib/supabase-store');

const permissions = { hasPermission: (user, name) => user.role === 'super_admin' || user.permissions?.[name] === true };
const directory = { clusters: [{ id: 'c1', name: 'Orion' }], internalPocs: [{ id: 'p1', name: 'Existing Owner', email: 'owner@example.com', active: true }, { id: 'p3', name: 'Unassigned Owner', email: 'unassigned@example.com', active: true }], clientPocs: [] };
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
  h.find(n => n.type === 'textarea' && n.props.value === '').props.onChange({ target: { value: 'desk@example.com' } });
  const stakeholderField = h.find(n => n.type === 'label' && n.props.children[0] === 'Birthday Stakeholder Emails');
  elements(stakeholderField, n => n.type === 'textarea')[0].props.onChange({ target: { value: 'stakeholder@gmail.com; director@example.com' } });
  await h.settle();
  await h.find(n => n.props.className === 'birthday-settings-form').props.onSubmit(event);
  await h.settle();
  assert.equal(writes[0].url, '/api/birthdays/settings');
  assert.match(section().props.notice, /saved successfully/i);
  assert.deepEqual(Array.from(writes[0].body.birthdayTodayEmails), ['stakeholder@gmail.com', 'director@example.com']);
  assert.ok(h.find(n => n.props.className === 'birthday-settings-form'), 'saved settings remain available');
  assert.equal(h.scrolls.length, 0, 'saving leaves the user at their current section');
  assert.equal(h.find(n => n.props.id === 'birthday-list').props.defaultOpen, true);
  h.find(n => n.props.onClick && n.props.children === 'Settings').props.onClick();
  assert.deepEqual(navigated, ['birthday-settings']);
  h.find(n => n.props.className === 'birthday-settings-form').props.onChange();
  await h.settle(); assert.equal(section().props.notice, '');
  fail = true;
  await h.find(n => n.props.className === 'birthday-settings-form').props.onSubmit(event);
  await h.settle();
  assert.ok(h.find(n => n.props.className === 'birthday-settings-form'), 'failed save leaves the form available');
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

  // The current switch stays visible independently of a historical send result.
  for (const [channel, enabled, state] of [['email', false, 'OFF'], ['whatsapp', true, 'ON']]) {
    const status = new ComponentHarness('src/components/BirthdayCentre.jsx', { channel, contact: { emailEnabled: enabled, whatsappEnabled: enabled }, caption: 'Accepted by Sender' }, '/', async () => ({}), 'WishStatus');
    await status.settle();
    assert.ok(elements(status.tree, n => n.props.className?.includes(enabled ? 'is-on' : 'is-off')).length);
    assert.ok(elements(status.tree, n => Array.isArray(n.props.children) && n.props.children.includes(state)).length);
    assert.equal(status.find(n => n.type === 'small').props.children, 'Accepted by Sender');
  }

  const added = [], ownerWrites = [];
  let ownerFail = false;
  const owners = new ComponentHarness('src/components/BirthdayInternalPocs.jsx', { directory, contacts: [], canAdd: true, onCreated: row => added.push(row) }, '/', async () => ({}), null,
    { modules: { '../api': { apiWriteWithAdminPin: async (url, body, method, password) => {
      ownerWrites.push({ url, body, method, password }); if (ownerFail) throw new Error('Incorrect Manage password');
      return { internalPoc: { id: 'p2', ...body } };
    } } } });
  await owners.settle();
  const ownerRows = () => elements(owners.tree, n => n.props.className === 'birthday-owner-row');
  assert.equal(ownerRows().length, 0, 'unassigned directory entries stay out of the gift-recipient list');
  owners.props.contacts = [{ id: 'b1', name: 'Birthday Client', organization: 'Test Client', internalPocIds: ['p1'] }, { id: 'b2', name: 'Removed Client', organization: 'Test Client', internalPocIds: ['p3'], removedAt: '2026-10-25' }];
  owners.dirty = true; await owners.settle();
  assert.equal(ownerRows().length, 1);
  assert.ok(owners.find(n => n.props.children === 'Existing Owner'));
  assert.ok(!owners.find(n => n.props.children === 'Unassigned Owner'));
  labelInput(owners, 'Search Assigned Gift POCs').props.onChange({ target: { value: 'Birthday Client' } });
  await owners.settle(); assert.equal(ownerRows().length, 1, 'assigned contact names are searchable');
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
  console.log('Birthday UI: save confirmation, retained settings, channel state/history, assigned recipients, navigation, duplicate owners and permissions passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

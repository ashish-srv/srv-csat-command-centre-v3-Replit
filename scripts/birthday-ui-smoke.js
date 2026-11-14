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

  // A copied CSAT contact still needs an assigned birthday owner. Show why
  // Save is blocked inside the editor rather than above the birthday table.
  const contactWrites = [];
  let storedBirthdayContacts = [];
  let contactFailure = '';
  const source = { id: 'csat-1', name: 'Copied Client POC', clientName: 'Existing Client', projectName: 'Existing Project', birthDate: '', contactEmail: 'client@example.com', contactWhatsapp: '', clusterId: 'c1', designation: 'Director', salutation: 'Client Sir' };
  const sourceContacts = [source];
  const editor = new ComponentHarness('src/components/BirthdayCentre.jsx', { currentUser: { role: 'super_admin' } }, '/birthdays',
    async () => ({ directory: { ...directory, clientPocs: sourceContacts }, contacts: JSON.parse(JSON.stringify(storedBirthdayContacts)), occasions: [], jobs: [], events: [], settings, year: 2026 }), null,
    { modules: { '../permissions': permissions, './BirthdaySection.jsx': { __esModule: true, default: 'BirthdaySection', revealBirthdaySection: () => {} } }, write: async (url, body) => {
      contactWrites.push({ url, body });
      if (contactFailure) throw new Error(contactFailure);
      storedBirthdayContacts = [{ ...body.contacts[0], id: 'birthday-1', version: (storedBirthdayContacts[0]?.version || 0) + 1 }];
      return { contacts: JSON.parse(JSON.stringify(storedBirthdayContacts)) };
    } });
  editor.window.setInterval = () => 1; editor.window.clearInterval = () => {};
  await editor.settle();
  editor.find(n => n.props.children === 'Add New Birthday Contact').props.onClick(); await editor.settle();
  editor.find(n => n.props.label === 'Copy Existing CSAT Contact (Optional)').props.onChange(source.id); await editor.settle();
  labelInput(editor, 'Birthday (MM-DD or YYYY-MM-DD)').props.onChange({ target: { value: '08-02' } }); await editor.settle();
  const contactForm = () => editor.find(n => n.props.className === 'birthday-editor');
  const saveArea = () => elements(contactForm(), n => n.props.className === 'birthday-actions')[0];
  await contactForm().props.onSubmit(event); await editor.settle();
  assert.equal(contactWrites.length, 0, 'missing owner is caught before any save request');
  assert.match(elements(saveArea(), n => n.props.role === 'alert')[0].props.children, /select at least one Responsible Internal POC/i);
  assert.equal(labelInput(editor, 'Birthday (MM-DD or YYYY-MM-DD)').props.value, '08-02');
  editor.find(n => n.props.label === 'Responsible Internal POCs').props.onChange(['p1']); await editor.settle();
  assert.equal(elements(saveArea(), n => n.props.role === 'alert').length, 0);
  contactFailure = 'This birthday contact already exists. Edit the existing contact.';
  await contactForm().props.onSubmit(event); await editor.settle();
  assert.equal(elements(saveArea(), n => n.props.role === 'alert')[0].props.children, contactFailure, 'server save errors stay beside Save');
  assert.equal(labelInput(editor, 'POC Name').props.value, source.name, 'failed save preserves copied contact details');
  contactFailure = '';
  await contactForm().props.onSubmit(event); await editor.settle();
  assert.ok(!contactForm(), 'successful save closes the completed editor');
  assert.match(editor.find(n => n.props.className === 'birthday-notice').props.children, /contact saved successfully/i);
  assert.equal(contactWrites.length, 2);
  assert.ok(contactWrites.every(w => w.url === '/api/birthdays/contacts'), 'saving a birthday contact does not write CSAT records');
  const savedContact = contactWrites.at(-1).body.contacts[0];
  assert.equal(savedContact.birthday, '08-02'); assert.equal(savedContact.whatsapp, '');
  assert.deepEqual(Array.from(savedContact.linkedPocIds), [source.id]);
  assert.deepEqual(Array.from(savedContact.internalPocIds), ['p1']);
  assert.equal(savedContact.emailEnabled, false); assert.equal(savedContact.whatsappEnabled, false); assert.equal(savedContact.giftEligible, false);

  // Reopen from the real birthday table, then update and refresh. CSAT's
  // original birthDate remains empty and must not replace the birthday date.
  editor.find(n => n.props.label === 'Months').props.onChange([]); await editor.settle();
  const openBirthdayEdit = async () => { editor.find(n => n.props.children === 'Edit').props.onClick(); await editor.settle(); };
  await openBirthdayEdit();
  assert.equal(labelInput(editor, 'Birthday (MM-DD or YYYY-MM-DD)').props.value, '08-02', 'table Edit loads the saved birthday');
  labelInput(editor, 'Birthday (MM-DD or YYYY-MM-DD)').props.onChange({ target: { value: '12-09' } }); await editor.settle();
  await contactForm().props.onSubmit(event); await editor.settle();
  assert.equal(contactWrites.at(-1).body.contacts[0].id, 'birthday-1', 'editing updates the same birthday contact');
  assert.equal(contactWrites.at(-1).body.contacts[0].version, 1);
  await editor.find(n => n.props.children === 'Refresh Birthday Status').props.onClick(); await editor.settle();
  await openBirthdayEdit();
  assert.equal(labelInput(editor, 'Birthday (MM-DD or YYYY-MM-DD)').props.value, '12-09', 'edited birthday survives save, refresh and reopening');
  assert.equal(source.birthDate, '', 'birthday editing leaves CSAT data unchanged');

  // The Add form must resolve an existing linked birthday record, rather than
  // copying the empty CSAT birthDate and accidentally creating a duplicate.
  storedBirthdayContacts[0] = { ...storedBirthdayContacts[0], internalPocIds: ['p1','p3'], giftEligible: true, emailEnabled: true, whatsappEnabled: true, whatsappOptIn: true, whatsapp: '919876543210', address: 'Saved delivery address', notes: 'Saved birthday notes' };
  await editor.find(n => n.props.children === 'Refresh Birthday Status').props.onClick(); await editor.settle();
  editor.find(n => n.props.children === 'Add New Birthday Contact').props.onClick(); await editor.settle();
  editor.find(n => n.props.label === 'Copy Existing CSAT Contact (Optional)').props.onChange(source.id); await editor.settle();
  assert.equal(labelInput(editor, 'Birthday (MM-DD or YYYY-MM-DD)').props.value, '12-09');
  assert.deepEqual(Array.from(editor.find(n => n.props.label === 'Responsible Internal POCs').props.selected), ['p1','p3']);
  assert.ok(editor.find(n => n.props.title === `Edit Birthday Contact — ${source.name}`));
  assert.ok(editor.find(n => n.props.role === 'status' && /Saved birthday details loaded/.test(n.props.children)));
  await contactForm().props.onSubmit(event); await editor.settle();
  const reselected = contactWrites.at(-1).body.contacts[0];
  assert.equal(reselected.id, 'birthday-1'); assert.equal(reselected.version, 2);
  for (const key of ['emailEnabled','whatsappEnabled','whatsappOptIn','giftEligible']) assert.equal(reselected[key], true, key);
  assert.equal(reselected.address, 'Saved delivery address'); assert.equal(reselected.notes, 'Saved birthday notes');
  sourceContacts.push({ ...source, id: 'another-person', name: 'Another Person', contactEmail: 'another@example.com', birthDate: '1990-04-15T00:00:00.000Z' });
  await editor.find(n => n.props.children === 'Refresh Birthday Status').props.onClick(); await editor.settle();
  await openBirthdayEdit();
  editor.find(n => n.props.label === 'Copy Existing CSAT Contact (Optional)').props.onChange('another-person'); await editor.settle();
  assert.ok(editor.find(n => n.props.title === 'Add Birthday Contact'), 'switching to a new POC does not retain a different saved record ID');
  assert.equal(labelInput(editor, 'Birthday (MM-DD or YYYY-MM-DD)').props.value, '04-15');
  assert.equal(editor.find(n => n.props.label === 'Responsible Internal POCs').props.selected.length, 0, 'new POC does not inherit another contact\'s owners');
  const newSwitches = elements(editor.find(n => n.props.className === 'birthday-switches'), n => n.type === 'input');
  assert.deepEqual(newSwitches.map(n => n.props.checked), [true,false,false,false,false], 'new POC keeps safe default switches');

  async function copiedFixture(person, saved = []) {
    const writes = [];
    const fixture = new ComponentHarness('src/components/BirthdayCentre.jsx', { currentUser: { role: 'super_admin' } }, '/birthdays',
      async () => ({ directory: { ...directory, clientPocs: [person] }, contacts: saved, occasions: [], jobs: [], events: [], settings, year: 2026 }), null,
      { modules: { '../permissions': permissions, './BirthdaySection.jsx': { __esModule: true, default: 'BirthdaySection', revealBirthdaySection: () => {} } }, write: async (url, body) => { writes.push({ url, body }); return {}; } });
    fixture.window.setInterval = () => 1; fixture.window.clearInterval = () => {};
    await fixture.settle();
    fixture.find(n => n.props.children === 'Add New Birthday Contact').props.onClick(); await fixture.settle();
    fixture.find(n => n.props.label === 'Copy Existing CSAT Contact (Optional)').props.onChange(person.id); await fixture.settle();
    return { fixture, writes };
  }
  for (const birthDate of ['1985-08-02', '1985-08-02T00:00:00.000Z', '08-02']) {
    const { fixture } = await copiedFixture({ ...source, birthDate });
    assert.equal(labelInput(fixture, 'Birthday (MM-DD or YYYY-MM-DD)').props.value, '08-02', birthDate);
  }
  const unlinked = { ...storedBirthdayContacts[0], linkedPocIds: [], whatsapp: '' };
  const matched = await copiedFixture(source, [unlinked]);
  assert.equal(labelInput(matched.fixture, 'Birthday (MM-DD or YYYY-MM-DD)').props.value, '12-09', 'unique name, organisation and email can find an unlinked imported birthday');
  assert.deepEqual(Array.from(matched.fixture.find(n => n.props.label === 'Linked CSAT Contacts (Optional)').props.selected), [source.id]);
  const unrelated = await copiedFixture({ ...source, id: 'csat-other', name: 'Someone Else' }, [unlinked]);
  assert.equal(labelInput(unrelated.fixture, 'Birthday (MM-DD or YYYY-MM-DD)').props.value, '', 'shared email alone cannot load a different person');
  assert.ok(!unrelated.fixture.find(n => n.props.title === `Edit Birthday Contact — ${source.name}`));
  for (const rows of [[{ ...storedBirthdayContacts[0], removedAt: '2026-10-01' }], [storedBirthdayContacts[0], { ...storedBirthdayContacts[0], id: 'duplicate-link' }]]) {
    const { fixture, writes } = await copiedFixture(source, rows);
    assert.match(fixture.find(n => n.props.role === 'alert').props.children, /removed|Multiple birthday records/);
    assert.equal(writes.length, 0, 'removed or ambiguous records are never restored or changed automatically');
  }

  // All-month controls must remove today's day restriction. The full reset
  // also clears other filters and search, while All Months retains them.
  const localParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', month: '2-digit' }).formatToParts(new Date());
  const nowMonth = localParts.find(p => p.type === 'month').value;
  const otherMonths = ['01','06','12'].filter(month => month !== nowMonth).slice(0, 2);
  const birthdayRows = [nowMonth, ...otherMonths].map((month, index) => ({ ...storedBirthdayContacts[0], id: `view-${index}`, name: `Birthday ${index}`, organization: `Client ${index}`, birthday: `${month}-01`, active: index !== 2 }));
  const view = new ComponentHarness('src/components/BirthdayCentre.jsx', { currentUser: { role: 'super_admin' } }, '/birthdays',
    async () => ({ directory, contacts: birthdayRows, occasions: [], jobs: [], events: [], settings, year: 2026 }), null, { modules: { '../permissions': permissions, './BirthdaySection.jsx': { __esModule: true, default: 'BirthdaySection', revealBirthdaySection: () => {} } } });
  view.window.setInterval = () => 1; view.window.clearInterval = () => {}; await view.settle();
  const visible = () => birthdayRows.filter(row => view.find(n => n.type === 'b' && n.props.children === row.name)).map(row => row.id);
  assert.deepEqual(visible(), ['view-0']);
  view.find(n => n.props.children === 'All Months').props.onClick(); await view.settle();
  assert.equal(visible().length, 3);
  assert.equal(view.find(n => n.props.label === 'Months').props.allLabel, 'All Months');
  view.find(n => n.props.children === 'Today’s Birthdays').props.onClick(); await view.settle();
  view.find(n => n.props.children === 'All Months').props.onClick(); await view.settle();
  assert.equal(visible().length, 3); assert.ok(!view.find(n => n.props.children === 'Clear Today Filter'));
  view.find(n => n.props.children === 'This Month').props.onClick(); await view.settle(); assert.deepEqual(visible(), ['view-0']);
  view.find(n => n.props.label === 'Organisations').props.onChange(['Client 1']); await view.settle();
  view.find(n => n.props.children === 'All Months').props.onClick(); await view.settle(); assert.deepEqual(visible(), ['view-1']);
  view.find(n => n.props.children === 'Show All Birthday Contacts').props.onClick(); await view.settle(); assert.equal(visible().length, 3);
  view.find(n => n.props.children === 'Today’s Birthdays').props.onClick(); await view.settle();
  view.find(n => n.props.label === 'Months').props.onChange(otherMonths); await view.settle();
  assert.equal(visible().length, 2); assert.ok(!view.find(n => n.props.children === 'Clear Today Filter'));
  view.find(n => n.props.children === 'Open').props.onClick(); await view.settle();
  const contactDetails = view.find(n => n.props.className === 'birthday-contact-details');
  assert.ok(contactDetails, 'Open shows complete contact details alongside gift history');
  assert.equal(elements(contactDetails, n => n.type === 'dt').length, 12);
  assert.ok(elements(contactDetails, n => n.type === 'dd' && n.props.children === 'Saved delivery address').length);
  assert.ok(elements(contactDetails, n => n.type === 'dd' && n.props.children === 'Saved birthday notes').length);

  const monthChanges = [];
  const picker = new ComponentHarness('src/components/Filters.jsx', { label: 'Months', options: ['01','02','03'], selected: ['01'], selectAllLabel: 'Select All Months', onChange: values => { monthChanges.push(Array.from(values)); picker.props = { ...picker.props, selected: values }; picker.dirty = true; } }, '/', async () => ({}), 'MultiSelect');
  await picker.settle(); picker.find(n => n.props.className?.startsWith('filter-trigger')).props.onClick(); await picker.settle();
  picker.find(n => n.props.children === 'Select All Months').props.onClick(); await picker.settle();
  assert.deepEqual(monthChanges.at(-1), ['01','02','03']);
  picker.find(n => n.props.children === 'Clear').props.onClick(); await picker.settle(); assert.deepEqual(monthChanges.at(-1), []);
  picker.find(n => n.props.children === 'OK').props.onClick(); await picker.settle(); assert.ok(!picker.find(n => n.props.role === 'listbox'));

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
  console.log('Birthday UI: inline contact validation, retained drafts, save confirmation, retained settings, channel state/history, assigned recipients, navigation, duplicate owners and permissions passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

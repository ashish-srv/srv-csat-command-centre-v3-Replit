import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut, apiWriteWithAdminPin } from '../api';
import { hasPermission } from '../permissions';
import { MultiSelect, SingleSelect, FilterBar } from './Filters.jsx';
import { Button, Panel, MetricCard, LoadingBlock } from './Ui.jsx';
import { downloadBirthdayWorkbook, parseBirthdayWorkbook } from '../lib/birthday-workbook.mjs';
import './BirthdayCentre.css';
import BirthdayReplyInbox from './BirthdayReplyInbox.jsx';

const stages = ['Awaiting Decision', 'Gift Selected', 'Arranged', 'Delivered'];
const months = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1).padStart(2, '0'), label: new Date(2000, i, 1).toLocaleDateString('en-IN', { month: 'long' }) }));
const stamp = value => value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—';
function birthdayLabel(birthday, year) {
  const date = new Date(`${year}-${birthday}T12:00:00Z`);
  if (birthday === '02-29' && date.getUTCMonth() !== 1) date.setUTCDate(0);
  return date.toLocaleDateString('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
}
const emptyContact = () => ({ name: '', organization: '', designation: '', salutation: '', birthday: '', email: '', whatsapp: '', clusterId: null, internalPocIds: [], linkedPocIds: [], giftEligible: false, active: true, emailEnabled: false, whatsappEnabled: false, whatsappOptIn: false, address: '', notes: '' });
const statusLabel = status => ({ accepted: 'Accepted by Sender', processing: 'Sending — Awaiting Confirmation', unknown: 'Result Unknown — Check Sender', failed: 'Failed', pending: 'Queued', skipped: 'Skipped', cancelled: 'Cancelled', history_cleared: 'History Cleared' }[status] || status);
function Progress({ occasion }) {
  if (occasion.historyCleared) return <span className="birthday-muted">History Cleared</span>;
  if (occasion.gift === 'No Gift') return <strong>No Gift Selected</strong>;
  return <ol className="birthday-progress" aria-label="Gift progress">{stages.map((stage, index) => <li key={stage} className={index <= stages.indexOf(occasion.stage) ? 'reached' : ''} aria-current={stage === occasion.stage ? 'step' : undefined}>{stage}</li>)}</ol>;
}

export default function BirthdayCentre({ currentUser }) {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const currentYear = Number(local.find(p => p.type === 'year').value), currentMonth = local.find(p => p.type === 'month').value;
  const [year, setYear] = useState(currentYear), [data, setData] = useState(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState({ months: [currentMonth], clusters: [], organizations: [], owners: [], eligibility: [], stages: [], wishes: [], contactStates: ['active','inactive'], day: '' });
  const [search, setSearch] = useState(''), [selected, setSelected] = useState([]), [opened, setOpened] = useState('');
  const [draft, setDraft] = useState(null), [sourceId, setSourceId] = useState(''), [preview, setPreview] = useState(null);
  const [settings, setSettings] = useState(null), [gift, setGift] = useState(''), [specialGift, setSpecialGift] = useState(''), [reason, setReason] = useState('');
  const [cleanup, setCleanup] = useState(null), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const editorRef = useRef(null), detailsRef = useRef(null), fileRef = useRef(null), requestRef = useRef(0), historyRequestRef = useRef(0);
  const canManage = hasPermission(currentUser, 'birthday_manage'), canRemind = hasPermission(currentUser, 'birthday_reminders');
  const canCleanup = hasPermission(currentUser, 'birthday_cleanup'), isSuper = currentUser.role === 'super_admin';
  async function load() {
    setLoading(true);
    const request = ++requestRef.current;
    try {
      const next = await apiGet(`/api/birthdays?year=${year}`);
      if (request !== requestRef.current) return;
      setData(next); setSettings(old => old || { ...next.settings, deskEmailsText: (next.settings.deskEmails || []).join('\n'), notificationEmailsText: (next.settings.notificationEmails || []).join('\n'), giftOptionsText: (next.settings.giftOptions || []).join('\n') });
      if (opened) loadHistory(opened);
    } catch (e) { if (request === requestRef.current) setError(e.message); }
    finally { if (request === requestRef.current) setLoading(false); }
  }
  useEffect(() => { setLoading(true); setError(''); load(); return () => { requestRef.current++; historyRequestRef.current++; }; }, [year]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden && !busy) load(); };
    const interval = window.setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', refresh); };
  }, [year, busy]);
  function reveal(ref) { window.requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }
  async function loadHistory(contactId) {
    setHistoryLoading(true);
    const request = ++historyRequestRef.current;
    try {
      const history = await apiGet(`/api/birthdays/contacts/${contactId}/history?year=${year}`);
      if (request !== historyRequestRef.current) return;
      setData(current => current?.year !== year ? current : { ...current, events: [...current.events.filter(e => e.contact_id !== contactId), ...history.events], jobs: [...current.jobs.filter(j => j.contact_id !== contactId), ...history.jobs] });
    } catch (e) { if (request === historyRequestRef.current) setError(e.message); }
    finally { if (request === historyRequestRef.current) setHistoryLoading(false); }
  }
  async function execute(fn, message = 'Birthday data saved.') {
    setBusy(true); setError(''); setNotice('');
    try { const result = await fn(); setNotice(result?.message || message); await load(); return true; }
    catch (e) { setError(e.message); return false; }
    finally { setBusy(false); }
  }
  const directory = data?.directory || { clusters: [], internalPocs: [], clientPocs: [] };
  const contacts = data?.contacts || [], occasions = data?.occasions || [], jobs = data?.jobs || [];
  const occasionFor = contact => occasions.find(o => o.contactId === contact.id) || { contactId: contact.id, year, stage: 'Awaiting Decision', gift: '', giftEligible: contact.giftEligible, changeRequests: [] };
  const wishFor = (contact, channel) => jobs.find(j => j.contact_id === contact.id && j.kind === 'wish' && j.channel === channel);
  const wishLabel = (contact, channel) => { const job = wishFor(contact, channel); return job ? `${statusLabel(job.status)}${job.result?.reason ? ` — ${job.result.reason}` : ''}` : contact[channel === 'email' ? 'emailEnabled' : 'whatsappEnabled'] ? 'Enabled — Not Sent' : 'Off'; };
  const filtered = contacts.filter(contact => {
    const o = occasionFor(contact);
    return (!filters.months.length || filters.months.includes(contact.birthday.slice(0, 2)))
      && (!filters.day || contact.birthday === filters.day)
      && (!filters.contactStates.length || filters.contactStates.includes(contact.removedAt ? 'removed' : contact.active ? 'active' : 'inactive'))
      && (!filters.clusters.length || filters.clusters.includes(contact.clusterId || 'unassigned'))
      && (!filters.organizations.length || filters.organizations.includes(contact.organization))
      && (!filters.owners.length || contact.internalPocIds.some(id => filters.owners.includes(id)))
      && (!filters.eligibility.length || filters.eligibility.includes(o.giftEligible ? 'Yes' : 'No'))
      && (!filters.stages.length || filters.stages.includes(o.stage) || (filters.stages.includes('Escalated') && o.escalated && !o.gift))
      && (!filters.wishes.length || ['email','whatsapp'].some(channel => { const job = wishFor(contact, channel); return filters.wishes.includes(job?.status || (contact[channel === 'email' ? 'emailEnabled' : 'whatsappEnabled'] ? 'not_sent' : 'off')); }))
      && `${contact.name} ${contact.organization} ${contact.email} ${contact.whatsapp} ${o.gift || ''}`.toLowerCase().includes(search.toLowerCase().trim());
  }).sort((a, b) => a.birthday.localeCompare(b.birthday) || a.organization.localeCompare(b.organization) || a.name.localeCompare(b.name));
  const selectedVisible = filtered.filter(c => selected.includes(c.id)), selectedIds = selectedVisible.map(c => c.id);
  const openContact = contacts.find(c => c.id === opened), openOccasion = openContact ? occasionFor(openContact) : null;
  function updateFilter(key, values) { setFilters(old => ({ ...old, [key]: values })); }
  function edit(contact = emptyContact()) { setDraft({ ...contact }); setSourceId(''); reveal(editorRef); }
  async function saveDraft(e) {
    e.preventDefault(); if (await execute(() => apiPost('/api/birthdays/contacts', { contacts: [draft] }))) setDraft(null);
  }
  async function importFile(event) {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    setBusy(true); setError('');
    try {
      if (file.size > 10000000) throw new Error('Choose an .xlsx file smaller than 10 MB.');
      const parsed = await parseBirthdayWorkbook(await file.arrayBuffer(), data);
      if (!parsed.errors.length) {
        try { await apiPost('/api/birthdays/contacts', { contacts: parsed.contacts, preview: true }); }
        catch (e) { parsed.errors.push(e.message); }
      }
      setPreview(parsed);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  function bulk(field, enabled) {
    execute(() => apiPut('/api/birthdays/bulk-channels', { contactIds: selectedIds, field, enabled }), `${selectedIds.length} selected contacts updated.`);
  }
  async function reminder(ids, kind) {
    await execute(() => apiPost('/api/birthdays/reminders', { year, contactIds: ids, kind, requestId: crypto.randomUUID() }));
  }
  async function act(action, extras = {}) {
    await execute(() => apiPost(`/api/birthdays/contacts/${opened}/action`, { year, action, gift, specialGift, reason, ...extras }));
  }
  function copySource(id) {
    setSourceId(id); const p = directory.clientPocs.find(c => c.id === id); if (!p) return;
    setDraft(old => ({ ...old, name: p.name, organization: p.clientName || '', designation: p.designation || '', birthday: p.birthDate?.slice(-5) || '', email: p.contactEmail || '', whatsapp: p.contactWhatsapp || '', salutation: p.salutation || '', clusterId: p.clusterId, linkedPocIds: [id] }));
  }
  async function confirmCleanup(e) {
    e.preventDefault();
    const success = await execute(() => apiWriteWithAdminPin(cleanup.removeContact ? `/api/birthdays/contacts/${cleanup.contactIds[0]}` : '/api/birthdays/history', { ...cleanup, year: cleanup.year, confirmation }, 'DELETE', password));
    if (success) { if (cleanup.removeContact) { setOpened(''); setDraft(null); } setCleanup(null); setPassword(''); setConfirmation(''); setSelected([]); }
  }
  function askCleanup(value) { setPassword(''); setConfirmation(''); setCleanup(value); }
  if (loading && !data) return <LoadingBlock label="Loading Birthday Centre" />;
  return <div className="birthday-centre">
    <header className="birthday-heading"><div><p className="eyebrow">Client Relationships</p><h1>Birthday Centre</h1><p>Wishes, shared gift decisions and yearly delivery records.</p></div><strong className={`birthday-badge ${data?.settings?.enabled ? 'good' : ''}`}>Scheduled Automation {data?.settings?.enabled ? 'ON' : 'OFF'}</strong></header>
    <Button disabled={busy || loading} onClick={() => { setError(''); load(); }}>{loading ? 'Refreshing…' : 'Refresh Birthday Status'}</Button>
    {error ? <div className="error-block" role="alert">{error}<Button onClick={() => { setError(''); load(); }}>Reload</Button></div> : null}
    {notice ? <p className="birthday-notice" role="status">{notice}</p> : null}
    {!data ? null : <>
      <nav className="birthday-nav" aria-label="Birthday sections">{[['birthday-list','Birthday Table'], ...(canManage ? [['birthday-import','Excel Upload'],['birthday-editor','Add / Edit Contact']] : []), ['birthday-replies','Birthday Replies'], ['birthday-details','Gift & History'], ...(isSuper ? [['birthday-settings','Settings']] : []), ...(canCleanup ? [['birthday-cleanup','History Cleanup']] : [])].map(([id, label]) => <button key={id} type="button" onClick={() => { if (id === 'birthday-editor' && !draft) edit(); else document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{label}</button>)}</nav>
      <div className="birthday-metrics">
        <MetricCard label="Matching Birthdays" value={filtered.length} caption={`${year} · Current filters`} />
        <MetricCard label="Gift Decisions Pending" value={filtered.filter(c => occasionFor(c).giftEligible && !occasionFor(c).gift && !occasionFor(c).historyCleared).length} caption="Includes escalated decisions" />
        <MetricCard label="Delivery Pending" value={filtered.filter(c => { const o = occasionFor(c); return o.gift && o.gift !== 'No Gift' && o.stage !== 'Delivered'; }).length} caption="Gift selected; not delivered" />
        <MetricCard label="WhatsApp Skipped for Feedback" value={filtered.filter(c => wishFor(c, 'whatsapp')?.result?.reason === 'Active Feedback Cycle').length} caption="Recorded skip; no automatic late wish" />
      </div>
      <Panel id="birthday-list" title="Birthdays & Gift Progress" className="birthday-section">
        <FilterBar showReset={true} onReset={() => { setFilters({ months: [], clusters: [], organizations: [], owners: [], eligibility: [], stages: [], wishes: [], contactStates: ['active','inactive'], day: '' }); setSearch(''); }}>
          <SingleSelect label="Birthday Year" value={String(year)} options={Array.from({ length: 8 }, (_, i) => ({ value: String(currentYear - 6 + i), label: String(currentYear - 6 + i) }))} allowClear={false} onChange={value => { setYear(Number(value)); setPreview(null); }} />
          <MultiSelect label="Months" selected={filters.months} options={months.map(m => m.value)} renderOption={value => months.find(m => m.value === value)?.label} onChange={v => updateFilter('months', v)} />
          <MultiSelect label="Clusters" selected={filters.clusters} options={[...directory.clusters.map(c => c.id), 'unassigned']} renderOption={id => directory.clusters.find(c => c.id === id)?.name || 'Unassigned'} onChange={v => updateFilter('clusters', v)} />
          <MultiSelect label="Organisations" selected={filters.organizations} options={[...new Set(contacts.map(c => c.organization))].sort()} onChange={v => updateFilter('organizations', v)} />
          <MultiSelect label="Responsible POCs" selected={filters.owners} options={directory.internalPocs.map(p => p.id)} renderOption={id => directory.internalPocs.find(p => p.id === id)?.name || id} onChange={v => updateFilter('owners', v)} />
          <MultiSelect label="Gift Eligible" selected={filters.eligibility} options={['Yes','No']} onChange={v => updateFilter('eligibility', v)} />
          <MultiSelect label="Gift Stage" selected={filters.stages} options={[...stages, 'Escalated','History Cleared']} onChange={v => updateFilter('stages', v)} />
          <MultiSelect label="Wish Status" selected={filters.wishes} options={['off','not_sent','pending','processing','accepted','skipped','failed','unknown','cancelled','history_cleared']} renderOption={v => ({ off: 'Off', not_sent: 'Enabled — Not Sent' }[v] || statusLabel(v))} onChange={v => updateFilter('wishes', v)} />
          <MultiSelect label="Contact State" selected={filters.contactStates} options={['active','inactive','removed']} renderOption={v => ({ active: 'Active', inactive: 'Inactive', removed: 'Removed From Birthday Flows' }[v])} onChange={v => updateFilter('contactStates', v)} />
        </FilterBar>
        <label className="birthday-search">Search Contacts, Organisations or Gifts<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search names, organisations, email, number or gift" /></label>
        <div className="birthday-actions"><Button disabled={busy} onClick={() => execute(() => downloadBirthdayWorkbook(directory, filtered), 'Filtered birthday contacts downloaded.')}>Download Filtered Excel</Button><span>{filters.day ? <Button onClick={() => updateFilter('day', '')}>Clear Today Filter</Button> : <Button onClick={() => setFilters(old => ({ ...old, months: [], day: `${currentMonth}-${local.find(p => p.type === 'day').value}` }))}>Today’s Birthdays</Button>}{selectedIds.length} selected within {filtered.length} matching birthdays</span></div>
        <div className="birthday-table-scroll" tabIndex={0} role="region" aria-label="Birthday contacts table"><table className="birthday-table"><thead><tr><th><input type="checkbox" aria-label="Select all matching birthdays" checked={!!filtered.length && filtered.every(c => selected.includes(c.id))} onChange={e => setSelected(e.target.checked ? filtered.map(c => c.id) : [])} /></th>{['Birthday / Contact','Organisation / Cluster','Responsible POCs','Gift / Progress','Email Wish','WhatsApp Wish','Actions'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>
          {filtered.map(c => { const o = occasionFor(c); return <tr key={c.id} className={opened === c.id ? 'opened' : ''}><td><input type="checkbox" aria-label={`Select ${c.name}`} checked={selected.includes(c.id)} onChange={e => setSelected(old => e.target.checked ? [...old, c.id] : old.filter(id => id !== c.id))} /></td><td><strong>{birthdayLabel(c.birthday, year)}</strong><b>{c.name}</b><small>{c.designation || 'Designation not set'} · {c.removedAt ? 'Removed' : c.active ? 'Active' : 'Inactive'}</small></td><td><b>{c.organization}</b><span>{directory.clusters.find(cluster => cluster.id === c.clusterId)?.name || 'Unassigned'}</span></td><td>{c.internalPocIds.map(id => <span key={id}>{directory.internalPocs.find(p => p.id === id)?.name || 'Unavailable POC'}</span>)}</td><td><strong className="birthday-gift">{o.historyCleared ? 'Gift History Cleared' : o.gift || (o.giftEligible ? 'Gift Not Selected' : 'Not Gift Eligible')}</strong>{o.historyCleared || o.giftEligible || o.gift ? <Progress occasion={o} /> : null}{o.escalated && !o.gift ? <span className="birthday-badge attention">Escalated</span> : null}{o.changeRequests?.some(r => r.status === 'pending') ? <span className="birthday-badge attention">Change Requested</span> : null}{o.deliveryReason ? <span className="birthday-reason">Not Delivered: {o.deliveryReason}</span> : null}</td><td>{wishLabel(c, 'email')}</td><td>{wishLabel(c, 'whatsapp')}</td><td><Button onClick={() => { setOpened(c.id); loadHistory(c.id); setGift(''); setSpecialGift(''); setReason(''); reveal(detailsRef); }}>Open</Button>{canManage ? c.removedAt ? <Button disabled={busy} onClick={() => execute(() => apiPost(`/api/birthdays/contacts/${c.id}/restore`))}>Restore</Button> : <Button onClick={() => edit(c)}>Edit</Button> : null}</td></tr>; })}
          {!filtered.length ? <tr><td colSpan={8}>No birthdays match these filters. Clear filters or add contacts.</td></tr> : null}
        </tbody></table></div>
        {canManage ? <div className="birthday-bulk"><strong>Selected Contacts Only</strong>{[['Email Wishes ON','emailEnabled',true],['Email Wishes OFF','emailEnabled',false],['WhatsApp Wishes ON','whatsappEnabled',true],['WhatsApp Wishes OFF','whatsappEnabled',false]].map(([label, field, enabled]) => <Button key={label} disabled={busy || !selectedIds.length} onClick={() => bulk(field, enabled)}>{label}</Button>)}<p>WhatsApp activation requires a valid number and recorded messaging permission for every selected contact. Active feedback always blocks a birthday WhatsApp send.</p></div> : null}
        {canRemind ? <div className="birthday-actions"><Button disabled={busy || !selectedIds.length} onClick={() => reminder(selectedIds, 'decision')}>Remind Selected Internal POCs</Button><Button disabled={busy || !selectedIds.length} onClick={() => reminder(selectedIds, 'delivery')}>Ask Desk About Selected Deliveries</Button></div> : null}
      </Panel>
      {canManage ? <Panel id="birthday-import" title="Bulk Birthday Excel Upload" className="birthday-section"><p>Fill one input sheet. Separate multiple responsible Internal POC emails with <strong>|</strong>. New contacts start with both wish channels OFF.</p><div className="birthday-actions"><Button disabled={busy} onClick={() => execute(() => downloadBirthdayWorkbook(directory), 'Birthday Excel template downloaded.')}>Download Excel Template</Button><Button disabled={busy} onClick={() => fileRef.current?.click()}>Choose Excel Upload</Button><input ref={fileRef} type="file" accept=".xlsx" hidden onChange={importFile} /></div>
        {preview ? <div className="birthday-preview"><h4>Import Preview · {preview.contacts.length} Contacts</h4>{preview.errors.length ? <div className="birthday-bounded" role="alert">{preview.errors.map((e, i) => <p key={i}>{e}</p>)}</div> : <p>Validation passed. No data has been saved yet.</p>}<div className="birthday-bounded">{preview.contacts.map((c, i) => <p key={i}><strong>{c.name}</strong> · {c.organization} · {c.birthday} · {c.internalPocIds.length} responsible POCs · {c.id ? 'Update existing' : 'New contact; wishes OFF'}</p>)}</div><Button variant="primary" disabled={busy || !!preview.errors.length} onClick={async () => { if (await execute(() => apiPost('/api/birthdays/contacts', { contacts: preview.contacts }), `${preview.contacts.length} birthday contacts saved.`)) setPreview(null); }}>Confirm Import</Button><Button disabled={busy} onClick={() => setPreview(null)}>Cancel Preview</Button></div> : null}
      </Panel> : null}
      {canManage ? <div id="birthday-editor" ref={editorRef} className="birthday-section"><Panel title={draft?.id ? `Edit Birthday Contact — ${draft.name}` : 'Add Birthday Contact'}><Button disabled={busy} onClick={() => edit()}>Add New Birthday Contact</Button>{draft ? <form onSubmit={saveDraft} className="birthday-editor"><SingleSelect label="Copy Existing CSAT Contact (Optional)" value={sourceId} options={directory.clientPocs.map(p => ({ value: p.id, label: `${p.name} · ${p.clientName} · ${p.projectName}` }))} onChange={copySource} />
        <div className="birthday-form-grid">{[['name','POC Name'],['organization','Organisation / Client'],['designation','Designation'],['salutation','Salutation'],['birthday','Birthday (MM-DD or YYYY-MM-DD)'],['email','Email'],['whatsapp','WhatsApp Number With Country Code']].map(([key, label]) => <label key={key}>{label}<input required={['name','organization','birthday'].includes(key)} value={draft[key]} onChange={e => setDraft(old => ({ ...old, [key]: e.target.value }))} /></label>)}
          <SingleSelect label="Cluster" value={draft.clusterId || ''} placeholder="Unassigned" options={directory.clusters.map(c => ({ value: c.id, label: c.name }))} onChange={value => setDraft(old => ({ ...old, clusterId: value || null }))} />
          <MultiSelect label="Responsible Internal POCs" options={directory.internalPocs.filter(p => p.active !== false).map(p => p.id)} selected={draft.internalPocIds} allLabel="Select Internal POCs" renderOption={id => { const p = directory.internalPocs.find(p => p.id === id); return `${p?.name} · ${p?.email || 'Email missing'}`; }} onChange={ids => setDraft(old => ({ ...old, internalPocIds: ids }))} />
          <MultiSelect label="Linked CSAT Contacts (Optional)" options={directory.clientPocs.map(p => p.id)} selected={draft.linkedPocIds} allLabel="No CSAT project required" renderOption={id => { const p = directory.clientPocs.find(p => p.id === id); return `${p?.name} · ${p?.projectName}`; }} onChange={ids => setDraft(old => ({ ...old, linkedPocIds: ids }))} />
          <label>Delivery Address<textarea value={draft.address} onChange={e => setDraft(old => ({ ...old, address: e.target.value }))} /></label><label>Notes<textarea value={draft.notes} onChange={e => setDraft(old => ({ ...old, notes: e.target.value }))} /></label>
        </div><div className="birthday-switches">{[['active','Contact Active'],['giftEligible','Gift Eligible by Default'],['emailEnabled','Email Birthday Wishes'],['whatsappOptIn','WhatsApp Messaging Permission Recorded'],['whatsappEnabled','WhatsApp Birthday Wishes']].map(([key, label]) => <label key={key}><input type="checkbox" checked={draft[key]} onChange={e => setDraft(old => ({ ...old, [key]: e.target.checked }))} />{label}</label>)}</div><div className="birthday-actions"><button className="button primary" type="submit" disabled={busy}>Save Birthday Contact</button><Button disabled={busy} onClick={() => setDraft(null)}>Cancel</Button></div></form> : <p>Add someone independently, or copy their contact details from CSAT.</p>}</Panel></div> : null}
      <BirthdayReplyInbox key={year} year={year} canManage={canManage} refreshToken={data} />
      <div id="birthday-details" ref={detailsRef} className="birthday-section"><Panel title={openContact ? `${openContact.name} · ${openContact.organization} · ${year}` : 'Gift Decisions & Birthday History'}>{!openContact ? <p>Open a birthday from the table to view its gift, approvals and history.</p> : <>
        <Progress occasion={openOccasion} /><p><strong>Selected Gift:</strong> {openOccasion.gift || 'Awaiting decision'} · <strong>Selected By:</strong> {openOccasion.selectedBy || '—'}</p><p><strong>Selection Time:</strong> {stamp(openOccasion.selectedAt)} · <strong>Gift Eligible for {year}:</strong> {openOccasion.giftEligible ? 'Yes' : 'No'}</p>
        {historyLoading ? <p role="status">Loading birthday history…</p> : null}
        {openOccasion.deliveryReason ? <p className="birthday-reason">Not Delivered: {openOccasion.deliveryReason} · {openOccasion.deliveryCheckedBy} · {stamp(openOccasion.deliveryCheckedAt)}</p> : null}
        {canManage && !openOccasion.historyCleared && !openContact.removedAt ? <div className="birthday-gift-editor"><div className="birthday-form-grid"><SingleSelect label="Gift" value={gift} options={(data.settings.giftOptions || []).map(g => ({ value: g, label: g }))} onChange={setGift} /><label>Special Gift Details<input value={specialGift} onChange={e => setSpecialGift(e.target.value)} /></label><label>Change / Non-Delivery Reason<textarea value={reason} onChange={e => setReason(e.target.value)} /></label></div><div className="birthday-actions"><Button disabled={busy || !gift || !openOccasion.giftEligible} onClick={() => { if (openOccasion.gift && !window.confirm('Changing the gift resets arrangement and delivery progress. Continue?')) return; act(openOccasion.gift ? 'change_gift' : 'select'); }}>{openOccasion.gift ? 'Change Gift (Authorised User)' : 'Confirm Gift Selection'}</Button><Button disabled={busy || !openOccasion.gift || openOccasion.gift === 'No Gift' || openOccasion.stage === 'Delivered'} onClick={() => act('arranged')}>Mark Arranged</Button><Button disabled={busy || !openOccasion.gift || openOccasion.gift === 'No Gift' || openOccasion.stage === 'Delivered'} onClick={() => act('delivered')}>Mark Delivered</Button><Button disabled={busy || !reason || !openOccasion.gift || openOccasion.gift === 'No Gift'} onClick={() => act('delivery_no')}>Record Not Delivered</Button><Button disabled={busy} onClick={() => act('eligibility', { eligible: !openOccasion.giftEligible })}>{openOccasion.giftEligible ? 'Disable' : 'Enable'} Gift Eligibility for {year}</Button></div></div> : null}
        {(openOccasion.changeRequests || []).map(r => <div key={r.id} className="birthday-request"><strong>{r.status.toUpperCase()} · {r.gift}</strong><p>{r.reason}</p><small>Requested by {r.actor} · {stamp(r.at)}</small>{canManage && r.status === 'pending' ? <div className="birthday-actions"><Button disabled={busy} onClick={() => { if (window.confirm('Approve this gift change? Arrangement and delivery progress will restart for the revised gift.')) act('approve', { requestId: r.id }); }}>Approve Change</Button><Button disabled={busy} onClick={() => act('reject', { requestId: r.id })}>Reject Change</Button></div> : null}</div>)}
        {canRemind && !openContact.removedAt ? <div className="birthday-actions"><Button disabled={busy || !!openOccasion.gift || !openOccasion.giftEligible || openOccasion.historyCleared} onClick={() => reminder([opened], 'decision')}>Remind All Responsible Internal POCs</Button><Button disabled={busy || !openOccasion.gift || openOccasion.gift === 'No Gift' || openOccasion.stage === 'Delivered'} onClick={() => reminder([opened], 'delivery')}>Ask Desk About Delivery</Button><Button disabled={busy || !openOccasion.gift || openOccasion.gift === 'No Gift' || openOccasion.stage === 'Delivered'} onClick={() => reminder([opened], 'pending_arrangement')}>Remind POCs & Desk About Arrangement</Button></div> : null}
        <h4>Wish & Email Status</h4><div className="birthday-bounded">{jobs.filter(j => j.contact_id === opened).map(job => <div key={job.id} className="birthday-history-row"><strong>{job.channel.toUpperCase()} · {job.kind.replaceAll('_', ' ')} · {statusLabel(job.status)}</strong><span>{job.result?.reason || ''}</span><small>{stamp(job.created_at)}</small></div>)}{!jobs.some(j => j.contact_id === opened) ? <p>No send history for this birthday year.</p> : null}</div>
        <h4>Follow-up, Gift & Approval History</h4><div className="birthday-bounded">{(data.events || []).filter(e => e.contact_id === opened).map(event => <details key={event.id} className="birthday-history-row"><summary><strong>{event.action}</strong> · {event.actor} · {stamp(event.created_at)}</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>)}{!data.events.some(e => e.contact_id === opened) ? <p>No follow-up or gift history recorded for this year.</p> : null}</div>
        {canManage && !openContact.removedAt ? <Button disabled={busy} onClick={() => askCleanup({ removeContact: true, contactIds: [opened], year, kind: 'contact' })}>Remove Contact From Birthday Flows</Button> : null}
      </>}</Panel></div>
      {isSuper && settings ? <Panel id="birthday-settings" title="Birthday Automation & Email Settings" className="birthday-section"><p>Schedules use India time: wishes from 8 AM, internal follow-ups from 9 AM. Enable the separate birthday scheduler workflow after configuration.</p><label className="birthday-check"><input type="checkbox" checked={settings.enabled} onChange={e => setSettings(old => ({ ...old, enabled: e.target.checked }))} />Enable Scheduled Birthday Automation</label><div className="birthday-form-grid">{[['deskEmails','Desk Email Recipients'],['notificationEmails','Additional Birthday Notification Recipients'],['giftOptions','Standard Gift Options']].map(([key, label]) => <label key={key}>{label}<textarea value={settings[`${key}Text`] || ''} onChange={e => setSettings(old => ({ ...old, [`${key}Text`]: e.target.value }))} placeholder="One per line" /></label>)}<label>Approved WhatsApp Birthday Template<input value={settings.whatsappTemplate} onChange={e => setSettings(old => ({ ...old, whatsappTemplate: e.target.value }))} /></label><label>WhatsApp Template Language<input value={settings.whatsappLanguage} onChange={e => setSettings(old => ({ ...old, whatsappLanguage: e.target.value }))} /></label></div><p>All active Super Admins receive escalations and change requests. Recipient settings here apply only to birthday operations. Email acceptance does not confirm inbox delivery.</p>{!data.smtpConfigured ? <p className="birthday-reason">SMTP is not configured. Sending attempts will be shown as failed until SMTP secrets are configured.</p> : null}<Button variant="primary" disabled={busy} onClick={() => execute(() => apiPut('/api/birthdays/settings', { ...settings, ...Object.fromEntries(['deskEmails','notificationEmails','giftOptions'].map(key => [key, (settings[`${key}Text`] || '').split(/[\n;,]/).map(value => value.trim()).filter(Boolean)])) }), 'Birthday settings saved.')}>Save Birthday Settings</Button></Panel> : null}
      {canCleanup ? <Panel id="birthday-cleanup" title="Birthday History Cleanup" className="birthday-section"><p>Select contacts in the table and choose the birthday year above. Cleanup affects those matching selections only. Contacts, CSAT data and minimal duplicate-send protection are preserved.</p><strong>{selectedIds.length} Selected Contacts · {year}</strong><div className="birthday-cleanup-grid">{[['followup','Follow-up History','Reminders and escalation history'],['wish','Wish History','Email and WhatsApp wish history'],['gift','Gift History','Selections, changes and delivery details'],['all','Complete Birthday History','All selected birthday process history']].map(([kind, title, description]) => <section key={kind}><h4>{title}</h4><p>{description}</p><Button disabled={busy || !selectedIds.length} onClick={() => askCleanup({ contactIds: selectedIds, year, kind })}>Review & Delete {title}</Button></section>)}</div></Panel> : null}
    </>}
    {cleanup ? <div className="birthday-modal-backdrop"><form onSubmit={confirmCleanup} className="birthday-modal" role="dialog" aria-modal="true" aria-labelledby="birthday-cleanup-title"><h2 id="birthday-cleanup-title">Confirm {cleanup.removeContact ? 'Birthday Contact Removal' : 'Birthday History Cleanup'}</h2><p>{cleanup.contactIds.length} selected contacts · {cleanup.year} · {cleanup.kind}</p><div className="birthday-bounded">{contacts.filter(c => cleanup.contactIds.includes(c.id)).map(c => <p key={c.id}>{c.name} · {c.organization}</p>)}</div><p>{cleanup.removeContact ? 'Future birthday sends will stop. Existing birthday and CSAT history is preserved.' : 'Selected history will be permanently removed. Clearing gift history also stops further gift follow-ups for that birthday year.'}</p><label>Type DELETE<input autoFocus value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" /></label><label>Manage Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></label><div className="birthday-actions"><button className="button primary" type="submit" disabled={busy || confirmation !== 'DELETE' || !password}>Confirm Deletion</button><Button disabled={busy} onClick={() => { setCleanup(null); setPassword(''); }}>Cancel</Button></div></form></div> : null}
  </div>;
}

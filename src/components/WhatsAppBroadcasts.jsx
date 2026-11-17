import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../api';
import { hasPermission } from '../permissions';
import { Button, LoadingBlock } from './Ui.jsx';
import { MultiSelect, SingleSelect, FilterBar, DateRange } from './Filters.jsx';
import { formatDateTime } from '../format';
import './WhatsAppBroadcasts.css';

const emptyFilters = () => ({ clusters: [], clients: [], projects: [] });
const labels = { queued: 'Queued', sending: 'Sending', accepted: 'Accepted by WhatsApp', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', unknown: 'Confirmation Missing', skipped: 'Skipped' };
const fieldCount = template => Math.max(0, ...[...String(template?.body || '').matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1])));
function replyStatus(row) {
  if (!row.latest_reply_at) return 'no_reply';
  return !row.last_staff_reply_at || Date.parse(row.latest_reply_at) > Date.parse(row.last_staff_reply_at) ? 'awaiting_response' : 'responded';
}
function section(id) {
  const node = document.getElementById(id);
  if (!node) return;
  if (node.tagName === 'DETAILS') node.open = true;
  node.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export default function WhatsAppBroadcasts({ currentUser }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [title, setTitle] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [parameters, setParameters] = useState([]);
  const [filters, setFilters] = useState(emptyFilters);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState([]);
  const [preview, setPreview] = useState(null);
  const [consent, setConsent] = useState(false);
  const [campaignId, setCampaignId] = useState('');
  const [recipients, setRecipients] = useState([]);
  const [recipientId, setRecipientId] = useState('');
  const [inboxOffset, setInboxOffset] = useState(0);
  const [inboxHasMore, setInboxHasMore] = useState(false);
  const [conversation, setConversation] = useState(null);
  const [reply, setReply] = useState('');
  const [renewedPermission, setRenewedPermission] = useState('');
  const [replyFilter, setReplyFilter] = useState([]);
  const [deliveryFilter, setDeliveryFilter] = useState([]);
  const [replySearch, setReplySearch] = useState('');
  const [replyRange, setReplyRange] = useState({ from: '', to: '', basis: 'completed' });
  const [registered, setRegistered] = useState({ name: '', language: 'en', body: '', approvedConfirmed: false });
  const requests = useRef({ page: 0, campaign: 0, chat: 0 });
  const sendRequest = useRef('');
  const replyRequest = useRef('');
  const canSend = hasPermission(currentUser, 'broadcast_send');
  const canReply = hasPermission(currentUser, 'broadcast_reply');
  const isSuper = currentUser?.role === 'super_admin';

  async function load() {
    const request = ++requests.current.page;
    try {
      const value = await apiGet(`/api/broadcasts?offset=${offset}`);
      if (request === requests.current.page) setData(value);
    } catch (failure) { if (request === requests.current.page) setError(failure.message); }
  }
  async function loadCampaign(id) {
    const request = ++requests.current.campaign;
    try {
      const query = new URLSearchParams({ offset: String(inboxOffset), replies: replyFilter.join(','), statuses: deliveryFilter.join(','), search: replySearch, from: replyRange.from, to: replyRange.to });
      const value = await apiGet(id ? `/api/broadcasts/${id}` : `/api/broadcasts/inbox?${query}`);
      if (request === requests.current.campaign) { setRecipients(value.recipients); setInboxHasMore(Boolean(value.hasMore)); }
    } catch (failure) { if (request === requests.current.campaign) setError(failure.message); }
  }
  async function loadConversation(id) {
    const request = ++requests.current.chat;
    try {
      const value = await apiGet(`/api/broadcasts/recipients/${id}/messages`);
      if (request === requests.current.chat) setConversation(value);
    } catch (failure) { if (request === requests.current.chat) setError(failure.message); }
  }
  useEffect(() => { load(); return () => { requests.current.page++; }; }, [offset]);
  useEffect(() => {
    setRecipients([]); setRecipientId(''); setConversation(null); requests.current.chat++;
  }, [campaignId]);
  useEffect(() => {
    loadCampaign(campaignId);
    return () => { requests.current.campaign++; };
  }, [campaignId, inboxOffset, replyFilter, deliveryFilter, replySearch, replyRange]);
  useEffect(() => {
    setConversation(null); setReply(''); setRenewedPermission(''); replyRequest.current = '';
    if (recipientId) loadConversation(recipientId);
    return () => { requests.current.chat++; };
  }, [recipientId]);
  useEffect(() => {
    const refresh = () => {
      if (document.hidden || busy) return;
      load();
      loadCampaign(campaignId);
      if (recipientId) loadConversation(recipientId);
    };
    const timer = window.setInterval(refresh, 30000);
    return () => window.clearInterval(timer);
  }, [offset, campaignId, recipientId, busy, inboxOffset, replyFilter, deliveryFilter, replySearch, replyRange]);

  function changed() { setPreview(null); setConsent(false); sendRequest.current = ''; }
  function filter(key, values) {
    changed();
    setFilters(old => ({ ...old, [key]: values, ...(key === 'clusters' ? { clients: [], projects: [] } : key === 'clients' ? { projects: [] } : {}) }));
  }
  async function perform(action) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  if (!data) return error ? <div className="error-block" role="alert">{error}<Button onClick={load}>Try Again</Button></div> : <LoadingBlock label="Loading WhatsApp Broadcasts" />;
  const directory = data.directory;
  const template = data.templates.find(row => row.id === templateId);
  const visible = directory.clientPocs.filter(poc =>
    (!filters.clusters.length || filters.clusters.includes(poc.clusterId))
    && (!filters.clients.length || filters.clients.includes(poc.clientId))
    && (!filters.projects.length || filters.projects.includes(poc.projectId))
    && `${poc.name} ${poc.clientName} ${poc.projectName} ${poc.contactWhatsapp || ''}`.toLowerCase().includes(search.trim().toLowerCase())
  ).sort((left, right) => (left.clientName || '').localeCompare(right.clientName || '') || left.clientId.localeCompare(right.clientId)
    || (left.projectName || '').localeCompare(right.projectName || '') || left.projectId.localeCompare(right.projectId) || left.name.localeCompare(right.name));
  const selectedVisible = visible.filter(row => selected.includes(row.id));
  const clients = directory.clients.filter(client => !filters.clusters.length || filters.clusters.includes(client.clusterId));
  const projects = directory.projects.filter(project => clients.some(client => client.id === project.clientId) && (!filters.clients.length || filters.clients.includes(project.clientId)));
  const groups = [];
  for (const poc of visible) {
    let group = groups.at(-1);
    if (!group || group.projectId !== poc.projectId) { group = { projectId: poc.projectId, clientName: poc.clientName, projectName: poc.projectName, pocs: [] }; groups.push(group); }
    group.pocs.push(poc);
  }
  const input = { title, templateId, parameters, clientPocIds: selectedVisible.map(row => row.id) };
  const matchingReplies = recipients.filter(row => {
    const latestDate = row.latest_reply_at ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.latest_reply_at)) : '';
    if (!campaignId) return true;
    return (!replyFilter.length || replyFilter.includes(replyStatus(row)))
      && (!deliveryFilter.length || deliveryFilter.includes(row.status))
      && (!replyRange.from || (latestDate && latestDate >= replyRange.from))
      && (!replyRange.to || (latestDate && latestDate <= replyRange.to))
      && `${row.phone || ''} ${row.latest_reply || ''} ${row.associations.map(poc => `${poc.name} ${poc.clientName} ${poc.projectName}`).join(' ')}`.toLowerCase().includes(replySearch.trim().toLowerCase());
  });

  return <div className="broadcast-centre">
    <header><p className="eyebrow">Client Communications</p><h1>WhatsApp Broadcasts</h1><p>Send announcements and manage client replies.</p></header>
    <nav className="broadcast-nav" aria-label="Broadcast sections">
      {canSend ? <Button onClick={() => section('broadcast-create')}>Create Broadcast</Button> : null}
      <Button onClick={() => section('broadcast-history')}>Broadcast History</Button>
      <Button onClick={() => section('broadcast-replies')}>Broadcast Replies</Button>
      {isSuper ? <Button onClick={() => section('broadcast-templates')}>Approved Templates</Button> : null}
      <Button disabled={busy} onClick={() => perform(async () => { await load(); await loadCampaign(campaignId); if (recipientId) await loadConversation(recipientId); })}>Refresh Status</Button>
    </nav>
    {error || notice ? <div className="broadcast-feedback">
      {error ? <div className="error-block" role="alert"><span>{error}</span><Button onClick={() => setError('')}>Dismiss</Button></div> : null}
      {notice ? <div className="broadcast-notice" role="status"><span>{notice}</span><Button onClick={() => setNotice('')}>Dismiss</Button></div> : null}
    </div> : null}
    {!data.messaging.enabled ? <p className="broadcast-warning">WhatsApp messaging is paused.</p> : null}
    {!data.senderConfigured ? <p className="broadcast-warning">The broadcast sender needs configuring before messages can be sent.</p> : null}

    {canSend ? <details id="broadcast-create" className="broadcast-panel" open>
      <summary>Create Broadcast</summary>
      <div className="broadcast-panel-body">
        <div className="broadcast-fields">
          <label>Campaign Name<input value={title} maxLength={160} onChange={event => { setTitle(event.target.value); changed(); }} /></label>
          <SingleSelect label="Approved Announcement Template" value={templateId} options={data.templates.filter(row => row.active).map(row => ({ value: row.id, label: `${row.name} · ${row.language}` }))} onChange={id => { setTemplateId(id); setParameters(Array.from({ length: fieldCount(data.templates.find(row => row.id === id)) }, () => ({ source: 'text', text: '' }))); changed(); }} />
        </div>
        {template ? <p className="broadcast-template-text">{template.body}</p> : <p>Select an approved template. Super Admin can register templates in Approved Templates below.</p>}
        {parameters.map((parameter, index) => <div className="broadcast-fields" key={index}>
          <SingleSelect label={`Template Field ${index + 1}`} value={parameter.source} allowClear={false} options={[{ value: 'text', label: 'Custom Text' }, { value: 'poc_name', label: 'POC Name' }, { value: 'client_name', label: 'Client Name' }, { value: 'project_name', label: 'Project Name' }]} onChange={source => { setParameters(old => old.map((value, position) => position === index ? { source, text: '' } : value)); changed(); }} />
          {parameter.source === 'text' ? <label>Field Value<input value={parameter.text} maxLength={1000} onChange={event => { setParameters(old => old.map((value, position) => position === index ? { ...value, text: event.target.value } : value)); changed(); }} /></label> : <p>Shared recipients will show the selected names together in the preview.</p>}
        </div>)}
        <h3>Select Recipients</h3>
        <FilterBar showReset onReset={() => { setFilters(emptyFilters()); setSearch(''); changed(); }}>
          <MultiSelect label="Clusters" options={directory.clusters.map(row => row.id)} selected={filters.clusters} renderOption={id => directory.clusters.find(row => row.id === id)?.name} onChange={values => filter('clusters', values)} />
          <MultiSelect label="Clients" options={clients.map(row => row.id)} selected={filters.clients} selectAllLabel="Select All" renderOption={id => directory.clients.find(row => row.id === id)?.name} onChange={values => filter('clients', values)} />
          <MultiSelect label="Projects" options={projects.map(row => row.id)} selected={filters.projects} selectAllLabel="Select All" renderOption={id => directory.projects.find(row => row.id === id)?.name} onChange={values => filter('projects', values)} />
        </FilterBar>
        <label>Search Clients, Projects, POCs or Numbers<input value={search} onChange={event => { setSearch(event.target.value); changed(); }} /></label>
        <div className="broadcast-actions"><Button onClick={() => { setSelected(visible.map(row => row.id)); changed(); }}>Select All Matching POCs</Button><Button onClick={() => { setSelected([]); changed(); }}>Clear Selection</Button><span>{selectedVisible.length} selected within {visible.length} matching POC records</span></div>
        <div className="broadcast-scroll" role="region" aria-label="Recipients grouped by client and project" tabIndex={0}>
          <table><thead><tr><th>Select</th><th>POC</th><th>WhatsApp Number</th><th>Contact Status</th></tr></thead><tbody>
            {groups.map(group => <ReactGroup key={group.projectId} group={group} selected={selected} onChange={ids => { setSelected(ids); changed(); }} />)}
            {!groups.length ? <tr><td colSpan={4}>No POCs match these filters.</td></tr> : null}
          </tbody></table>
        </div>
        <Button disabled={busy || !template || !selectedVisible.length || !title.trim()} onClick={() => perform(async () => { const value = await apiPost('/api/broadcasts/preview', input); setPreview(value); setConsent(false); })}>Preview Broadcast</Button>
        {preview ? <div className="broadcast-preview">
          <h3>Review Broadcast</h3><p>{preview.uniqueRecipients} eligible WhatsApp numbers · {preview.recipients.filter(row => row.reason).length} skipped recipient groups</p>
          <div className="broadcast-scroll">{preview.recipients.map((row, index) => <article key={index} className={row.reason ? 'broadcast-preview-skipped' : ''}>
            <strong>{row.associations.map(poc => poc.name).filter((name, position, names) => names.indexOf(name) === position).join(', ')} · {row.phone || 'Number Unavailable'}</strong>
            {row.associations.map(poc => <small key={poc.id}>{poc.clientName} → {poc.projectName}{poc.reason ? ` · Skipped POC: ${poc.reason}` : ''}</small>)}
            {row.reason ? <p className="broadcast-warning">Skipped · {row.reason}</p> : <p className="broadcast-template-text">{row.message}</p>}
          </article>)}</div>
          <label className="broadcast-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I confirm the selected recipients agreed to receive announcements from SRV Media.</label>
          <Button variant="primary" disabled={busy || !consent || !preview.uniqueRecipients || !data.messaging.enabled || !data.senderConfigured} onClick={() => perform(async () => {
            if (!window.confirm(`Send “${title}” to up to ${preview.uniqueRecipients} eligible WhatsApp numbers?`)) return;
            sendRequest.current ||= window.crypto.randomUUID();
            const result = await apiPost('/api/broadcasts/send', { ...input, requestId: sendRequest.current, consentConfirmed: true });
            setCampaignId(result.campaign.id); setPreview(null); setSelected([]); sendRequest.current = '';
            setNotice(`${result.duplicate ? 'This broadcast was already recorded. ' : ''}${result.queued} recipients queued; ${result.skipped} skipped.${result.senderTriggered ? '' : ' Sender wake-up was not confirmed. Check the scheduled broadcast worker.'}`);
            await load(); section('broadcast-history');
          })}>{busy ? 'Sending…' : 'Send Broadcast'}</Button>
        </div> : null}
      </div>
    </details> : null}

    <details id="broadcast-history" className="broadcast-panel" open><summary>Broadcast History</summary><div className="broadcast-panel-body">
      <div className="broadcast-scroll"><table><thead><tr><th>Campaign</th><th>Created</th><th>Recipients</th><th>Accepted / Sent</th><th>Replies</th><th>Skipped</th><th>Failed</th><th /></tr></thead><tbody>
        {data.campaigns.map(campaign => <tr key={campaign.id} className={campaign.id === campaignId ? 'broadcast-selected' : ''}>
          <td><strong>{campaign.title}</strong><small>{campaign.created_by}</small></td><td>{formatDateTime(campaign.created_at)}</td><td>{campaign.total}</td><td>{campaign.accepted}</td><td>{campaign.replied}</td><td>{campaign.skipped}</td><td>{campaign.failed}</td>
          <td><Button onClick={() => { setCampaignId(campaign.id); section('broadcast-replies'); }}>Open</Button></td>
        </tr>)}
        {!data.campaigns.length ? <tr><td colSpan={8}>No broadcasts yet.</td></tr> : null}
      </tbody></table></div>
      <div className="broadcast-actions"><Button disabled={!offset || busy} onClick={() => setOffset(value => Math.max(0, value - 50))}>Newer</Button><Button disabled={!data.hasMore || busy} onClick={() => setOffset(value => value + 50)}>Older</Button></div>
    </div></details>

    <details id="broadcast-replies" className="broadcast-panel" open><summary>Broadcast Replies & Delivery</summary><div className="broadcast-panel-body">
      <SingleSelect label="Broadcast" value={campaignId} placeholder="All Broadcasts" options={data.campaigns.map(row => ({ value: row.id, label: row.title }))} onChange={id => { setCampaignId(id); setInboxOffset(0); }} />
      <>
        <FilterBar showReset onReset={() => { setReplyFilter([]); setDeliveryFilter([]); setReplySearch(''); setReplyRange({ from: '', to: '', basis: 'completed' }); setInboxOffset(0); }}>
          <MultiSelect label="Reply Status" selected={replyFilter} options={['awaiting_response','responded','no_reply']} renderOption={value => ({ awaiting_response: 'Awaiting Our Response', responded: 'Responded', no_reply: 'No Reply' }[value])} onChange={value => { setReplyFilter(value); setInboxOffset(0); }} />
          <MultiSelect label="Delivery Status" selected={deliveryFilter} options={Object.keys(labels)} renderOption={value => labels[value]} onChange={value => { setDeliveryFilter(value); setInboxOffset(0); }} />
          <DateRange range={replyRange} onChange={value => { setReplyRange(value); setInboxOffset(0); }} />
        </FilterBar>
        <label>Search Recipients or Latest Reply<input value={replySearch} onChange={event => { setReplySearch(event.target.value); setInboxOffset(0); }} /></label>
        <div className="broadcast-scroll"><table><thead><tr><th>POC / Number</th><th>Clients / Projects</th><th>Delivery</th><th>Latest Reply</th><th>Reply Time</th><th>Response Status</th><th /></tr></thead><tbody>
          {matchingReplies.map(row => <tr key={row.id} className={recipientId === row.id ? 'broadcast-selected' : ''}>
            <td>{[...new Set(row.associations.map(poc => poc.name))].join(', ')}<small>{row.phone || 'Number Unavailable'}</small><small>{row.title}</small></td>
            <td>{row.associations.map(poc => <small key={poc.id}>{poc.clientName} → {poc.projectName}{poc.reason ? ` · ${poc.reason}` : ''}</small>)}</td>
            <td><span className={`broadcast-state ${row.status}`}>{labels[row.status]}</span>{row.reason ? <small>{row.reason}</small> : null}</td>
            <td className="broadcast-reply-preview">{row.latest_reply || '—'}</td><td>{row.latest_reply_at ? formatDateTime(row.latest_reply_at) : '—'}</td>
            <td>{{ awaiting_response: 'Awaiting Our Response', responded: 'Responded', no_reply: 'No Reply' }[replyStatus(row)]}</td>
            <td><Button onClick={() => { setRecipientId(row.id); window.requestAnimationFrame(() => section('broadcast-conversation')); }}>Conversation</Button></td>
          </tr>)}
          {!matchingReplies.length ? <tr><td colSpan={7}>No recipients match these filters.</td></tr> : null}
        </tbody></table></div>
        {!campaignId ? <div className="broadcast-actions"><Button disabled={!inboxOffset} onClick={() => setInboxOffset(value => Math.max(0, value - 100))}>Newer Replies</Button><Button disabled={!inboxHasMore} onClick={() => setInboxOffset(value => value + 100)}>Older Replies</Button></div> : null}
      </>
      {recipientId ? <div id="broadcast-conversation" className="broadcast-conversation">
        {!conversation ? <LoadingBlock label="Loading broadcast conversation" /> : <>
          <h3>{[...new Set(conversation.recipient.associations.map(poc => poc.name))].join(', ')} · {conversation.recipient.phone}</h3>
          {conversation.optedOut ? <div className="broadcast-warning"><p>This recipient opted out. Future proactive WhatsApp sends are paused.</p>{canSend ? <details><summary>Record Renewed Permission</summary><label>How and When the Client Renewed Permission<input value={renewedPermission} maxLength={1000} onChange={event => setRenewedPermission(event.target.value)} /></label><Button disabled={busy || renewedPermission.trim().length < 10} onClick={() => perform(async () => { if (!window.confirm('Confirm the client agreed to receive WhatsApp messages again?')) return; await apiPost(`/api/broadcasts/recipients/${recipientId}/permission`, { note: renewedPermission, consentConfirmed: true }); await loadConversation(recipientId); setNotice('Renewed WhatsApp permission recorded.'); })}>Confirm Renewed Permission</Button></details> : null}</div> : null}
          <div className="broadcast-chat" role="region" aria-label="Selected POC broadcast conversation" tabIndex={0}>
            <article className="broadcast-bubble srv"><strong>SRV Media</strong><p>{renderMessage(conversation.recipient)}</p><small>{formatDateTime(conversation.recipient.sent_at || conversation.recipient.claimed_at)} · {labels[conversation.recipient.status]}</small></article>
            {conversation.messages.map(message => <article key={message.id} className={`broadcast-bubble ${message.side}`}><strong>{message.side === 'client' ? 'Client' : 'SRV Media'}</strong><p>{message.body}</p><small>{formatDateTime(message.provider_at || message.created_at)}{message.side === 'srv' ? ` · ${labels[message.status] || message.status}` : ''}</small>{message.error ? <small>{message.error}</small> : null}</article>)}
          </div>
          {conversation.feedbackOwnsReplies ? <p className="broadcast-warning">A newer feedback session owns subsequent replies. Open its Project Workspace conversation to respond.</p> : !conversation.replyWindowOpen ? <p>The 24-hour WhatsApp reply window is closed. An approved template is required to contact this recipient.</p> : null}
          {canReply ? <div><label>Reply on WhatsApp<textarea rows={4} value={reply} maxLength={4096} disabled={conversation.feedbackOwnsReplies || !conversation.replyWindowOpen || busy} onChange={event => { setReply(event.target.value); replyRequest.current = ''; }} /></label>
            <Button variant="primary" disabled={busy || !reply.trim() || !conversation.replyWindowOpen || conversation.feedbackOwnsReplies || !data.messaging.enabled || !data.senderConfigured} onClick={() => perform(async () => {
              replyRequest.current ||= window.crypto.randomUUID();
              const result = await apiPost(`/api/broadcasts/recipients/${recipientId}/reply`, { text: reply, requestId: replyRequest.current });
              setReply(''); replyRequest.current = ''; setNotice(result.senderTriggered ? 'Reply queued for WhatsApp.' : 'Reply queued. Sender wake-up was not confirmed; check the broadcast worker.');
              await loadConversation(recipientId); await loadCampaign(campaignId);
            })}>Send WhatsApp Reply</Button></div> : null}
        </>}
      </div> : null}
    </div></details>

    {isSuper ? <details id="broadcast-templates" className="broadcast-panel"><summary>Approved Announcement Templates</summary><div className="broadcast-panel-body">
      <p>Register the exact text-only template approved in Meta WhatsApp Manager. Numbered fields such as {'{{1}}'} will be personalised in Create Broadcast.</p>
      <form onSubmit={event => { event.preventDefault(); perform(async () => { await apiPost('/api/broadcasts/templates', registered); setRegistered({ name: '', language: 'en', body: '', approvedConfirmed: false }); setNotice('Approved template registered.'); await load(); }); }}>
        <div className="broadcast-fields"><label>Meta Template Name<input required value={registered.name} onChange={event => setRegistered(old => ({ ...old, name: event.target.value }))} placeholder="srv_general_announcement" /></label><label>Language Code<input required value={registered.language} onChange={event => setRegistered(old => ({ ...old, language: event.target.value }))} /></label></div>
        <label>Approved Template Text<textarea required rows={5} maxLength={4096} value={registered.body} onChange={event => setRegistered(old => ({ ...old, body: event.target.value }))} /></label>
        <label className="broadcast-check"><input required type="checkbox" checked={registered.approvedConfirmed} onChange={event => setRegistered(old => ({ ...old, approvedConfirmed: event.target.checked }))} />I confirm this text-only template is approved in Meta and the name, language and text match.</label>
        <button type="submit" className="button primary" disabled={busy}>Save Approved Template</button>
      </form>
    </div></details> : null}
  </div>;
}

function ReactGroup({ group, selected, onChange }) {
  const checked = group.pocs.every(poc => selected.includes(poc.id));
  return <>
    <tr className="broadcast-group"><td><input type="checkbox" aria-label={`Select ${group.clientName} ${group.projectName}`} checked={checked} onChange={event => onChange(event.target.checked ? [...new Set([...selected, ...group.pocs.map(poc => poc.id)])] : selected.filter(id => !group.pocs.some(poc => poc.id === id)))} /></td><th colSpan={3}>{group.clientName} → {group.projectName}</th></tr>
    {group.pocs.map(poc => <tr key={poc.id}><td><input type="checkbox" aria-label={`Select ${poc.name} for ${poc.projectName}`} checked={selected.includes(poc.id)} onChange={event => onChange(event.target.checked ? [...selected, poc.id] : selected.filter(id => id !== poc.id))} /></td><td>{poc.name}</td><td>{poc.contactWhatsapp || 'Missing'}</td><td>{poc.active ? 'Active' : 'Inactive'}</td></tr>)}
  </>;
}

function renderMessage(recipient) {
  if (recipient.message_body !== undefined) return recipient.message_body;
  if (recipient.message !== undefined) return recipient.message;
  const values = recipient.parameters.map(parameter => {
    if (parameter.source === 'text') return parameter.text;
    const field = { poc_name: 'name', client_name: 'clientName', project_name: 'projectName' }[parameter.source];
    return [...new Set(recipient.associations.filter(poc => !poc.reason).map(poc => poc[field]).filter(Boolean))].join(', ');
  });
  return recipient.template.body.replace(/\{\{(\d+)\}\}/g, (_, number) => values[Number(number) - 1] || '');
}

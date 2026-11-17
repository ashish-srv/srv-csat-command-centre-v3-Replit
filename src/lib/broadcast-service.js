const crypto = require('node:crypto');
const { BroadcastRepository } = require('./broadcast-repository');
const { whatsappNumber, recipientReason } = require('./whatsapp-recipients');
const { emitAutomation } = require('./n8n');

const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const json = (statusCode, value) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(value) });
const clustersFor = access => access.role === 'super_admin' ? null : (access.clusterAccess || []).map(row => row.clusterId);
const actorFor = access => access.email || access.name || 'Super Admin';

function permission(access, key) {
  if (!access || access.role === 'project_user' || !(access.role === 'super_admin' || access.permissions?.[key] === true)) fail('WhatsApp Broadcast access denied.', 403);
}

function automationAuth(headers) {
  const actual = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'x-csat-webhook-secret')?.[1] || '';
  const expected = process.env.N8N_WEBHOOK_SECRET || '';
  const received = Buffer.from(String(actual)), secret = Buffer.from(expected);
  if (!expected || expected === 'replace-with-shared-secret' || received.length !== secret.length || !crypto.timingSafeEqual(received, secret)) fail('Unauthorised broadcast automation.', 401);
}

function validDate(value) {
  if (!value) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
}

function parameterCount(body) {
  const matches = [...body.matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1]));
  const unique = [...new Set(matches)].sort((left, right) => left - right);
  if (unique.length > 10 || unique.some((value, index) => value !== index + 1)) fail('Template parameters must run consecutively from {{1}} to {{10}} at most.');
  const remainder = body.replace(/\{\{\d+\}\}/g, '');
  if (/[{}]/.test(remainder)) fail('Use numbered template parameters, such as {{1}}.');
  return unique.length;
}

function expandedParameters(parameters, associations) {
  const unique = key => [...new Set(associations.filter(row => !row.reason).map(row => row[key]).filter(Boolean))].join(', ');
  return parameters.map(parameter => parameter.source === 'text' ? parameter.text
    : parameter.source === 'poc_name' ? unique('name')
      : parameter.source === 'client_name' ? unique('clientName') : unique('projectName'));
}

function feedbackMessagingBlock(session) {
  const state = session?.conversationState || {};
  const stoppedByAdmin = state.stoppedByAdmin === true || state.closureReason === 'stopped_by_admin';
  // The feedback store also uses status=opted_out for an administrative stop.
  if (state.optedOut || state.state === 'opted_out' || (session?.status === 'opted_out' && !stoppedByAdmin)) {
    return 'Client Opted Out During Feedback';
  }
  if (state.handoffReason === 'wrong_person') return 'WhatsApp Number Marked as Wrong Person';
  return '';
}

function renderTemplate(template, parameters, associations) {
  const values = expandedParameters(parameters, associations);
  return template.body.replace(/\{\{(\d+)\}\}/g, (_, number) => values[Number(number) - 1] || '');
}

async function audience(store, pocs) {
  const groups = new Map();
  for (const poc of pocs) {
    const phone = whatsappNumber(poc.contactWhatsapp);
    const key = phone || `unavailable:${poc.id}`;
    if (!groups.has(key)) groups.set(key, { phone, associations: [] });
    groups.get(key).associations.push({ id: poc.id, name: poc.name, clientId: poc.clientId, clientName: poc.clientName,
      projectId: poc.projectId, projectName: poc.projectName, clusterId: poc.clusterId, reason: recipientReason(poc), whatsapp: poc.contactWhatsapp || '' });
  }
  for (const row of groups.values()) {
    const available = row.associations.some(association => !association.reason);
    row.reason = available ? '' : [...new Set(row.associations.map(association => association.reason))].join('; ');
    if (!row.reason) {
      if (typeof store.whatsappContactOptedOut === 'function' && await store.whatsappContactOptedOut(row.phone)) row.reason = 'WhatsApp Messaging Opt-Out';
      const routing = await store.getWhatsappRoutingContext(row.phone);
      if (['active','ambiguous'].includes(routing.status)) row.reason = 'Active Feedback in Progress';
      if (!row.reason) row.reason = feedbackMessagingBlock(routing.session);
    }
  }
  return [...groups.values()];
}

function visibleAssociations(recipient, clusters) {
  return { ...recipient, associations: recipient.associations.filter(row => !clusters || clusters.includes(row.clusterId)) };
}

function canReadHistory(recipient, clusters) {
  return !clusters || (recipient.associations.length > 0 && recipient.associations.every(row => clusters.includes(row.clusterId)));
}

async function prepare(store, access, input, repo) {
  const title = String(input.title || '').trim();
  if (!title || title.length > 160) fail('Enter a broadcast title of up to 160 characters.');
  const template = (await repo.templates()).find(row => row.id === input.templateId && row.active);
  if (!template) fail('Select an active approved announcement template.');
  const count = parameterCount(template.body);
  if (!Array.isArray(input.parameters) || input.parameters.length !== count) fail('Complete every template parameter.');
  const parameters = input.parameters.map(parameter => {
    if (!['text','poc_name','client_name','project_name'].includes(parameter?.source)) fail('Select a valid parameter source.');
    const text = String(parameter.text || '').trim();
    if (parameter.source === 'text' && (!text || text.length > 1000)) fail('Custom template values must contain 1–1000 characters.');
    return { source: parameter.source, text: parameter.source === 'text' ? text : '' };
  });
  if (!Array.isArray(input.clientPocIds) || !input.clientPocIds.length || input.clientPocIds.length > 5000) fail('Select between 1 and 5,000 POC records.');
  const ids = [...new Set(input.clientPocIds)];
  const directory = await store.getDirectory();
  const clusters = clustersFor(access);
  const allowed = directory.clientPocs.filter(row => !clusters || clusters.includes(row.clusterId));
  const selected = ids.map(id => allowed.find(row => row.id === id));
  if (selected.some(row => !row)) fail('A selected POC is unavailable or outside your assigned clusters.', 403);
  const recipients = await audience(store, selected);
  for (const row of recipients) {
    row.parameterValues = expandedParameters(parameters, row.associations);
    row.message = renderTemplate(template, parameters, row.associations);
    if (!row.reason && (row.message.length > 4096 || row.parameterValues.some(value => !value || value.length > 1000))) row.reason = 'Personalised Message Exceeds Template Limits';
  }
  return { title, template, parameters, recipients };
}

async function checkQueuedRecipient(row, transactionStore, directory) {
  const current = row.associations.map(association => directory.clientPocs.find(poc => poc.id === association.id)).filter(Boolean);
  const available = current.filter(poc => !recipientReason(poc) && whatsappNumber(poc.contactWhatsapp) === row.phone);
  if (!available.length) return 'Recipient Removed, Inactive or WhatsApp Number Changed';
  if (await transactionStore.whatsappContactOptedOut(row.phone)) return 'WhatsApp Messaging Opt-Out';
  const routing = await transactionStore.getWhatsappRoutingContext(row.phone);
  if (['active','ambiguous'].includes(routing.status)) return 'Active Feedback in Progress';
  const feedbackBlock = feedbackMessagingBlock(routing.session);
  if (feedbackBlock) return feedbackBlock;
  if (await transactionStore.whatsappSendInProgress(row.phone)) return 'Broadcast Sending in Progress';
  return '';
}

async function checkQueuedReply(message, transactionStore, query, repo) {
  if (typeof transactionStore.whatsappSendInProgress === 'function' && await transactionStore.whatsappSendInProgress(message.phone)) return 'Broadcast Sending in Progress';
  const routing = await transactionStore.getWhatsappRoutingContext(message.phone);
  if (['active','ambiguous'].includes(routing.status)) return 'A feedback session is active. Open its conversation to respond.';
  const feedbackAt = await repo.latestFeedbackStart(message.phone, new Date().toISOString(), query);
  if (feedbackAt && Date.parse(feedbackAt) >= Date.parse(message.sent_at || message.template_claimed_at)) return 'A newer feedback session owns replies. Open that feedback conversation.';
  const latest = (await query.query(`select max(coalesce(provider_at,created_at)) as at from public.whatsapp_broadcast_messages where recipient_id=$1 and side='client'`, [message.recipient_id])).rows[0]?.at;
  if (!latest || Date.now() - Date.parse(latest) >= 24 * 60 * 60 * 1000) return 'The 24-hour WhatsApp reply window has closed.';
  return '';
}

async function claimJobs(repo, store) {
  if (!(await store.getMessagingStatus()).enabled) return [];
  let directory;
  const jobs = await repo.claim({
    checkBroadcastRecipient: async (row, transactionStore) => {
      directory ||= await transactionStore.getDirectory();
      return checkQueuedRecipient(row, transactionStore, directory);
    },
    checkBroadcastReply: (message, transactionStore, query) => checkQueuedReply(message, transactionStore, query, repo)
  });
  return jobs.map(job => job.kind === 'template' ? { ...job, parameters: job.parameterValues || expandedParameters(job.parameters, job.associations) } : job);
}

async function handleBroadcastRequest({ store, access, request, pathname, method, body = {}, searchParams, repository }) {
  try {
    const machine = pathname.startsWith('/api/automation/broadcasts');
    if (machine) automationAuth(request.headers);
    else permission(access, 'broadcast_view');
    const repo = repository || new BroadcastRepository(store);
    if (machine) {
      if (method === 'POST' && pathname === '/api/automation/broadcasts/claim') return json(200, { jobs: await claimJobs(repo, store) });
      const ready = /^\/api\/automation\/broadcasts\/jobs\/([^/]+)\/ready$/.exec(pathname);
      if (method === 'POST' && ready && uuid(ready[1]) && ['template','reply'].includes(body.kind)) {
        const outcome = await repo.ready(ready[1], body.kind, async (job, recipient, transactionStore, query) => {
          if (!(await transactionStore.getMessagingStatus()).enabled) return 'WhatsApp Messaging Paused';
          transactionStore.whatsappSendInProgress = async () => false;
          if (body.kind === 'reply') return checkQueuedReply({ ...job, ...recipient, recipient_id: recipient.id, template_claimed_at: recipient.claimed_at }, transactionStore, query, repo);
          const current = await Promise.all(recipient.associations.map(row => transactionStore.getClientPocById(row.id)));
          const directory = { clientPocs: current.filter(Boolean) };
          // This job itself is already sending. Check the live feedback and
          // current contact without treating its own reservation as a conflict.
          return checkQueuedRecipient(recipient, transactionStore, directory);
        });
        return json(200, outcome);
      }
      if (method === 'POST' && pathname === '/api/automation/broadcasts/status') {
        if (!Array.isArray(body.statuses) || body.statuses.length > 100) fail('Supply up to 100 delivery updates.');
        for (const event of body.statuses) {
          if (!event.id || String(event.id).length > 300 || !['sent','delivered','read','failed'].includes(event.status)) continue;
          await repo.delivery({ id: String(event.id), status: event.status, reason: event.status === 'failed' ? String(event.errors?.[0]?.title || event.errors?.[0]?.message || 'WhatsApp delivery failed').slice(0, 500) : '' });
        }
        return json(200, { saved: true });
      }
      const callback = /^\/api\/automation\/broadcasts\/jobs\/([^/]+)\/result$/.exec(pathname);
      if (method === 'POST' && callback && uuid(callback[1])) {
        if (!['template','reply'].includes(body.kind) || !['accepted','failed','unknown'].includes(body.status)) fail('Invalid broadcast send result.');
        const providerMessageId = String(body.providerMessageId || '').trim();
        if (providerMessageId.length > 300 || (body.status === 'accepted' && !providerMessageId)) fail('Accepted sends require the WhatsApp message ID.');
        return json(200, { saved: await repo.finish(callback[1], body.kind, { status: body.status, providerMessageId, reason: String(body.reason || '').slice(0, 1000) }) });
      }
      fail('Unknown broadcast automation route.', 404);
    }
    const clusters = clustersFor(access);
    if (method === 'GET' && pathname === '/api/broadcasts/inbox') {
      const offset = Number(searchParams.get('offset') || 0);
      const from = searchParams.get('from') || '', to = searchParams.get('to') || '';
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !validDate(from) || !validDate(to) || (from && to && from > to)) fail('Choose valid inbox filters.');
      const result = await repo.inbox(clusters, { offset, from, to, search: String(searchParams.get('search') || '').slice(0,250),
        replies: (searchParams.get('replies') || '').split(',').filter(Boolean), statuses: (searchParams.get('statuses') || '').split(',').filter(Boolean) });
      return json(200, { ...result, recipients: result.recipients.filter(row => canReadHistory(row, clusters)).map(row => ({ ...visibleAssociations(row, clusters), message: row.message_body ?? renderTemplate(row.template, row.parameters, row.associations) })) });
    }
    if (method === 'GET' && pathname === '/api/broadcasts') {
      const offset = Number(searchParams.get('offset') || 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) fail('Invalid history page.');
      const directory = await store.getDirectory();
      const pocs = directory.clientPocs.filter(row => !clusters || clusters.includes(row.clusterId));
      const projectIds = new Set(pocs.map(poc => poc.projectId));
      return json(200, { ...await repo.campaigns(clusters, offset), templates: await repo.templates(),
        directory: { clusters: directory.clusters.filter(row => !clusters || clusters.includes(row.id)),
          clients: directory.clients.filter(row => !clusters || clusters.includes(row.clusterId)),
          projects: directory.projects.filter(row => projectIds.has(row.id)),
          clientPocs: pocs.map(poc => ({ id: poc.id, name: poc.name, active: poc.active, contactWhatsapp: poc.contactWhatsapp, salutation: poc.salutation || '',
            clientId: poc.clientId, clientName: poc.clientName, projectId: poc.projectId, projectName: poc.projectName, clusterId: poc.clusterId })) },
        messaging: await store.getMessagingStatus(), senderConfigured: Boolean(process.env.N8N_BROADCAST_WEBHOOK) });
    }
    if (method === 'POST' && pathname === '/api/broadcasts/templates') {
      if (access.role !== 'super_admin') fail('Only Super Admin can register approved templates.', 403);
      const name = String(body.name || '').trim(), language = String(body.language || 'en').trim(), text = String(body.body || '').trim();
      if (!/^[a-z0-9_]{1,100}$/.test(name) || !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(language)) fail('Enter the exact Meta template name and language code.');
      if (!text || text.length > 4096 || body.approvedConfirmed !== true) fail('Paste the approved text-only template body and confirm its Meta approval.');
      parameterCount(text);
      return json(201, { template: await repo.saveTemplate({ name, language, body: text }, actorFor(access)) });
    }
    if (method === 'POST' && ['/api/broadcasts/preview','/api/broadcasts/send'].includes(pathname)) {
      permission(access, 'broadcast_send');
      const prepared = await prepare(store, access, body, repo);
      if (pathname.endsWith('/preview')) return json(200, { ...prepared, uniqueRecipients: prepared.recipients.filter(row => !row.reason).length });
      if (!(await store.getMessagingStatus()).enabled) fail('WhatsApp messaging is paused.', 409);
      if (!process.env.N8N_BROADCAST_WEBHOOK) fail('Configure N8N_BROADCAST_WEBHOOK before sending announcements.', 503);
      if (body.consentConfirmed !== true) fail('Confirm the selected recipients agreed to receive announcements from SRV Media.');
      if (!uuid(body.requestId)) fail('A valid broadcast request ID is required.');
      const hash = crypto.createHash('sha256').update(JSON.stringify({ title: prepared.title, templateId: body.templateId, parameters: prepared.parameters, ids: [...new Set(body.clientPocIds)].sort() })).digest('hex');
      const created = await repo.create({ ...prepared, requestId: body.requestId, hash }, prepared.recipients, actorFor(access));
      const trigger = await emitAutomation('broadcast_queue_ready', { campaignId: created.campaign.id });
      return json(201, { ...created, queued: created.counts?.queued ?? prepared.recipients.filter(row => !row.reason).length,
        skipped: created.counts?.skipped ?? prepared.recipients.filter(row => row.reason).length, senderTriggered: trigger.status === 'sent' });
    }
    const campaign = /^\/api\/broadcasts\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && campaign && uuid(campaign[1])) {
      const recipients = (await repo.recipients(campaign[1], clusters)).filter(row => canReadHistory(row, clusters)).map(row => visibleAssociations(row, clusters));
      if (!recipients.length) fail('Broadcast not found in your assigned clusters.', 404);
      return json(200, { recipients: recipients.map(row => ({ ...row, message: row.message_body ?? renderTemplate(row.template, row.parameters, row.associations) })) });
    }
    const messages = /^\/api\/broadcasts\/recipients\/([^/]+)\/(messages|reply|permission)$/.exec(pathname);
    if (messages && uuid(messages[1])) {
      const recipient = await repo.recipient(messages[1], clusters);
      if (!recipient || !canReadHistory(recipient, clusters)) fail('Broadcast recipient not found in your assigned clusters.', 404);
      if (method === 'POST' && messages[2] === 'permission') {
        permission(access, 'broadcast_send');
        if (!whatsappNumber(recipient.phone)) fail('A valid WhatsApp number is required.');
        const note = String(body.note || '').trim();
        if (body.consentConfirmed !== true || note.length < 10 || note.length > 1000) fail('Record how and when the client renewed permission, and confirm their agreement.');
        await repo.setPermission(recipient.phone, true, note, actorFor(access));
        return json(200, { saved: true });
      }
      if (method === 'GET' && messages[2] === 'messages') {
        const rows = await repo.messages(recipient.id);
        const latest = rows.filter(row => row.side === 'client').at(-1);
        const feedbackAt = await repo.latestFeedbackStart(recipient.phone, new Date().toISOString());
        const feedbackOwnsReplies = Boolean(feedbackAt && Date.parse(feedbackAt) >= Date.parse(recipient.sent_at || recipient.claimed_at));
        return json(200, { messages: rows, recipient: { ...visibleAssociations(recipient, clusters), message: recipient.message_body ?? renderTemplate(recipient.template, recipient.parameters, recipient.associations) }, feedbackOwnsReplies,
          optedOut: typeof store.whatsappContactOptedOut === 'function' && await store.whatsappContactOptedOut(recipient.phone),
          replyWindowOpen: Boolean(latest && Date.now() - Date.parse(latest.provider_at || latest.created_at) < 24 * 60 * 60 * 1000) });
      }
      if (method === 'POST' && messages[2] === 'reply') {
        permission(access, 'broadcast_reply');
        if (!(await store.getMessagingStatus()).enabled) fail('WhatsApp messaging is paused.', 409);
        if (!process.env.N8N_BROADCAST_WEBHOOK) fail('Configure the broadcast sender first.', 503);
        const text = String(body.text || '').trim();
        if (!text || text.length > 4096 || !uuid(body.requestId)) fail('Enter a message of up to 4,096 characters and a valid request ID.');
        const reason = await checkQueuedReply({ ...recipient, recipient_id: recipient.id, template_claimed_at: recipient.claimed_at }, store, repo.pool, repo);
        if (reason) fail(reason, 409);
        const message = await repo.enqueueReply(recipient, text, body.requestId, actorFor(access));
        const trigger = await emitAutomation('broadcast_queue_ready', { recipientId: recipient.id });
        return json(201, { message, queued: true, senderTriggered: trigger.status === 'sent' });
      }
    }
    fail('Unknown broadcast route.', 404);
  } catch (error) {
    if (error.code === '42P01') return json(503, { error: 'Run the WhatsApp Broadcasts database migration before opening this tab.' });
    console.error('[broadcast]', error.status ? error.message : 'Request failed', error.code || '');
    return json(error.status || 500, { error: error.status ? error.message : 'Broadcast request failed. Check server logs.' });
  }
}

module.exports = { handleBroadcastRequest, audience, parameterCount, expandedParameters, renderTemplate, prepare, claimJobs, checkQueuedRecipient, checkQueuedReply, automationAuth };

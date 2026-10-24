const crypto = require('node:crypto');
const { BirthdayRepository } = require('./birthday-repository');
const D = require('./birthday-domain');
const { brandEmail, escapeEmail } = require('./email-theme');
const { sendEmail } = require('./email');
const { phoneHash } = require('./birthday-inbound');

const actorFor = access => access.email || access.name || 'Super Admin';
const contactIdValid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
const browserJobRow = job => ({ id: job.id, contact_id: job.contact_id, birthday_year: job.birthday_year, channel: job.channel, kind: job.kind, status: job.status, created_at: job.created_at, result: { reason: job.result?.reason || job.result?.error || '', providerMessageId: job.result?.providerMessageId || '' } });
const json = (statusCode, payload) => ({ statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(payload) });
const yearValue = value => { const year = Number(value); if (!Number.isInteger(year) || year < 2000 || year > 2100) D.problem('Select a year from 2000 to 2100.'); return year; };
function permission(access, key) {
  if (!access || access.role === 'project_user' || !(access.role === 'super_admin' || access.permissions?.[key] === true)) D.problem('Birthday Centre access denied.', 403);
}
function adminPassword(headers) {
  const supplied = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'x-admin-pin')?.[1];
  const expected = process.env.ADMIN_PIN || '';
  if (!expected) D.problem('Manage password is not configured (ADMIN_PIN).', 503);
  if (!supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) D.problem('Incorrect Manage password.', 403);
}
function automationPassword(headers) {
  const secret = process.env.N8N_WEBHOOK_SECRET || '';
  const supplied = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === 'x-csat-webhook-secret')?.[1] || '';
  if (secret.length < 16 || secret === 'replace-with-shared-secret') D.problem('Configure N8N_WEBHOOK_SECRET (at least 16 characters) for birthday automation.', 503);
  if (secret.length !== supplied.length || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) D.problem('Unauthorized birthday automation.', 401);
}
async function scopedContact(repo, id, access, includeRemoved = false) {
  if (!contactIdValid(id)) D.problem('Invalid birthday contact ID.');
  const contact = await repo.contact(id, includeRemoved);
  if (!contact) D.problem('Birthday contact not found.', 404);
  if (!D.canViewContact(contact, access)) D.problem('Birthday contact is outside your assigned clusters.', 403);
  return contact;
}
async function settingsFor(repo) { return { ...D.DEFAULT_SETTINGS, ...await repo.settings() }; }
async function superRecipients(store) {
  return D.unique((await store.listAppUsers()).filter(u => u.active && u.role === 'super_admin' && D.emailValid(u.email || '')).map(u => u.email.toLowerCase()));
}
function ownerRows(contact, directory) {
  return directory.internalPocs.filter(p => contact.internalPocIds.includes(p.id) && p.active !== false && D.emailValid(p.email || ''));
}
function actionUrl(baseUrl, payload) { return `${String(baseUrl).replace(/\/$/, '')}/api/automation/birthdays/action?token=${encodeURIComponent(D.actionToken(payload))}`; }
async function queueNotification({ repo, store, directory, settings, contact, occasion, kind, key, baseUrl, extra = '' }) {
  const owners = ownerRows(contact, directory);
  const supervisors = await superRecipients(store);
  let recipients;
  if (kind === 'decision') recipients = owners.map(p => ({ email: p.email.toLowerCase(), name: p.name, ownerId: p.id, purpose: 'decision' }));
  else if (kind === 'delivery') recipients = settings.deskEmails.map(email => ({ email, name: 'Desk Team', purpose: 'delivery' }));
  else {
    const addresses = kind === 'change_request' ? supervisors
      : ['missed_wish','escalation'].includes(kind) || (kind === 'pending_arrangement' && !occasion.gift) ? [...settings.notificationEmails, ...settings.deskEmails, ...supervisors]
      : [...owners.map(p => p.email), ...settings.deskEmails, ...supervisors];
    recipients = D.unique(addresses.map(e => e.toLowerCase())).filter(email => !(kind === 'birthday_today' && occasion.gift && occasion.gift !== 'No Gift' && occasion.stage !== 'Delivered' && settings.deskEmails.includes(email))).map(email => ({ email, name: 'Team' }));
  }
  if (!recipients.length) {
    return await repo.enqueue(contact, occasion.year, `${key}:missing-recipient`, kind, 'email', { to: [], subject: 'Birthday Recipient Configuration Required', error: kind === 'delivery' ? 'Configure Desk Email Recipients.' : 'No active owner / Super Admin email recipient is configured.' }) ? 1 : 0;
  }
  const labels = { decision: 'Birthday Gift Decision Required', escalation: 'Escalated — Birthday Gift Decision Pending',
    pending_arrangement: 'Birthday Tomorrow — Arrangement / Delivery Pending', delivery: 'Birthday Today — Confirm Gift Delivery',
    gift_selected: 'Birthday Gift Selection Recorded', change_request: 'Birthday Gift Change Approval Required', gift_changed: 'Birthday Gift Decision Updated', change_rejected: 'Birthday Gift Change Request Declined', missed_wish: 'Birthday WhatsApp Wish Skipped — Active Feedback', birthday_today: 'Today’s Birthday' };
  let queued = 0;
  for (const recipient of recipients) {
    const link = recipient.purpose ? actionUrl(baseUrl, { contactId: contact.id, year: occasion.year, purpose: recipient.purpose, email: recipient.email, ownerId: recipient.ownerId }) : '';
    const heading = labels[kind] || kind;
    const details = `Contact: ${contact.name}\nOrganisation: ${contact.organization}\nBirthday: ${D.birthdayDate(contact.birthday, occasion.year)}\nGift: ${occasion.gift || 'Awaiting decision'}\nStage: ${occasion.stage}\nResponsible POCs: ${owners.map(p => p.name).join(', ')}${contact.address ? `\nAddress: ${contact.address}` : ''}${extra ? `\n${extra}` : ''}`;
    const guidance = kind === 'delivery' ? 'Please confirm Delivered or Not Delivered. A reason is required for Not Delivered.'
      : kind === 'decision' ? 'Please choose the birthday gift. The first confirmed selection is shared by all responsible POCs; later changes require approval.' : '';
    const choices = kind === 'decision' ? settings.giftOptions.map(gift => ({ gift, url: `${link}&gift=${encodeURIComponent(gift)}` })) : [];
    const text = `Dear ${recipient.name},\n\n${heading}\n\n${details}\n\n${guidance}${choices.length ? '\n' + choices.map(c => `${c.gift}: ${c.url}`).join('\n') : link ? `\nOpen birthday action: ${link}` : ''}\nOpen Birthday Centre: ${baseUrl}/birthdays`;
    const buttons = choices.length ? choices.map(c => `<a href="${escapeEmail(c.url)}" style="display:inline-block;margin:5px;padding:10px 16px;border:1px solid #b71c26;color:#981922;background:#fff0f1;text-decoration:none">${escapeEmail(c.gift)}</a>`).join('') : link ? `<a href="${escapeEmail(link)}" style="display:inline-block;padding:12px 20px;background:#e51b23;color:white;text-decoration:none">Confirm Delivery</a>` : '';
    const html = `<h2 style="color:#981922">${escapeEmail(heading)}</h2><p>Dear ${escapeEmail(recipient.name)},</p><div style="white-space:pre-wrap">${escapeEmail(details)}</div><p>${escapeEmail(guidance)}</p><p>${buttons}</p><p><a href="${escapeEmail(baseUrl)}/birthdays">Open Birthday Centre</a></p>`;
    if (await repo.enqueue(contact, occasion.year, `${key}:${recipient.email}`, kind, 'email', { to: [recipient.email], subject: `${heading}: ${contact.name} · ${contact.organization}`, ...brandEmail({ title: 'Birthday Centre', text, html }) })) queued++;
  }
  return queued;
}
async function processEmailJobs(repo, send = sendEmail, contactIds = null) {
  const jobs = await repo.claim('email', contactIds), results = [];
  const settings = await settingsFor(repo);
  async function processOne(job) {
    if (!job.payload.to?.length) { await repo.finish(job.id, 'failed', { reason: job.payload.error || 'No email recipient configured.' }); return; }
    const current = await repo.contact(job.contact_id);
    if (!current || !current.active || (job.kind === 'wish' && (!current.emailEnabled || !settings.enabled))) {
      await repo.finish(job.id, 'cancelled', { reason: 'Contact removed, inactive or email wishes turned off.' }); return;
    }
    if (job.kind === 'wish' && D.birthdayDate(current.birthday, job.birthday_year) !== D.localDate().date) {
      await repo.finish(job.id, 'skipped', { reason: 'Birthday has passed; no late automatic wish.' }); return;
    }
    if (['decision','escalation','pending_arrangement','delivery'].includes(job.kind)) {
      const occasion = await repo.ensure(current, job.birthday_year);
      const decisionPending = ['decision','escalation'].includes(job.kind);
      if (occasion.historyCleared || !occasion.giftEligible || occasion.gift === 'No Gift' ||
          (decisionPending && occasion.gift) || (!decisionPending && occasion.stage === 'Delivered') ||
          (job.kind === 'delivery' && !occasion.gift)) {
        await repo.finish(job.id, 'cancelled', { reason: 'This birthday no longer needs this gift follow-up.' }); return;
      }
    }
    try {
      const result = await send(job.payload);
      await repo.finish(job.id, result.sent ? 'accepted' : 'failed', result);
      results.push({ id: job.id, status: result.sent ? 'accepted' : 'failed' });
    } catch (error) {
      // SMTP timeouts can occur after acceptance: no automatic blind resend.
      await repo.finish(job.id, 'unknown', { reason: error.message });
      results.push({ id: job.id, status: 'unknown' });
    }
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
    while (cursor < jobs.length) await processOne(jobs[cursor++]);
  }));
  return results;
}
async function runBirthdaySchedule({ repo, store, baseUrl, now = new Date() }) {
  const settings = await settingsFor(repo);
  // Recover unconfirmed send claims even when scheduled wishes are switched off.
  await repo.stale();
  if (!settings.enabled) return { enabled: false, queued: 0, emailResults: await processEmailJobs(repo) };
  const local = D.localDate(now), directory = await store.getDirectory();
  let queued = 0;
  const errors = [];
  const unfinished = await repo.unfinished();
  for (const contact of await repo.contacts()) {
    if (!contact.active) continue;
    try {
    const years = [local.year];
    if (D.daysUntil(contact.birthday, local.year + 1, local.date) <= 10) years.push(local.year + 1);
    const old = unfinished.filter(o => o.contactId === contact.id).map(o => o.year);
    for (const year of D.unique([...years, ...old])) {
      const days = D.daysUntil(contact.birthday, year, local.date);
      if (days > 10) continue;
      let occasion = await repo.ensure(contact, year);
      if (!occasion.historyCleared && local.hour >= 9) for (const kind of D.reminderKinds(contact, occasion, year, local.date)) {
        const count = await queueNotification({ repo, store, directory, settings, contact, occasion, kind, key: `auto:${contact.id}:${year}:${kind}:${kind === 'escalation' ? 'once' : local.date}`, baseUrl });
        if (count) occasion = await repo.change(contact, year, 'followup', kind, 'Birthday scheduler', previous => ({ ...previous, followupsStarted: true, escalated: previous.escalated || kind === 'escalation' }));
        queued += count;
      }
      if (days !== 0 || local.hour < 8) continue;
      if (local.hour >= 9 && (settings.notificationEmails.length || settings.deskEmails.length)) {
        await queueNotification({ repo, store, directory, settings, contact, occasion, kind: 'birthday_today', key: `today:${contact.id}:${year}`, baseUrl });
      }
      if (contact.emailEnabled && contact.email) {
        const salutation = contact.salutation || contact.name;
        await repo.enqueue(contact, year, `wish:${contact.identityKey}:${year}:email`, 'wish', 'email', {
          to: [contact.email], subject: `Happy Birthday, ${contact.name}!`,
          ...brandEmail({ title: 'Happy Birthday', text: `Dear ${salutation},\n\nWishing you a wonderful birthday and a happy, healthy and fulfilling year ahead.\n\nWarm birthday wishes from everyone at SRV Media.` }) });
      }
      if (contact.whatsappEnabled && contact.whatsappOptIn && contact.whatsapp) {
        await repo.enqueue(contact, year, `wish:${contact.identityKey}:${year}:whatsapp`, 'wish', 'whatsapp', {});
      }
    }
    } catch (e) {
      errors.push({ contactId: contact.id, error: e.message });
      await repo.enqueue(contact, local.year, `setup-error:${contact.id}:${local.date}`, 'setup_error', 'email', { to: [], error: e.message });
    }
  }
  return { enabled: true, queued, errors, emailResults: await processEmailJobs(repo) };
}
async function claimWhatsappJobs({ repo, store, baseUrl }) {
  const settings = await settingsFor(repo), jobs = await repo.claim('whatsapp'), result = [];
  for (const job of jobs) {
    const contact = await repo.contact(job.contact_id);
    if (!settings.enabled || !contact?.active || !contact.whatsappEnabled || !contact.whatsappOptIn) { await repo.finish(job.id, 'cancelled', { reason: 'Birthday WhatsApp sending is off.' }); continue; }
    const today = D.localDate().date;
    if (D.birthdayDate(contact.birthday, job.birthday_year) !== today) { await repo.finish(job.id, 'skipped', { reason: 'Birthday has passed; no late automatic wish.' }); continue; }
    const messaging = await store.getMessagingStatus();
    if (!messaging.enabled || !settings.whatsappTemplate) { await repo.finish(job.id, 'skipped', { reason: !messaging.enabled ? 'Global WhatsApp Messaging Paused' : 'Birthday Template Not Configured' }); continue; }
    const blockers = await repo.activeFeedback(contact);
    if (blockers.length) {
      await repo.finish(job.id, 'skipped', { reason: 'Active Feedback Cycle', projects: blockers });
      await queueNotification({ repo, store, directory: await store.getDirectory(), settings, contact, occasion: await repo.ensure(contact, job.birthday_year), kind: 'missed_wish', key: `missed:${contact.id}:${job.birthday_year}`, baseUrl,
        extra: `WhatsApp wish skipped because feedback is active: ${blockers.map(b => `${b.project_name} (${b.cycle_type})`).join(', ')}. It will not be sent automatically later.` });
      continue;
    }
    // Reserve transport identity before the provider can deliver a reply.
    await repo.prepareWhatsappRoute(job, contact, phoneHash(contact.whatsapp));
    result.push({ jobId: job.id, to: contact.whatsapp, template: settings.whatsappTemplate, language: settings.whatsappLanguage, name: contact.salutation || contact.name });
  }
  await processEmailJobs(repo);
  return result;
}
function actionPage({ token, contact, occasion, settings, purpose, requestedGift }) {
  const options = settings.giftOptions.map(gift => `<option value="${escapeEmail(gift)}"${gift === requestedGift ? ' selected' : ''}>${escapeEmail(gift)}</option>`).join('');
  const selected = occasion.gift ? `<p><strong>${escapeEmail(occasion.gift)}</strong> was selected by ${escapeEmail(occasion.selectedBy || 'an authorised user')} on ${escapeEmail(occasion.selectedAt || '')}.</p><p>You may request a change below. It will require approval.</p>` : '<p>No gift decision has been recorded yet.</p>';
  const fields = purpose === 'delivery' ? '<label>Delivery Status<select name="action" required><option value="">Select delivery status</option><option value="delivered">Delivered</option><option value="delivery_no">Not Delivered</option></select></label><label>Reason if not delivered<textarea name="reason" maxlength="1500"></textarea></label>'
    : `${selected}<input type="hidden" name="action" value="${occasion.gift ? 'request_change' : 'select'}"><label>${occasion.gift ? 'Requested Gift' : 'Select Gift'}<select name="gift" required><option value="">Select a gift</option>${options}</select></label><label>Special Gift Details<input name="specialGift" maxlength="200"></label><label>Reason for change<textarea name="reason" maxlength="1500" ${occasion.gift ? 'required' : ''}></textarea></label>`;
  const body = `<h2>${escapeEmail(contact.name)} · ${escapeEmail(contact.organization)}</h2><p>Birthday: ${D.birthdayDate(contact.birthday, occasion.year)} · ${escapeEmail(occasion.stage)}</p><form id="birthday-form">${fields}<button type="submit">${occasion.gift && purpose !== 'delivery' ? 'Submit Change Request' : 'Confirm'}</button></form><p id="result" role="status"></p><script>document.getElementById('birthday-form').addEventListener('submit',async function(e){e.preventDefault();const button=this.querySelector('button');button.disabled=true;try{const values=Object.fromEntries(new FormData(this));values.token=${JSON.stringify(token).replace(/</g, '\\u003c')};const response=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(values)});const result=await response.json();document.getElementById('result').textContent=result.message||result.error;if(response.ok)this.hidden=true;else button.disabled=false;}catch(e){document.getElementById('result').textContent='Unable to confirm. Please reload to check whether your selection was saved.';}});</script>`;
  return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' }, body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SRV Birthday Centre</title><style>body{font:16px Verdana,sans-serif;color:#24252b;background:#f5f4f4;margin:0;padding:24px}main{max-width:720px;margin:auto;background:white;padding:28px;border-top:6px solid #e51b23}label{display:block;margin:18px 0}input,select,textarea{box-sizing:border-box;display:block;width:100%;padding:12px;margin-top:8px;font:inherit}button{background:#b71c26;color:white;padding:14px;border:0;font:inherit;cursor:pointer}</style></head><body><main><h1>SRV Birthday Centre</h1>${body}</main></body></html>` };
}
async function applyOccasionAction({ repo, store, directory, settings, contact, year, body, actor, baseUrl }) {
  const action = body.action;
  const gift = body.gift === 'Special Gift' ? `Special Gift: ${String(body.specialGift || '').trim()}` : String(body.gift || '').trim();
  if (['select','request_change','change_gift'].includes(action) && (!settings.giftOptions.includes(body.gift) || (body.gift === 'Special Gift' && !String(body.specialGift || '').trim()) || gift.length > 240)) D.problem('Choose a standard gift and enter details for a special gift.');
  const reason = String(body.reason || '').trim().slice(0, 1500);
  let kind = null;
  let notificationExtra = '';
  const now = new Date().toISOString();
  const occasion = await repo.change(contact, year, 'gift', action, actor, previous => {
    if (previous.historyCleared) D.problem('This birthday history has been cleared. Start with a different birthday year.', 409);
    if (action === 'eligibility') return { ...previous, giftEligible: body.eligible === true };
    if (['select','request_change','change_gift'].includes(action) && !previous.giftEligible) D.problem('This birthday is not gift eligible. Enable eligibility for this year first.');
    if (action === 'select') { const selection = D.decideGift(previous, gift, actor, now); if (!selection.duplicate) kind = 'gift_selected'; return selection; }
    if (action === 'request_change') {
      if (!previous.gift) D.problem('Select the initial gift first.');
      if (!reason) D.problem('Explain why the gift should change.');
      if ((previous.changeRequests || []).some(r => r.status === 'pending' && r.actor === actor && r.gift === gift)) return { duplicate: true };
      kind = 'change_request';
      notificationExtra = `Requested Gift: ${gift}\nReason: ${reason}\nRequested By: ${actor}\nApproval is required in Birthday Centre.`;
      return { ...previous, changeRequests: [...(previous.changeRequests || []), { id: crypto.randomUUID(), gift, reason, actor, at: now, status: 'pending' }] };
    }
    if (action === 'approve' || action === 'reject') {
      const request = (previous.changeRequests || []).find(r => r.id === body.requestId && r.status === 'pending');
      if (!request) D.problem('This change request has already been handled.', 409);
      const after = { ...previous, changeRequests: previous.changeRequests.map(r => r.id === request.id ? { ...r, status: action === 'approve' ? 'approved' : 'rejected', reviewedBy: actor, reviewedAt: now } : r) };
      if (action === 'approve') { kind = 'gift_changed'; return { ...after, gift: request.gift, selectedBy: actor, selectedAt: now, stage: 'Gift Selected', deliveryReason: '', deliveredAt: null, arrangedAt: null }; }
      kind = 'change_rejected'; notificationExtra = `Requested Gift: ${request.gift}\nRequest declined by: ${actor}${reason ? `\nReview note: ${reason}` : ''}\nThe existing gift remains unchanged.`;
      return after;
    }
    if (action === 'change_gift') {
      if (!reason) D.problem('A reason is required when an authorised user changes the gift.');
      kind = 'gift_changed'; notificationExtra = `Changed By: ${actor}\nReason: ${reason}`;
      return { ...previous, gift, selectedBy: actor, selectedAt: now, changeReason: reason, stage: 'Gift Selected', deliveryReason: '', deliveredAt: null, arrangedAt: null };
    }
    if (!previous.gift || previous.gift === 'No Gift') D.problem('Select a gift before updating arrangement or delivery.');
    if (action === 'arranged') { if (previous.stage === 'Delivered') D.problem('A delivered gift cannot be moved back to Arranged.'); return previous.stage === 'Arranged' ? { duplicate: true } : { ...previous, stage: 'Arranged', arrangedAt: now, arrangedBy: actor }; }
    if (action === 'delivered') return previous.stage === 'Delivered' ? { duplicate: true } : { ...previous, stage: 'Delivered', deliveredAt: now, deliveredBy: actor, deliveryReason: '' };
    if (action === 'delivery_no') {
      if (!reason) D.problem('A reason is required for Not Delivered.');
      return { ...previous, stage: previous.stage === 'Delivered' ? 'Arranged' : previous.stage, deliveredAt: null, deliveryReason: reason, deliveryCheckedBy: actor, deliveryCheckedAt: now };
    }
    D.problem('Unknown birthday action.');
  });
  let notificationWarning = '';
  if (kind) try { await queueNotification({ repo, store, directory, settings, contact, occasion, kind, key: `${kind}:${occasion.id}:${occasion.version}`, baseUrl,
    extra: notificationExtra || `Decision recorded by: ${actor}` }); }
  catch (e) { notificationWarning = ` Update saved; email could not be queued: ${e.message}`; }
  // Save succeeds even when SMTP isn't configured; the dashboard exposes queued/failed mail.
  await processEmailJobs(repo, undefined, [contact.id]);
  const duplicateMessage = action === 'request_change' ? 'A matching change request is already awaiting approval.' : action === 'delivered' ? 'Delivery is already confirmed.' : action === 'arranged' ? 'The arrangement is already recorded.' : `${occasion.gift || 'The request'} is already recorded${occasion.selectedBy ? ` by ${occasion.selectedBy}` : ''}. Reload this page to request a change.`;
  return { occasion, message: (occasion.duplicate ? duplicateMessage : action === 'request_change' ? 'Your change request is saved for Super Admin / authorised Admin approval.' : 'Birthday update saved.') + notificationWarning };
}

async function handleBirthdayRequest({ store, access, request, pathname, method, body, searchParams, baseUrl, repository = null }) {
  try {
    if (!pathname.startsWith('/api/automation/birthdays')) permission(access, 'birthday_centre');
    const repo = repository || new BirthdayRepository(store);
    if (pathname === '/api/automation/birthdays/action') {
      const token = method === 'GET' ? searchParams.get('token') : body.token;
      const claim = D.readActionToken(token), contact = await repo.contact(claim.contactId);
      if (!contact?.active) D.problem('This birthday contact is no longer active.', 410);
      const settings = await settingsFor(repo), directory = await store.getDirectory();
      const owner = ownerRows(contact, directory).find(p => p.id === claim.ownerId && p.email.toLowerCase() === claim.email);
      if ((claim.purpose === 'decision' && !owner) || (claim.purpose === 'delivery' && !settings.deskEmails.includes(claim.email)) || !['decision','delivery'].includes(claim.purpose)) D.problem('This birthday link is no longer authorised.', 403);
      const year = yearValue(claim.year), occasion = await repo.ensure(contact, year);
      if (method === 'GET') return actionPage({ token, contact, occasion, settings, purpose: claim.purpose, requestedGift: searchParams.get('gift') });
      if (method !== 'POST') D.problem('Method not allowed.', 405);
      const allowed = claim.purpose === 'decision' ? ['select','request_change'] : ['delivered','delivery_no'];
      if (!allowed.includes(body.action)) D.problem('This link cannot perform that action.', 403);
      return json(200, await applyOccasionAction({ repo, store, directory, settings, contact, year, body, actor: owner ? `${owner.name} (${claim.email} email link)` : `Desk (${claim.email} email link)`, baseUrl }));
    }
    if (pathname.startsWith('/api/automation/birthdays')) {
      automationPassword(request.headers);
      if (method === 'POST' && pathname.endsWith('/run')) return json(200, await runBirthdaySchedule({ repo, store, baseUrl }));
      if (method === 'POST' && pathname.endsWith('/claim-whatsapp')) return json(200, { jobs: await claimWhatsappJobs({ repo, store, baseUrl }) });
      const callback = /^\/api\/automation\/birthdays\/jobs\/([^/]+)\/result$/.exec(pathname);
      if (method === 'POST' && callback && contactIdValid(callback[1])) {
        if (!['accepted','failed','unknown'].includes(body.status)) D.problem('Invalid send result.');
        if (body.status === 'accepted' && (typeof body.providerMessageId !== 'string' || !body.providerMessageId.trim() || body.providerMessageId.length > 300)) D.problem('A provider message ID is required for an accepted birthday WhatsApp wish.');
        const result = await repo.finish(callback[1], body.status, { providerMessageId: String(body.providerMessageId || '').slice(0, 300), reason: String(body.reason || '').slice(0, 1000) });
        // A late provider confirmation still establishes the reply identity even
        // if the outbox claim was already marked unknown by the timeout sweep.
        await repo.confirmWhatsappRoute(callback[1], body.status, String(body.providerMessageId || '').slice(0, 300));
        return json(200, { saved: Boolean(result) });
      }
      D.problem('Unknown birthday automation endpoint.', 404);
    }
    permission(access, 'birthday_centre');
    const year = yearValue(body.year || searchParams.get('year') || D.localDate().year);
    if (method === 'GET' && pathname === '/api/birthdays/replies') {
      const status = searchParams.get('status') || 'awaiting_review';
      const offset = Number(searchParams.get('offset') || 0);
      if (!['awaiting_review','reviewed','all'].includes(status) || !Number.isInteger(offset) || offset < 0 || offset > 100000) D.problem('Choose a valid birthday reply filter/page.');
      const ids = (await repo.contacts(true)).filter(c => D.canViewContact(c, access)).map(c => c.id);
      return json(200, await repo.replies(ids, year, { status, offset, search: String(searchParams.get('search') || '').slice(0,250) }));
    }
    const replyMatch = /^\/api\/birthdays\/replies\/([^/]+)\/review$/.exec(pathname);
    if (method === 'POST' && replyMatch) {
      permission(access, 'birthday_manage');
      if (!contactIdValid(replyMatch[1])) D.problem('Invalid birthday reply ID.');
      const reply = await repo.reply(replyMatch[1]);
      if (!reply || reply.status === 'history_cleared') D.problem('Birthday reply not found.', 404);
      await scopedContact(repo, reply.contact_id, access, true);
      const reviewed = await repo.reviewReply(reply.id, actorFor(access));
      if (!reviewed) D.problem('This birthday reply history was cleared. Reload before reviewing.', 409);
      return json(200, { reply: reviewed, message: `Birthday reply marked reviewed by ${reviewed.reviewed_by}. No automated response or CSAT update was sent.` });
    }
    if (method === 'GET' && pathname === '/api/birthdays') {
      const contacts = (await repo.contacts(true)).filter(c => D.canViewContact(c, access));
      const ids = contacts.map(c => c.id);
      const [occasions, events, jobs, directory, settings] = await Promise.all([repo.occasions(year), repo.events(ids, year), repo.jobs(ids, year), store.getDirectory(), settingsFor(repo)]);
      const clusters = directory.clusters.filter(c => access.role === 'super_admin' || access.clusterAccess.some(a => a.clusterId === c.id));
      const clusterIds = new Set(clusters.map(c => c.id));
      const browserJobs = jobs.map(browserJobRow);
      return json(200, { contacts, occasions: occasions.filter(o => ids.includes(o.contactId)), events, jobs: browserJobs, year,
        directory: { clusters, internalPocs: directory.internalPocs.filter(p => access.role === 'super_admin' || (p.clusterIds || [p.clusterId]).some(id => clusterIds.has(id))).map(p => ({ id: p.id, name: p.name, email: p.email, active: p.active })), clientPocs: directory.clientPocs.filter(p => access.role === 'super_admin' || clusterIds.has(p.clusterId)).map(p => ({ id: p.id, name: p.name, clientName: p.clientName, projectName: p.projectName, birthDate: p.birthDate, contactEmail: p.contactEmail, contactWhatsapp: p.contactWhatsapp, designation: p.designation, salutation: p.salutation, clusterId: p.clusterId })) },
        settings: access.role === 'super_admin' ? settings : { enabled: settings.enabled, giftOptions: settings.giftOptions },
        smtpConfigured: require('./email').smtpConfigured() });
    }
    const historyMatch = /^\/api\/birthdays\/contacts\/([^/]+)\/history$/.exec(pathname);
    if (method === 'GET' && historyMatch) {
      const contact = await scopedContact(repo, historyMatch[1], access, true);
      const [events, jobs] = await Promise.all([repo.events([contact.id], year), repo.jobs([contact.id], year)]);
      return json(200, { events, jobs: jobs.map(browserJobRow), historyLimit: 2000 });
    }
    if (method === 'PUT' && pathname === '/api/birthdays/settings') {
      if (access.role !== 'super_admin') D.problem('Only Super Admin can change birthday settings.', 403);
      const emails = key => { if (!Array.isArray(body[key]) || body[key].some(e => !D.emailValid(e))) D.problem(`Enter valid ${key}.`); return D.unique(body[key].map(e => e.toLowerCase())); };
      const giftOptions = D.unique((body.giftOptions || []).map(g => String(g).trim()).filter(Boolean));
      if (!giftOptions.includes('No Gift') || !giftOptions.includes('Special Gift') || giftOptions.length > 30 || giftOptions.some(g => g.length > 100)) D.problem('Keep Special Gift and No Gift in the catalogue (maximum 30 options).');
      if (body.whatsappTemplate && !/^[a-z0-9_]+$/.test(body.whatsappTemplate)) D.problem('Enter the approved WhatsApp template name.');
      const settings = { enabled: body.enabled === true, deskEmails: emails('deskEmails'), notificationEmails: emails('notificationEmails'), giftOptions,
        whatsappTemplate: String(body.whatsappTemplate || ''), whatsappLanguage: String(body.whatsappLanguage || 'en').slice(0, 10), updatedBy: actorFor(access) };
      await repo.saveSettings(settings); return json(200, { settings });
    }
    if (method === 'POST' && pathname === '/api/birthdays/contacts') {
      permission(access, 'birthday_manage');
      const directory = await store.getDirectory(), rows = body.contacts;
      if (!Array.isArray(rows) || !rows.length || rows.length > 500) D.problem('Submit between 1 and 500 birthday contacts.');
      const existing = await repo.contacts(), byId = new Map(existing.map(c => [c.id, c]));
      const prepared = rows.map((row, i) => {
        const old = row.id ? byId.get(row.id) : null;
        if (row.id && (!old || !D.canViewContact(old, access))) D.problem(`Row ${i + 1}: birthday contact is unavailable.`, 403);
        try { return { ...D.normalizeContact(row, directory, access, old), ...(old ? { id: old.id, version: Number(row.version) } : {}) }; }
        catch (e) { e.message = `Row ${i + 1}: ${e.message}`; throw e; }
      });
      if (D.unique(prepared.map(c => c.identityKey)).length !== prepared.length) D.problem('The upload contains duplicate birthday contacts.');
      const allContacts = await repo.contacts(true);
      const duplicates = (a,b) => a.identityKey === b.identityKey || (a.whatsapp && a.whatsapp === b.whatsapp) || (a.email && a.email === b.email && a.name.toLowerCase() === b.name.toLowerCase() && a.birthday === b.birthday);
      if (prepared.some((c,i) => prepared.slice(0,i).some(old => duplicates(c,old)) || allContacts.some(old => old.id !== c.id && duplicates(c,old)))) D.problem('A contact already exists with this WhatsApp number or email. Export its ID to update it, or restore it if removed.', 409);
      if (body.preview === true) return json(200, { valid: true, count: prepared.length });
      return json(200, { contacts: await repo.saveContacts(prepared, actorFor(access)) });
    }
    if (method === 'PUT' && pathname === '/api/birthdays/bulk-channels') {
      permission(access, 'birthday_manage');
      if (!['emailEnabled','whatsappEnabled','active'].includes(body.field)) D.problem('Unknown birthday switch.');
      const ids = D.unique(Array.isArray(body.contactIds) ? body.contactIds : []);
      if (!ids.length || ids.length > 500) D.problem('Select 1–500 contacts explicitly.');
      const directory = await store.getDirectory(), rows = [];
      for (const id of ids) { const old = await scopedContact(repo, id, access); rows.push({ ...D.normalizeContact({ [body.field]: body.enabled === true }, directory, access, old), id, version: old.version }); }
      return json(200, { contacts: await repo.saveContacts(rows, actorFor(access)) });
    }
    if (method === 'DELETE' && pathname === '/api/birthdays/history') {
      permission(access, 'birthday_cleanup'); adminPassword(request.headers);
      if (!['followup','wish','gift','all'].includes(body.kind)) D.problem('Choose a cleanup section.');
      const ids = D.unique(Array.isArray(body.contactIds) ? body.contactIds : []);
      if (!ids.length || ids.length > 500 || body.confirmation !== 'DELETE') D.problem('Select contacts and confirm DELETE.');
      for (const id of ids) await scopedContact(repo, id, access, true);
      return json(200, { deletedEvents: await repo.cleanup(ids, year, body.kind, actorFor(access)), message: 'Selected birthday history cleared. Contacts and minimal resend protection retained.' });
    }
    if (method === 'POST' && pathname === '/api/birthdays/reminders') {
      permission(access, 'birthday_reminders');
      const ids = D.unique(Array.isArray(body.contactIds) ? body.contactIds : []);
      if (!ids.length || ids.length > 100 || !['decision','delivery','pending_arrangement'].includes(body.kind)) D.problem('Select up to 100 contacts and a reminder type.');
      const directory = await store.getDirectory(), settings = await settingsFor(repo);
      // Validate the whole selection before any email is queued.
      const contacts = await Promise.all(ids.map(id => scopedContact(repo, id, access)));
      const occasions = await Promise.all(contacts.map(c => repo.ensure(c, year)));
      if (contacts.some((c, i) => !c.active || !occasions[i].giftEligible || occasions[i].gift === 'No Gift' || occasions[i].historyCleared || (body.kind === 'decision' && occasions[i].gift) || (body.kind !== 'decision' && (!occasions[i].gift || occasions[i].stage === 'Delivered')))) D.problem('One or more selected birthdays do not need this reminder.');
      const requestId = String(body.requestId || '').slice(0, 80);
      if (!requestId) D.problem('A reminder request ID is required.');
      for (let i = 0; i < contacts.length; i++) {
        await queueNotification({ repo, store, directory, settings, contact: contacts[i], occasion: occasions[i], kind: body.kind, key: `manual:${requestId}:${contacts[i].id}:${year}`, baseUrl });
        await repo.change(contacts[i], year, 'followup', 'Manual Reminder', actorFor(access), o => ({ ...o, followupsStarted: true }));
      }
      return json(200, { results: await processEmailJobs(repo, undefined, ids), message: 'Reminder requests recorded. Review email status below for acceptance or failure.' });
    }
    const contactMatch = /^\/api\/birthdays\/contacts\/([^/]+)$/.exec(pathname);
    if (contactMatch && method === 'DELETE') {
      permission(access, 'birthday_manage'); adminPassword(request.headers);
      const contact = await scopedContact(repo, contactMatch[1], access);
      await repo.remove(contact.id); return json(200, { message: 'Contact removed from birthday flows. CSAT records were preserved.' });
    }
    const restoreMatch = /^\/api\/birthdays\/contacts\/([^/]+)\/restore$/.exec(pathname);
    if (restoreMatch && method === 'POST') {
      permission(access, 'birthday_manage');
      const contact = await scopedContact(repo, restoreMatch[1], access, true);
      await repo.restore(contact.id); return json(200, { message: 'Birthday contact restored as inactive with both wish channels OFF. Edit it before reactivation.' });
    }
    const actionMatch = /^\/api\/birthdays\/contacts\/([^/]+)\/action$/.exec(pathname);
    if (actionMatch && method === 'POST') {
      permission(access, 'birthday_manage');
      const contact = await scopedContact(repo, actionMatch[1], access);
      if (!['select','change_gift','approve','reject','arranged','delivered','delivery_no','eligibility'].includes(body.action)) D.problem('Unknown birthday action.');
      return json(200, await applyOccasionAction({ repo, store, directory: await store.getDirectory(), settings: await settingsFor(repo), contact, year, body, actor: actorFor(access), baseUrl }));
    }
    D.problem('Birthday endpoint not found.', 404);
  } catch (e) {
    if (!e.status || e.status >= 500) console.error('[birthday]', e.message);
    return json(e.status || (e.code === '42P01' ? 503 : 500), { error: e.status ? e.message : e.code === '42P01' ? 'Birthday Centre database setup is pending. Run migrations 024 and 025 before enabling this feature.' : 'Birthday Centre request failed. Please reload and check the saved status before retrying.' });
  }
}
module.exports = { handleBirthdayRequest, runBirthdaySchedule, claimWhatsappJobs, processEmailJobs, applyOccasionAction, queueNotification, permission, automationPassword, adminPassword };

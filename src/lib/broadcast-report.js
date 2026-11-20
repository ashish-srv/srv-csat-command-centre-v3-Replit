const statusLabels = { queued: 'Queued', sending: 'Sending', accepted: 'Accepted by WhatsApp', sent: 'Sent', delivered: 'Delivered', read: 'Read', failed: 'Failed', unknown: 'Confirmation Missing', skipped: 'Skipped' };
const replyLabels = { awaiting_response: 'Awaiting Our Response', responded: 'Responded', no_reply: 'No Reply' };
const label = value => statusLabels[value] || value || '';
const unique = values => [...new Set(values.filter(Boolean))].join(', ');
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(value)) : '';
const replyStatus = row => !row.latestReplyAt ? 'No Reply' : !row.lastStaffReplyAt || Date.parse(row.latestReplyAt) > Date.parse(row.lastStaffReplyAt) ? 'Awaiting Our Response' : 'Responded';
const column = (key, title, width=24) => ({ key, label: title, width });
const dateColumn = (key, title) => ({ ...column(key,title,26), numberFormat: 'dd mmm yyyy hh:mm' });
function excelDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const part = type => Number(parts.find(item => item.type === type).value);
  return new Date(Date.UTC(part('year'),part('month')-1,part('day'),part('hour'),part('minute'),part('second')));
}

export function buildBroadcastReport(data) {
  const recipients = data.recipients || [];
  if (!recipients.length) throw new Error('No broadcast records match these filters. Clear or change the filters and try again.');
  const filters = data.filters || {};
  const campaigns = new Map();
  const byRecipient = new Map();
  for (const message of data.messages || []) {
    if (!byRecipient.has(message.recipientId)) byRecipient.set(message.recipientId, []);
    byRecipient.get(message.recipientId).push(message);
  }
  for (const row of recipients) {
    if (!campaigns.has(row.broadcastId)) campaigns.set(row.broadcastId, { id: row.broadcastId, title: row.title,
      created: timestamp(row.createdAt), createdDate: excelDate(row.createdAt), creator: row.createdBy, template: row.templateName, language: row.language,
      recipients: 0, delivered: 0, read: 0, awaiting: 0, failed: 0, skipped: 0, queued: 0, replied: 0 });
    const campaign = campaigns.get(row.broadcastId);
    campaign.recipients++;
    if (['delivered','read'].includes(row.status)) campaign.delivered++;
    if (row.status === 'read') campaign.read++;
    if (['accepted','sent','unknown'].includes(row.status)) campaign.awaiting++;
    if (['queued','sending'].includes(row.status)) campaign.queued++;
    if (row.status === 'failed') campaign.failed++;
    if (row.status === 'skipped') campaign.skipped++;
    if (row.latestReplyAt) campaign.replied++;
  }
  const history = [...campaigns.values()].map(row => ({ ...row,
    announcement: `${row.title}\n${row.template || 'Earlier content removed'}${row.language ? ` · ${row.language}` : ''}`,
    createdSummary: `${row.created}\n${row.creator || ''}`,
    deliverySummary: `Recipients: ${row.recipients}\nDelivered (incl. Read): ${row.delivered}\nRead: ${row.read}\nAwaiting confirmation: ${row.awaiting}\nQueued / Sending: ${row.queued}`,
    responseSummary: `Failed: ${row.failed}\nSkipped: ${row.skipped}\nWith client reply: ${row.replied}`
  }));
  const rows = recipients.map(row => {
    const names = unique(row.associations.map(poc => poc.name));
    const associations = unique(row.associations.map(poc => `${poc.clientName || 'Client not set'} → ${poc.projectName || 'Project not set'}${poc.reason ? ` (${poc.reason})` : ''}`));
    const deliveryAt = timestamp(row.deliveryAt);
    const retryAt = timestamp(row.retryAfter);
    return { title: row.title, template: row.templateName, names, phone: row.phone, associations,
      status: label(row.status), reason: row.reason, code: row.errorCode, created: timestamp(row.createdAt),
      sent: timestamp(row.sentAt || row.dispatchAt), updated: deliveryAt, retry: retryAt,
      createdDate: excelDate(row.createdAt), sentDate: excelDate(row.sentAt || row.dispatchAt), updatedDate: excelDate(row.deliveryAt), retryDate: excelDate(row.retryAfter), replyDate: excelDate(row.latestReplyAt),
      replyStatus: replyStatus(row), latestReply: row.latestReply, replyTime: timestamp(row.latestReplyAt),
      person: `${names}\n${row.phone || 'Number unavailable'}`,
      delivery: [label(row.status), row.reason, row.errorCode && `Meta code: ${row.errorCode}`, deliveryAt && `Updated: ${deliveryAt}`, retryAt && `Retry no earlier than: ${retryAt}`].filter(Boolean).join('\n'),
      reply: [row.latestReply || 'No reply received', timestamp(row.latestReplyAt), replyStatus(row)].filter(Boolean).join('\n') };
  });
  const chats = [];
  const chatRows = [];
  for (const recipient of recipients) {
    const saved = byRecipient.get(recipient.id) || [];
    const title = `${recipient.title} · ${unique(recipient.associations.map(poc => poc.name))} · ${recipient.phone || 'Number unavailable'}`;
    const context = unique(recipient.associations.map(poc => `${poc.clientName} → ${poc.projectName}`));
    const messages = [];
    if (!recipient.removedAt) messages.push({ side: 'srv', speaker: 'SRV Media · Announcement',
      message: recipient.message, time: `${timestamp(recipient.sentAt || recipient.dispatchAt || recipient.createdAt)} IST · ${label(recipient.status)}` });
    for (const message of saved) messages.push({ side: message.side, speaker: message.side === 'client' ? unique(recipient.associations.map(poc => poc.name)) || 'Client' : 'SRV Media',
      message: message.body, time: [timestamp(message.at), 'IST', message.side === 'srv' && label(message.status), message.error].filter(Boolean).join(' · ') });
    chats.push({ title: `${title}\n${context}`, messages });
    chatRows.push({ conversationHeading: `${title}\n${context}${recipient.removedAt ? '\nEarlier announcement and chat content removed.' : ''}` });
    for (const message of messages) chatRows.push({ speaker: message.speaker, time: message.time, message: message.message });
  }
  return { title: 'WhatsApp Broadcast Report', subtitle: data.section === 'history' ? 'Announcement History, Recipients and Conversations' : 'Broadcast Replies and Delivery',
    broadcast: true, generatedAt: data.generatedAt, generatedAtExcel: excelDate(data.generatedAt), timeZone: 'Asia/Kolkata', timeZoneLabel: 'IST', metricsTitle: 'Delivery Summary', filters: [
      { label: 'Scope', value: data.section === 'history' ? 'All accessible announcement history' : filters.campaignId ? unique(recipients.map(row => row.title)) : 'All accessible broadcasts' },
      { label: 'Delivery Status', value: filters.statuses?.length ? filters.statuses.map(label).join(', ') : 'All' },
      { label: 'Reply Status', value: filters.replies?.length ? filters.replies.map(value => replyLabels[value]).join(', ') : 'All' },
      { label: 'Latest Reply Dates (IST)', value: `${filters.from || 'Any start'} to ${filters.to || 'Any end'}` },
      { label: 'Search', value: filters.search || 'All' }
    ], metrics: [
      { label: 'Announcements', value: campaigns.size }, { label: 'Recipient Groups', value: recipients.length },
      { label: 'Delivered (incl. Read)', value: recipients.filter(row => ['delivered','read'].includes(row.status)).length },
      { label: 'Failed', value: recipients.filter(row => row.status === 'failed').length },
      { label: 'Skipped', value: recipients.filter(row => row.status === 'skipped').length },
      { label: 'With Client Reply', value: recipients.filter(row => row.latestReplyAt).length }
    ], sections: [
      { title: 'Announcement History', sheetName: 'Announcements', note: 'Counts reflect the report filters. Accepted or Sent is awaiting delivery confirmation. Dates and times are IST.', rows: history,
        columns: [column('title','Announcement',35),dateColumn('createdDate','Created (IST)'),column('creator','Created By',30),column('template','Template',30),column('language','Language',12),column('recipients','Recipient Groups',18),column('delivered','Delivered (incl. Read)',23),column('read','Read',12),column('awaiting','Awaiting Confirmation',24),column('failed','Failed',12),column('skipped','Skipped',12),column('queued','Queued / Sending',20),column('replied','With Client Reply',20)],
        htmlColumns: [column('announcement','Announcement'),column('createdSummary','Created (IST) / By'),column('deliverySummary','Delivery'),column('responseSummary','Responses')] },
      { title: 'Recipients, Replies and Delivery', sheetName: 'Recipients', note: 'Shared numbers have one recipient record per announcement. Skipped groups retain the reason they were excluded. Dates and times are IST.', rows,
        columns: [column('title','Announcement',35),column('names','POCs',30),column('phone','WhatsApp Number',22),column('associations','Clients / Projects',45),column('status','Delivery Status'),column('reason','Failure / Skipped Reason',50),column('code','Meta Error Code',18),dateColumn('createdDate','Created (IST)'),dateColumn('sentDate','Submitted (IST)'),dateColumn('updatedDate','Delivery Updated (IST)'),dateColumn('retryDate','Retry No Earlier Than (IST)'),column('replyStatus','Reply Status'),column('latestReply','Latest Client Reply',55),dateColumn('replyDate','Latest Reply Time (IST)')],
        htmlColumns: [column('title','Announcement'),column('person','POC / Number'),column('associations','Clients / Projects'),column('delivery','Delivery / Reason'),column('reply','Latest Reply')] },
      { title: 'Original Conversations', sheetName: 'Conversations', note: 'Saved announcement and chat text, grouped by announcement and recipient. Skipped or failed announcements retain their delivery status above; a saved announcement does not prove receipt.',
        columns: [column('speaker','Speaker',30),column('time','Time / Delivery (IST)',35),column('message','Original Message',100)], rows: chatRows, chatSessions: chats }
    ] };
}

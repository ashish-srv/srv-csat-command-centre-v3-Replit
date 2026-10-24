const { normalizeClusterAccess } = require('./cluster-access');

// These events remain local audit records. They must not dispatch per-message
// emails or a second completion email in addition to the consolidated summary.
const SAVED_ONLY = new Set(['feedback_received', 'manager_alert', 'client_question', 'wrong_person', 'opt_out', 'escalation']);
const HANDOFF = new Set(['handoff', 'post_completion_message']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function emailRecipients(users, clusterId, handoff = false) {
  return [...new Set(users.filter(user => user.active !== false && (user.role === 'super_admin'
    || (!handoff && user.role === 'admin' && normalizeClusterAccess(user.clusterAccess, user.role).some(row => row.clusterId === clusterId && row.emailEnabled))))
    .map(user => String(user.email || '').trim().toLowerCase()).filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
}

function emailReport(eventType, payload) {
  const handoff = HANDOFF.has(eventType);
  const quick = payload.summaryType === 'quick_checkin_poc';
  const title = handoff ? 'Human Handoff — Review Required' : quick ? 'Quick Check-in — Completed Feedback' : 'Completed Feedback Summary';
  const session = payload.session || payload.sessions?.[0] || {};
  const csat = session.csatSource === 'predicted' ? null : payload.csatScore ?? session.csatScore;
  const entries = [
    ['Cluster', payload.project?.clusterName], ['Client', payload.project?.clientName], ['Project', payload.project?.name],
    ['Client POC', payload.poc?.name || session.pocName], ['Feedback Type', quick ? 'Quick Check-in' : payload.cycle?.cycleType || session.sessionType],
    ['CSAT', quick ? 'Not collected' : csat == null ? 'Not provided' : `${csat}/10`],
    ['NPS', quick ? 'Not collected' : (payload.npsScore ?? session.npsScore) == null ? 'Not provided' : `${payload.npsScore ?? session.npsScore}/10`],
    ...(!quick && session.csatSource === 'predicted' ? [['Estimated CSAT (Not Client Rating)', `${session.csatScore}/10`]] : [])
  ];
  const sections = [
    ['Concerns', (payload.issues || []).map(row => row.description || row.rootCause || row.title)],
    ['Appreciation', (payload.appreciations || []).map(row => row.detail || row.text || row.title)],
    ['Suggestions, Requests and Other Feedback', (payload.observations || []).map(row => row.detail || row.text || row.title)],
    ['Client Questions', (payload.clientQuestions || []).map(row => row.text)],
    ...(handoff ? [['Message Needing Human Review', [payload.clientText]]] : [])
  ].map(([name, values]) => [name, values.filter(Boolean)]).filter(([, values]) => values.length);
  const messages = (payload.messages || []).filter(row => row.body);
  const transcript = messages.map(row => ({ speaker: row.speaker || (row.side === 'client' ? payload.poc?.name || 'Client' : 'SRV Media'), time: row.createdAt || row.created_at || '', body: row.body, client: row.side === 'client' }));
  const text = [title, ...entries.map(([name, value]) => `${name}: ${value || 'Not set'}`),
    ...sections.map(([name, values]) => `\n${name}\n${values.join('\n')}`), '\nConversation Transcript',
    ...transcript.map(row => `${row.speaker} · ${row.time}\n${row.body}`)].join('\n');
  const html = `<div style="font-family:Verdana,Arial,sans-serif;color:#172b43;font-size:14px;line-height:1.6;max-width:900px;margin:auto"><h1 style="font-size:22px;background:#e8f0ff;color:#153b71;padding:20px">${escape(title)}</h1><table style="width:100%;border-collapse:collapse">${entries.map(([name, value]) => `<tr><th style="text-align:left;padding:8px;border-bottom:1px solid #d8e1ef">${escape(name)}</th><td style="padding:8px;border-bottom:1px solid #d8e1ef">${escape(value || 'Not set')}</td></tr>`).join('')}</table>${sections.map(([name, values]) => `<h2 style="font-size:17px;background:#eef5f5;padding:10px;color:#164d4c">${escape(name)}</h2><ul>${values.map(value => `<li style="white-space:pre-wrap">${escape(value)}</li>`).join('')}</ul>`).join('')}<h2 style="font-size:17px;background:#eef5f5;padding:10px">Conversation Transcript</h2>${transcript.map(row => `<div style="margin:12px ${row.client ? '40px 12px 0' : '0 12px 40px'};padding:12px;border:1px solid #ccd8e8;border-radius:10px;background:${row.client ? '#f0f7ff' : '#f2faf4'}"><strong>${escape(row.speaker)}</strong><div style="font-size:12px;color:#43536b">${escape(row.time)}</div><div style="white-space:pre-wrap">${escape(row.body)}</div></div>`).join('')}</div>`;
  return { subject: `${title} | ${payload.project?.name || 'Project'} | ${payload.poc?.name || session.pocName || 'Client POC'}`, html, text };
}

async function prepareCsatEmail(store, eventType, payload) {
  if (SAVED_ONLY.has(eventType)) return { suppressed: true, reason: 'included_in_completed_poc_summary' };
  if (eventType !== 'cycle_completed' && !HANDOFF.has(eventType)) return { payload };
  if (eventType === 'cycle_completed' && !['quick_checkin_poc', 'feedback_poc'].includes(payload.summaryType)) return { suppressed: true, reason: 'per_poc_summary_only' };
  const users = typeof store.listAppUsers === 'function' ? await store.listAppUsers() : [];
  const project = payload.project?.clusterId ? payload.project : await store.getProjectById(payload.project?.id);
  const superAdmins = emailRecipients(users, null, true);
  if (!superAdmins.length) return { blocked: true, reason: 'No active Super Admin email is configured' };
  const recipients = emailRecipients(users, project?.clusterId, HANDOFF.has(eventType));
  let messages = payload.messages || [];
  if (HANDOFF.has(eventType) && payload.session?.id && typeof store.getMessagesForSession === 'function') messages = await store.getMessagesForSession(payload.session.id);
  const routed = { ...payload, project: project || payload.project, messages, recipients, mandatoryRecipients: superAdmins,
    recipientPolicy: 'cluster_admins_v1', emailPolicyVersion: 1 };
  return { payload: { ...routed, email: { ...emailReport(eventType, routed), to: recipients } } };
}

module.exports = { SAVED_ONLY, HANDOFF, emailRecipients, emailReport, prepareCsatEmail };

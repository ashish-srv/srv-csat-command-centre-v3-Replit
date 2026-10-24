const { normalizeClusterAccess } = require('./cluster-access');
const { brandEmail, EMAIL_COLORS } = require('./email-theme');

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
  const c = EMAIL_COLORS;
  const heading = name => `<h2 style="font-size:17px;line-height:1.5;background:${c.section};border-left:4px solid ${c.accent};padding:10px 12px;margin:24px 0 12px;color:${c.sectionInk}">${escape(name)}</h2>`;
  const html = `<table style="width:100%;border-collapse:collapse;font-size:14px">${entries.map(([name, value]) => `<tr><th scope="row" style="text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid ${c.border};color:${c.heading}">${escape(name)}</th><td style="padding:10px 12px;border-bottom:1px solid ${c.border};color:${c.ink}">${escape(value || 'Not set')}</td></tr>`).join('')}</table>
${sections.map(([name, values]) => `${heading(name)}<ul style="padding-left:24px;margin:12px 0">${values.map(value => `<li style="white-space:pre-wrap;margin:8px 0">${escape(value)}</li>`).join('')}</ul>`).join('')}
${heading('Conversation Transcript')}
${transcript.map(row => `<div style="margin:12px ${row.client ? '24px 12px 0' : '0 12px 24px'};padding:14px;border:1px solid ${c.border};border-left:3px solid ${row.client ? '#777078' : c.accent};border-radius:6px;background:${row.client ? c.clientBubble : c.teamBubble}"><strong style="color:${c.heading}">${escape(row.speaker)}</strong><div style="font-size:12px;color:${c.muted}">${escape(row.time)}</div><div style="white-space:pre-wrap;margin-top:6px">${escape(row.body)}</div></div>`).join('')}`;
  return { subject: `${title} | ${payload.project?.name || 'Project'} | ${payload.poc?.name || session.pocName || 'Client POC'}`, ...brandEmail({ title, html, text }) };
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

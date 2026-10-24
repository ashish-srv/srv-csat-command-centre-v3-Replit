// These self-contained functions are embedded in the importable n8n Code nodes.
// Keep workflow copies byte-for-byte in sync; n8n-email-workflows-smoke checks it.
function buildPolicyEmail(body, kind, now = Date.now()) {
  const blocked = reason => ({ allowed: false, reason, to: '', recipients: [] });
  if (kind === 'manager') return blocked('included_in_completed_poc_summary');
  if (!body || typeof body !== 'object' || Array.isArray(body)) return blocked('invalid_payload');
  if (kind === 'handoff' && !['handoff', 'post_completion_message'].includes(body.eventType)) {
    return blocked('not_an_explicit_human_handoff');
  }
  if (kind === 'summary' && (body.eventType !== 'cycle_completed'
    || !['feedback_poc', 'quick_checkin_poc'].includes(body.summaryType))) return blocked('per_poc_summary_only');
  if (body.emailPolicyVersion !== 1 || body.recipientPolicy !== 'cluster_admins_v1') return blocked('application_policy_required');
  const addresses = values => {
    if (!Array.isArray(values) || !values.length) return null;
    const valid = values.every(value => typeof value === 'string'
      && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value.trim()));
    return valid ? [...new Set(values.map(value => value.trim().toLowerCase()))] : null;
  };
  const recipients = addresses(body.recipients);
  const mandatory = addresses(body.mandatoryRecipients);
  const emailTo = addresses(body.email?.to);
  const same = (a, b) => a.length === b.length && a.every(value => b.includes(value));
  if (!recipients || !mandatory || !emailTo) return blocked('valid_recipients_and_super_admin_required');
  if (!mandatory.every(value => recipients.includes(value))) return blocked('mandatory_super_admin_missing');
  if (!same(recipients, emailTo)) return blocked('recipient_lists_disagree');
  if (kind === 'handoff' && !same(recipients, mandatory)) return blocked('handoff_super_admins_only');
  const email = body.email;
  if (typeof email.subject !== 'string' || !email.subject.trim() || /[\r\n]/.test(email.subject)
    || typeof email.html !== 'string' || !email.html.trim()
    || typeof email.text !== 'string' || !email.text.trim()) return blocked('application_email_template_required');
  if (kind === 'summary') {
    if (!body.project?.id || !body.poc?.id || !Array.isArray(body.sessions) || body.sessions.length !== 1
      || !body.sessions[0]?.id) return blocked('single_poc_session_required');
    const session = body.sessions[0];
    if ((session.projectId && session.projectId !== body.project.id)
      || (session.clientPocId && session.clientPocId !== body.poc.id)) return blocked('session_scope_mismatch');
    const state = session.conversationState || {};
    for (const value of [state.closingGraceExpiresAt, state.quickCheckinWindowExpiresAt].filter(Boolean)) {
      const deadline = Date.parse(value);
      if (!Number.isFinite(deadline)) return blocked('invalid_response_window');
      if (deadline > now) return blocked('response_window_still_open');
    }
    if (!Array.isArray(body.messages)) return blocked('transcript_array_required');
    if (body.messages.some(message => !message || (message.sessionId && message.sessionId !== session.id))) {
      return blocked('transcript_scope_mismatch');
    }
  }
  // Never re-derive recipients from service owners, managers, or a Config node.
  // Timing, cluster authorization and durable send-once claims belong to the app.
  return { allowed: true, to: recipients.join(','), recipients, subject: email.subject,
    html: email.html, text: email.text, summaryType: body.summaryType || null };
}

function smtpAcceptance(result, expected) {
  const normalize = list => Array.isArray(list) ? list.map(item => String(typeof item === 'string' ? item : item?.address || '').trim().toLowerCase()) : [];
  const accepted = normalize(result?.accepted);
  const rejected = normalize(result?.rejected);
  const recipients = normalize(expected?.recipients);
  const sent = !result?.error && recipients.length > 0 && rejected.length === 0
    && recipients.every(email => accepted.includes(email));
  return { ok: sent, sent, reason: sent ? 'smtp_accepted' : 'smtp_acceptance_not_confirmed_for_all_recipients',
    inboxDeliveryVerified: false, acceptedCount: accepted.length, rejectedCount: rejected.length,
    messageId: result?.messageId || null };
}

module.exports = { buildPolicyEmail, smtpAcceptance };

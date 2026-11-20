const { sessionIsTerminal } = require('./supabase-store');
const { whatsappNumber } = require('./whatsapp-recipients');

function quickCheckinClosed(session, now = Date.now()) {
  if (session?.sessionType !== 'quick_checkin') return false;
  const state = session.conversationState || {};
  if (state.stoppedByAdmin || state.optedOut || state.reminderExhausted
    || ['stopped','handed_off','opted_out'].includes(state.state)) return true;
  const deadline = Date.parse(state.state === 'quick_checkin_window' ? state.quickCheckinWindowExpiresAt || '' : session.reminderDueAt || '');
  if (state.state === 'quick_checkin_window' && deadline > now && session.status !== 'opted_out'
    && !state.optedOut && !state.stoppedByAdmin && !state.reminderExhausted) return false;
  return sessionIsTerminal(session) || (Number.isFinite(deadline) && deadline <= now);
}

// Called only after the button's original session and sender have been verified.
// Broadcast/birthday isolation runs first; visitor controls never enter this path.
function activeFeedbackCandidate(candidate, body, now = Date.now()) {
  const { session, poc } = candidate || {};
  if (!session || !poc || !['pulse','project_end','quick_checkin'].includes(session.sessionType)
    || session.clientPocId !== poc.id || poc.active === false || poc.removedAt
    || (session.channel && session.channel !== 'whatsapp')
    || !whatsappNumber(body.from) || whatsappNumber(poc.contactWhatsapp) !== whatsappNumber(body.from)) return null;
  const state = session.conversationState || {};
  if (session.status === 'opted_out' || state.optedOut || state.stoppedByAdmin
    || state.reminderExhausted || ['handed_off','opted_out','stopped'].includes(state.state)) return null;
  if (session.sessionType === 'quick_checkin') {
    if (quickCheckinClosed(session, now)) return null;
  } else {
    const grace = Date.parse(session.conversationState?.closingGraceExpiresAt || '');
    if (Number.isFinite(grace) && grace <= now) return null;
    if (sessionIsTerminal(session) && !(session.conversationState?.state === 'closing_grace' && grace > now)) return null;
  }
  const started = Date.parse(session.startedAt || '');
  if (!Number.isFinite(started)) return null;
  const providerSeconds = Number(body.providerTimestamp);
  if (Number.isFinite(providerSeconds) && providerSeconds > 0 && providerSeconds * 1000 + 999 < started) return null;
  return { session, poc };
}

function newerSurveyForClosedQuickCheckin(source, routing, body, now = Date.now()) {
  if (!quickCheckinClosed(source, now)) return null;
  const candidates = routing?.status === 'active' ? [routing]
    : routing?.status === 'ambiguous' && source.projectId
      ? (routing.candidates || []).filter(item => item.session?.projectId === source.projectId) : [];
  // The verified button identifies its project, not a choice between two open
  // sessions in that project. Never pick by recency among ambiguous candidates.
  if (candidates.length !== 1) return null;
  const current = activeFeedbackCandidate(candidates[0], body, now);
  const previous = Date.parse(source.startedAt || '');
  if (!current || current.session.id === source.id || !Number.isFinite(previous)
    || Date.parse(current.session.startedAt) <= previous) return null;
  return current;
}

function resumedFeedbackIntro(project, session) {
  const name = String(project?.name || 'your project').replace(/\s+/g, ' ').trim();
  const type = { pulse: '30-day feedback', project_end: 'project-end feedback', quick_checkin: 'quick check-in' }[session.sessionType] || 'feedback';
  return `Let’s continue your current ${type} for ${name}.`;
}

function preferredResumedFeedback(candidates, body, now = Date.now()) {
  const newestStart = Math.max(...candidates.map(item => Date.parse(item.session?.startedAt || '') || Infinity));
  const providerAt = Number(body.providerTimestamp) > 0 ? Number(body.providerTimestamp) * 1000 + 999 : now;
  const selected = candidates.filter(item => {
    const at = Date.parse(item.session?.conversationState?.templateResumedAt || '');
    return at >= newestStart && at <= providerAt;
  }).sort((a,b) => Date.parse(b.session.conversationState.templateResumedAt) - Date.parse(a.session.conversationState.templateResumedAt));
  if (!selected.length || (selected[1] && selected[0].session.conversationState.templateResumedAt === selected[1].session.conversationState.templateResumedAt)) return null;
  return activeFeedbackCandidate(selected[0], body, now);
}

module.exports = { quickCheckinClosed, newerSurveyForClosedQuickCheckin, activeFeedbackCandidate, resumedFeedbackIntro, preferredResumedFeedback };

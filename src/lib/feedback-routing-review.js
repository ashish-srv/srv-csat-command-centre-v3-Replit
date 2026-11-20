const crypto = require('node:crypto');
const { whatsappNumber } = require('./whatsapp-recipients');

const EVENT = 'feedback_routing_review';
const REASONS = {
  unavailable_button: 'The earlier feedback button could not be verified. No feedback session was changed.',
  ambiguous_projects: 'More than one feedback session is open and the intended project could not be identified safely.'
};

function reviewDedupeKey(body) {
  return `feedback_routing_review:${crypto.createHash('sha256').update(`${whatsappNumber(body.from)}:${body.providerMessageId || crypto.randomUUID()}`).digest('hex')}`;
}

function canReviewFeedbackRouting(row, access, projects) {
  if (access?.role === 'super_admin') return true;
  const ids = row.payload?.projectIds || [];
  const allowed = new Set(projects.map(project => project.id));
  return access?.role === 'admin' && ids.length > 0 && ids.every(id => allowed.has(id));
}

async function recordFeedbackRoutingReview(store, body, reason, pocs, messagingEnabled) {
  const from = whatsappNumber(body.from);
  // A review is an internal queue entry, never a concern, rating or email.
  const dedupeKey = reviewDedupeKey(body);
  const reply = 'Thank you. I couldn’t identify the current feedback request from this message, so I have saved it for our team to review. Please contact your SRV representative if you need to continue immediately.';
  const payload = {
    from, clientText: String(body.text || ''), reason, reasonText: REASONS[reason],
    pocName: pocs[0]?.name || String(body.fromName || 'Unknown contact'),
    projectIds: [...new Set(pocs.map(poc => poc.projectId).filter(Boolean))],
    providerMessageId: body.providerMessageId || null,
    replyText: messagingEnabled ? reply : null
  };
  const claim = await store.claimAutomationEvent(EVENT, payload, dedupeKey);
  if (!claim) return { duplicate: true, sendToWhatsapp: false, routedTo: 'feedback_review' };
  // The pending claim itself is the durable inbox item; there is no later
  // claim-completion step that could strand a review after a process crash.
  return { sendToWhatsapp: messagingEnabled, whatsappReplyText: messagingEnabled ? reply : '',
    routedTo: 'feedback_review', reviewId: claim.id, messagingPaused: !messagingEnabled };
}

async function pendingFeedbackRoutingReviews(store) {
  const result = [];
  for (let offset = 0; ; offset += 200) {
    const rows = await store.request('automation_events', { query: `event_type=eq.${EVENT}&status=eq.pending&select=*&order=created_at.desc,id.desc&limit=200&offset=${offset}` });
    result.push(...rows.filter(row => row.event_type === EVENT));
    if (rows.length < 200) return result;
  }
}

module.exports = { EVENT, REASONS, reviewDedupeKey, canReviewFeedbackRouting, recordFeedbackRoutingReview, pendingFeedbackRoutingReviews };

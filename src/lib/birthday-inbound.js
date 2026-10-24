const crypto = require('node:crypto');
const { BirthdayRepository } = require('./birthday-repository');
const { phone } = require('./birthday-domain');

const phoneHash = value => crypto.createHash('sha256').update(phone(value)).digest('hex');
const replyResult = (reply, duplicate = false) => ({
  sendToWhatsapp: false, whatsappReplyText: '', routedTo: 'birthday_review',
  birthdayReplyId: reply.id, classification: reply.classification, duplicate
});

// A transport-layer guard, not an interpreter: no keyword lists, Gemini calls,
// inferred sentiment, CSAT writes, handoffs or outbound messages belong here.
async function captureBirthdayInbound({ store, body, routing, repository = null }) {
  if (!repository && !store.pool) return null;
  const repo = repository || new BirthdayRepository(store);
  const sender = phone(body.from);
  if (!/^[1-9]\d{7,14}$/.test(sender)) return null;
  const hash = phoneHash(sender);
  const messageId = String(body.providerMessageId || '');
  const replyTo = String(body.replyToMessageId || '');
  const seconds = Number(body.providerTimestamp);
  const providerSentAt = Number.isFinite(seconds) && seconds > 946684800 && seconds * 1000 <= Date.now() + 300000
    ? new Date(seconds * 1000).toISOString() : null;
  // Provider timestamps have second precision. Include the remainder of that
  // second, but do not let a delayed old delivery attach to a newer wish.
  const notAfter = providerSentAt ? new Date(seconds * 1000 + 999).toISOString() : new Date().toISOString();
  let evidence;
  try { evidence = await repo.birthdayRoutingEvidence(hash, messageId, replyTo, notAfter); }
  catch (error) {
    // Deploying the application before birthday migrations must not change CSAT.
    if (error.code === '42P01') return null;
    throw error;
  }
  if (evidence.duplicate) return replyResult(evidence.duplicate, true);
  const exact = evidence.quoted;
  if (!exact && !evidence.latest) return null;
  // An old CSAT delivery replay must stay with its original duplicate handler.
  if (messageId && typeof store.hasProviderMessage === 'function' && await store.hasProviderMessage(messageId)) return null;
  let target = exact;
  if (!target) {
    // Never steal a survey button, active survey turn, or a known other thread.
    // Before the birthday sender confirms its outgoing ID, a quoted reply is
    // still ambiguous: keep it for review rather than answer from an old survey.
    if ((replyTo && evidence.latest.provider_message_id) || body.buttonPayload || ['active','ambiguous'].includes(routing?.status)) return null;
    const lastCsat = await repo.latestCsatOutbound(sender, notAfter);
    if (lastCsat && new Date(lastCsat).getTime() >= new Date(evidence.latest.dispatched_at).getTime()) return null;
    target = evidence.latest;
  }
  if (!messageId || messageId.length > 500 || replyTo.length > 500) {
    const error = new Error('A valid provider message ID is required to save this birthday reply safely.');
    error.status = 400; throw error;
  }
  const reply = await repo.saveBirthdayReply(target, {
    providerMessageId: messageId, replyToMessageId: replyTo || null,
    text: String(body.text || ''), fromName: String(body.fromName || '').slice(0, 250),
    providerSentAt,
    classification: exact ? 'birthday' : 'manual_review'
  });
  return replyResult(reply, reply.duplicate === true);
}

module.exports = { captureBirthdayInbound, phoneHash };

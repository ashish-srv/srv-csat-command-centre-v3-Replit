const crypto = require('node:crypto');
const { BroadcastRepository } = require('./broadcast-repository');
const { BirthdayRepository } = require('./birthday-repository');
const { whatsappNumber } = require('./whatsapp-recipients');

function result(message, duplicate = false) {
  return { sendToWhatsapp: false, whatsappReplyText: '', routedTo: 'broadcast', broadcastReplyId: message.id, duplicate };
}

async function captureBroadcastInbound({ store, body, repository }) {
  if (!repository && !store.pool) return null;
  const phone = whatsappNumber(body.from);
  if (!phone) return null;
  const repo = repository || new BroadcastRepository(store);
  const messageId = String(body.providerMessageId || '');
  const replyTo = String(body.replyToMessageId || '');
  const seconds = Number(body.providerTimestamp);
  const providerAt = Number.isFinite(seconds) && seconds > 946684800 && seconds * 1000 <= Date.now() + 300000
    ? new Date(seconds * 1000).toISOString() : null;
  const before = providerAt ? new Date(seconds * 1000 + 999).toISOString() : new Date().toISOString();
  let evidence;
  try { evidence = await repo.routingEvidence(phone, messageId, replyTo, before); }
  catch (error) { if (error.code === '42P01') return null; throw error; }
  if (evidence.duplicate) return result(evidence.duplicate, true);
  if (!evidence.latest) return null;
  if (messageId && typeof store.hasProviderMessage === 'function' && await store.hasProviderMessage(messageId)) return null;
  let birthday;
  if (!evidence.quoted && store.pool) {
    try {
      birthday = await new BirthdayRepository(store).birthdayRoutingEvidence(crypto.createHash('sha256').update(phone).digest('hex'), messageId, replyTo, before);
      // A retry must stay with its original inbox even after a later campaign.
      if (birthday.duplicate) return null;
    } catch (error) { if (error.code !== '42P01') throw error; }
  }

  // A newer survey owns all subsequent replies, including after it closes.
  // Announcement reply references never override that agreed priority.
  const feedbackAt = await repo.latestFeedbackStart(phone, before);
  const broadcastAt = evidence.latest.sent_at || evidence.latest.dispatch_at;
  if (feedbackAt && Date.parse(feedbackAt) >= Date.parse(broadcastAt)) return null;
  if (birthday?.quoted || (birthday?.latest && Date.parse(birthday.latest.dispatched_at) > Date.parse(broadcastAt))) return null;
  if (!messageId || messageId.length > 300 || replyTo.length > 300) throw Object.assign(new Error('A valid WhatsApp provider message ID is required to record the broadcast reply.'), { status: 400 });
  const recipient = evidence.quoted || evidence.latest;
  const message = await repo.saveIncoming(recipient, { messageId, replyTo, text: String(body.text || '').trim(), providerAt });
  return result(message);
}

module.exports = { captureBroadcastInbound };

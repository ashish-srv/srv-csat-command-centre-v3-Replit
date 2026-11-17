function whatsappNumber(value) {
  const text = String(value || '').trim();
  if (/[a-z]/i.test(text)) return '';
  const number = text.replace(/\D/g, '');
  return /^[1-9]\d{7,14}$/.test(number) ? number : '';
}

function recipientReason(poc) {
  if (poc.removedAt) return 'POC Removed';
  if (!poc.active) return 'POC Inactive';
  if (!String(poc.contactWhatsapp || '').trim()) return 'WhatsApp Number Missing';
  if (!whatsappNumber(poc.contactWhatsapp)) return 'Invalid WhatsApp Number';
  return '';
}

async function feedbackRecipients(store, candidates) {
  const eligible = [];
  const skipped = [];
  const includedNumbers = new Set();
  for (const poc of candidates) {
    const phone = whatsappNumber(poc.contactWhatsapp);
    let reason = recipientReason(poc);
    if (!reason && includedNumbers.has(phone)) reason = 'WhatsApp Number Already Included';
    if (!reason && typeof store.whatsappContactOptedOut === 'function' && await store.whatsappContactOptedOut(phone)) reason = 'WhatsApp Messaging Opt-Out';
    if (!reason) {
      const routing = await store.getWhatsappRoutingContext(phone);
      if (['active', 'ambiguous'].includes(routing.status)) {
        const session = routing.session || routing.candidates?.[0]?.session;
        const project = session?.projectId && typeof store.getProjectById === 'function' ? await store.getProjectById(session.projectId) : null;
        reason = `Active Feedback in Progress${project?.name ? ` on ${project.name}` : ''}`;
      }
    }
    if (!reason && typeof store.whatsappSendInProgress === 'function' && await store.whatsappSendInProgress(phone)) {
      reason = 'Broadcast Sending in Progress';
    }
    if (reason) skipped.push({ id: poc.id, name: poc.name, whatsapp: poc.contactWhatsapp || '', reason });
    else {
      includedNumbers.add(phone);
      eligible.push({ ...poc, contactWhatsapp: phone });
    }
  }
  return { eligible, skipped };
}

function explicitOptOut(text) {
  return /^(?:stop|unsubscribe|opt[ -]?out|do not (?:message|contact) me(?: again)?|don't (?:message|contact) me(?: again)?)[.!\s]*$/i.test(String(text || '').trim());
}

module.exports = { whatsappNumber, recipientReason, feedbackRecipients, explicitOptOut };

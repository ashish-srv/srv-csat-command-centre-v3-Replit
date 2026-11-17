// Delivery receipts are independent of CSAT intent/state processing.
function deliveryEvent(event, now = Date.now()) {
  if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 300 || !['sent','delivered','read','failed'].includes(event.status)) return null;
  const failed = event.status === 'failed';
  const error = event.errors?.[0] || {};
  const code = failed && /^\d{1,10}$/.test(String(error.code)) ? String(error.code) : null;
  const seconds = Number(event.timestamp);
  const at = Number.isFinite(seconds) && seconds > 0 && seconds * 1000 <= now + 300000 ? seconds * 1000 : now;
  const detail = error.error_data?.details || error.title || error.message || 'WhatsApp delivery failed';
  return { id: event.id, status: event.status, reason: failed ? `${code ? `Meta ${code}: ` : ''}${String(detail)}`.slice(0,1000) : '',
    errorCode: code, deliveryAt: new Date(at).toISOString(), retryAfter: code === '131049' ? new Date(at + 86400000).toISOString() : null };
}

function retryBlock(row, now = Date.now()) {
  if (row.deleted_at) return 'This announcement history has been removed.';
  if (row.status !== 'failed') return 'Only a confirmed failed delivery can be retried. Awaiting confirmation does not mean delivery failed.';
  if (row.retry_recipient_id) return 'A retry has already been created. Open that attempt to check its result.';
  const code = row.error_code || (/Meta\s+(\d+)/i.exec(row.reason || '') || [])[1];
  if (code === '131049') {
    const after = Date.parse(row.retry_after || '') || (Date.parse(row.delivery_at || row.dispatch_at || row.sent_at || '') + 86400000);
    if (!Number.isFinite(after)) return 'The failure time is unavailable. Restore the delivery receipt before retrying.';
    if (now < after) return `Meta marketing limit: wait until ${new Date(after).toISOString()} before retrying. Delivery is not guaranteed after this time.`;
  }
  return '';
}

module.exports = { deliveryEvent, retryBlock };

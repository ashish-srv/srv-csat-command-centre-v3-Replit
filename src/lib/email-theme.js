// Shared presentation only: no changes to delivery, recipients or conversation state.
const EMAIL_COLORS = Object.freeze({
  accent: '#e51b23', heading: '#24252b', ink: '#25272b', muted: '#59545a',
  background: '#f5f4f4', border: '#e4dddd', section: '#fff0f1', sectionInk: '#981922',
  clientBubble: '#f6f6f8', teamBubble: '#fff7f7'
});
const EMAIL_SIGNATURE = 'Best Regards,\nAshish Kate';
const escapeEmail = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function brandEmail({ title = 'CSAT Command Centre', html = '', text = '' }) {
  const plain = String(text).trimEnd();
  const signedText = plain.endsWith(EMAIL_SIGNATURE) ? plain : `${plain}${plain ? '\n\n' : ''}${EMAIL_SIGNATURE}`;
  // Allow an already formatted app email to pass through the SMTP helper once.
  if (String(html).includes('data-srv-email-theme="v1"')) return { html, text: signedText };
  const c = EMAIL_COLORS;
  const unsignedText = plain.endsWith(EMAIL_SIGNATURE) ? plain.slice(0, -EMAIL_SIGNATURE.length).trimEnd() : plain;
  const content = html || `<div style="white-space:pre-wrap">${escapeEmail(unsignedText)}</div>`;
  return { text: signedText, html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:${c.background}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" data-srv-email-theme="v1" style="background:${c.background};font-family:Verdana,Arial,sans-serif;color:${c.ink};font-size:15px;line-height:1.65">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:760px;background:#ffffff;border:1px solid ${c.border};border-top:6px solid ${c.accent}">
<tr><td style="background:${c.heading};padding:24px;color:#ffffff">
<div style="font-size:13px;font-weight:bold;letter-spacing:2px;color:#ffd6d8;margin-bottom:8px">SRV MEDIA</div>
<h1 style="margin:0;font-size:23px;line-height:1.4;font-weight:bold;color:#ffffff">${escapeEmail(title)}</h1>
</td></tr>
<tr><td style="padding:24px;overflow-wrap:anywhere;word-break:break-word">${content}</td></tr>
<tr><td data-srv-email-signature="ashish-kate" style="padding:20px 24px 24px;border-top:1px solid ${c.border};color:${c.ink}">
Best Regards,<br><strong style="font-size:16px;color:${c.sectionInk}">Ashish Kate</strong>
</td></tr></table>
</td></tr></table></body></html>` };
}

module.exports = { brandEmail, EMAIL_COLORS, EMAIL_SIGNATURE, escapeEmail };

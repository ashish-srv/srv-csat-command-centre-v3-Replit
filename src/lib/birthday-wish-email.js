const { escapeEmail } = require('./email-theme');

const BIRTHDAY_SIGNATURE = 'Best Regards,\nSRV Media';

function birthdayWishEmail(contact, baseUrl = '') {
  const fullName = contact.name;
  let imageUrl = '';
  try {
    const url = new URL('/images/birthday-celebration-v1.gif', baseUrl);
    if (['https:', 'http:'].includes(url.protocol)) imageUrl = url.href;
  } catch { /* The greeting is complete even without a public image URL. */ }
  const text = [
    'Dear ' + fullName + ',',
    'Happy Birthday! 🎂🌸',
    'Wishing you a beautiful day filled with happiness, laughter and the people who make you smile.',
    'May the year ahead bring you good health, wonderful opportunities and plenty of special moments to celebrate. It is a pleasure to be connected with you, and all of us at SRV Media send you our warmest wishes today.',
    'Here’s to a lovely birthday and a bright, fulfilling year ahead! ✨',
    BIRTHDAY_SIGNATURE
  ].join('\n\n');
  const image = imageUrl
    ? '<img src="' + escapeEmail(imageUrl) + '" width="480" height="190" alt="A birthday cake with glowing candles, flowers and celebratory confetti" style="display:block;width:100%;max-width:480px;height:auto;border:0;margin:0 auto">'
    : '<div style="font-size:50px;line-height:1.5" aria-label="Birthday cake and flowers">🎂 🌸 🎉</div>';
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Happy Birthday from SRV Media</title></head>',
    '<body style="margin:0;padding:0;background:#fff9f3">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" data-srv-email-theme="v1" data-srv-email-kind="birthday-wish" style="background:#fff9f3;font-family:Verdana,Arial,sans-serif;color:#394b5d;font-size:15px;line-height:1.8">',
    '<tr><td align="center" style="padding:28px 12px">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid #f0dbd2;border-radius:20px;overflow:hidden">',
    '<tr><td align="center" style="padding:25px 24px 18px;background:#fff5dc;border-top:6px solid #f4c667">',
    '<div style="font-size:12px;font-weight:bold;letter-spacing:3px;color:#dd1f26">SRV MEDIA</div>',
    '<p style="font-size:13px;color:#845e78;margin:14px 0 4px">A little celebration, just for you</p>',
    '<h1 style="font-size:32px;line-height:1.35;color:#dc5b72;margin:6px 0 4px">Happy Birthday! 🎉</h1>',
    image,
    '</td></tr>',
    '<tr><td style="padding:26px 28px 12px;overflow-wrap:anywhere">',
    '<p style="font-size:17px;font-weight:bold;color:#23776c;margin:0 0 18px">Dear ' + escapeEmail(fullName) + ',</p>',
    '<p style="margin:0 0 18px">Wishing you a beautiful day filled with <strong style="color:#23776c">happiness, laughter</strong> and the people who make you smile. 🌸</p>',
    '<p style="margin:0 0 18px">May the year ahead bring you good health, wonderful opportunities and plenty of special moments to celebrate. It is a pleasure to be connected with you, and all of us at SRV Media send you our warmest wishes today.</p>',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="padding:18px;background:#eaf8ef;border:1px solid #c9e7d9;border-radius:12px;color:#23776c;font-weight:bold">Here’s to a lovely birthday and a bright, fulfilling year ahead! ✨</td></tr></table>',
    '</td></tr>',
    '<tr><td data-srv-email-signature="srv-media" style="padding:20px 28px 28px;color:#394b5d">Best Regards,<br><strong style="font-size:17px;color:#dd1f26">SRV Media</strong></td></tr>',
    '<tr><td align="center" style="padding:14px;background:#fff0f3;color:#845e78;font-size:12px">Warm wishes from all of us at SRV Media 🌷</td></tr>',
    '</table></td></tr></table></body></html>'
  ].join('\n');
  return { subject: 'Happy Birthday, ' + contact.name + '! 🎂', text, html };
}

module.exports = { birthdayWishEmail, BIRTHDAY_SIGNATURE };

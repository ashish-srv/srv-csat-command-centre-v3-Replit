const assert = require('node:assert/strict');
const { brandEmail, EMAIL_COLORS, EMAIL_SIGNATURE } = require('../src/lib/email-theme');
const { emailReport } = require('../src/lib/csat-email-policy');
let checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const count = (value, part) => value.split(part).length - 1;
function verify(mail) {
  check(mail.text.endsWith(EMAIL_SIGNATURE), true);
  check(count(mail.text, EMAIL_SIGNATURE), 1);
  check(count(mail.html, 'data-srv-email-signature="ashish-kate"'), 1);
  check(count(mail.html, 'Best Regards,'), 1);
  check(mail.html.includes('Verdana,Arial,sans-serif'), true);
  check(mail.html.includes(EMAIL_COLORS.accent), true);
  check(mail.html.includes(EMAIL_COLORS.heading), true);
  check(mail.html.indexOf('data-srv-email-signature') > mail.html.lastIndexOf('END OF ORIGINAL CONTENT'), true);
  check(brandEmail(mail), { html: mail.html, text: mail.text });
}

async function main() {
  for (const [eventType, summaryType] of [['cycle_completed', 'feedback_poc'], ['cycle_completed', 'quick_checkin_poc'],
    ['handoff', undefined], ['post_completion_message', undefined]]) {
    for (const cycleType of ['pulse', 'project_end']) {
      const payload = { summaryType, cycle: { cycleType }, project: { name: 'Test <script>alert(1)</script>' },
        poc: { name: 'Test POC' }, csatScore: 9, npsScore: 10,
        issues: [{ title: 'Reporting & turnaround' }], observations: [{ detail: 'Industry visit request' }],
        appreciations: [{ detail: 'Helpful team' }], clientText: 'Please help <&>',
        messages: [{ side: 'client', body: 'Original feedback <&> END OF ORIGINAL CONTENT', metadata: { interpretation: 'HIDDEN_INTERPRETATION' } }] };
      const mail = emailReport(eventType, payload);
      verify(mail);
      check(mail.html.includes('<script>'), false);
      check(mail.html.includes('Original feedback &lt;&amp;&gt; END OF ORIGINAL CONTENT'), true);
      check(mail.text.includes('Original feedback <&> END OF ORIGINAL CONTENT'), true);
      check(mail.html.includes('HIDDEN_INTERPRETATION'), false);
      check(mail.subject.includes('Best Regards'), false);
    }
  }
  verify(brandEmail({ title: 'Project setup', text: 'New project created. END OF ORIGINAL CONTENT', html: '<p>New project created. END OF ORIGINAL CONTENT</p>' }));
  verify(brandEmail({ title: '<unsafe>', text: '<script>END OF ORIGINAL CONTENT</script>' }));
  check(brandEmail({ title: '<unsafe>', text: 'Text only' }).html.includes('<unsafe>'), false);
  verify(brandEmail({ text: `Already signed. END OF ORIGINAL CONTENT\n\n${EMAIL_SIGNATURE}` }));

  // Exercise the actual shared SMTP entry point without sending anything.
  const nodemailer = require('nodemailer');
  const originalTransport = nodemailer.createTransport;
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
  const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const sent = [];
  try {
    Object.assign(process.env, { SMTP_HOST: 'fixture.invalid', SMTP_PORT: '587', SMTP_USER: 'test@example.test',
      SMTP_PASSWORD: 'fixture-only', SMTP_FROM: 'sender@example.test' });
    nodemailer.createTransport = () => ({ sendMail: async mail => { sent.push(mail); return { messageId: 'mock-only' }; } });
    const { sendEmail } = require('../src/lib/email');
    for (const subject of ['New client added', 'New project needs review', 'Service change approval needed']) {
      const result = await sendEmail({ to: ['admin@example.test'], subject, text: 'Details. END OF ORIGINAL CONTENT', html: '<h2>Review Required</h2><p>Details. END OF ORIGINAL CONTENT</p>' });
      check(result.sent, true);
      const mail = sent.at(-1);
      verify(mail);
      check(mail.to, ['admin@example.test']);
      check(mail.subject, subject);
      check(mail.from, 'sender@example.test');
    }
    const branded = brandEmail({ text: 'END OF ORIGINAL CONTENT' });
    await sendEmail({ to: 'admin@example.test', subject: 'Already branded', ...branded });
    verify(sent.at(-1));
  } finally {
    nodemailer.createTransport = originalTransport;
    for (const key of keys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
  }
  console.log(`${checks} email theme/signature checks passed. SMTP mocked; no real emails sent.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

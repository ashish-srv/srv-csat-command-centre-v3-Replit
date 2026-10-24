const { brandEmail } = require('./email-theme');

let transporter = null;
let transporterKey = "";

function boolSetting(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function smtpSettings() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || "").trim();
  const password = String(process.env.SMTP_PASSWORD || "").trim();
  const secure = boolSetting(process.env.SMTP_SECURE, port === 465);
  const from = String(process.env.SMTP_FROM || user).trim();
  return {
    configured: Boolean(host && Number.isInteger(port) && port > 0 && user && password && from),
    host, port, user, password, secure, from
  };
}

function smtpConfigured() {
  return smtpSettings().configured;
}

function recipientList(value) {
  return [...new Set(String(value || "").split(/[;,]/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

async function sendEmail({ to, subject, text, html }) {
  const settings = smtpSettings();
  if (!settings.configured) return { configured: false, sent: false, error: "SMTP is not configured" };
  const recipients = Array.isArray(to) ? recipientList(to.join(",")) : recipientList(to);
  if (!recipients.length) return { configured: true, sent: false, error: "No recipients configured" };

  const key = JSON.stringify([settings.host, settings.port, settings.user, settings.secure]);
  if (!transporter || transporterKey !== key) {
    const nodemailer = require("nodemailer");
    transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
      connectionTimeout: 12_000,
      greetingTimeout: 12_000,
      socketTimeout: 20_000
    });
    transporterKey = key;
  }
  const branded = brandEmail({ html, text });
  const info = await transporter.sendMail({ from: settings.from, to: recipients, subject, ...branded });
  return { configured: true, sent: true, messageId: info.messageId || null, recipients };
}

module.exports = { recipientList, sendEmail, smtpConfigured, smtpSettings };

const crypto = require('node:crypto');

const STAGES = ['Awaiting Decision', 'Gift Selected', 'Arranged', 'Delivered'];
const DEFAULT_SETTINGS = { enabled: false, deskEmails: [], notificationEmails: [],
  giftOptions: ['Cake + Plant', 'Cake', 'Plant', 'Bouquet', 'Special Gift', 'No Gift'],
  whatsappTemplate: '', whatsappLanguage: 'en' };
const emailValid = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const unique = values => [...new Set(values.filter(Boolean))];
const phone = value => String(value || '').replace(/\D/g, '');
function problem(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function localDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, year: Number(get('year')), hour: Number(get('hour')) };
}
function birthdayDate(monthDay, year) {
  const date = `${year}-${monthDay}`;
  // Feb 29 is observed on Feb 28 in non-leap years; the stored birthday stays Feb 29.
  return monthDay === '02-29' && new Date(`${date}T12:00:00Z`).getUTCMonth() !== 1 ? `${year}-02-28` : date;
}
function daysUntil(monthDay, year, today) {
  return Math.round((Date.parse(`${birthdayDate(monthDay, year)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}
function normalizeContact(input, directory, access, existing = null) {
  const text = (key, max = 250) => { const value = String(input[key] ?? existing?.[key] ?? '').trim(); if (value.length > max) problem(`${key} must be at most ${max} characters.`); return value; };
  const name = text('name'), organization = text('organization');
  const rawBirthday = text('birthday');
  if (!/^(?:\d{4}-)?\d{2}-\d{2}$/.test(rawBirthday)) problem('Birthday must be MM-DD or YYYY-MM-DD.');
  const birthday = rawBirthday.slice(-5);
  if (!name || !organization) problem('Contact name and organisation are required.');
  const birthdayMs = Date.parse(`2000-${birthday}T00:00:00Z`);
  if (!/^\d{2}-\d{2}$/.test(birthday) || !Number.isFinite(birthdayMs) || new Date(birthdayMs).toISOString().slice(5, 10) !== birthday) problem('Birthday must be a valid MM-DD or YYYY-MM-DD date.');
  const email = text('email').toLowerCase(), whatsapp = phone(text('whatsapp'));
  if (email && !emailValid(email)) problem('Enter a valid contact email.');
  if (whatsapp && !/^[1-9]\d{7,14}$/.test(whatsapp)) problem('WhatsApp number must include the country code (8–15 digits).');
  const clusterId = input.clusterId === undefined ? existing?.clusterId || null : input.clusterId || null;
  if (clusterId && !directory.clusters.some(c => c.id === clusterId)) problem('Select a standard cluster.');
  const ids = input.internalPocIds ?? existing?.internalPocIds ?? [];
  if (!Array.isArray(ids) || !ids.length) problem('Assign at least one responsible Internal POC.');
  const owners = unique(ids).map(id => directory.internalPocs.find(p => p.id === id && p.active !== false));
  if (!owners.length || owners.some(p => !p || !emailValid(p.email || ''))) problem('Every assigned Internal POC must be active and have a valid email.');
  const visibleClusters = new Set((access.clusterAccess || []).map(c => c.clusterId));
  if (access.role !== 'super_admin' && (!visibleClusters.has(clusterId) || owners.some(p => !(p.clusterIds || [p.clusterId]).some(id => visibleClusters.has(id))))) problem('Contact or owner is outside your assigned clusters.', 403);
  const linkedPocIds = input.linkedPocIds ?? existing?.linkedPocIds ?? [];
  if (!Array.isArray(linkedPocIds) || linkedPocIds.some(id => !directory.clientPocs.some(p => p.id === id && (access.role === 'super_admin' || visibleClusters.has(p.clusterId))))) problem('A linked CSAT contact is outside your scope.', 403);
  const bool = (key, fallback = false) => input[key] === undefined ? (existing?.[key] ?? fallback) : input[key] === true;
  const record = { name, organization, birthday, email, whatsapp, clusterId,
    designation: text('designation'), salutation: text('salutation'), address: text('address', 1000), notes: text('notes', 1500),
    internalPocIds: unique(ids), linkedPocIds: unique(linkedPocIds), active: bool('active', true),
    giftEligible: bool('giftEligible'), emailEnabled: bool('emailEnabled'), whatsappEnabled: bool('whatsappEnabled'), whatsappOptIn: bool('whatsappOptIn') };
  if (record.emailEnabled && !email) problem('An email address is required before enabling email wishes.');
  if (record.whatsappEnabled && (!whatsapp || !record.whatsappOptIn)) problem('WhatsApp number and recorded messaging permission are required before enabling WhatsApp wishes.');
  record.identityKey = existing?.identityKey || crypto.createHash('sha256').update(whatsapp ? `phone:${whatsapp}` : email ? `email:${email}` : `person:${name.toLowerCase()}|${organization.toLowerCase()}|${birthday}`).digest('hex');
  return record;
}
function canViewContact(contact, access) {
  return access?.role === 'super_admin' || (access?.role === 'admin' && (access.clusterAccess || []).some(row => row.clusterId === contact.clusterId));
}
function initialOccasion(contact) {
  return { stage: 'Awaiting Decision', gift: '', giftEligible: contact.giftEligible === true, snapshot: { name: contact.name, organization: contact.organization, birthday: contact.birthday }, changeRequests: [], escalated: false, followupsStarted: false, deliveryReason: '' };
}
function decideGift(data, choice, actor, now = new Date().toISOString()) {
  if (data.gift) return { duplicate: true, data };
  if (!choice) problem('Select a gift.');
  return { duplicate: false, data: { ...data, gift: choice, stage: 'Gift Selected', selectedBy: actor, selectedAt: now } };
}
function reminderKinds(contact, occasion, year, today) {
  if (!contact.active || !occasion.giftEligible || occasion.gift === 'No Gift') return [];
  const days = daysUntil(contact.birthday, year, today), kinds = [];
  if (!occasion.gift && (days === 10 || (days <= 7 && days >= 0) || (days < 0 && occasion.followupsStarted))) kinds.push('decision');
  if (!occasion.gift && days <= 3 && days >= 0 && !occasion.escalated) kinds.push('escalation');
  if (days === 1 && occasion.stage !== 'Delivered') kinds.push('pending_arrangement');
  if (days === 0 && occasion.gift && occasion.stage !== 'Delivered') kinds.push('delivery');
  return kinds;
}
function tokenSecret() { return process.env.APP_SESSION_SECRET || process.env.SESSION_SECRET || process.env.N8N_WEBHOOK_SECRET || ''; }
function actionToken(payload, now = Date.now()) {
  if (tokenSecret().length < 16) problem('Configure a stable SESSION_SECRET of at least 16 characters for birthday action links.', 503);
  const value = Buffer.from(JSON.stringify({ ...payload, exp: now + 45 * 86400000 })).toString('base64url');
  return `${value}.${crypto.createHmac('sha256', tokenSecret()).update(value).digest('base64url')}`;
}
function readActionToken(token, now = Date.now()) {
  const [value, signature, extra] = String(token || '').split('.');
  if (!value || !signature || !/^[A-Za-z0-9_-]+$/.test(signature) || extra || tokenSecret().length < 16) problem('Invalid or expired birthday link.', 403);
  const expected = crypto.createHmac('sha256', tokenSecret()).update(value).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) problem('Invalid or expired birthday link.', 403);
  let data;
  try { data = JSON.parse(Buffer.from(value, 'base64url').toString()); } catch { problem('Invalid birthday link.', 403); }
  if (!Number.isFinite(data.exp) || data.exp < now) problem('This birthday link has expired.', 403);
  return data;
}
module.exports = { STAGES, DEFAULT_SETTINGS, emailValid, unique, phone, problem, localDate, birthdayDate, daysUntil, normalizeContact, canViewContact, initialOccasion, decideGift, reminderKinds, actionToken, readActionToken };

const crypto = require('node:crypto');

const TOKEN_KEY = 'zoho_analytics_access_token';
const MATCH_COLUMNS = ['Client Name', 'Project Name', 'Project Type', 'Financial Year'];
const COLUMNS = [
  ['Project Cluster', 'clusterName'], ['Client Group', 'clientGroup'], ['Client Criticality', 'clientCriticality'],
  ['Client Name', 'clientName'], ['Project Name', 'name'], ['Financial Year', 'financialYear'],
  ['Project Type', 'projectType'], ['Revenue Category', 'revenueCategory'], ['Portfolio Type', 'portfolioType'],
  ['Project Director', 'team.projectDirector.name'], ['AM', 'team.am.name'], ['TL', 'team.tl.name'],
  ['AD', 'team.ad.name'], ['AVP', 'team.avp.name'], ['Start Date', 'startDate', 'date'], ['End Date', 'endDate', 'date'],
  ['Campaign Status', 'campaignStatus'], ['Current Delivery Phase', 'currentPhase'], ['Project Performance Status', 'performanceStatus'],
  ['Currency', 'currency'], ['FX Rate to INR', 'fxRateToInr', 'number'], ['PO Amount (Local Currency)', 'poAmountLocal', 'number'],
  ['Budget Allocated (Local Currency)', 'budgetAllocatedLocal', 'number'], ['Budget Spent (Local Currency)', 'budgetSpentLocal', 'number'],
  ['Revenue Generated (Local Currency)', 'revenueGeneratedLocal', 'number'], ['Services', 'services', 'services']
];
const COLUMN_NAMES = COLUMNS.map(([name]) => name);

class ZohoError extends Error {
  constructor(message, statusCode = 502) { super(message); this.name = 'ZohoError'; this.statusCode = statusCode; }
}

function configuration(env) {
  const required = ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_ORG_ID', 'ZOHO_WORKSPACE_ID', 'ZOHO_VIEW_ID'];
  const missing = required.filter(key => !String(env[key] || '').trim());
  if (missing.length) throw new ZohoError(`Missing Replit Secrets: ${missing.join(', ')}`, 503);
  for (const key of ['ZOHO_ORG_ID', 'ZOHO_WORKSPACE_ID', 'ZOHO_VIEW_ID']) {
    if (!/^\d+$/.test(String(env[key]).trim())) throw new ZohoError(`${key} must contain the numeric Zoho identifier.`, 503);
  }
  // The supplied workflows use the India data centre. Only known Zoho hosts
  // are accepted: request bodies can never choose an OAuth or API destination.
  const regions = { in: 'in', us: 'com', eu: 'eu' };
  const region = env.ZOHO_DATA_CENTER || 'in';
  if (!regions[region]) throw new ZohoError('ZOHO_DATA_CENTER must be in, us or eu.', 503);
  return {
    clientId: env.ZOHO_CLIENT_ID.trim(), clientSecret: env.ZOHO_CLIENT_SECRET.trim(), refreshToken: env.ZOHO_REFRESH_TOKEN.trim(),
    orgId: env.ZOHO_ORG_ID.trim(), workspaceId: env.ZOHO_WORKSPACE_ID.trim(), viewId: env.ZOHO_VIEW_ID.trim(),
    accounts: `https://accounts.zoho.${regions[region]}`, api: `https://analyticsapi.zoho.${regions[region]}`
  };
}

function credentialIdentity(config) {
  return crypto.createHmac('sha256', config.clientSecret)
    .update(JSON.stringify([config.clientId, config.refreshToken, config.accounts])).digest('hex');
}

function cacheKey(config) {
  // The already-secret, high-entropy OAuth client secret is the key material.
  // Domain separation avoids another deployment secret or reuse of a raw key.
  return crypto.hkdfSync('sha256', Buffer.from(config.clientSecret), Buffer.from(config.clientId),
    Buffer.from('srv-csat/zoho-analytics/token-cache/v1'), 32);
}

function seal(token, config) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cacheKey(config), iv);
  cipher.setAAD(Buffer.from(TOKEN_KEY));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64')).join('.');
}

function unseal(encoded, config) {
  const [iv, tag, data] = String(encoded).split('.').map(value => Buffer.from(value, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', cacheKey(config), iv);
  decipher.setAAD(Buffer.from(TOKEN_KEY)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function withTokenRecord(store, task, existingClient) {
  if (!existingClient && !store.pool?.connect) throw new ZohoError('Zoho token caching requires the Replit PostgreSQL data provider.', 503);
  const client = existingClient || await store.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '20000ms'");
    await client.query("INSERT INTO public.app_settings(setting_key,setting_value) VALUES($1,'{}'::jsonb) ON CONFLICT(setting_key) DO NOTHING", [TOKEN_KEY]);
    const result = await client.query('SELECT setting_value FROM public.app_settings WHERE setting_key=$1 FOR UPDATE', [TOKEN_KEY]);
    const saved = result.rows[0]?.setting_value || {};
    const write = async value => client.query('UPDATE public.app_settings SET setting_value=$2::jsonb,updated_at=now() WHERE setting_key=$1', [TOKEN_KEY, JSON.stringify(value)]);
    const value = await task(saved, write);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { if (!existingClient) client.release(); }
}

async function withPushLock(store, task) {
  if (!store.pool?.connect) throw new ZohoError('Zoho push requires the Replit PostgreSQL data provider.', 503);
  const client = await store.pool.connect();
  let locked = false;
  try {
    // Session-level lock serializes this application's imports across workers.
    // The same connection is reused for token transactions, even with pool=1.
    locked = (await client.query('SELECT pg_try_advisory_lock(74061013,1) AS locked')).rows[0]?.locked === true;
    if (!locked) throw new ZohoError('Another Zoho push is running. Please try again when it finishes.', 409);
    return await task(client);
  } finally {
    let broken = false;
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(74061013,1)'); }
      catch { broken = true; }
    }
    client.release(broken);
  }
}

function errorCode(body) {
  const code = String(body?.error?.code || body?.errorCode || body?.code || '');
  return /^[\w-]{1,50}$/.test(code) ? ` (code ${code})` : '';
}

class ZohoAnalytics {
  constructor(store, { env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.store = store; this.env = env; this.fetch = fetchImpl; this.now = now;
  }

  async rawRequest(url, options, operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
      const text = await response.text();
      if (text.length > 20 * 1024 * 1024) throw new ZohoError('Zoho returned too much data for this push.');
      return { response, text };
    } catch (error) {
      if (error instanceof ZohoError) throw error;
      throw new ZohoError(operation === 'import'
        ? 'Zoho did not confirm the push result. Check the Zoho table before trying again.'
        : 'Could not reach Zoho. Please check the connection and try again.');
    } finally { clearTimeout(timer); }
  }

  async accessToken(config, client, invalidToken = null) {
    return withTokenRecord(this.store, async (saved, write) => {
      if (saved.credentialIdentity === credentialIdentity(config) && Date.parse(saved.expiresAt) > this.now()) {
        let token;
        try { token = unseal(saved.encryptedAccessToken, config); } catch { /* Refresh a damaged/old cache on demand. */ }
        if (token && token !== invalidToken) return { token, reused: true, expiresAt: saved.expiresAt };
      }
      const startedAt = this.now();
      const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
        refresh_token: config.refreshToken, grant_type: 'refresh_token' });
      const result = await this.rawRequest(`${config.accounts}/oauth/v2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
      }, 'token');
      let data;
      try { data = JSON.parse(result.text); } catch { throw new ZohoError('Zoho returned an invalid token response.'); }
      const ttl = Number(data.expires_in);
      if (!result.response.ok || data.error || typeof data.access_token !== 'string' || !/^[^\s\r\n]{8,4096}$/.test(data.access_token)
        || !Number.isFinite(ttl) || ttl <= 0 || ttl > 86400) {
        throw new ZohoError('Zoho could not generate an access token. Check the Client ID, Client Secret and Refresh Token.');
      }
      const expiresAt = new Date(startedAt + ttl * 1000).toISOString();
      await write({ version: 1, credentialIdentity: credentialIdentity(config), encryptedAccessToken: seal(data.access_token, config),
        generatedAt: new Date(startedAt).toISOString(), expiresAt });
      return { token: data.access_token, reused: false, expiresAt };
    }, client);
  }

  async request(config, suffix, options = {}, client) {
    let token = await this.accessToken(config, client);
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await this.rawRequest(`${config.api}/restapi/v2/workspaces/${config.workspaceId}/views/${config.viewId}/${suffix}`, {
        ...options, headers: { ...options.headers, 'ZANALYTICS-ORGID': config.orgId, Authorization: `Zoho-oauthtoken ${token.token}` }
      }, options.method === 'POST' ? 'import' : 'read');
      if (result.response.status !== 401 || attempt === 1) break;
      token = await this.accessToken(config, client, token.token);
    }
    if (!result.response.ok) {
      throw new ZohoError(`Zoho rejected the request (HTTP ${result.response.status}). Check table access and OAuth permissions.`);
    }
    return { ...result, token };
  }

  parseSuccess(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new ZohoError('Zoho returned an invalid API response.'); }
    if (data.status !== 'success') throw new ZohoError(`Zoho did not accept the request${errorCode(data)}. Check the account, table and OAuth permissions.`);
    return data.data;
  }

  async metadata(config, client) {
    const result = await this.request(config, 'metadata', {}, client);
    const data = this.parseSuccess(result.text);
    if (!Array.isArray(data?.columns)) throw new ZohoError('Zoho did not return table columns.');
    return { columns: data.columns, token: result.token };
  }

  async checkConnection() {
    const config = configuration(this.env);
    const { columns, token } = await this.metadata(config);
    return { connected: true, tokenReused: token.reused, tokenExpiresAt: token.expiresAt, columnCount: columns.length,
      missingColumns: COLUMN_NAMES.filter(name => !columns.some(column => column.columnName === name)) };
  }

  async push(projects, allProjects = projects) {
    const config = configuration(this.env);
    return withPushLock(this.store, async client => {
      const { columns } = await this.metadata(config, client);
      const missing = COLUMN_NAMES.filter(name => !columns.some(column => column.columnName === name));
      if (missing.length) throw new ZohoError(`Zoho table is missing columns: ${missing.join(', ')}`, 422);
      for (const name of ['Start Date', 'End Date']) {
        if (columns.find(column => column.columnName === name)?.dataType !== 'DATE') {
          throw new ZohoError(`Set ${name} to the Date data type in Zoho before pushing.`, 422);
        }
      }
      const exportConfig = { responseFormat: 'csv', selectedColumns: MATCH_COLUMNS, includeHeader: true,
        showHiddenCols: true, showPersonalCols: true, delimiter: 0, recordDelimiter: 1, quoted: 1 };
      const existing = await this.request(config, `data?CONFIG=${encodeURIComponent(JSON.stringify(exportConfig))}`, {}, client);
      const targetRows = parseTargetKeys(existing.text);
      const prepared = preparePush(projects, targetRows, allProjects);
      if (!prepared.rows.length) return { updated: 0, added: 0, confirmed: 0, skipped: prepared.skipped };
      const importConfig = { importType: 'updateadd', fileType: 'csv', autoIdentify: true, onError: 'abort',
        matchingColumns: MATCH_COLUMNS, selectedColumns: COLUMN_NAMES, dateFormat: 'yyyy-MM-dd' };
      const csv = toCsv([COLUMN_NAMES, ...prepared.rows.map(row => COLUMN_NAMES.map(name => row[name]))]);
      const form = new FormData();
      form.append('FILE', new Blob([csv], { type: 'text/csv' }), 'project-performance.csv');
      const result = await this.request(config, `data?CONFIG=${encodeURIComponent(JSON.stringify(importConfig))}`, { method: 'POST', body: form }, client);
      const imported = this.parseSuccess(result.text);
      const summary = imported?.importSummary;
      if (Number(summary?.successRowCount) !== prepared.rows.length || Number(summary?.totalRowCount) !== prepared.rows.length
        || Number(summary?.warnings || 0) !== 0 || imported?.importErrors) {
        throw new ZohoError('Zoho returned an incomplete import result. Check the table and import history before trying again.');
      }
      return { updated: prepared.updated, added: prepared.rows.length - prepared.updated, confirmed: prepared.rows.length,
        skipped: prepared.skipped };
    });
  }
}

function clean(value) { return value == null ? '' : String(value).trim(); }
function matchKey(row) { return JSON.stringify(MATCH_COLUMNS.map(name => row[name] == null ? '' : String(row[name]))); }
function foldedKey(row) { return JSON.stringify(MATCH_COLUMNS.map(name => clean(row[name]).toLowerCase())); }

function projectRow(project) {
  return Object.fromEntries(COLUMNS.map(([name, field, type]) => {
    let value = field.split('.').reduce((current, part) => current?.[part], project);
    if (value == null || value === '') value = null;
    else if (type === 'date') {
      const date = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
        throw new ZohoError(`Invalid ${name}.`, 422);
      }
      value = date;
    } else if (type === 'number') {
      value = Number(value);
      if (!Number.isFinite(value)) throw new ZohoError(`Invalid ${name}.`, 422);
    } else if (type === 'services') value = value.map(service => service.name).filter(Boolean).join(', ') || null;
    else value = clean(value) || null;
    return [name, value];
  }));
}

function preparePush(projects, existing, allProjects = projects) {
  const skipped = [], candidates = [];
  for (const project of projects) {
    try {
      const row = projectRow(project);
      if (MATCH_COLUMNS.some(name => !row[name])) throw new ZohoError('Client Name, Project Name, Project Type and Financial Year are required to match safely.', 422);
      candidates.push({ project, row });
    } catch (error) { skipped.push({ project: project.name || 'Unnamed Project', reason: error.message }); }
  }
  const sourceCounts = new Map(), targets = new Map(), foldedTargets = new Map();
  for (const project of allProjects) {
    const keyRow = { 'Client Name': project.clientName, 'Project Name': project.name,
      'Project Type': project.projectType, 'Financial Year': project.financialYear };
    if (MATCH_COLUMNS.every(name => clean(keyRow[name]))) {
      sourceCounts.set(foldedKey(keyRow), (sourceCounts.get(foldedKey(keyRow)) || 0) + 1);
    }
  }
  for (const row of existing) {
    targets.set(matchKey(row), (targets.get(matchKey(row)) || 0) + 1);
    const keys = foldedTargets.get(foldedKey(row)) || []; keys.push(matchKey(row)); foldedTargets.set(foldedKey(row), keys);
  }
  const rows = [];
  let updated = 0;
  for (const { project, row } of candidates) {
    const key = matchKey(row), related = foldedTargets.get(foldedKey(row)) || [];
    if (sourceCounts.get(foldedKey(row)) > 1 || related.length > 1 || (related.length && !related.includes(key))) {
      skipped.push({ project: project.name, reason: 'Ambiguous or case-conflicting match. Please review the matching columns.' });
      continue;
    }
    if (targets.has(key)) updated++;
    rows.push(row);
  }
  return { rows, skipped, updated };
}

function toCsv(rows) {
  return rows.map(row => row.map(value => value == null ? '' : `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

function parseTargetKeys(text) {
  // Quoted CSV can contain commas, escaped quotes and embedded line breaks.
  // An invalid export is never treated as an empty table and appended over.
  const rows = [];
  let row = [], field = '', quoted = false, closedQuote = false;
  const input = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else field += char;
    } else if (char === '"' && !field && !closedQuote) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closedQuote = false;
      if (char !== ',') { if (row.some(value => value !== '')) rows.push(row); row = []; if (char === '\r' && input[i + 1] === '\n') i++; }
    } else {
      if (closedQuote || char === '"') throw new ZohoError('Zoho returned an invalid CSV export.');
      field += char;
    }
  }
  if (quoted) throw new ZohoError('Zoho returned an incomplete CSV export.');
  if (field || row.length || closedQuote) { row.push(field); if (row.some(value => value !== '')) rows.push(row); }
  const headers = rows.shift() || [];
  if (MATCH_COLUMNS.some(name => headers.filter(header => header === name).length !== 1)) throw new ZohoError('Zoho export did not include the four matching columns. Check read permissions.');
  return rows.map(values => {
    if (values.length !== headers.length) throw new ZohoError('Zoho returned an inconsistent CSV export.');
    return Object.fromEntries(MATCH_COLUMNS.map(name => [name, values[headers.indexOf(name)]]));
  });
}

module.exports = { ZohoAnalytics, ZohoError, TOKEN_KEY, MATCH_COLUMNS, COLUMN_NAMES, projectRow, preparePush, parseTargetKeys, toCsv };

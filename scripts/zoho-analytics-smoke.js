const assert = require('node:assert/strict');
const { ZohoAnalytics, TOKEN_KEY, MATCH_COLUMNS, COLUMN_NAMES, dateColumnInfo, projectRow, preparePush, parseTargetKeys, toCsv } = require('../src/lib/zoho-analytics');

// A transactional single-record fixture, shared across independent clients.
// No production database, Zoho account or external network is used.
class TokenPool {
  constructor() { this.record = null; this.queue = Promise.resolve(); this.pushLocked = false; this.releases = 0; }
  async connect() {
    const pool = this;
    let releaseLock = null, working, ownsPush = false;
    return {
      async query(sql, params = []) {
        if (sql.startsWith('SELECT pg_try_advisory_lock')) {
          if (pool.pushLocked) return { rows: [{ locked: false }] };
          pool.pushLocked = ownsPush = true; return { rows: [{ locked: true }] };
        }
        if (sql.startsWith('SELECT pg_advisory_unlock')) { pool.pushLocked = ownsPush = false; return { rows: [] }; }
        if (sql.startsWith('INSERT INTO public.app_settings')) {
          assert.equal(params[0], TOKEN_KEY);
          const before = pool.queue;
          pool.queue = new Promise(resolve => { releaseLock = resolve; });
          await before;
          working = structuredClone(pool.record || {});
        }
        if (sql.startsWith('SELECT setting_value')) return { rows: [{ setting_value: working }] };
        if (sql.startsWith('UPDATE public.app_settings')) {
          assert.equal(params[0], TOKEN_KEY); working = JSON.parse(params[1]);
        }
        if (sql === 'COMMIT') { pool.record = working; releaseLock?.(); releaseLock = null; }
        if (sql === 'ROLLBACK') { releaseLock?.(); releaseLock = null; }
        return { rows: [] };
      },
      release(broken) { pool.releases++; if (broken && ownsPush) pool.pushLocked = false; assert.equal(releaseLock, null); }
    };
  }
}

const env = { ZOHO_CLIENT_ID: 'fixture-client', ZOHO_CLIENT_SECRET: 'fixture-secret-not-real-0123456789',
  ZOHO_REFRESH_TOKEN: 'fixture-refresh-not-real', ZOHO_ORG_ID: '90071992547409931',
  ZOHO_WORKSPACE_ID: '90071992547409932', ZOHO_VIEW_ID: '90071992547409933' };
const project = { id: 'p1', clientName: 'Client A', name: 'Project A', projectType: 'Campaign', financialYear: '2026-2027',
  startDate: '2026-04-01', endDate: '2027-03-31', currency: 'INR', fxRateToInr: 1, poAmountLocal: 1200.50,
  budgetAllocatedLocal: 0, team: { am: { name: 'A, "Team"' } }, services: [{ name: 'Search' }, { name: 'Social Media' }] };
const next = { ...project, id: 'p2', name: 'Project B', poAmountLocal: null };
const keyRows = projects => projects.map(projectRow);
function fixture() {
  const pool = new TokenPool();
  const state = { clock: Date.parse('2026-11-13T10:00:00Z'), tokenCalls: 0, imports: [], calls: [], target: keyRows([project]),
    failToken: false, failRead: false, failImport: false, badCount: false, rejectTokenOnce: false, blockImport: null,
    columns: COLUMN_NAMES.map(columnName => ({ columnName, dataType: ['Start Date', 'End Date'].includes(columnName) ? 'DATE' : 'PLAIN' })) };
  const respond = (value, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
  const fetchImpl = async (url, options) => {
    state.calls.push({ url, method: options.method || 'GET' });
    assert.equal(options.redirect, 'error');
    if (url === 'https://accounts.zoho.in/oauth/v2/token') {
      state.tokenCalls++;
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.equal(options.body.get('refresh_token'), env.ZOHO_REFRESH_TOKEN);
      await new Promise(resolve => setImmediate(resolve));
      return respond(state.failToken ? { error: 'invalid_client', echoed: env.ZOHO_CLIENT_SECRET }
        : { access_token: `fixture-access-token-${state.tokenCalls}`, expires_in: 3600 });
    }
    assert.ok(url.startsWith(`https://analyticsapi.zoho.in/restapi/v2/workspaces/${env.ZOHO_WORKSPACE_ID}/views/${env.ZOHO_VIEW_ID}/`));
    assert.equal(options.headers['ZANALYTICS-ORGID'], env.ZOHO_ORG_ID);
    assert.match(options.headers.Authorization, /^Zoho-oauthtoken fixture-access-token-/);
    if (state.rejectTokenOnce) { state.rejectTokenOnce = false; return respond({}, 401); }
    if (url.endsWith('/metadata')) return respond({ status: 'success', data: { columns: state.columns } });
    if (options.method !== 'POST') {
      if (state.failRead) return respond({ status: 'failure', error: { code: 999 } });
      const config = JSON.parse(new URL(url).searchParams.get('CONFIG'));
      assert.deepEqual(config.selectedColumns, MATCH_COLUMNS);
      return respond(toCsv([MATCH_COLUMNS, ...state.target.map(row => MATCH_COLUMNS.map(name => row[name]))]));
    }
    if (state.blockImport) await state.blockImport;
    const config = JSON.parse(new URL(url).searchParams.get('CONFIG'));
    assert.equal(config.importType, 'updateadd'); assert.equal(config.onError, 'abort');
    assert.deepEqual(config.matchingColumns, MATCH_COLUMNS);
    assert.deepEqual(config.selectedColumns, COLUMN_NAMES);
    assert.equal(config.selectedColumns.includes('Project ID'), false);
    assert.equal(config.selectedColumns.includes('Client ID'), false);
    const csv = await options.body.get('FILE').text();
    state.imports.push(csv);
    if (state.failImport) throw new Error(`simulated network failure ${env.ZOHO_CLIENT_SECRET}`);
    const count = parseTargetKeys(csv).length;
    return respond({ status: 'success', data: { importSummary: { totalRowCount: count,
      successRowCount: state.badCount ? 0 : count, warnings: 0 }, importErrors: '' } });
  };
  const client = (customEnv = env) => new ZohoAnalytics({ pool }, { env: customEnv, fetchImpl, now: () => state.clock });
  return { pool, state, client };
}

async function main() {
  const f = fixture();
  assert.equal(f.pool.record, null); assert.equal(f.state.calls.length, 0, 'No startup OAuth request');
  let result = await f.client().checkConnection();
  assert.equal(result.connected, true); assert.equal(result.tokenReused, false); assert.deepEqual(result.missingColumns, []);
  assert.ok(result.dateColumns.every(column => column.isDate));
  assert.equal(f.state.tokenCalls, 1);
  const original = structuredClone(f.pool.record);
  assert.ok(!JSON.stringify(f.pool.record).includes('fixture-access-token-1'));
  assert.ok(!JSON.stringify(f.pool.record).includes(env.ZOHO_REFRESH_TOKEN));
  assert.ok(!JSON.stringify(f.pool.record).includes(env.ZOHO_CLIENT_SECRET));
  assert.ok(!JSON.stringify(result).includes('access-token'));
  f.state.clock += 59 * 60 * 1000;
  const repeated = await Promise.all(Array.from({ length: 8 }, () => f.client().checkConnection()));
  assert.ok(repeated.every(row => row.tokenReused)); assert.equal(f.state.tokenCalls, 1);
  assert.deepEqual(f.pool.record, original, 'Valid cache reads do not overwrite or append records');
  f.state.clock += 60 * 1000;
  const refreshed = await Promise.all(Array.from({ length: 8 }, () => f.client().checkConnection()));
  assert.equal(f.state.tokenCalls, 2, 'One refresh across concurrent independent clients');
  assert.equal(refreshed.filter(row => !row.tokenReused).length, 1);
  assert.notEqual(f.pool.record.encryptedAccessToken, original.encryptedAccessToken);
  assert.equal(typeof f.pool.record, 'object'); assert.equal(Array.isArray(f.pool.record), false);
  console.log('PASS one encrypted token record, exact expiry, cross-user reuse and concurrent refresh');

  f.state.clock += 3600000; f.state.failToken = true;
  const beforeFailure = structuredClone(f.pool.record);
  await assert.rejects(f.client().checkConnection(), error => !error.message.includes(env.ZOHO_CLIENT_SECRET) && /could not generate/.test(error.message));
  assert.deepEqual(f.pool.record, beforeFailure, 'Failed refresh does not replace the existing cache');
  f.state.failToken = false;
  await f.client().checkConnection();
  const beforeChangedConfig = f.state.tokenCalls;
  await f.client({ ...env, ZOHO_REFRESH_TOKEN: env.ZOHO_REFRESH_TOKEN }).checkConnection();
  assert.equal(f.state.tokenCalls, beforeChangedConfig);
  f.state.rejectTokenOnce = true;
  await f.client().checkConnection();
  assert.equal(f.state.tokenCalls, beforeChangedConfig + 1);
  await assert.rejects(f.client({ ...env, ZOHO_VIEW_ID: '' }).checkConnection(), /ZOHO_VIEW_ID/);
  await assert.rejects(f.client({ ...env, ZOHO_DATA_CENTER: 'https://attacker.invalid' }).checkConnection(), /DATA_CENTER/);
  console.log('PASS safe refresh failures, invalid-token recovery and configuration validation');

  assert.equal(projectRow(project)['Budget Allocated (Local Currency)'], 0);
  assert.equal(projectRow(project)['Start Date'], '2026-04-01');
  assert.equal(projectRow(next)['PO Amount (Local Currency)'], null);
  assert.equal(projectRow({ ...project, zohoPassword: 'DO-NOT-SEND', csatScore: 9 })['zohoPassword'], undefined);
  assert.throws(() => projectRow({ ...project, endDate: '2026-11-31' }), /Invalid End Date/);
  const duplicate = { ...project, id: 'duplicate' };
  assert.equal(preparePush([project, duplicate], []).rows.length, 0);
  assert.equal(preparePush([project], [], [project, { ...duplicate, clusterId: 'outside-cluster' }]).rows.length, 0,
    'A scoped caller cannot overwrite another cluster project with an identical natural key');
  assert.equal(preparePush([project], keyRows([project, duplicate])).rows.length, 0);
  assert.equal(preparePush([{ ...project, financialYear: '' }], []).rows.length, 0);
  assert.equal(preparePush([project], [{ ...projectRow(project), 'Client Name': 'client a' }]).rows.length, 0);
  assert.equal(preparePush([project], [{ ...projectRow(project), 'Client Name': 'Client A ' }]).rows.length, 0);
  assert.equal(preparePush([project, { ...project, projectType: 'Social Media' }], []).rows.length, 2);
  assert.equal(preparePush([project, { ...project, financialYear: '2025-2026' }], []).rows.length, 2);
  const complex = { ...projectRow(project), 'Client Name': 'Client, "A"\nNew line' };
  assert.deepEqual(parseTargetKeys(toCsv([MATCH_COLUMNS, MATCH_COLUMNS.map(name => complex[name])]))[0],
    Object.fromEntries(MATCH_COLUMNS.map(name => [name, complex[name]])));
  for (const text of ['{"status":"failure"}', 'Client Name,Project Name\nA,B', '"unclosed']) assert.throws(() => parseTargetKeys(text));
  console.log('PASS exact four-column matching, duplicates, whitespace/case conflicts, date-only values and quoted CSV');

  const validDates = [
    { dataType: 'DATE' }, { dataType: 'date' }, { dataType: ' Date ' },
    { dataTypeName: 'Date', dataTypeId: 93 }, { dataType: 93, dataTypeName: 'Date' },
    { dataTypeId: 93 }, { dataTypeId: '93' }, { dataType: '93' },
    { dataType: 'DATETIME' }, { dataTypeName: 'Date Time' }, { dataType: 'DATE_TIME' },
    { dataType: 'TIMESTAMP', dataTypeName: 'Date' }
  ];
  for (const metadata of validDates) {
    for (const name of ['Start Date', 'End Date']) {
      assert.equal(dateColumnInfo(metadata, name).isDate, true);
      const d = fixture();
      d.state.columns = d.state.columns.map(column => column.columnName === name ? { columnName: name, ...metadata } : column);
      assert.equal((await d.client().push([project])).confirmed, 1, `${name}: ${JSON.stringify(metadata)}`);
      assert.equal(d.state.imports.length, 1);
      assert.ok(d.state.imports[0].includes('"2026-04-01"'));
      assert.ok(!d.state.imports[0].includes('T00:00:00'));
    }
  }
  for (const metadata of [{}, { dataType: 'PLAIN' }, { dataTypeName: 'Plain Text' }, { dataType: 'TEXT' },
    { dataType: 'NUMBER' }, { dataTypeId: 1 }, { dataType: 'UPDATE' }, { dataType: 'DATE_FORMAT' },
    { dataType: 'TIME' }, { dataTypeId: [93] }, { dataTypeId: { value: 93 } },
    { dataType: 'PLAIN', dataTypeName: 'Date', dataTypeId: 93 }]) {
    for (const name of ['Start Date', 'End Date']) {
      const d = fixture();
      d.state.columns = d.state.columns.map(column => column.columnName === name ? { columnName: name, ...metadata } : column);
      const status = await d.client().checkConnection();
      assert.equal(status.dateColumns.find(column => column.columnName === name).isDate, false);
      await assert.rejects(d.client().push([project]), error => error.statusCode === 422 && error.message.startsWith(name));
      assert.equal(d.state.imports.length, 0);
    }
  }
  assert.equal(dateColumnInfo({ dataTypeName: '<script>unsafe</script>' }, 'Start Date').reportedType, 'Unknown');
  console.log('PASS documented Date metadata, case/spacing variants and Date-Time types in both date columns; text/numeric/unknown types block imports');

  const p = fixture();
  const pushed = await p.client().push([project, next]);
  assert.deepEqual(pushed, { updated: 1, added: 1, confirmed: 2, skipped: [] });
  assert.equal(p.state.tokenCalls, 1); assert.equal(p.state.imports.length, 1);
  assert.ok(p.state.imports[0].includes('"2026-04-01"'));
  assert.ok(!p.state.imports[0].includes('T00:00:00'));
  assert.ok(!p.state.imports[0].includes('DO-NOT-SEND'));
  assert.match(p.state.imports[0], /"1200.5","0",,,"Search, Social Media"/);
  assert.ok(p.state.imports[0].includes('"A, ""Team"""'));
  assert.equal(p.pool.pushLocked, false);
  p.state.failRead = true;
  await assert.rejects(p.client().push([project]), error => error.name === 'ZohoError' && error.statusCode === 502);
  assert.equal(p.state.imports.length, 1);
  p.state.failRead = false; p.state.badCount = true;
  await assert.rejects(p.client().push([project]), /incomplete import/);
  p.state.badCount = false; p.state.failImport = true;
  await assert.rejects(p.client().push([project]), /did not confirm/);
  assert.equal(p.pool.pushLocked, false);
  p.state.failImport = false;
  p.state.columns = p.state.columns.filter(row => row.columnName !== 'Currency');
  await assert.rejects(p.client().push([project]), /missing columns: Currency/);
  console.log('PASS import confirmation, numeric zero, empty-field clearing payload, no ID columns and no blind retries');

  const concurrent = fixture();
  let unblock;
  concurrent.state.blockImport = new Promise(resolve => { unblock = resolve; });
  const first = concurrent.client().push([project]);
  while (!concurrent.state.calls.some(call => call.method === 'POST' && call.url.includes('/data?'))) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(concurrent.client().push([project]), /Another Zoho push/);
  unblock(); await first;
  assert.equal(concurrent.state.imports.length, 1);
  assert.equal(concurrent.pool.pushLocked, false);
  console.log('PASS concurrent imports are serialized across clients; no live database or external requests');
}

module.exports = { TokenPool };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

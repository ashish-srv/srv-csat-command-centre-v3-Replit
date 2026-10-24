const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Exercise real HTTP handlers with isolated, in-memory data. Never contact a
// database, Google, Gemini, WhatsApp or n8n during this suite.
process.env.APP_LOGIN_PASSWORD = 'cluster-test-password';
process.env.GOOGLE_ALLOWED_DOMAINS = 'srvmedia.com';
process.env.GOOGLE_CLIENT_ID = 'cluster-test.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'cluster-test-secret';
const projects = ['a', 'b'].map(id => ({ id: `p${id}`, key: id, name: id, clientId: `c${id}`, clusterId: id, team: { amId: `i${id}` } }));
const directory = { clusters: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  clients: [{ id: 'ca', clusterId: 'a' }, { id: 'cb', clusterId: 'b' }], projects,
  internalPocs: [{ id: 'ia', clusterId: 'a' }, { id: 'ib', clusterId: 'b' }],
  clientPocs: [{ id: 'poca', projectId: 'pa' }, { id: 'pocb', projectId: 'pb' }],
  removedClientPocs: [], projectServices: [], pocLevels: [], departments: [], subDepartments: [] };
const admin = { id: 'admin', email: 'admin@srvmedia.com', role: 'admin', active: true, clusterAccess: [{ clusterId: 'a', emailEnabled: true }] };
const external = { id: 'external', email: 'approved@gmail.com', role: 'project_user', active: true, externalLoginAllowed: true, internalPocId: 'ia' };
const users = [admin, external, { id: 'super', email: 'super@srvmedia.com', role: 'super_admin', active: true }];
let writes = 0;
const store = {
  getAppUserByEmail: async email => users.find(user => user.email === email),
  listAppUsers: async () => users,
  getDirectory: async () => directory,
  getProjectPerformanceData: async () => ({ ...directory, projects, standards: {}, audit: [], financialYears: [] }),
  listProjects: async () => projects,
  getDashboard: async () => ({ ...directory, metrics: {}, openIssues: [], openCycles: [], cycles: [], responseTracker: [] }),
  getProject: async key => projects.find(project => project.key === key),
  getProjectWorkspace: async key => ({ project: projects.find(project => project.key === key), cycles: [], sessions: [], messages: [], pocs: [], services: [], issues: [] }),
  getSession: async id => ({ id, projectId: id.endsWith('a') ? 'pa' : 'pb' }),
  getCycle: async id => ({ id, projectId: id.endsWith('a') ? 'pa' : 'pb' }),
  getMessagesForSession: async id => [{ body: `Original message ${id}`, side: 'client' }],
  getSessionDetail: async id => ({ session: await store.getSession(id), project: projects[id.endsWith('a') ? 0 : 1], poc: { name: 'Test POC' }, messages: await store.getMessagesForSession(id) }),
  listCycleSessions: async () => [],
  updateProject: async () => { writes++; },
  saveProjectPerformance: async () => { writes++; }
};
const storePath = require.resolve('../src/lib/store');
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { createStore: () => store } };
const filename = require.resolve('../src/server/api-handler');
const harness = new Module(filename, module);
harness.filename = filename;
harness.paths = Module._nodeModulePaths(path.dirname(filename));
harness._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testAuth = { createAppSessionToken, APP_SESSION_COOKIE };', filename);
const { handleApiRequest, testAuth } = harness.exports;
const cookieFor = (email, hostedDomain = 'srvmedia.com') => `${testAuth.APP_SESSION_COOKIE}=${testAuth.createAppSessionToken(Date.now(), { provider: 'google', sub: email, email, hostedDomain })}`;
const request = (method, url, cookie, body = {}, searchParams = new URLSearchParams()) => handleApiRequest({ method, path: url, headers: { cookie }, body, searchParams, baseUrl: 'https://fixture.invalid' });

async function main() {
  let checks = 0;
  const check = (value, expected) => { assert.deepEqual(value, expected); checks++; };
  const cookie = cookieFor(admin.email);
  for (const route of ['/api/dashboard', '/api/project-performance', '/api/admin/directory']) {
    const result = await request('GET', route, cookie);
    check(result.statusCode, 200);
    check(JSON.parse(result.body).projects.map(project => project.id), ['pa']);
  }
  check((await request('GET', '/api/projects/a/workspace', cookie)).statusCode, 200);
  check((await request('GET', '/api/sessions/session-a', cookie)).statusCode, 200);
  for (const [method, route, body] of [
    ['GET', '/api/projects/b/workspace'], ['GET', '/api/sessions/session-b'], ['GET', '/api/cycles/cycle-b/sessions'],
    ['PUT', '/api/project-performance/pb', {}], ['PATCH', '/api/admin/projects/pb', { activeStatus: 'active' }],
    ['PUT', '/api/admin/projects/bulk-status', { projectIds: ['pa', 'pb'], activeStatus: 'paused' }],
    ['POST', '/api/admin/import-workbook', {}], ['PATCH', '/api/admin/messaging', { enabled: false }]
  ]) check((await request(method, route, cookie, body)).statusCode, 403);
  check(writes, 0);
  admin.clusterAccess = [];
  check(JSON.parse((await request('GET', '/api/dashboard', cookie)).body).projects, []);
  check((await request('GET', '/api/projects/a/workspace', cookie)).statusCode, 403);
  check(JSON.parse((await request('GET', '/api/dashboard', cookieFor('super@srvmedia.com'))).body).projects.length, 2);
  const externalCookie = cookieFor(external.email, '');
  check((await request('GET', '/api/project-performance', externalCookie)).statusCode, 200);
  check(JSON.parse((await request('GET', '/api/project-performance', externalCookie)).body).projects.map(project => project.id), ['pa']);
  check((await request('GET', '/api/dashboard', externalCookie)).statusCode, 403);
  check((await request('GET', '/api/projects/a/workspace', externalCookie)).statusCode, 403);
  external.externalLoginAllowed = false;
  check((await request('GET', '/api/project-performance', externalCookie)).statusCode, 403);
  external.externalLoginAllowed = true;
  external.active = false;
  check((await request('GET', '/api/project-performance', externalCookie)).statusCode, 403);
  external.active = true;
  external.role = 'admin';
  check((await request('GET', '/api/project-performance', externalCookie)).statusCode, 403);
  external.role = 'project_user';

  const { OAuth2Client } = require('google-auth-library');
  const originalGet = OAuth2Client.prototype.getToken;
  const originalVerify = OAuth2Client.prototype.verifyIdToken;
  let identity = external.email;
  OAuth2Client.prototype.getToken = async () => ({ tokens: { id_token: 'fixture' } });
  OAuth2Client.prototype.verifyIdToken = async () => ({ getPayload: () => ({ sub: identity, email: identity, email_verified: true }) });
  try {
    for (const email of [external.email, 'not-approved@gmail.com']) {
      identity = email;
      const start = await request('GET', '/api/auth/google/start', '');
      check(start.statusCode, 302);
      const state = new URL(start.headers.location).searchParams.get('state');
      const stateCookie = String(start.headers['set-cookie']).split(';')[0];
      const result = await request('GET', '/api/auth/google/callback', stateCookie, {}, new URLSearchParams({ code: 'fixture', state }));
      check(result.statusCode, 303);
      if (email === external.email) check(result.headers.location, '/dashboard');
      else { assert.match(result.headers.location, /google_domain_not_allowed/); checks++; }
    }
  } finally {
    OAuth2Client.prototype.getToken = originalGet;
    OAuth2Client.prototype.verifyIdToken = originalVerify;
  }
  console.log(`${checks} cluster HTTP and external Google identity checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

function normalizeClusterAccess(value, role) {
  const rows = new Map();
  for (const item of Array.isArray(value) ? value : []) {
    const clusterId = String(item?.clusterId || '').trim();
    if (clusterId) rows.set(clusterId, { clusterId, emailEnabled: role === 'admin' && item.emailEnabled === true });
  }
  return [...rows.values()];
}

function clusterIds(access) {
  return new Set(normalizeClusterAccess(access?.clusterAccess, access?.role).map(row => row.clusterId));
}

function clusterVisible(clusterId, access) {
  return access?.role === 'super_admin' || (access?.role === 'admin' && clusterIds(access).has(clusterId));
}

function scopeDirectory(directory, access) {
  const clusters = clusterIds(access);
  const clients = (directory.clients || []).filter(row => clusters.has(row.clusterId));
  const clientIds = new Set(clients.map(row => row.id));
  const projects = (directory.projects || []).filter(row => clientIds.has(row.clientId));
  const projectIds = new Set(projects.map(row => row.id));
  const internalPocs = (directory.internalPocs || []).filter(row => (row.clusterIds || [row.clusterId]).some(id => clusters.has(id)));
  const internalIds = new Set(internalPocs.map(row => row.id));
  return {
    ...directory,
    clusters: (directory.clusters || []).filter(row => clusters.has(row.id)), clients, projects,
    internalPocs: internalPocs.map(row => ({ ...row, reportingManagerId: internalIds.has(row.reportingManagerId) ? row.reportingManagerId : null })),
    clientPocs: (directory.clientPocs || []).filter(row => projectIds.has(row.projectId)),
    removedClientPocs: (directory.removedClientPocs || []).filter(row => projectIds.has(row.projectId)),
    projectServices: (directory.projectServices || []).filter(row => projectIds.has(row.projectId))
  };
}

function scopeProjectData(data, access, directory) {
  const allowed = new Set(scopeDirectory(directory, access).projects.map(row => row.id));
  const projects = (data.projects || []).filter(row => allowed.has(row.id));
  const keys = new Set(projects.map(row => row.key));
  const result = { ...data, projects };
  for (const name of ['openIssues', 'openCycles', 'cycles', 'responseTracker', 'responseQueue', 'audit', 'serviceChangeRequests']) {
    if (Array.isArray(data[name])) result[name] = data[name].filter(row => allowed.has(row.projectId || row.project_id));
  }
  if (data.clients) result.clients = data.clients.filter(row => clusterIds(access).has(row.clusterId));
  if (data.clusters) result.clusters = data.clusters.filter(row => clusterIds(access).has(row.id));
  if (data.internalPocs) result.internalPocs = scopeDirectory(directory, access).internalPocs;
  if (data.scheduleEvents) result.scheduleEvents = data.scheduleEvents.filter(row => keys.has(row.projectKey));
  if (data.projectPocCounts) result.projectPocCounts = Object.fromEntries(Object.entries(data.projectPocCounts).filter(([id]) => allowed.has(id)));
  if (data.metrics) {
    const scored = projects.filter(row => row.csatScore !== null && row.csatScore !== undefined);
    result.metrics = { projectCount: projects.length, avgCsat: scored.length ? Math.round(scored.reduce((sum, row) => sum + Number(row.csatScore), 0) / scored.length * 10) / 10 : null,
      openIssues: result.openIssues?.length || 0, openCycles: result.openCycles?.length || 0, atRisk: projects.filter(row => row.riskLevel === 'High').length };
  }
  return result;
}

// Scope every browser request before its handler performs any writes. Explicit
// route coverage fails closed when a new endpoint is introduced.
async function authorizeClusterRequest(store, access, method, pathname, body = {}) {
  const directory = await store.getDirectory();
  const scoped = scopeDirectory(directory, access);
  const allowed = {
    cluster: new Set(scoped.clusters.map(row => row.id)), client: new Set(scoped.clients.map(row => row.id)),
    project: new Set(scoped.projects.map(row => row.id)), internal: new Set(scoped.internalPocs.map(row => row.id)),
    poc: new Set([...scoped.clientPocs, ...scoped.removedClientPocs].map(row => row.id)),
    service: new Set(scoped.projectServices.map(row => row.id))
  };
  const deny = () => { throw new Error('This record or operation is outside your assigned clusters. Ask a Super Admin.'); };
  const requireId = (kind, id) => { if (!id || !allowed[kind].has(id)) deny(); };
  const projectByKey = async key => {
    const project = await store.getProject(key);
    requireId('project', project?.id);
  };
  const appUsers = /^\/api\/admin\/app-users(?:\/([^/]+))?$/.exec(pathname);
  const global = /^\/api\/admin\/(?:messaging|poc-levels|performance-standards|service-catalog|organization-standards|departments|sub-departments|clusters|import-workbook)(?:\/|$)/.test(pathname);
  if (global && method !== 'GET') deny();
  if (appUsers) {
    const users = await store.listAppUsers();
    const performance = await store.getProjectPerformanceData();
    const personWithinScope = id => allowed.internal.has(id)
      && (performance.projects || []).filter(project => Object.values(project.team || {}).includes(id)).every(project => allowed.project.has(project.id));
    const manageable = user => user.role === 'project_user'
      && normalizeClusterAccess(user.clusterAccess, user.role).length > 0
      && normalizeClusterAccess(user.clusterAccess, user.role).every(row => allowed.cluster.has(row.clusterId))
      && personWithinScope(user.internalPocId);
    if (appUsers[1] && !manageable(users.find(row => row.id === decodeURIComponent(appUsers[1])) || {})) deny();
    if (method !== 'GET' && method !== 'DELETE') {
      if (body.role && body.role !== 'project_user') deny();
      if (body.externalLoginAllowed !== undefined) deny(); // External identity approval is Super Admin-only.
      const personId = body.internalPocId ?? users.find(row => row.id === appUsers[1])?.internalPocId;
      if (body.createInternalPoc || !personId || !personWithinScope(personId)) deny();
      if (method === 'POST' && !Array.isArray(body.clusterAccess)) deny();
      if (body.clusterAccess !== undefined && (!Array.isArray(body.clusterAccess) || !body.clusterAccess.length || body.clusterAccess.some(row => !allowed.cluster.has(row.clusterId)))) deny();
    }
    return { directory, scoped, manageable };
  }

  let known = global || ['/api/dashboard', '/api/projects', '/api/project-performance', '/api/admin/status', '/api/admin/directory', '/api/admin/project-teams', '/api/admin/import-workbook-template',
    '/api/admin/projects', '/api/admin/projects/bulk', '/api/admin/projects/bulk-status', '/api/admin/project-setups', '/api/admin/clients', '/api/admin/internal-pocs', '/api/admin/services', '/api/admin/pocs', '/api/admin/client-pocs', '/api/project-performance/projects', '/api/admin/pocs/bulk-control',
    '/api/admin/project-automation/preview', '/api/admin/project-automation/bulk', '/api/admin/bulk-feedback/preview', '/api/admin/bulk-feedback/send'].includes(pathname);
  let match;
  if ((match = /^\/api\/projects\/([^/]+)(?:\/(?:workspace|automation-settings|request-feedback|issues))?$/.exec(pathname))) {
    known = true; await projectByKey(decodeURIComponent(match[1]));
  } else if ((match = /^\/api\/(sessions|cycles|issues)\/([^/]+)(?:\/(?:messages|sessions|manual-whatsapp-message|score|stop|reminder|no-response|close|reopen|progress))?$/.exec(pathname))) {
    known = true;
    const getter = { sessions: 'getSession', cycles: 'getCycle', issues: 'getIssue' }[match[1]];
    if (typeof store[getter] !== 'function') deny();
    const record = await store[getter](decodeURIComponent(match[2]));
    requireId('project', record?.projectId || record?.project_id);
  } else if ((match = /^\/api\/admin\/(projects|clients|internal-pocs|services|pocs)\/([^/]+)(?:\/(?:pocs|services|chat-messages|feedback-cycles|issues))?$/.exec(pathname)) && !['bulk', 'bulk-status', 'bulk-control'].includes(match[2])) {
    known = true;
    const kind = { projects: 'project', clients: 'client', 'internal-pocs': 'internal', services: 'service', pocs: 'poc' }[match[1]];
    requireId(kind, decodeURIComponent(match[2]));
  } else if ((match = /^\/api\/project-performance\/(?:projects\/)?([^/]+)(?:\/(?:zoho-password|services|service-change-requests)(?:\/[^/]+)?)?$/.exec(pathname)) && match[1] !== 'projects') {
    known = true; requireId('project', decodeURIComponent(match[1]));
  }
  if (!known) deny();
  // Validate all identifiers in all bulk rows before the first mutation.
  const refs = { projectId: 'project', clientId: 'client', clusterId: 'cluster', internalPocId: 'internal', reportingManagerId: 'internal', projectDirectorId: 'internal', amId: 'internal', tlId: 'internal', adId: 'internal', avpId: 'internal', clientPocId: 'poc' };
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (refs[key] && item) requireId(refs[key], item);
      else if (key === 'projectIds' && Array.isArray(item)) item.forEach(id => requireId('project', id));
      else if (key === 'clusterIds' && Array.isArray(item)) item.forEach(id => requireId('cluster', id));
      else if (['clientPocIds', 'pocIds'].includes(key) && Array.isArray(item)) item.forEach(id => requireId('poc', id));
      else if (key === 'clientIds' && Array.isArray(item)) item.forEach(id => requireId('client', id));
      else if (typeof item === 'object') walk(item);
    }
  };
  walk(body);
  if (body.clusterId !== undefined && !allowed.cluster.has(body.clusterId)) deny();
  if (body.clusterIds !== undefined && (!Array.isArray(body.clusterIds) || !body.clusterIds.length || body.clusterIds.some(id => !allowed.cluster.has(id)))) deny();
  const internalEdit = /^\/api\/admin\/internal-pocs\/([^/]+)$/.exec(pathname);
  if (internalEdit && method !== 'GET') {
    const id = decodeURIComponent(internalEdit[1]);
    const person = (directory.internalPocs || []).find(row => row.id === id);
    // Editing a shared person also affects their other clusters. Only an
    // administrator with every assigned cluster (or Super Admin) may do so.
    if ((person?.clusterIds || [person?.clusterId]).some(clusterId => !allowed.cluster.has(clusterId))) deny();
    const performance = await store.getProjectPerformanceData();
    if ((performance.projects || []).some(project => !allowed.project.has(project.id) && Object.values(project.team || {}).includes(id))) deny();
    if ((directory.projectServices || []).some(service => service.internalPocId === id && !allowed.project.has(service.projectId))) deny();
    if ((directory.internalPocs || []).some(person => person.reportingManagerId === id && !allowed.internal.has(person.id))) deny();
  }
  if (pathname === '/api/admin/pocs/bulk-control') (body.updates || []).forEach(row => requireId('poc', row.id));
  if (method === 'POST' && pathname === '/api/admin/clients') requireId('cluster', body.clusterId);
  if (method === 'POST' && pathname === '/api/admin/internal-pocs') {
    if (body.clusterIds?.length) body.clusterIds.forEach(id => requireId('cluster', id));
    else requireId('cluster', body.clusterId);
  }
  return { directory, scoped };
}

function scopedBrowserStore(store, access, context) {
  return new Proxy(store, { get(target, key) {
    if (key === 'getDirectory') return async () => scopeDirectory(await target.getDirectory(), access);
    if (key === 'listProjects') return async (...args) => (await target.listProjects(...args)).filter(row => context.scoped.projects.some(project => project.id === row.id));
    if (key === 'getDashboard' || key === 'getProjectPerformanceData') return async (...args) => scopeProjectData(await target[key](...args), access, await target.getDirectory());
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

module.exports = { normalizeClusterAccess, clusterIds, clusterVisible, scopeDirectory, scopeProjectData, authorizeClusterRequest, scopedBrowserStore };

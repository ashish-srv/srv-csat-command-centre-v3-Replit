const assert = require("assert");
const { importAdminWorkbook } = require("../src/lib/admin-import");

function emptyDirectory() {
  return {
    clusters: [], clients: [], projects: [],
    pocLevels: [
      { id: "level-normal", name: "Normal", weight: 40 },
      { id: "level-important", name: "Important", weight: 60 }
    ],
    departments: [], subDepartments: [], internalPocs: [],
    serviceCatalog: [
      { id: "service-ppc", name: "PPC / Media", serviceKey: "ppc", active: true },
      { id: "service-website", name: "Website", serviceKey: "website", active: true }
    ]
  };
}

function validWorkbook() {
  return {
    clients: [{ row: 5, key: "mitwpu", name: "MIT-WPU", clusterName: "Education", activeStatus: "active" }],
    projects: [{
      row: 5, clientKey: "mitwpu", key: "MITWPU2627", name: "Digital Marketing",
      activeStatus: "active", startDate: "2026-07-01", endDate: "2027-06-30", feedbackIntervalDays: 30
    }],
    clientPocs: [{
      row: 5, projectKey: "MITWPU2627", name: "Aashish", designation: "Marketing Head",
      contactWhatsapp: "+91 98765 43210", contactEmail: "aashish@example.com", salutation: "Aashish Sir",
      birthDate: "1988-04-18", honorific: "Mr", levelName: "Important", weightPercentage: 100, active: "yes"
    }],
    internalPocs: [
      {
        row: 5, name: "Manager", email: "manager@srvmedia.com", phone: "+91 98000 00000",
        clusterName: "Education", departmentName: "Performance", subDepartmentName: "PPC",
        reportingManagerEmail: "", active: "yes"
      },
      {
        row: 6, name: "Owner", email: "owner@srvmedia.com", phone: "+91 98000 00001",
        clusterName: "Education", departmentName: "Performance", subDepartmentName: "PPC",
        reportingManagerEmail: "manager@srvmedia.com", active: "yes"
      }
    ],
    services: [{
      row: 5, projectKey: "MITWPU2627", serviceKey: "", name: "PPC / Media",
      internalOwnerEmail: "owner@srvmedia.com", kpis: "CPL; leads; lead quality"
    }]
  };
}

function fakeStore() {
  let sequence = 0;
  const calls = [];
  const next = (prefix, input) => ({ id: `${prefix}-${++sequence}`, ...input });
  return {
    calls,
    async getDirectory() { return emptyDirectory(); },
    async getClientDetail() { return null; },
    async createCluster(input) { calls.push(["cluster", input]); return next("cluster", input); },
    async createDepartment(input) { calls.push(["department", input]); return next("department", input); },
    async createSubDepartment(input) { calls.push(["sub", input]); return next("sub", input); },
    async createInternalPoc(input) { calls.push(["internal:create", input]); return next("internal", input); },
    async updateInternalPoc(id, input) { calls.push(["internal:update", id, input]); return { id, ...input }; },
    async createClient(input) { calls.push(["client:create", input]); return next("client", input); },
    async updateClient(id, input) { calls.push(["client:update", id, input]); return { id, ...input }; },
    async createProject(input) { calls.push(["project:create", input]); return next("project", input); },
    async updateProject(id, input) { calls.push(["project:update", id, input]); return { id, ...input }; },
    async ensureProjectSchedule() { return false; },
    async createClientPoc(input) { calls.push(["poc:create", input]); return next("poc", input); },
    async updateClientPoc(id, input) { calls.push(["poc:update", id, input]); return { id, ...input }; },
    async createProjectService(input) { calls.push(["service:create", input]); return next("service", input); },
    async updateProjectService(id, input) { calls.push(["service:update", id, input]); return { id, ...input }; }
  };
}

async function run() {
  const store = fakeStore();
  const result = await importAdminWorkbook(store, validWorkbook());
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts.clients, { created: 1, updated: 0 });
  assert.deepEqual(result.counts.projects, { created: 1, updated: 0 });
  assert.deepEqual(result.counts.clientPocs, { created: 1, updated: 0 });
  assert.deepEqual(result.counts.services, { created: 1, updated: 0 });
  assert.deepEqual(result.counts.internalPocs, { created: 2, updated: 0 });
  const serviceCall = store.calls.find(([name]) => name === "service:create");
  assert.equal(serviceCall[1].serviceKey, "ppc");
  assert.ok(serviceCall[1].internalPocId);
  const ownerManagerLink = store.calls.find(([name, , input]) => name === "internal:update" && input.reportingManagerId);
  assert.ok(ownerManagerLink, "the second internal POC pass should link the manager");
  const pocCreate = store.calls.find(([name]) => name === "poc:create");
  assert.equal(pocCreate[1].birthDate, "1988-04-18", "birthday should be included in the POC upsert");

  const missingCoverage = validWorkbook();
  missingCoverage.services = [];
  const blockedStore = fakeStore();
  const blocked = await importAdminWorkbook(blockedStore, missingCoverage);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.some((message) => message.includes("at least one service")));
  assert.equal(blockedStore.calls.length, 0, "validation errors must prevent all writes");

  const flexibleProjectId = validWorkbook();
  flexibleProjectId.projects[0].key = "mitwpu-website";
  flexibleProjectId.clientPocs[0].projectKey = "mitwpu-website";
  flexibleProjectId.services[0].projectKey = "mitwpu-website";
  const flexibleProjectResult = await importAdminWorkbook(fakeStore(), flexibleProjectId);
  assert.equal(flexibleProjectResult.ok, true, "project ID should not be tied to the project dates");

  const invalidPocWeight = validWorkbook();
  invalidPocWeight.clientPocs[0].weightPercentage = 60;
  const invalidPocWeightResult = await importAdminWorkbook(fakeStore(), invalidPocWeight);
  assert.equal(invalidPocWeightResult.ok, false);
  assert.ok(invalidPocWeightResult.errors.some((message) => message.includes("total exactly 100%")));

  const inactiveOnly = validWorkbook();
  inactiveOnly.clientPocs[0].active = "no";
  inactiveOnly.clientPocs[0].weightPercentage = 0;
  const inactiveOnlyResult = await importAdminWorkbook(fakeStore(), inactiveOnly);
  assert.equal(inactiveOnlyResult.ok, true, "an active project may import only inactive historical POCs");

  const selfManaged = validWorkbook();
  selfManaged.internalPocs[0].reportingManagerEmail = "manager@srvmedia.com";
  const selfManagedResult = await importAdminWorkbook(fakeStore(), selfManaged);
  assert.equal(selfManagedResult.ok, true, "an internal POC may be their own reporting manager");

  const sharedClientPoc = validWorkbook();
  sharedClientPoc.projects.push({
    ...sharedClientPoc.projects[0], row: 6, key: "MITWEBSITE", name: "Website"
  });
  sharedClientPoc.clientPocs.push({
    ...sharedClientPoc.clientPocs[0], row: 6, projectKey: "MITWEBSITE"
  });
  sharedClientPoc.services.push({
    ...sharedClientPoc.services[0], row: 6, projectKey: "MITWEBSITE", serviceKey: "website", name: "Website"
  });
  const sharedClientPocResult = await importAdminWorkbook(fakeStore(), sharedClientPoc);
  assert.equal(sharedClientPocResult.ok, true, "one client POC may belong to several projects of the same client");

  const sharedCrossClientPoc = validWorkbook();
  sharedCrossClientPoc.clients.push({ row: 6, key: "sls-nagpur", name: "SLS Nagpur", clusterName: "Education", activeStatus: "active" });
  sharedCrossClientPoc.projects.push({
    ...sharedCrossClientPoc.projects[0], row: 6, clientKey: "sls-nagpur", key: "SLSNAGPUR", name: "SLS Nagpur Marketing"
  });
  sharedCrossClientPoc.clientPocs.push({
    ...sharedCrossClientPoc.clientPocs[0], row: 6, projectKey: "SLSNAGPUR"
  });
  sharedCrossClientPoc.services.push({
    ...sharedCrossClientPoc.services[0], row: 6, projectKey: "SLSNAGPUR"
  });
  const sharedCrossClientResult = await importAdminWorkbook(fakeStore(), sharedCrossClientPoc);
  assert.equal(sharedCrossClientResult.ok, true, "one POC may belong to projects under different clients");

  const loop = validWorkbook();
  loop.internalPocs[0].reportingManagerEmail = "owner@srvmedia.com";
  const loopResult = await importAdminWorkbook(fakeStore(), loop);
  assert.equal(loopResult.ok, false);
  assert.ok(loopResult.errors.some((message) => message.includes("management loop")));

  console.log("Admin multi-client workbook import smoke tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { transformSync } = require("esbuild");
const { ComponentHarness, elements } = require("./workspace-navigation-smoke");
const { encryptCredential, decryptCredential } = require("../src/lib/credential-vault");

const currentUser = { appUserId: "user1", email: "test@example.com", role: "super_admin", permissions: {} };
const project = { id: "p1", key: "p1", clientId: "c1", clientName: "Client", name: "Project", version: 1, services: [], team: {}, kpis: [], auditHistory: [], clientPocs: [] };
const other = { ...project, id: "p2", key: "p2", name: "Project 2" };
let data = { projects: [project, other], clients: [], internalPocs: [], referenceValues: {}, serviceCatalog: [], serviceChangeRequests: [] };
const storageItems = new Map();
const storage = { getItem: (key) => storageItems.get(key) || null, setItem: (key, value) => storageItems.set(key, value) };
const field = (h, label) => h.find((node) => node.props.label === label && node.props.children)?.props.children;
const picker = (h) => h.find((node) => node.type === "SingleSelect" && node.props.label === "Project to Update");

async function main() {
  const exported = { exports: {} };
  vm.runInNewContext(transformSync(fs.readFileSync("src/lib/performance-metrics.js", "utf8"), { format: "cjs" }).code, { module: exported, exports: exported.exports });
  const metrics = exported.exports;
  assert.equal(metrics.kpiDifference({ target: 1200, actual: 1647 }), 447);
  assert.equal(metrics.kpiAchievement({ kpiName: "CPL", target: 1200, actual: 1647 }), null);
  assert.equal(metrics.kpiAchievement({ kpiName: "CPA", target: 1200, actual: 900 }), null);
  assert.equal(metrics.kpiAchievement({ kpiName: "Leads", target: 100, actual: 200 }), 200);
  assert.equal(metrics.kpiDifference({ target: "", actual: 0 }), null);
  assert.equal(metrics.kpiDifference({ target: 0, actual: 0 }), 0);
  console.log("PASS KPI difference, cost suppression, zero and missing values");
  const table = new ComponentHarness("src/components/ProjectPerformance.jsx", { project: { ...project, currency: "INR", kpis: [{ kpiName: "CPL", comment: "MBA IT", unit: "currency", target: 1200, actual: 1647 }, { kpiName: "Leads", comment: "Technology Management", target: 100, actual: 200 }] } }, "/", async () => ({}), "KpiTable");
  await table.settle();
  const rendered = JSON.stringify(table.tree);
  assert.ok(rendered.includes("Difference (Actual"));
  assert.ok(rendered.includes("Not applicable") && rendered.includes("Over target") && rendered.includes("200.0%"));
  assert.ok(!rendered.includes("72.9%"));
  assert.ok(rendered.includes("MBA IT") && rendered.includes("Technology Management"));
  assert.equal(table.find((node) => node.props.field === "difference").props.kpi.difference, 447);
  console.log("PASS rendered KPI table distinguishes program labels and cost overruns");

  const previousKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  try {
    const secret = "test-only-credential", encrypted = encryptCredential(secret, "p1");
    assert.ok(!encrypted.includes(secret));
    assert.equal(decryptCredential(encrypted, "p1"), secret);
    assert.notEqual(encrypted, encryptCredential(secret, "p1"), "random IV for every write");
    assert.throws(() => decryptCredential(encrypted, "p2"), "ciphertext cannot be moved to a different project");
    const parts = encrypted.split("."); parts[3] = Buffer.alloc(20).toString("base64");
    assert.throws(() => decryptCredential(parts.join("."), "p1"));
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    assert.throws(() => encryptCredential(secret, "p1"), /CREDENTIALS_ENCRYPTION_KEY/);
    assert.equal(encryptCredential("", "p1"), null);
  } finally { if (previousKey === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY; else process.env.CREDENTIALS_ENCRYPTION_KEY = previousKey; }
  console.log("PASS encrypted credential round-trip, tamper protection and missing-key failure");

  let saved = null;
  const config = { storage, write: async (_path, payload) => { saved = payload; return {}; } };
  const create = (user = currentUser) => new ComponentHarness("src/components/ProjectPerformance.jsx", { currentUser: user }, "/project-performance", async () => structuredClone(data), null, config);
  const h = create(); await h.settle(); picker(h).props.onChange("p1"); await h.settle();
  field(h, "Mandates, Targets and Service Details").props.onChange({ target: { value: "Unsaved mandate" } });
  h.find((node) => node.type === "Button" && node.props.children === "Add KPI").props.onClick(); await h.settle();
  field(h, "Comment / Program").props.onChange({ target: { value: "MBA IT" } });
  field(h, "Zoho Password").props.onChange({ target: { value: "not-in-browser-storage" } }); await h.settle();
  assert.ok(![...storageItems.values()].join("").includes("not-in-browser-storage"));
  data.projects[0] = { ...project, version: 2, mandates: "Someone else's saved mandate" };
  h.document.hidden = true; h.dispatch("visibilitychange"); await h.settle();
  h.document.hidden = false; h.dispatch("visibilitychange"); await h.settle();
  assert.equal(field(h, "Mandates, Targets and Service Details").props.value, "Unsaved mandate");
  assert.equal(field(h, "Comment / Program").props.value, "MBA IT");
  assert.equal(field(h, "Zoho Password").props.value, "not-in-browser-storage");
  const save = h.find((node) => node.type === "Button" && node.props.children === "Save Project Performance");
  await save.props.onClick(); await h.settle();
  assert.equal(saved.expectedVersion, 1, "background refresh must not rebase a dirty draft onto another editor's version");
  assert.equal(saved.kpis[0].comment, "MBA IT");
  assert.ok(!storage.getItem("csat:performance-drafts:user1").includes("Unsaved mandate"));
  console.log("PASS tab return preserves drafts and original conflict version; passwords are never persisted in browser storage");

  field(h, "Mandates, Targets and Service Details").props.onChange({ target: { value: "Draft for project 1" } }); await h.settle();
  picker(h).props.onChange("p2"); await h.settle();
  field(h, "Mandates, Targets and Service Details").props.onChange({ target: { value: "Draft for project 2" } }); await h.settle();
  picker(h).props.onChange("p1"); await h.settle();
  assert.equal(field(h, "Mandates, Targets and Service Details").props.value, "Draft for project 1");
  const remount = create(); await remount.settle();
  assert.equal(field(remount, "Mandates, Targets and Service Details").props.value, "Draft for project 1");
  const anotherUser = create({ ...currentUser, appUserId: "user2", email: "other@example.com" }); await anotherUser.settle();
  assert.equal(picker(anotherUser).props.value, "");
  console.log("PASS project switching, route remount and user isolation");

  let finishSlowRefresh;
  let slowRefresh = false;
  const race = new ComponentHarness("src/components/ProjectPerformance.jsx", { currentUser }, "/project-performance", async () => slowRefresh ? new Promise((resolve) => { finishSlowRefresh = resolve; }) : structuredClone(data), null, config);
  await race.settle(); picker(race).props.onChange("p1"); await race.settle();
  slowRefresh = true; race.dispatch("visibilitychange"); await race.settle();
  picker(race).props.onChange("p2"); await race.settle();
  finishSlowRefresh(structuredClone(data)); await race.settle();
  assert.equal(picker(race).props.value, "p2", "late response cannot restore a previously selected project");
  console.log("PASS delayed refresh cannot switch back to an older project");

  let chosen = "owner1";
  const select = new ComponentHarness("src/components/Filters.jsx", { label: "AM", options: [{ value: "owner1", label: "Owner One" }, { value: "owner2", label: "Other Person" }], value: chosen, onChange: (value) => { chosen = value; } }, "/", async () => ({}), "SingleSelect");
  await select.settle();
  select.find((node) => node.props.className?.startsWith("filter-trigger")).props.onKeyDown({ key: "Backspace", preventDefault() {} });
  assert.equal(chosen, "");
  select.find((node) => node.props.className?.startsWith("filter-trigger")).props.onClick(); await select.settle();
  select.find((node) => node.type === "input").props.onChange({ target: { value: "Other" } }); await select.settle();
  const matchedOptions = elements(select.tree, (node) => node.props.role === "option");
  assert.ok(JSON.stringify(matchedOptions).includes("Other Person"));
  assert.ok(!JSON.stringify(matchedOptions).includes("Owner One"));
  console.log("PASS searchable dropdown and Backspace clearing");

  let hiddenValue = "";
  const reveal = new ComponentHarness("src/components/ProjectPerformance.jsx", { project: { ...project, zohoPasswordSet: true } }, "/", async () => new Promise((resolve) => { hiddenValue = resolve; }), "ZohoPassword");
  await reveal.settle();
  const showing = reveal.find((node) => node.props["aria-label"] === "Show Zoho password").props.onClick();
  reveal.dispatch("blur"); hiddenValue({ password: "must-not-appear-after-blur" }); await showing; await reveal.settle();
  assert.ok(!JSON.stringify(reveal.tree).includes("must-not-appear-after-blur"));
  console.log("PASS delayed password reveal cannot expose credentials after tab leave");

  const directory = { clients: [{ id: "c1", key: "c1", name: "Client", clusterId: "cl1" }], clusters: [{ id: "cl1", name: "Orion" }], projects: [project, other].map((p) => ({ ...p, activeStatus: "active", startDate: "2026-01-01", endDate: "2026-12-31", feedbackIntervalDays: 30 })), clientPocs: [], internalPocs: [], departments: [], subDepartments: [], pocLevels: [], serviceCatalog: [], projectServices: [{ id: "svc1", projectId: "p1", name: "Design", serviceKey: "design" }, { id: "svc2", projectId: "p2", name: "SEO", serviceKey: "seo" }] };
  const manage = new ComponentHarness("src/components/Manage.jsx", { currentUser, onReload() {} }, "/manage", async (url) => url === "/api/admin/directory" ? directory : { users: [], values: [], projects: [], requests: [] }, null, { write: async () => ({}) });
  await manage.settle();
  manage.find((node) => node.props["aria-label"] === "Edit Project").props.onClick(); await manage.settle();
  assert.ok(manage.scrolls.includes("manage-projects"));
  const scrollCount = manage.scrolls.length;
  manage.find((node) => node.props["aria-label"] === "Edit Project").props.onClick(); await manage.settle();
  assert.ok(manage.scrolls.length > scrollCount, "clicking the same project's pencil scrolls back to its existing editor");
  manage.find((node) => node.props["aria-label"] === "Edit Design").props.onClick(); await manage.settle();
  const batch = () => manage.find((node) => node.type?.name === "ServiceBatchForm");
  assert.equal(batch().props.value.projectId, "p1");
  await batch().props.onSave(); await manage.settle();
  assert.equal(batch().props.value.projectId, "p1");
  assert.equal(batch().props.value.rows.length, 1);
  assert.equal(manage.scrolls.at(-1), 350);
  assert.equal(elements(manage.tree, (node) => node.props["aria-label"] === "Edit SEO").length, 0, "saved service editor retains its project scope");
  console.log("PASS Manage edit navigation, save context, scroll and project-scoped services");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

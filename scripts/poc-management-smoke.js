const assert = require("node:assert/strict");
const { SupabaseStore } = require("../src/lib/supabase-store");
const { PostgresStore } = require("../src/lib/postgres-store");
const { ComponentHarness, elements } = require("./workspace-navigation-smoke");

async function dropdowns() {
  for (const [label, top] of [["POC tag 1", 100], ["POC tag 2", 580], ["POC tag 3", 700], ["Service", 650], ["Internal owner", 650], ["AM", 620]]) {
    let chosen = "normal";
    const select = new ComponentHarness("src/components/Filters.jsx", { label, portal: true, options: [{ value: "normal", label: "Normal" }, { value: "important", label: "Important" }], value: chosen, onChange: (value) => { chosen = value; } }, "/", async () => ({}), "SingleSelect");
    await select.settle();
    const container = select.find((node) => node.props.className?.startsWith("filter-field"));
    const anchor = container.props.ref.current;
    anchor.getBoundingClientRect = () => ({ top, bottom: top + 40, left: 30, width: 300 });
    select.find((node) => node.props.className?.startsWith("filter-trigger")).props.onClick(); await select.settle();
    let menu = select.find((node) => node.props.className?.includes("filter-menu-portal"));
    assert.ok(menu, `${label} must open`);
    if (top >= 530) {
      assert.equal(menu.props.style.top, "auto", "the normal CSS top offset must be reset when opening above");
      assert.ok(menu.props.style.bottom > 0);
    } else {
      assert.equal(menu.props.style.bottom, "auto");
      assert.equal(menu.props.style.top, top + 44);
    }
    select.dispatch("scroll", { target: {} }); await select.settle();
    select.dispatch("resize", { target: select.window }); await select.settle();
    menu = select.find((node) => node.props.className?.includes("filter-menu-portal"));
    assert.ok(menu, "focus/ancestor scrolling must reposition, not close, the menu");
    select.find((node) => node.props.role === "option" && node.props.children?.[1]?.props.children === "Important").props.onClick();
    await select.settle(); assert.equal(chosen, "important");
    assert.ok(!select.find((node) => node.props.className?.includes("filter-menu-portal")));
  }
  console.log("PASS upward/downward dropdowns across repeated POCs, services, owners and team fields");

  let form;
  const levels = [{ id: "normal", name: "Normal" }, { id: "important", name: "Important" }];
  form = new ComponentHarness("src/components/Manage.jsx", {
    value: { projectId: "p1", rows: [], removedIds: [] }, projects: [{ id: "p1", name: "Project" }], pocs: [], levels,
    onChange: (value) => { form.props = { ...form.props, value }; form.dirty = true; }
  }, "/", async () => ({}), "PocBatchForm");
  await form.settle();
  for (let index = 0; index < 3; index += 1) {
    form.find((node) => node.type === "Button" && node.props.children === "Add another POC").props.onClick(); await form.settle();
    const tags = elements(form.tree, (node) => node.props.label === "POC tag");
    tags[index].props.children.props.onChange({ target: { value: index === 1 ? "normal" : "important" } }); await form.settle();
  }
  assert.deepEqual(Array.from(form.props.value.rows, (row) => row.levelId), ["important", "normal", "important"]);
  form.find((node) => node.props["aria-label"] === "Remove POC 2").props.onClick(); await form.settle();
  assert.deepEqual(Array.from(form.props.value.rows, (row) => row.levelId), ["important", "important"]);
  console.log("PASS adding multiple POCs retains independent tags and removing an unsaved row affects only that row");
}

async function assignments() {
  const tables = {
    clients: [{ id: "c1", name: "Client 1" }, { id: "c2", name: "Client 2" }],
    projects: [{ id: "p1", client_id: "c1", name: "Project 1" }, { id: "p2", client_id: "c2", name: "Project 2" }],
    client_pocs: [
      { id: "a", project_id: "p1", name: "Shared", contact_whatsapp: "919999999999", active: true, weight_percentage: 50 },
      { id: "b", project_id: "p2", name: "Shared", contact_whatsapp: "919999999999", active: true, weight_percentage: 100 },
      { id: "c", project_id: "p1", name: "Inactive but retained", active: false, weight_percentage: 0 }
    ],
    feedback_sessions: [
      { id: "open", project_id: "p1", client_poc_id: "a", status: "partial", csat_score: 9, conversation_state: { pocWeightPercentage: 50 } },
      { id: "past", project_id: "p1", client_poc_id: "a", status: "completed", csat_score: 8, conversation_state: { state: "completed" } },
      { id: "elsewhere", project_id: "p2", client_poc_id: "b", status: "partial", conversation_state: {} }
    ]
  };
  const writes = [], stopped = [];
  const store = new SupabaseStore({ skipEnv: true });
  store.pocLevels = async () => new Map();
  store.request = async (table, options = {}) => {
    const params = new URLSearchParams(options.query || "");
    let rows = (tables[table] || []).filter((row) => [...params].every(([key, expression]) => {
      if (["select", "order", "limit"].includes(key)) return true;
      if (expression === "is.null") return row[key] == null;
      if (expression === "is.true") return row[key] === true;
      if (expression.startsWith("eq.")) return String(row[key]) === expression.slice(3);
      if (expression.startsWith("in.(")) return expression.slice(4, -1).split(",").includes(String(row[key]));
      return true;
    }));
    if (options.method === "PATCH") { writes.push({ table, options }); rows.forEach((row) => Object.assign(row, options.body)); }
    if (options.method === "POST") {
      rows = options.body.map((row) => ({ id: `new-${tables[table].length}`, ...row }));
      tables[table].push(...rows);
    }
    assert.notEqual(options.method, "DELETE", "assignment removal must not cascade through past feedback");
    return structuredClone(rows);
  };
  store.stopSessionForCycle = async (id, options) => {
    stopped.push(id);
    const row = tables.feedback_sessions.find((session) => session.id === id);
    row.status = "opted_out";
    row.conversation_state = { ...row.conversation_state, state: "completed", stoppedByAdmin: true, stopReason: options.reason };
  };
  const removed = await store.removeProjectPocs("p1", ["a"]);
  assert.equal(removed, 1); assert.deepEqual(stopped, ["open"]);
  assert.ok(writes[0].options.query.includes("project_id=eq.p1&id=in.(a)"));
  assert.equal(tables.client_pocs[0].weight_percentage, 50, "retain legacy historical weighting");
  assert.equal(tables.client_pocs[1].active, true, "the same contact on another project/client is untouched");
  assert.equal(tables.feedback_sessions[0].csat_score, 9);
  assert.equal(tables.feedback_sessions[1].csat_score, 8);
  assert.equal(tables.feedback_sessions[1].status, "completed");
  assert.equal(tables.feedback_sessions[2].status, "partial");
  assert.deepEqual((await store.pocsForProject("p1", { activeOnly: false })).map((row) => row.id), ["c"]);
  assert.equal((await store.pocsForProject("p1", { activeOnly: false, includeRemoved: true })).length, 2);
  const directory = await store.getDirectory();
  assert.deepEqual(directory.clientPocs.map((row) => row.id), ["b", "c"]);
  assert.deepEqual(directory.removedClientPocs.map((row) => row.id), ["a"], "permanent cleanup can still explicitly select historical assignments");
  const detail = await store.getClientDetail("c1"); assert.deepEqual(detail.pocs.map((row) => row.id), ["c"]);
  assert.deepEqual((await store.getClientDetail("c1", { includeRemoved: true })).pocs.map((row) => row.id), ["a", "c"]);
  store.listProjects = async () => tables.projects.map((row) => ({ id: row.id, clientId: row.client_id, name: row.name }));
  const performance = await store.getProjectPerformanceData();
  assert.deepEqual(performance.projects.find((row) => row.id === "p1").clientPocs.map((row) => row.id), ["c"]);
  assert.equal(await store.whatsappConflict("919999999999", "p1"), null);
  assert.equal((await store.whatsappConflict("919999999999", "p2")).owner.id, "b");
  const restored = await store.createClientPoc({ projectId: "p1", name: "Added again", contactWhatsapp: "919999999999", weightPercentage: 100 });
  assert.ok(restored.id !== "a");
  assert.equal((await store.pocsForProject("p1")).length, 1);
  assert.equal(await store.updateClientPoc("a", { active: true }), null, "removed historical records cannot be silently reactivated");
  await assert.rejects(store.removeProjectPocs("p1", ["b"]), /POC list changed/);
  assert.equal(tables.client_pocs[1].active, true);
  const historic = new SupabaseStore({ skipEnv: true });
  let historyOptions;
  historic.listCycleSessions = async () => [{ id: "past", clientPocId: "a", status: "completed", csatScore: 8, npsScore: null, pocWeight: 50 }];
  historic.pocsForProject = async (_id, options) => { historyOptions = options; return [{ id: "a", weightPercentage: 50 }]; };
  historic.listProjectSessions = historic.listCycleSessions;
  historic.request = async () => [];
  const score = await historic.recomputeCycle("cycle1", "p1");
  assert.equal(historyOptions.includeRemoved, true, "cycle aggregation must keep removed historical respondents");
  assert.equal(score.csatScore, 8);
  console.log("PASS project-only removal, inactive/current lists, re-adding, historical scores and other-client isolation");
}

async function transactions() {
  const previous = SupabaseStore.prototype.saveProjectPocBatch;
  const statements = [];
  let released = 0, fail = false;
  const client = { query: async (sql) => { statements.push(sql); return { rows: [{ id: "p1" }] }; }, release: () => { released += 1; } };
  const store = new PostgresStore({ pool: { connect: async () => client } });
  SupabaseStore.prototype.saveProjectPocBatch = async function () {
    assert.equal(this.pool, client);
    if (fail) throw new Error("simulated write failure");
    return { pocs: [], removed: 1 };
  };
  try {
    assert.equal((await store.saveProjectPocBatch("p1", [], ["a"])).removed, 1);
    assert.equal(statements[0], "BEGIN"); assert.match(statements[1], /FOR UPDATE/); assert.equal(statements.at(-1), "COMMIT");
    fail = true;
    await assert.rejects(store.saveProjectPocBatch("p1", [], ["a"]), /simulated write failure/);
    assert.equal(statements.at(-1), "ROLLBACK"); assert.equal(released, 2);
  } finally { SupabaseStore.prototype.saveProjectPocBatch = previous; }
  console.log("PASS PostgreSQL batch commit, row lock, failure rollback and connection release");
}

async function manageSave() {
  const retained = { id: "b", projectId: "p1", name: "Retained", levelId: "normal", active: true, weightPercentage: 100 };
  const directory = { clusters: [], clients: [{ id: "c1", name: "Client" }], projects: [{ id: "p1", clientId: "c1", name: "Project", activeStatus: "active" }], clientPocs: [{ ...retained, id: "a", name: "Removed" }, retained], projectServices: [], internalPocs: [], pocLevels: [{ id: "normal", name: "Normal" }], departments: [], subDepartments: [], serviceCatalog: [] };
  const writes = [];
  let fail = false;
  const manage = new ComponentHarness("src/components/Manage.jsx", { currentUser: { role: "super_admin" }, onReload() {} }, "/manage", async (url) => url === "/api/admin/directory" ? directory : {}, null, {
    write: async (url, payload) => {
      if (fail) throw new Error("simulated save failure");
      writes.push({ url, payload });
      directory.clientPocs = [retained];
      return { pocs: [retained], removed: 1 };
    }
  });
  await manage.settle();
  manage.find((node) => node.type === "Button" && node.props.children === "Manage project POCs").props.onClick(); await manage.settle();
  const batch = () => manage.find((node) => node.type?.name === "PocBatchForm");
  batch().props.onChange({ ...batch().props.value, rows: [retained], removedIds: ["a"] }); await manage.settle();
  await batch().props.onSave(); await manage.settle();
  assert.equal(writes.length, 1, "saving must work when All Clients is selected, not only with a loaded client detail");
  assert.equal(writes[0].url, "/api/admin/projects/p1/pocs");
  assert.deepEqual(Array.from(writes[0].payload.removedIds), ["a"]);
  assert.equal(batch().props.value.projectId, "p1");
  assert.deepEqual(Array.from(batch().props.value.rows, (row) => row.id), ["b"]);
  assert.equal(batch().props.value.removedIds.length, 0);
  assert.equal(manage.scrolls.at(-1), 350);
  assert.ok(!manage.find((node) => node.props["aria-label"] === "Edit Removed"));
  fail = true;
  batch().props.onChange({ ...batch().props.value, rows: [], removedIds: ["b"] }); await manage.settle();
  await batch().props.onSave(); await manage.settle();
  assert.deepEqual(Array.from(batch().props.value.removedIds), ["b"], "failed saves retain the removal draft for retry");
  assert.equal(directory.clientPocs[0].id, "b");
  console.log("PASS All Clients POC saving, editor/project/scroll retention, actual removal display and failure retry");
}

async function workspaceConfiguration() {
  const project = { id: "p1", clientId: "c1", activeStatus: "active" };
  const old = { id: "old", projectId: "p1", name: "Existing", levelId: "normal", weightPercentage: 100, active: true };
  const directory = { projects: [project], clientPocs: [old], projectServices: [], internalPocs: [], serviceCatalog: [], pocLevels: [{ id: "normal", name: "Normal" }, { id: "important", name: "Important" }] };
  let payload;
  const config = new ComponentHarness("src/components/ProjectConfiguration.jsx", { workspace: { project, pocs: [old], services: [] }, currentUser: { role: "super_admin" }, showToast() {} }, "/", async () => directory, null, {
    write: async (_url, body) => { payload = body; directory.clientPocs = []; return { pocs: [], removed: 1 }; }
  });
  await config.settle(); config.find((node) => node.props.className === "project-configuration-toggle").props.onClick(); await config.settle();
  for (let index = 0; index < 2; index += 1) {
    config.find((node) => node.type === "Button" && node.props.children === "Add another POC").props.onClick(); await config.settle();
    const tags = elements(config.tree, (node) => node.props.label === "POC tag");
    tags[index + 1].props.children.props.onChange({ target: { value: "important" } }); await config.settle();
  }
  const tags = elements(config.tree, (node) => node.props.label === "POC tag");
  assert.deepEqual(tags.map((node) => node.props.children.props.value), ["normal", "important", "important"]);
  // Remove unsaved rows, then remove the persisted assignment and save.
  const removers = () => elements(config.tree, (node) => node.props["aria-label"]?.startsWith("Remove ") && node.props["aria-label"]?.endsWith(" from this project"));
  removers()[2].props.onClick(); await config.settle();
  removers()[1].props.onClick(); await config.settle();
  removers()[0].props.onClick(); await config.settle();
  await config.find((node) => node.type === "Button" && node.props.children === "Save all POCs").props.onClick(); await config.settle();
  assert.deepEqual(Array.from(payload.removedIds), ["old"], "unsaved rows must never be submitted as persisted deletions");
  assert.equal(payload.pocs.length, 0);
  assert.equal(removers().length, 0, "removed assignments stay absent after configuration reload");
  console.log("PASS Workspace repeated POC tags, unsaved/saved removal IDs and post-save disappearance");
}

async function main() { await dropdowns(); await assignments(); await transactions(); await manageSave(); await workspaceConfiguration(); }
main().catch((error) => { console.error(error); process.exitCode = 1; });

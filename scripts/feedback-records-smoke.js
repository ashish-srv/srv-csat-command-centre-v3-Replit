const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { SupabaseStore, sessionIsTerminal } = require("../src/lib/supabase-store");
const { PostgresStore } = require("../src/lib/postgres-store");
const { observationRecords, fullIssueDetail, issueHeading, feedbackRecordTopic } = require("../src/lib/feedback-records");
const results = [];
const copy = (value) => JSON.parse(JSON.stringify(value));
async function scenario(name, run) {
  try { await run(); results.push([true, name]); }
  catch (error) { results.push([false, name, error.stack]); }
}
function recordFixture() {
  const provider = new SupabaseStore({ skipEnv: true }), rows = [];
  provider.request = async (table, options = {}) => {
    assert.equal(table, "observations");
    if (options.method !== "POST") return copy(rows);
    assert.equal(options.query, "on_conflict=session_id,record_key");
    const fresh = options.body.filter((item) => !rows.some((row) => row.record_key === item.record_key));
    rows.push(...copy(fresh)); return copy(fresh);
  };
  return { provider, rows, session: { id: "s", projectId: "p", clientPocId: "c" } };
}
function expiryFixture(states) {
  const provider = new SupabaseStore({ skipEnv: true });
  const rows = states.map((state, index) => ({ id: `s${index}`, cycle_id: `c${index}`, project_id: "p", client_poc_id: "poc",
    status: "partial", completion_status: "partial", conversation_state: state, feedback_cycles: { cycle_type: "quick_checkin" } }));
  const patches = [], rollups = [];
  provider.request = async (table, options = {}) => {
    const query = new URLSearchParams(options.query || "");
    if (table === "feedback_cycles") return rows.map((row) => ({ id: row.cycle_id }));
    assert.equal(table, "feedback_sessions");
    if (options.method === "PATCH") {
      const row = rows.find((item) => `eq.${item.id}` === query.get("id"));
      const revisionMatches = typeof row.updated_at === "string" && row.updated_at ? `eq.${row.updated_at}` === query.get("updated_at")
        : `eq.${JSON.stringify(row.conversation_state)}` === query.get("conversation_state");
      if (provider.race || `eq.${row.status}` !== query.get("status") || !revisionMatches) return [];
      patches.push(copy(options.body)); Object.assign(row, copy(options.body)); return [copy(row)];
    }
    return Number(query.get("offset") || 0) ? [] : copy(rows);
  };
  provider.recomputeCycle = async (...args) => { rollups.push(args); };
  provider.listCycleSessions = async (cycleId) => rows.filter((row) => row.cycle_id === cycleId).map((row) => ({
    id: row.id, sessionType: row.feedback_cycles.cycle_type, status: row.status, completionStatus: row.completion_status,
    conversationState: copy(row.conversation_state) }));
  return { provider, rows, patches, rollups };
}
async function run() {
  await scenario("Paraphrases of one source retain the exact client words once, without invented intent", async () => {
    const f = recordFixture(), sourceMessage = { id: "m1", body: "there should be weekly report sharing" };
    const readings = ["Client requested weekly report sharing.", "Please provide weekly updates to track progress better.", "The client requested regular reports."];
    await f.provider.recordObservations(f.session, readings.map((detail, index) => ({ topic: `Reporting ${index}`, detail, sentiment: "neutral" })), { sourceMessage });
    await f.provider.recordObservations(f.session, [{ topic: "Frequency", detail: "Share weekly reports", sentiment: "neutral" }], { sourceMessage });
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].detail, sourceMessage.body);
    assert.equal(f.rows[0].source_message_id, "m1");
    assert.equal(f.rows[0].source_text, sourceMessage.body);
  });
  await scenario("Distinct exact points, later additions, corrections and sentiment remain separate", async () => {
    const f = recordFixture(), sourceMessage = { id: "m1", body: "Separate course-wise totals. Include spend by region." };
    const points = ["Separate course-wise totals.", "Include spend by region."];
    await f.provider.recordObservations(f.session, points.map((detail) => ({ topic: "Reporting", detail })), { sourceMessage });
    await f.provider.recordObservations(f.session, [{ topic: "Reporting", detail: "Send monthly, not weekly." }], { sourceMessage: { id: "m2", body: "Send monthly, not weekly." } });
    await f.provider.recordObservations(f.session, [{ topic: "Reporting", detail: points[0], sentiment: "positive" }], { sourceMessage: { id: "m3", body: points[0] } });
    assert.equal(f.rows.length, 4);
    assert.deepEqual(f.rows.slice(0, 2).map((row) => row.detail), points);
  });
  await scenario("Legacy identical text deduplicates across label variants, not by topic alone", async () => {
    const f = recordFixture();
    await f.provider.recordObservations(f.session, [{ topic: "Reporting", detail: "Weekly reports please." }]);
    await f.provider.recordObservations(f.session, [{ topic: "Reporting Cadence", detail: "Weekly reports please." }, { topic: "Reporting", detail: "Separate course-wise totals." }]);
    assert.equal(f.rows.length, 2);
  });
  await scenario("Concurrent identical deliveries have a database conflict key", async () => {
    const f = recordFixture(), options = { sourceMessage: { id: "m1", body: "Weekly reports please." } };
    await Promise.all(Array.from({ length: 5 }, () => f.provider.recordObservations(f.session, [{ topic: "Reporting", detail: options.sourceMessage.body }], options)));
    assert.equal(f.rows.length, 1);
  });
  await scenario("Long feedback restores a clipped prefix and preserves Unicode and line breaks", () => {
    const body = `${"Shared changes were not implemented consistently. ".repeat(19)}\nThank you Sammar and Moulik — धन्यवाद 😊`;
    const [record] = observationRecords([{ topic: "Creative Process", detail: body.slice(0, 600) }], { id: "m", body });
    assert.equal(record.detail, body);
    assert.equal(fullIssueDetail({ issueRootCause: body.slice(0, 800), reasonText: body }), body);
    assert.equal(issueHeading({ serviceName: "Landing Page", reasonText: body, issueTitle: `Landing Page: ${body}`.slice(0, 160) }), "Landing Page: Client-reported concern");
  });
  await scenario("Unknown topic does not become a management complaint; explicit lead-quality evidence is labelled correctly", () => {
    assert.equal(feedbackRecordTopic({ topic: "Management Feedback", detail: "Irrelevant Leads only got generated" }), "Lead Quality");
    assert.equal(feedbackRecordTopic({ topic: "Management Feedback", detail: "Only unqualified leads came through." }), "Lead Quality");
    assert.equal(feedbackRecordTopic({ topic: "Management Feedback", detail: "The form was confusing." }), "Client Feedback");
    assert.equal(feedbackRecordTopic({ topic: "Management Feedback", detail: "Management never responded." }), "Management Feedback");
    assert.equal(feedbackRecordTopic({ topic: "Lead Volume", detail: "We need more leads." }), "Lead Volume");
  });
  await scenario("A shortened issue title cannot hide its longer explanation in UI or report", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/components/ProjectWorkspace.jsx"), "utf8");
    const code = source.match(/function hasDistinctIssueDetail\(issue\) \{[\s\S]*?\n\}/)[0];
    const distinct = new Function(`${code}; return hasDistinctIssueDetail;`)();
    assert.equal(distinct({ title: "Landing Page: Common changes were not applied", rootCause: "Common changes were not applied consistently across all designs. Communication improved later." }), true);
    assert.equal(distinct({ title: "Landing Page: Same words", rootCause: "Same words" }), false);
    assert.equal(source.split("hasDistinctIssueDetail(issue)").length, 4);
  });
  await scenario("Quick window blocks until deadline, then releases phone even before scheduler runs", async () => {
    const future = new Date(Date.now() + 600000).toISOString();
    const f = expiryFixture([{ state: "quick_checkin_window", quickCheckinWindowExpiresAt: future }]);
    assert.ok(await f.provider.getActiveSessionForPoc("poc"));
    f.rows[0].conversation_state.quickCheckinWindowExpiresAt = new Date(Date.now() - 1).toISOString();
    assert.equal(await f.provider.getActiveSessionForPoc("poc"), null);
    assert.equal(await f.provider.hasOpenCycle("p", "quick_checkin"), false);
    assert.equal(sessionIsTerminal((await f.provider.listCycleSessions("c0"))[0]), true);
    assert.equal(PostgresStore.prototype.getActiveSessionForPoc, SupabaseStore.prototype.getActiveSessionForPoc);
  });
  await scenario("Expiry uses real window even with missing/stale reminder time; leaves live/invalid/awaiting sessions alone", async () => {
    const now = Date.now(), past = new Date(now - 1).toISOString(), future = new Date(now + 600000).toISOString();
    const f = expiryFixture([
      { state: "quick_checkin_window", quickCheckinWindowExpiresAt: past, quickCheckinOutcome: "feedback_shared", quickCheckinDetail: "Original detail" },
      { state: "quick_checkin_window", quickCheckinWindowExpiresAt: future },
      { state: "quick_checkin_window", quickCheckinWindowExpiresAt: "invalid" },
      { state: "quick_checkin_detail" }, { state: "quick_checkin_choice" }
    ]);
    f.rows.forEach((row) => { row.reminder_due_at = past; });
    f.rows[0].reminder_due_at = null;
    const expired = await f.provider.expireDueQuickCheckins(new Date(now).toISOString(), { windowsOnly: true });
    assert.equal(expired.expired, 1); assert.equal(f.rollups.length, 1);
    assert.equal(f.rows[0].conversation_state.quickCheckinDetail, "Original detail");
    assert.equal(f.rows[0].conversation_state.quickCheckinWindowExpiresAt, past);
    assert.ok(f.rows[0].conversation_state.summaryPendingSince);
    assert.equal(f.rows[0].completion_status, "completed");
    assert.equal((await f.provider.expireDueQuickCheckins(new Date(now).toISOString(), { windowsOnly: true })).expired, 0);
    assert.equal((await f.provider.expireDueQuickCheckins(new Date(now).toISOString())).expired, 2);
    assert.equal(f.rows[1].status, "partial"); assert.equal(f.rows[2].status, "partial");
  });
  await scenario("Concurrent expiry does not overwrite an updated conversation or queue a duplicate", async () => {
    const f = expiryFixture([{ state: "quick_checkin_window", quickCheckinWindowExpiresAt: new Date(Date.now() - 1).toISOString() }]);
    f.provider.race = true;
    assert.equal((await f.provider.expireDueQuickCheckins()).expired, 0);
    assert.equal(f.rollups.length, 0); assert.equal(f.patches.length, 0);
  });
  await scenario("Expiry guards long real feedback by row revision without putting client text in a URL", async () => {
    const f = expiryFixture([{ state: "quick_checkin_window", quickCheckinWindowExpiresAt: new Date(Date.now() - 1).toISOString(), quickCheckinDetail: "Private long message ".repeat(1000) }]);
    f.rows[0].updated_at = new Date().toISOString();
    const request = f.provider.request;
    f.provider.request = async (table, options = {}) => {
      if (options.method === "PATCH") {
        assert.ok(options.query.length < 200);
        assert.doesNotMatch(options.query, /Private|conversation_state/);
      }
      return request(table, options);
    };
    assert.equal((await f.provider.expireDueQuickCheckins()).expired, 1);
    assert.equal(f.rows[0].conversation_state.quickCheckinDetail.length, 21000);
  });
  await scenario("PostgreSQL Date timestamps with lost microseconds cannot leave a quick window permanently open", async () => {
    const f = expiryFixture([{ state: "quick_checkin_window", quickCheckinWindowExpiresAt: new Date(Date.now() - 1).toISOString() }]);
    f.rows[0].updated_at = new Date("2026-10-22T10:00:00.123456Z");
    const request = f.provider.request;
    f.provider.request = async (table, options = {}) => {
      if (options.method === "PATCH") {
        assert.doesNotMatch(options.query, /updated_at/);
        assert.match(options.query, /conversation_state=eq/);
      }
      const result = await request(table, options);
      // Real node-postgres SELECT rows retain Date instances, unlike JSON copies.
      if (!options.method && table === "feedback_sessions") result.forEach((row) => { row.updated_at = f.rows[0].updated_at; });
      return result;
    };
    assert.equal((await f.provider.expireDueQuickCheckins()).expired, 1);
  });
  for (const cycleType of ["pulse", "project_end", "quick_checkin"]) {
    await scenario(`${cycleType} creation accepts an expired quick window but rejects a live one on the same phone`, async () => {
      const f = expiryFixture([{ state: "quick_checkin_window", quickCheckinWindowExpiresAt: new Date(Date.now() + 600000).toISOString() }]);
      const poc = { id: "poc", name: "Test POC", contactWhatsapp: "919000000001", active: true, weightPercentage: 75 };
      const project = { id: "p", key: "project", name: "Project", pocs: [poc], feedbackIntervalDays: 30 };
      f.provider.getProject = async () => project;
      f.provider.getProjectById = async () => project;
      f.provider.hasAnyCycle = async () => false;
      f.provider.getPocsByWhatsapp = async () => [poc];
      f.provider.addMessage = async () => ({});
      const originalRequest = f.provider.request;
      const writes = [];
      f.provider.request = async (table, options = {}) => {
        if (options.method === "POST") { writes.push({ table, ...copy(options) }); return options.body.map((row) => ({ id: `new-${table}`, ...copy(row) })); }
        if (table === "projects") { writes.push({ table, ...copy(options) }); return []; }
        return originalRequest(table, options);
      };
      await assert.rejects(f.provider.createCycle(project.key, { cycleType }), /active feedback request/);
      assert.equal(writes.length, 0);
      f.rows[0].conversation_state.quickCheckinWindowExpiresAt = new Date(Date.now() - 1).toISOString();
      const result = await f.provider.createCycle(project.key, { cycleType });
      assert.equal(result.cycle.cycleType, cycleType);
      assert.equal(result.sessions.length, 1);
      assert.equal(result.sessions[0].conversationState.pocWeightPercentage, 75);
      assert.equal(poc.weightPercentage, 75);
    });
  }
  await scenario("Missing deadlines and another unfinished POC still block a new cycle", async () => {
    for (const state of [{ state: "quick_checkin_window" }, { state: "quick_checkin_window", quickCheckinWindowExpiresAt: "bad date" }, { state: "quick_checkin_detail" }]) {
      const f = expiryFixture([state]);
      assert.ok(await f.provider.getActiveSessionForPoc("poc"));
      assert.equal(await f.provider.hasOpenCycle("p", "quick_checkin"), true);
    }
    const f = expiryFixture([{ state: "quick_checkin_window", quickCheckinWindowExpiresAt: new Date(Date.now() - 1).toISOString() }, { state: "quick_checkin_choice" }]);
    f.rows[1].cycle_id = "c0";
    assert.equal(await f.provider.hasOpenCycle("p", "quick_checkin"), true);
  });
  await scenario("PostgreSQL emits parameterized JSON compare-and-set and observation conflict SQL", async () => {
    const calls = [], provider = new PostgresStore({ pool: { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } } });
    const state = { state: "quick_checkin_window", quickCheckinDetail: "A quote: ' & URL" };
    await provider.request("feedback_sessions", { method: "PATCH", query: `id=eq.s&status=eq.partial&conversation_state=eq.${encodeURIComponent(JSON.stringify(state))}`, body: { status: "completed" } });
    assert.match(calls[0].sql, /"conversation_state" = \$\d/);
    assert.ok(calls[0].values.includes(JSON.stringify(state)));
    await provider.request("observations", { method: "POST", query: "on_conflict=session_id,record_key", prefer: "resolution=ignore-duplicates,return=representation", body: [{ session_id: "s", record_key: "key", detail: "=not a formula" }] });
    assert.match(calls[1].sql, /ON CONFLICT \("session_id", "record_key"\) DO NOTHING/);
  });
  await scenario("Report groups by POC identity and session, escapes HTML, omits interpretation and preserves long chat text", async () => {
    const filename = path.join(__dirname, "../src/lib/report-export.js");
    const harness = new Module(filename, module); harness.filename = filename; harness.paths = Module._nodeModulePaths(path.dirname(filename));
    harness._compile(fs.readFileSync(filename, "utf8").replace(/export (async )?function /g, "$1function ")
      .replace("export { safeFileName };", "").replace('import("exceljs")', 'Promise.resolve(require("exceljs"))')
      + "\nmodule.exports = { conversationReportSections, reportToHtml, buildExcelReport };", filename);
    const { conversationReportSections, reportToHtml, buildExcelReport } = harness.exports;
    const long = "Client's full words 😊\n".repeat(170);
    const group = (pocId, id, date, text) => ({ session: { id, clientPocId: pocId, pocName: "Same / Name", startedAt: date, reportCycle: { cycleType: "pulse" } },
      messages: [{ body: text, side: "client", createdAt: date, metadata: { interpretedIntent: "INTERNAL_ONLY", fallbackReason: "PRIVATE_REASON" } },
        { body: "Recorded", side: "bot", createdAt: date }] });
    const sections = conversationReportSections([group("a", "a2", "2026-10-22", long), group("b", "b1", "2026-10-21", "<script>alert(1)</script>"), group("a", "a1", "2026-10-20", "Earlier reply")], { cycleLabel: (value) => value, dateLabel: (value) => value });
    assert.equal(sections.length, 2); assert.equal(sections[0].chatSessions.length, 2);
    assert.match(sections[0].chatSessions[0].title, /a1/);
    assert.equal(sections[0].rows.filter((row) => row.speaker === "Same / Name").map((row) => row.message).join(""), `Earlier reply${long}`);
    const html = reportToHtml({ title: "Test", sections });
    assert.match(html, /chat-message client/); assert.match(html, /chat-message srv/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /INTERNAL_ONLY|PRIVATE_REASON|<script>alert/);
    const workbook = await buildExcelReport({ title: "Test", sections });
    assert.equal(workbook.worksheets.length, 3);
    assert.notEqual(workbook.worksheets[1].name, workbook.worksheets[2].name);
    workbook.worksheets.slice(1).forEach((sheet) => sheet.eachRow((row) => {
      assert.ok(row.height < 409, "message continuations must fit Excel's visible row-height limit");
    }));
    const values = workbook.worksheets.flatMap((sheet) => sheet.getSheetValues()).flat(2).filter(Boolean).join(" ");
    assert.doesNotMatch(values, /INTERNAL_ONLY|PRIVATE_REASON|Interpretation/);
    assert.ok((await workbook.xlsx.writeBuffer()).byteLength > 1000);
  });
  let failed = 0;
  for (const [passed, name, error] of results) { if (!passed) failed++; console.log(`${passed ? "PASS" : "FAIL"} ${name}${error ? `\n${error}` : ""}`); }
  console.log(`${results.length - failed}/${results.length} feedback record/export/expiry scenarios passed`);
  if (failed) process.exitCode = 1;
}
run().catch((error) => { console.error(error); process.exitCode = 1; });

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { SupabaseStore, sessionIsTerminal } = require("../src/lib/supabase-store");
const { PostgresStore } = require("../src/lib/postgres-store");
const { applyServiceScopeDecision } = require("../src/lib/whatsapp-state-machine");
const { conductTurn, interpretReply } = require("../src/lib/gemini");
const { prepareCsatEmail } = require("../src/lib/csat-email-policy");

// Exercise real private orchestration without adding public API endpoints.
const filename = require.resolve("../src/server/api-handler");
const harness = new Module(filename, module);
harness.filename = filename;
harness.paths = Module._nodeModulePaths(path.dirname(filename));
harness._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.audit = { notifyAutomation, notifyCycleSummaryAfterAutomaticCompletion, finalizeFeedbackWindowsAndNotify, quickCheckinDetailDecision, applyTurnServiceScope };", filename);
const flow = harness.exports.audit;
const copy = (value) => JSON.parse(JSON.stringify(value));
const results = [];
async function scenario(name, run) {
  try { await run(); results.push([true, name]); }
  catch (error) { results.push([false, name, error.stack]); }
}
function providerFixture() {
  const provider = Object.create(SupabaseStore.prototype);
  const future = new Date(Date.now() + 600000).toISOString();
  const row = { id: "session-a", cycle_id: "cycle-a", project_id: "project-a", client_poc_id: "poc-a",
    status: "needs_attention", completion_status: "completed", csat_score: 9, nps_score: 10,
    conversation_state: { state: "closing_grace", closingGraceExpiresAt: future },
    feedback_cycles: { cycle_type: "project_end" } };
  const events = [], observations = [];
  const patches = [], rollups = [];
  provider.request = async (table, options = {}) => {
    const params = new URLSearchParams(options.query || "");
    if (table === "feedback_sessions") {
      if (options.method === "PATCH") { patches.push(copy(options.body)); Object.assign(row, copy(options.body)); }
      return Number(params.get("offset") || 0) > 0 ? [] : [copy(row)];
    }
    if (table === "automation_events") {
      if (options.method === "POST") {
        const event = options.body[0];
        if (events.some((item) => item.dedupe_key === event.dedupe_key)) return [];
        const saved = { ...copy(event), id: `event-${events.length}` };
        events.push(saved); return [copy(saved)];
      }
      if (options.method === "PATCH") {
        const event = events.find((item) => `eq.${item.id}` === params.get("id"));
        assert.ok(event); Object.assign(event, copy(options.body)); return [copy(event)];
      }
      return events.filter((item) => `eq.${item.dedupe_key}` === params.get("dedupe_key")).map(copy);
    }
    if (table === "observations") {
      if (options.method === "POST") { observations.push(...copy(options.body)); return copy(options.body); }
      return copy(observations);
    }
    throw new Error(`Unexpected storage access: ${table}`);
  };
  provider.getSession = async () => ({ id: row.id, cycleId: row.cycle_id, projectId: row.project_id,
    clientPocId: row.client_poc_id, sessionType: row.feedback_cycles.cycle_type,
    status: row.status, completionStatus: row.completion_status, csatScore: row.csat_score,
    npsScore: row.nps_score, conversationState: copy(row.conversation_state) });
  provider.recomputeCycle = async (...args) => { rollups.push(args); };
  provider.getMessagingStatus = async () => ({ enabled: false });
  provider.listAppUsers = async () => [
    { email: 'super@example.test', role: 'super_admin', active: true },
    { email: 'cluster-admin@example.test', role: 'admin', active: true, clusterAccess: [{ clusterId: 'cluster-a', emailEnabled: true }] }
  ];
  provider.getProjectById = async () => ({ id: row.project_id, key: 'test', name: 'Test', clusterId: 'cluster-a' });
  let messages = [{ side: "client", body: "Original feedback" }];
  provider.getSessionDetail = async () => ({ session: await provider.getSession(),
    poc: { id: row.client_poc_id, name: "POC A" }, messages: copy(messages) });
  provider.cycleSummary = async () => ({ project: { id: row.project_id, key: "test", name: "Test" },
    cycle: { id: row.cycle_id, cycleType: row.feedback_cycles.cycle_type, csatScore: 5 },
    sessions: [await provider.getSession(), { id: "other", status: "started" }],
    issues: [{ sessionId: row.id, title: "Relevant" }, { sessionId: "other", title: "Other POC" }],
    observations: [], appreciations: [], recipients: ["other-owner@example.test"] });
  return { provider, row, events, observations, patches, rollups,
    setMessages(value) { messages = value; } };
}

async function run() {
  const originalFetch = global.fetch;
  const keys = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "N8N_CYCLE_COMPLETED_WEBHOOK", "N8N_HUMAN_HANDOFF_WEBHOOK"];
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.N8N_CYCLE_COMPLETED_WEBHOOK = "https://fixture.invalid/summary";
  process.env.N8N_HUMAN_HANDOFF_WEBHOOK = "https://fixture.invalid/handoff";
  try {
    await scenario("Long conversation prompts retain the newest reply and an explicit latest-message block", async () => {
      process.env.GEMINI_API_KEY = "fixture";
      let prompt;
      global.fetch = async (_url, options) => {
        prompt = JSON.parse(options.body).input;
        return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ message: "Thank you for the update.", askedFor: "none" }) }) };
      };
      const latest = "Please add a weekly spend report, separately from the earlier design concern.";
      const messages = Array.from({ length: 23 }, (_, i) => ({ side: i % 2 ? "bot" : "client", body: `Earlier ${i} ${"background ".repeat(300)}` }));
      messages.push({ side: "client", body: latest });
      await conductTurn({ project: { name: "Test", services: [] }, messages, checklist: {}, preferredAction: { type: "closing_grace" } });
      assert.ok(prompt.includes(latest));
      assert.ok(prompt.includes(`<latest_client_message>\n${latest}\n</latest_client_message>`));
      assert.ok(prompt.includes("Earlier text omitted"));
    });
    await scenario("A pending rating option is recognized even if the first model mislabels it as overall feedback", async () => {
      global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ intent: "feedback", serviceScope: "overall_feedback" }) }) });
      const read = await interpretReply({ project: { services: [] }, question: "Add more or move to rating?", text: "overall rating", pendingRatingChoice: "overall_rating", verifySurveyControls: true });
      assert.equal(read.ratingChoice, "proceed");
      const state = { sessionType: "project_end", generalFeedbackText: "The existing detailed review" };
      flow.applyTurnServiceScope(state, { services: [] }, "overall rating", read, {}, { pendingQuestionType: "rating_feedback" });
      assert.equal(state.generalFeedbackText, "The existing detailed review");
    });
    await scenario("Additional overall details accumulate without erasing or duplicating the original review", () => {
      const state = { sessionType: "project_end", generalFeedbackText: "The dashboard figures were inaccurate." };
      for (let i = 0; i < 2; i++) applyServiceScopeDecision(state, { services: [] }, "overall_feedback", { text: "Please include course-wise lead quality too." });
      assert.equal(state.generalFeedbackText, "The dashboard figures were inaccurate.\nPlease include course-wise lead quality too.");
    });
    await scenario("Distinct observations about the same topic are saved; identical replays are not", async () => {
      const f = providerFixture(), session = await f.provider.getSession();
      const first = { topic: "Reporting", detail: "Send spend reports weekly.", sentiment: "neutral" };
      const second = { topic: "Reporting", detail: "Separate the figures by course.", sentiment: "neutral" };
      await f.provider.recordObservations(session, [first]);
      await f.provider.recordObservations(session, [first, second, second]);
      assert.deepEqual(f.observations.map((item) => item.detail), [first.detail, second.detail]);
    });
    await scenario("Risk does not keep completed feedback open; the correction window still reserves its WhatsApp session", async () => {
      const f = providerFixture();
      assert.equal(sessionIsTerminal(await f.provider.getSession()), true);
      assert.ok(await f.provider.getActiveSessionForPoc("poc-a"));
      f.row.conversation_state.closingGraceExpiresAt = new Date(Date.now() - 1000).toISOString();
      assert.equal(await f.provider.getActiveSessionForPoc("poc-a"), null);
      const closed = await f.provider.finalizeExpiredInactiveFinalSweeps();
      assert.equal(closed.length, 1);
      assert.equal(f.row.conversation_state.state, "completed");
      assert.equal(f.row.status, "needs_attention");
      assert.equal(f.row.conversation_state.closureReason, "closing_window_elapsed");
      assert.equal(f.rollups.length, 1);
      assert.equal((await f.provider.finalizeExpiredInactiveFinalSweeps()).length, 0);
      const storedRequest = f.provider.request;
      f.provider.request = async (table, options) => table === "feedback_cycles"
        ? [{ id: f.row.cycle_id }] : storedRequest(table, options);
      f.provider.listCycleSessions = async () => [await f.provider.getSession()];
      assert.equal(await f.provider.hasOpenCycle(f.row.project_id, "project_end"), false);
      f.provider.listCycleSessions = async () => [await f.provider.getSession(), { status: "started", conversationState: {} }];
      assert.equal(await f.provider.hasOpenCycle(f.row.project_id, "project_end"), true);
      assert.equal(PostgresStore.prototype.finalizeExpiredInactiveFinalSweeps, SupabaseStore.prototype.finalizeExpiredInactiveFinalSweeps);
    });
    await scenario("Each POC summary waits for their fixed window, includes final additions, and sends once without waiting for other POCs", async () => {
      const f = providerFixture(), sent = [];
      global.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ ok: true, sent: true }) }; };
      await flow.notifyCycleSummaryAfterAutomaticCompletion(f.provider, await f.provider.getSession(), "https://example.test");
      assert.equal(sent.length, 0);
      assert.ok(f.row.conversation_state.summaryPendingSince);
      f.setMessages([{ side: "client", body: "Original feedback" }, { side: "client", body: "Please add course-wise reporting too." }]);
      f.row.csat_score = 8;
      f.row.conversation_state.closingGraceExpiresAt = new Date(Date.now() - 1000).toISOString();
      await flow.finalizeFeedbackWindowsAndNotify(f.provider, new Date().toISOString(), "https://example.test");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].summaryType, "feedback_poc");
      assert.equal(sent[0].sessions.length, 1);
      assert.equal(sent[0].csatScore, 8);
      assert.equal(sent[0].npsScore, 10);
      assert.equal(sent[0].issues.length, 1);
      assert.equal(sent[0].messages[1].body, "Please add course-wise reporting too.");
      assert.ok(!sent[0].recipients.includes("other-owner@example.test"));
      assert.deepEqual(sent[0].recipients, ['super@example.test', 'cluster-admin@example.test']);
      assert.match(sent[0].email.text, /Please add course-wise reporting too/);
      await flow.finalizeFeedbackWindowsAndNotify(f.provider, new Date().toISOString(), "https://example.test");
      assert.equal(sent.length, 1);
    });
    await scenario("Deployment does not backfill historical summaries or resend previously delivered cycle mail", async () => {
      const f = providerFixture();
      f.row.conversation_state.state = "completed";
      assert.deepEqual(await f.provider.pendingFeedbackSummaries(), []);
      f.events.push({ id: "old", dedupe_key: "cycle_completed:cycle:cycle-a", status: "sent" });
      global.fetch = async () => { throw new Error("Must not send"); };
      const result = await flow.notifyCycleSummaryAfterAutomaticCompletion(f.provider, await f.provider.getSession(), "https://example.test");
      assert.equal(result.delivered, true);
      assert.equal(f.row.conversation_state.summaryDeliveryStatus, "sent");
    });
    await scenario("A failed or pending handoff is never presented as a delivered duplicate, and is not blindly resent", async () => {
      const f = providerFixture(); let sends = 0;
      global.fetch = async () => { sends++; throw new Error("Delivery timeout"); };
      const a = await flow.notifyAutomation(f.provider, "post_completion_message", {}, "failed-handoff");
      const b = await flow.notifyAutomation(f.provider, "post_completion_message", {}, "failed-handoff");
      assert.equal(a.status, "failed"); assert.equal(b.status, "failed"); assert.equal(b.delivered, false); assert.equal(sends, 1);
      await f.provider.claimAutomationEvent("post_completion_message", {}, "pending-handoff");
      const pending = await flow.notifyAutomation(f.provider, "post_completion_message", {}, "pending-handoff");
      assert.equal(pending.status, "pending"); assert.equal(pending.delivered, false); assert.equal(sends, 1);
      global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ sent: true }) });
      await flow.notifyAutomation(f.provider, "post_completion_message", {}, "sent-handoff");
      const duplicate = await flow.notifyAutomation(f.provider, "post_completion_message", {}, "sent-handoff");
      assert.equal(duplicate.status, "duplicate"); assert.equal(duplicate.delivered, true);
    });
    await scenario("HTTP 200 with sent:false is recorded as a failed workflow delivery", async () => {
      const f = providerFixture();
      global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, sent: false, reason: "no_recipients" }) });
      const result = await flow.notifyAutomation(f.provider, "cycle_completed", { summaryType: 'feedback_poc', project: await f.provider.getProjectById() }, "no-recipients");
      assert.equal(result.status, "failed"); assert.equal(result.error, "no_recipients");
    });
    await scenario("Quick check-in does not treat an ungrounded negative intent as completion", () => {
      assert.equal(flow.quickCheckinDetailDecision("The figures are unacceptable", { intent: "negative", completionScope: "none" }), "needs_detail");
      assert.equal(flow.quickCheckinDetailDecision("Nothing further from my side", { intent: "negative", completionScope: "feedback" }), "covered");
      assert.equal(flow.quickCheckinDetailDecision("I can respond tomorrow", { intent: "defer", deferRequested: true }), "defer");
    });
    await scenario("Workflow 10 displays this POC's scores and transcript without claiming the whole cycle completed", async () => {
      const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, "../n8n/workflows/10 - CSAT v6 - Cluster POC Feedback Summary.json"), "utf8"));
      const code = workflow.nodes.find((node) => node.type === "n8n-nodes-base.code").parameters.jsCode;
      const body = { summaryType: "feedback_poc", project: { id: "project-a", clusterId: "cluster-a", name: "Example", clientName: "Client" },
        poc: { id: "poc-a", name: "POC A" },
        cycle: { cycleType: "project_end", csatScore: 5 }, csatScore: 9, npsScore: 10,
        sessions: [{ id: "session-a", pocName: "POC A", completionStatus: "completed" }],
        messages: [{ side: "client", body: "Additional feedback in the closing window." }] };
      const execute = async () => {
        const prepared = await prepareCsatEmail(providerFixture().provider, "cycle_completed", body);
        return new Function("$input", code)({ first: () => ({ json: { body: { eventType: "cycle_completed", ...prepared.payload } } }) })[0].json;
      };
      const result = await execute();
      assert.equal(result.allowed, true);
      assert.match(result.subject, /POC A/);
      assert.match(result.text, /CSAT: 9\/10/);
      assert.match(result.text, /NPS:.*10\/10/);
      assert.match(result.text, /Additional feedback in the closing window/);
      assert.doesNotMatch(result.text, /feedback cycle complete|single summary for the completed feedback cycle/);
      assert.equal(result.to, "super@example.test,cluster-admin@example.test");
      body.cycle.cycleType = "monthly";
      body.npsScore = null;
      const monthly = await execute();
      assert.match(monthly.text, /CSAT: 9\/10/);
      assert.match(monthly.text, /NPS: Not provided/);
      body.summaryType = "quick_checkin_poc";
      body.cycle.cycleType = "quick_checkin";
      const quick = await execute();
      assert.match(quick.text, /CSAT: Not collected\nNPS: Not collected/);
      assert.equal(quick.to, result.to);
    });
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  }
  for (const [passed, name, error] of results) console.log(`${passed ? "PASS" : "FAIL"} ${name}${error ? `\n${error}` : ""}`);
  const failed = results.filter(([passed]) => !passed).length;
  console.log(`${results.length - failed}/${results.length} conversation lifecycle scenarios passed`);
  process.exitCode = failed ? 1 : 0;
}
run().catch((error) => { console.error(error); process.exitCode = 1; });

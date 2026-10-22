const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { isDeepStrictEqual } = require("node:util");
const { SupabaseStore } = require("../src/lib/supabase-store");
const { PostgresStore } = require("../src/lib/postgres-store");
const { IDLE_RATING_MS, idleRatingEligibility, ownsPendingRatingReminder } = require("../src/lib/idle-rating-prompt");
const { processWhatsAppReply } = require("../src/lib/whatsapp-state-machine");
const filename = require.resolve("../src/server/api-handler");
const harness = new Module(filename, module);
harness.filename = filename;
harness.paths = Module._nodeModulePaths(path.dirname(filename));
harness._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.idleTest = processIdleRatingPrompts;", filename);
const runPrompt = harness.exports.idleTest;
const clone = (value) => structuredClone(value);
const now = Date.parse("2026-10-22T12:00:00Z");
const nowIso = new Date(now).toISOString();
const earlier = new Date(now - IDLE_RATING_MS).toISOString();
const results = [];
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); }
}
function fixture(type = "project_end") {
  const provider = Object.create(SupabaseStore.prototype);
  const row = { id: "session", project_id: "project", client_poc_id: "poc", cycle_id: "cycle",
    status: "partial", completion_status: "partial", last_client_response_at: earlier,
    reminder_due_at: nowIso, csat_score: null, nps_score: null, reminder_count: 0,
    feedback_cycles: { cycle_type: type }, conversation_state: {
      state: "waiting_for_overall_rating", sessionType: type, pendingQuestionType: "rating_feedback",
      ratingFeedbackPause: { ratingType: "overall_rating", choiceAsked: true, overallReview: true },
      idleRatingPromptEligible: true, overallRatingAsked: false, overallRating: null, npsScore: null,
      generalFeedbackText: "The engagement was good but responses were sometimes slow.",
      projectEndReviewCaptured: type === "project_end", mentionedServices: {},
      pocWeightPercentage: 50
    } };
  const messages = [
    { id: "client-1", side: "client", body: row.conversation_state.generalFeedbackText, createdAt: earlier },
    { id: "reply-1", side: "srv", body: "I have noted your feedback.", createdAt: earlier,
      metadata: { pendingQuestionType: "rating_feedback" } }
  ];
  const events = [], patches = [], sent = [];
  const project = { id: "project", key: "test", services: [] };
  const poc = { id: "poc", active: true, contactWhatsapp: "910000000000" };
  const f = { provider, row, messages, events, patches, sent, project, poc, enabled: true, beforePatch: null, onClaim: null };
  provider.request = async (table, options = {}) => {
    const q = new URLSearchParams(options.query || "");
    if (table === "feedback_sessions") {
      if (options.method === "PATCH") {
        if (f.beforePatch) { const action = f.beforePatch; f.beforePatch = null; action(); }
        const expected = q.get("conversation_state");
        if (expected && !isDeepStrictEqual(row.conversation_state, JSON.parse(expected.slice(3)))) return [];
        const cutoff = q.get("last_client_response_at");
        if (cutoff && Date.parse(row.last_client_response_at) > Date.parse(cutoff.slice(4))) return [];
        if (q.get("status") && q.get("status") !== `eq.${row.status}`) return [];
        patches.push(clone(options.body)); Object.assign(row, clone(options.body));
      }
      return Number(q.get("offset") || 0) ? [] : [clone(row)];
    }
    if (table === "automation_events") {
      if (options.method === "POST") {
        if (f.onClaim) { const action = f.onClaim; f.onClaim = null; action(); }
        if (events.some((item) => item.dedupe_key === options.body[0].dedupe_key)) return [];
        const event = { ...clone(options.body[0]), id: `event-${events.length}` }; events.push(event); return [clone(event)];
      }
      const event = events.find((item) => `eq.${item.id}` === q.get("id"));
      Object.assign(event, clone(options.body)); return [clone(event)];
    }
    throw new Error(`Unexpected table ${table}`);
  };
  provider.getSession = async () => ({ id: row.id, cycleId: row.cycle_id, projectId: row.project_id,
    clientPocId: row.client_poc_id, sessionType: type, status: row.status, completionStatus: row.completion_status,
    lastClientResponseAt: row.last_client_response_at, reminderDueAt: row.reminder_due_at,
    csatScore: row.csat_score, npsScore: row.nps_score, conversationState: clone(row.conversation_state) });
  provider.getMessagesForSession = async () => clone(messages);
  provider.getProjectById = async () => project;
  provider.getClientPocById = async () => poc;
  provider.getMessagingStatus = async () => ({ enabled: f.enabled });
  provider.pocLevels = async () => new Map();
  provider.addMessage = async (_id, message) => { const saved = { ...clone(message), id: `msg-${messages.length}`, createdAt: nowIso }; messages.push(saved); return saved; };
  f.run = () => runPrompt(provider, nowIso);
  return f;
}
async function main() {
  const originalFetch = global.fetch;
  const savedUrl = process.env.N8N_MANUAL_MESSAGE_WEBHOOK;
  process.env.N8N_MANUAL_MESSAGE_WEBHOOK = "https://fixture.invalid/manual";
  try {
    for (const type of ["pulse", "project_end"]) await test(`${type}: once after one hour; score reply resumes the correct flow`, async () => {
      const f = fixture(type);
      global.fetch = async (_url, options) => { f.sent.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ sent: true }) }; };
      const result = await f.run();
      assert.equal(result.sent.length, 1, JSON.stringify(result));
      assert.equal(f.sent.length, 1);
      assert.match(f.sent[0].text, /overall.*out of 10/i);
      assert.equal(f.row.conversation_state.overallRating, null);
      assert.equal(f.row.conversation_state.npsScore, null);
      assert.equal(f.row.conversation_state.pocWeightPercentage, 50);
      assert.equal(f.row.conversation_state.closingGraceExpiresAt, undefined);
      assert.equal(f.row.reminder_count, 0);
      assert.equal(f.row.reminder_due_at, null);
      await f.run(); await f.run();
      assert.equal(f.sent.length, 1);
      assert.deepEqual(await f.provider.getDueReminderTargets(nowIso), []);
      const turn = processWhatsAppReply({ session: await f.provider.getSession(), project: f.project, poc: f.poc, text: "8" });
      assert.equal(turn.conversationState.overallRating, 8);
      assert.equal(turn.conversationState.npsScore, null);
      assert.equal(turn.conversationState.state, type === "project_end" ? "waiting_for_nps" : "closing_grace");
    });
    await test("59:59 is not due; any newer client activity resets the hour", async () => {
      const f = fixture(); const session = await f.provider.getSession();
      assert.equal(idleRatingEligibility(session, f.messages, now - 1).reason, "not_due");
      assert.equal(idleRatingEligibility(session, f.messages, now).eligible, true);
      f.messages.push({ id: "new", side: "client", body: "One more concern", createdAt: nowIso });
      assert.equal(idleRatingEligibility(session, f.messages, now).eligible, false);
      f.messages.push({ id: "ack", side: "srv", createdAt: nowIso, metadata: { pendingQuestionType: "rating_feedback" } });
      assert.equal(idleRatingEligibility(session, f.messages, now).reason, "not_due");
      assert.equal(idleRatingEligibility(session, f.messages, now + IDLE_RATING_MS).eligible, true);
    });
    for (const [name, changes] of Object.entries({
      "greeting only": { idleRatingPromptEligible: false }, "historical record": { idleRatingPromptEligible: undefined },
      "service-only review": { ratingFeedbackPause: { ratingType: "overall_rating", overallReview: false } },
      "rating already asked": { overallRatingAsked: true }, "rating answered zero": { overallRating: 0 },
      "rating declined": { overallRatingDeclined: true }, "postponed": { deferredAt: earlier },
      "opted out": { optedOut: true }, "requested closure": { clientRequestedClose: true },
      "handed off": { state: "handed_off" }, "completed": { state: "completed" },
      "closing window": { closingGraceExpiresAt: nowIso }, "clarification": { pendingObservation: { topic: "Billing" } },
      "NPS pending": { pendingQuestionType: "nps" }, "already attempted": { idleRatingPromptAttemptedAt: earlier }
    })) await test(`No unnecessary prompt: ${name}`, async () => {
      const f = fixture(); Object.assign(f.row.conversation_state, changes);
      global.fetch = async () => { throw new Error("Must not send"); };
      const result = await f.run(); assert.equal(result.sent.length, 0); assert.equal(f.events.length, 0);
    });
    await test("Quick check-ins, expired service windows and manual questions are excluded", async () => {
      const f = fixture("quick_checkin");
      assert.equal(idleRatingEligibility(await f.provider.getSession(), f.messages, now).eligible, false);
      const g = fixture(); const session = await g.provider.getSession();
      assert.equal(idleRatingEligibility(session, g.messages, now + 24 * IDLE_RATING_MS).reason, "outside_service_window");
      g.messages.at(-1).metadata = { manualOutbound: true, manualQuestionType: "overall_rating" };
      assert.equal(idleRatingEligibility(session, g.messages, now).eligible, false);
    });
    await test("Inactive/removed recipients and global messaging pause do not consume an attempt", async () => {
      for (const change of [(f) => { f.poc.active = false; }, (f) => { f.poc.removedAt = earlier; }, (f) => { f.enabled = false; }]) {
        const f = fixture(); change(f);
        assert.equal((await f.run()).sent.length, 0); assert.equal(f.events.length, 0);
        assert.equal(f.row.conversation_state.idleRatingPromptAttemptedAt, undefined);
      }
    });
    await test("Two concurrent schedulers dispatch once", async () => {
      const f = fixture();
      global.fetch = async (_url, options) => { f.sent.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ sent: true }) }; };
      await Promise.all([f.run(), f.run(), f.run()]);
      assert.equal(f.sent.length, 1); assert.equal(f.events.length, 1);
    });
    await test("A reply racing the atomic reservation prevents a send and preserves the reply", async () => {
      const f = fixture();
      f.beforePatch = () => { f.row.last_client_response_at = nowIso; f.row.conversation_state.generalFeedbackText += " Another concern"; };
      const result = await f.run();
      assert.equal(result.sent.length, 0); assert.equal(f.events.length, 0);
      assert.match(f.row.conversation_state.generalFeedbackText, /Another concern/);
    });
    await test("A reply arriving during the delivery claim cancels dispatch", async () => {
      const f = fixture();
      f.onClaim = () => { f.messages.push({ id: "late", side: "client", body: "Please wait", createdAt: nowIso }); };
      global.fetch = async () => { throw new Error("Must not send"); };
      assert.equal((await f.run()).sent.length, 0);
      assert.equal(f.events[0].status, "skipped");
    });
    for (const timeout of [false, true]) await test(`Failed delivery (${timeout ? "timeout" : "HTTP rejection"}) never auto-retries`, async () => {
      const f = fixture(); let calls = 0;
      global.fetch = async () => { calls += 1; if (timeout) throw new Error("timeout after possible acceptance"); return { ok: false, status: 503 }; };
      assert.equal((await f.run()).failed.length, 1);
      await f.run(); assert.equal(calls, 1);
      assert.equal(f.row.conversation_state.overallRatingAsked, false);
      assert.ok(f.row.conversation_state.idleRatingPromptAttemptedAt);
      assert.equal(f.messages.length, 2);
    });
    await test("No configured sender does not consume a reminder", async () => {
      const f = fixture(); delete process.env.N8N_MANUAL_MESSAGE_WEBHOOK;
      assert.equal((await f.run()).configured, false); assert.equal(f.patches.length, 0);
      process.env.N8N_MANUAL_MESSAGE_WEBHOOK = "https://fixture.invalid/manual";
    });
    await test("Generic reminders are suppressed only for the missing overall-rating wait", async () => {
      const f = fixture();
      assert.equal(ownsPendingRatingReminder(await f.provider.getSession()), true);
      f.row.conversation_state.overallRating = 8;
      assert.equal(ownsPendingRatingReminder(await f.provider.getSession()), false);
      assert.equal(PostgresStore.prototype.reserveIdleRatingPrompt, SupabaseStore.prototype.reserveIdleRatingPrompt);
    });
  } finally {
    global.fetch = originalFetch;
    if (savedUrl === undefined) delete process.env.N8N_MANUAL_MESSAGE_WEBHOOK; else process.env.N8N_MANUAL_MESSAGE_WEBHOOK = savedUrl;
  }
  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.error ? `\n${result.error}` : ""}`);
  console.log(`${results.filter((item) => item.ok).length}/${results.length} idle rating scenarios passed`);
  if (results.some((item) => !item.ok)) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { applyReplyFidelityReview } = require("../src/lib/reply-fidelity");
const { interpretReply } = require("../src/lib/gemini");
const filename = require.resolve("../src/server/api-handler");
const harness = new Module(filename, module);
harness.filename = filename;
harness.paths = Module._nodeModulePaths(path.dirname(filename));
harness._compile(fs.readFileSync(filename, "utf8") + "\nmodule.exports.audit = { notifyClientRequest, notifyAutomation, quickCheckinDetailDecision };", filename);
const flow = harness.exports.conversationFlow;
const { notifyClientRequest, notifyAutomation, quickCheckinDetailDecision } = harness.exports.audit;
const project = { id: "p1", key: "test", services: [{ serviceKey: "account", name: "Account Management" }] };
const results = [];
async function scenario(name, run) {
  try { await run(); results.push([true, name]); }
  catch (error) { results.push([false, name, error.stack]); }
}
const emptyRead = { intent: "off_topic", source: "gemini", observations: [], concerns: [], captured: [], appreciations: [] };
const requests = [
  "I wish to bring my students to your office for guidance on AI for branding.",
  "Would your team be open to a workshop for our alumni next semester?",
  "Could someone explain the difference between the two invoice totals?",
  "Please send the accessibility test results for our portal.",
  "Can your team advise whether a bilingual campaign is possible?"
];
async function run() {
  const priorFetch = global.fetch;
  const keys = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "N8N_HUMAN_HANDOFF_WEBHOOK"];
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await scenario("Varied requests repair contradictory intent without importing writer facts or survey controls", () => {
      for (const source of requests) {
        const input = { ...emptyRead, rating: null, serviceScope: "none" };
        const saved = JSON.stringify(input);
        const result = applyReplyFidelityReview(input, { scope: "srv_request", requestEvidence: [source],
          overallRating: 10, serviceScope: "skip_remaining_services", captured: [{ serviceKey: "senior" }] }, source, () => true);
        assert.equal(result.intent, "feedback");
        assert.equal(result.observations[0].detail, source);
        assert.equal(result.observations[0].sentiment, "neutral");
        assert.equal(result.observations[0].needsFollowUp, false);
        assert.equal(result.rating, null);
        assert.equal(result.serviceScope, "none");
        assert.deepEqual(result.captured, []);
        assert.equal(JSON.stringify(input), saved);
        const grounded = flow.groundLatestReplyInterpretation(result, source, project);
        assert.equal(grounded.intent, "feedback");
        assert.equal(quickCheckinDetailDecision(source, grounded), "feedback");
      }
    });
    await scenario("Existing grounded request survives off-topic classification even when review is unavailable", () => {
      for (const source of requests) {
        const result = flow.groundLatestReplyInterpretation({ ...emptyRead,
          observations: [{ topic: "Client Request", detail: source, kind: "request", sentiment: "neutral" }] }, source, project);
        assert.equal(result.intent, "feedback");
        assert.equal(quickCheckinDetailDecision(source, result), "feedback");
      }
    });
    await scenario("Unrelated topics, invented quotes, stale evidence and bare ratings cannot create requests", () => {
      for (const source of ["10", "thanks", "How far away is Mars?", "no more"]) {
        const result = applyReplyFidelityReview(emptyRead, { scope: "srv_request", requestEvidence: requests }, source, () => true);
        assert.deepEqual(result.observations, []);
        assert.equal(result.intent, "off_topic");
      }
      assert.equal(applyReplyFidelityReview(emptyRead, { scope: "unrelated", requestEvidence: requests }, requests[0], () => true).intent, "off_topic");
    });
    await scenario("Scoped service opinion cannot manufacture a second Management Feedback complaint", () => {
      for (const source of ["account management is avergae", "Account Management is mediocre", "The account team is not good"]) {
        const facts = flow.enrichConductedWithDeterministicFacts({}, source, project, {
          intent: "feedback", sentiment: "negative", captured: [{ serviceKey: "account", summary: source, sentiment: "negative", needsFollowUp: true }]
        }, { protectSubstantiveConcern: true });
        assert.equal(facts.captured.length, 1);
        assert.equal(facts.observations.length, 0, JSON.stringify(facts));
      }
    });
    await scenario("Reviewed acknowledgement preserves uncertainty and positive outcomes without changing state", () => {
      const source = "It seems the same campaign is running; I cannot see the promised messages. Registration targets were met, however.";
      const ack = "You are concerned that the same campaign may still be running and that you cannot see the promised messages. It is good to hear your registration targets were met.";
      const read = applyReplyFidelityReview({ ...emptyRead, intent: "feedback" }, {
        scope: "feedback", requestEvidence: [], acknowledgement: ack, preservesUncertainty: true,
        coverage: [{ evidence: "It seems the same campaign is running", responseExcerpt: "the same campaign may still be running" },
          { evidence: "I cannot see the promised messages", responseExcerpt: "you cannot see the promised messages" },
          { evidence: "Registration targets were met", responseExcerpt: "registration targets were met" }]
      }, source, () => true);
      assert.equal(read.acknowledgementReviewed, true);
      const facts = { ...read, latestClientText: source, extractedAcknowledgement: read.acknowledgement,
        text: "Your campaigns were not sent.", acknowledgement: "Your campaigns were not sent." };
      assert.equal(flow.clientFacingAcknowledgement(facts, project, {}), ack);
      const state = { sessionType: "project_end", reopenedDuringClosingGrace: true, overallRating: 8, npsScore: 9,
        closingGraceExpiresAt: "2030-01-01T00:10:00.000Z" };
      facts.observations = [{ topic: "Campaign", detail: source, sentiment: "negative" }];
      const before = JSON.stringify(state);
      assert.ok(flow.closingGraceMessage({}, state, facts, project).includes(ack));
      assert.equal(JSON.stringify(state), before);
      assert.doesNotMatch(flow.fallbackForAction({ type: "feedback_continuation" }, {}, project, {
        appreciations: [{ subject: "Overall Engagement", subjectType: "outcome", detail: "Registration targets were met" }]
      }), /kind words about Overall Engagement|share.*with them/i);
    });
    await scenario("Malformed, ungrounded, unsafe or uncertainty-losing review cannot replace wording", () => {
      const read = { ...emptyRead, acknowledgement: "Your concern about delivery is noted." };
      for (const review of [null, {}, { scope: "feedback", acknowledgement: "Invented", preservesUncertainty: true, coverage: [] },
        { scope: "feedback", acknowledgement: "Delivery failed", preservesUncertainty: false, coverage: [{ evidence: "Delivery may be late", responseExcerpt: "Delivery failed" }] }]) {
        assert.equal(applyReplyFidelityReview(read, review, "Delivery may be late", () => false).acknowledgement, read.acknowledgement);
      }
    });
    await scenario("Real interpreter invokes bounded semantic review for a request mislabelled off-topic", async () => {
      process.env.GEMINI_API_KEY = "fixture";
      let calls = 0;
      global.fetch = async (_url, options) => {
        const prompt = JSON.parse(options.body).input;
        calls++;
        return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(
          prompt.includes("Task: review latest-message scope")
            ? { scope: "srv_request", requestEvidence: [requests[0]], acknowledgement: "", coverage: [] }
            : { intent: "off_topic", observations: [], appreciations: [] }) }) };
      };
      const read = await interpretReply({ project, question: "Anything else?", text: requests[0] });
      assert.equal(read.intent, "feedback");
      assert.equal(calls, 2);
      assert.ok(read.observations.some((item) => item.detail === requests[0]));
    });
    await scenario("Active and closing requests are saved without per-message emails in all three flows", async () => {
      process.env.N8N_HUMAN_HANDOFF_WEBHOOK = "https://fixture.invalid/handoff";
      const events = new Map(), payloads = [], audits = [];
      const store = {
        recordAutomationEvent: async event => audits.push(event),
        claimAutomationEvent: async (eventType, payload, key) => {
          if (events.has(key)) return null;
          const row = { id: key, status: "pending", eventType, payload }; events.set(key, row); return row;
        },
        getAutomationEventByDedupeKey: async (key) => events.get(key),
        completeAutomationEvent: async (id, event) => events.set(id, event)
      };
      global.fetch = async (_url, options) => { payloads.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ sent: true }) }; };
      for (const sessionType of ["pulse", "project_end", "quick_checkin"]) {
        for (const state of ["waiting_for_open_feedback", "closing_grace"]) {
          const args = { project, poc: { id: "poc" }, session: { id: `s-${sessionType}`, sessionType, conversationState: { state } },
            text: requests[0], messageId: `${sessionType}-${state}`, baseUrl: "https://fixture.invalid",
            facts: { observations: [{ kind: "request", detail: requests[0] }] } };
          const original = JSON.stringify(args);
          const first = await notifyClientRequest(store, args), repeated = await notifyClientRequest(store, args);
          assert.equal(first, null); assert.equal(repeated, null);
          assert.equal(JSON.stringify(args), original);
        }
      }
      assert.equal(payloads.length, 0);
      assert.equal(audits.length, 12);
      assert.ok(audits.every(item => item.eventType === "client_question" && item.status === "recorded" && item.payload.clientText === requests[0]));
    });
    await scenario("A genuine handoff with missing configuration or delivery failure never claims acceptance", async () => {
      const args = { project, poc: {}, session: { id: "s" }, text: requests[1], messageId: "m", baseUrl: "https://fixture.invalid", offTopic: true };
      for (const mode of ["missing", "http", "workflow", "timeout"]) {
        const audits = [];
        if (mode === "missing") delete process.env.N8N_HUMAN_HANDOFF_WEBHOOK;
        else process.env.N8N_HUMAN_HANDOFF_WEBHOOK = "https://fixture.invalid/handoff";
        global.fetch = async () => {
          if (mode === "timeout") throw new Error("Timed out");
          return { ok: mode !== "http", status: mode === "http" ? 500 : 200, json: async () => ({ sent: false, reason: "No recipient" }) };
        };
        const event = await notifyAutomation({
          listAppUsers: async () => [{ email: "super@example.com", role: "super_admin", active: true }],
          getProjectById: async () => project,
          recordAutomationEvent: async row => audits.push(row)
        }, "handoff", { ...args, clientText: args.text });
        assert.notEqual(event.status, "sent");
        assert.equal(event.status, mode === "missing" ? "skipped" : "failed");
        assert.equal(audits.length, 1);
      }
    });
  } finally {
    global.fetch = priorFetch;
    for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  }
  for (const [ok, name, error] of results) console.log(`${ok ? "PASS" : "FAIL"} ${name}${error ? `\n${error}` : ""}`);
  console.log(`${results.filter(([ok]) => ok).length}/${results.length} request/fidelity scenarios passed`);
  process.exitCode = results.some(([ok]) => !ok) ? 1 : 0;
}
run().catch((error) => { console.error(error); process.exitCode = 1; });

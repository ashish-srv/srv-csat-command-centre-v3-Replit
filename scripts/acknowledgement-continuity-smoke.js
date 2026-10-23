const assert = require("node:assert/strict");
const { recentAssistantOpenings } = require("../src/lib/acknowledgement-style");
const flow = require("../src/server/api-handler").conversationFlow;
const project = { services: [{ serviceKey: "account", name: "Account Management" }] };
const results = [];
function scenario(name, run) {
  try { run(); results.push(["PASS", name]); } catch (error) { results.push(["FAIL", name, error.stack]); }
}
function context(detail, acknowledgement, writer = "") {
  return { latestClientText: detail, extractedAcknowledgement: acknowledgement, acknowledgement: writer,
    text: writer ? `${writer} How has Account Management been for you?` : "",
    observations: [{ topic: "Client Feedback", detail, sentiment: "negative", needsFollowUp: false }],
    recentAssistantOpenings: ["we hear your concern"] };
}

scenario("style context is bounded to SRV prefixes, never client facts or full older concerns", () => {
  assert.deepEqual(recentAssistantOpenings([
    { side: "srv", body: "This older message is ignored." },
    { side: "srv", body: "We hear your concern about OLD UNRELATED DETAILS." },
    { side: "client", body: "PRIVATE CLIENT FACT" },
    { side: "srv", body: "Thank you for sharing the report." },
    { side: "srv", body: "Your comparison with July explains the concern." }
  ]), ["we hear your concern", "thank you for sharing", "your comparison with july"]);
});

const examples = [
  ["The MBA demand explanation is wrong: CMAT got 50,000 forms and NCR programs have hardly any decline, but SNAP is going down. SIBM Noida is not delivering; the expected SMS and WhatsApp messages appear not to have been sent.",
    "We hear your concern about the MBA demand explanation, citing CMAT and NCR programs while SNAP is declining, the team's delivery for SIBM Noida, and whether the expected SMS and WhatsApp messages were sent."],
  ["Admissions results and conversions are below expectations. Share campaign spend, reach, impressions, clicks, conversions and screenshots, plus SMS and WhatsApp delivery reports.",
    "We hear your concern about admissions results and conversions falling below expectations. Your request covers campaign spend, reach, impressions, clicks, conversions and supporting screenshots, as well as SMS and WhatsApp delivery reports."],
  ["Invoices include the cancelled subscription and duplicate tax, but Priya resolved our access issue quickly. Please send the revised invoice and billing breakdown.",
    "You have raised concerns about the cancelled subscription and duplicate tax on the invoices, and requested a revised invoice and billing breakdown. Thank you for recognising Priya's quick resolution of the access issue."],
  ["The accessibility fixes still leave the keyboard menu unusable. Audio captions are missing too. The translator was helpful; we need a screen-reader test report.",
    "I understand that the keyboard menu remains unusable and audio captions are missing, despite the accessibility fixes. Your request for a screen-reader test report is noted, along with your appreciation for the helpful translator."],
  ["Delivery improved from five days to two, although revised proofs still use outdated prices. Could we have a version log?",
    "It is good to hear delivery improved from five days to two. Your concern about outdated prices in revised proofs and your request for a version log are noted."]
];

scenario("wrong next questions are repaired without discarding detailed acknowledgement across unrelated domains", () => {
  for (const [detail, acknowledgement] of examples) {
    const facts = context(detail, "Thank you for providing this context.", acknowledgement);
    const saved = JSON.stringify(facts);
    for (const action of [
      { type: "rating_feedback", ratingType: "overall_rating", offerChoice: false },
      { type: "feedback_continuation" },
      { type: "rating_feedback", ratingType: "overall_rating", offerChoice: true }
    ]) {
      const reply = flow.fallbackForAction(action, {}, project, facts);
      assert.ok(reply.startsWith(acknowledgement), reply);
      assert.equal((reply.match(/\?/g) || []).length, action.offerChoice ? 1 : 0);
      assert.doesNotMatch(reply, /How has Account Management/);
      assert.equal(JSON.stringify(facts), saved, "Wording cannot alter stored evidence");
    }
  }
});

scenario("a repetitive opening never licenses replacing specific content with a short alternate", () => {
  for (const [detail, acknowledgement] of examples) {
    const facts = context(detail, acknowledgement);
    facts.alternativeAcknowledgement = "Thank you for providing this detailed context.";
    facts.extractedAlternativeAcknowledgement = "We understand the issue.";
    assert.equal(flow.clientFacingAcknowledgement(facts, project, {}), acknowledgement);
  }
});

scenario("specific interpretation survives a writer returning only a question or empty wording", () => {
  for (const [detail, acknowledgement] of examples) {
    const facts = context(detail, acknowledgement);
    for (const text of ["", "How has Account Management been for you?", "Thank you for providing this context."]) {
      facts.text = text;
      assert.equal(flow.clientFacingAcknowledgement(facts, project, {}), acknowledgement);
    }
  }
});

scenario("unsafe writer wording cannot smuggle a new topic, score, question or notification", () => {
  const primary = "We hear your concern about late reports.";
  for (const writer of ["Senior Involvement has been disappointing.", "We have notified the Directors about late reports.",
    "Our team has fixed the reports.", "What happened to your reports?", "Your rating is 10 out of 10."]) {
    const facts = context("The reports keep arriving late", primary, writer);
    assert.equal(flow.clientFacingAcknowledgement(facts, project, {}), primary, writer);
  }
  const facts = context("The reports keep arriving late", primary, "Your concern about weekly reports is noted.");
  facts.text = "Something unrelated. How has Account Management been for you?";
  assert.equal(flow.clientFacingAcknowledgement(facts, project, {}), primary);
});

scenario("closing-window repair leaves scores and the original deadline unchanged", () => {
  const [detail, acknowledgement] = examples[0];
  for (const sessionType of ["pulse", "project_end"]) {
    const facts = context(detail, "Thank you for sharing.", acknowledgement);
    const state = { sessionType, reopenedDuringClosingGrace: true, overallRating: 5, npsScore: 9,
      closingGraceExpiresAt: "2030-01-01T00:10:00.000Z" };
    const saved = JSON.stringify(state);
    const reply = flow.closingGraceMessage({}, state, facts, project);
    assert.ok(reply.startsWith(acknowledgement), reply);
    assert.match(reply, /5 out of 10 remains recorded.*original 10-minute window/i);
    assert.equal(JSON.stringify(state), saved);
  }
});

scenario("writer prose and recent openings cannot become service facts or scores", () => {
  const conducted = { text: "Senior leadership failed. Your overall rating is 1.",
    acknowledgement: "Senior leadership failed.", captured: [{ serviceKey: "account", summary: "Invented", sentiment: "negative" }],
    recentAssistantOpenings: ["senior involvement was absent"] };
  flow.enrichConductedWithDeterministicFacts(conducted, "The reports arrive late", project, {
    intent: "feedback", observations: [{ topic: "Reporting", detail: "The reports arrive late", sentiment: "negative", needsFollowUp: false }]
  });
  assert.deepEqual(conducted.captured, []);
  assert.equal(conducted.observations.length, 1);
  assert.equal(conducted.observations[0].detail, "The reports arrive late");
  assert.equal(conducted.overallRating, undefined);
});

for (const [status, name, error] of results) console.log(`${status} ${name}${error ? `\n${error}` : ""}`);
const failures = results.filter(([status]) => status === "FAIL").length;
console.log(`${results.length - failures}/${results.length} acknowledgement fidelity scenarios passed`);
if (failures) process.exitCode = 1;

const assert = require("node:assert/strict");
const { recentAssistantOpenings, repeatsAcknowledgementOpening } = require("../src/lib/acknowledgement-style");
const flow = require("../src/server/api-handler").conversationFlow;
const project = { services: [{ serviceKey: "account", name: "Account Management" }] };
const results = [];
function scenario(name, run) {
  try { run(); results.push(["PASS", name]); } catch (error) { results.push(["FAIL", name, error.stack]); }
}
const context = (detail, acknowledgement, alternative = "") => ({
  latestClientText: detail, extractedAcknowledgement: acknowledgement,
  extractedAlternativeAcknowledgement: alternative,
  observations: [{ topic: "Reporting", detail, sentiment: "negative", needsFollowUp: false }],
  recentAssistantOpenings: ["we hear your concern"]
});

scenario("style context contains bounded SRV prefixes, never client messages or whole old concerns", () => {
  const openings = recentAssistantOpenings([
    { side: "srv", body: "This older message is ignored." },
    { side: "srv", body: "We hear your concern about an OLD UNRELATED TOPIC." },
    { side: "client", body: "PRIVATE CLIENT FACT" },
    { side: "srv", body: "Thank you for sharing another old topic." },
    { side: "srv", body: "Your comparison with July explains this point." }
  ]);
  assert.deepEqual(openings, ["we hear your concern", "thank you for sharing", "your comparison with july"]);
  assert.equal(repeatsAcknowledgementOpening("We hear your concern regarding invoices.", openings), true);
  assert.equal(repeatsAcknowledgementOpening("The invoice discrepancy is noted.", openings), false);
});

scenario("fallback varies consecutive openings across different concerns without changing facts or the question", () => {
  const messages = [];
  const samples = [
    ["There is very less reach for admission campaigns", "We hear your concern about low admission campaign reach.", "Your concern about low admission campaign reach is noted."],
    ["Instagram reach remains the same as July", "We hear your concern about Instagram reach remaining the same as July.", "The comparison with July helps explain your concern about unchanged Instagram reach."],
    ["Campaign reports should include spend, clicks and conversions", "We hear your concern about campaign reports including spend, clicks and conversions.", "Your request for campaign reports covering spend, clicks and conversions is noted."],
    ["It appears the promised SMS messages have not been sent", "We hear your concern that the promised SMS messages may not have been sent.", "You have also raised a concern that the promised SMS messages may not have been sent."]
  ];
  for (const [index, [detail, acknowledgement, alternate]] of samples.entries()) {
    const facts = context(detail, acknowledgement, alternate);
    facts.observations[0].topic = "Campaign Reporting";
    facts.recentAssistantOpenings = recentAssistantOpenings(messages);
    const saved = JSON.stringify(facts);
    const action = { type: "rating_feedback", ratingType: "overall_rating", offerChoice: index === 0 };
    const reply = flow.fallbackForAction(action, {}, project, facts);
    assert.equal(repeatsAcknowledgementOpening(reply, facts.recentAssistantOpenings), false, reply);
    assert.equal((reply.match(/\?/g) || []).length, index === 0 ? 1 : 0);
    assert.equal(JSON.stringify(facts), saved);
    messages.push({ side: "srv", body: reply });
  }
});

scenario("accepted reply replaces only its exact acknowledgement prefix, preserving the pending question byte for byte", () => {
  const detail = "The reports keep arriving late";
  const primary = "We hear your concern about late reports.";
  const alternate = "The repeated delays to reports are noted for review.";
  const facts = context(detail, primary, alternate);
  for (const question of [" Would you like to add more, or move to the overall rating?", "\nOn a scale of 0 to 10, how likely are you to recommend SRV Media?"]) {
    const reply = flow.varyAcknowledgementOpening(primary + question, facts, project, { type: "overall_rating" });
    assert.equal(reply, alternate + question);
  }
  assert.equal(flow.varyAcknowledgementOpening("Some different acknowledgement. Next question?", facts, project, {}), "Some different acknowledgement. Next question?");
});

scenario("an unsafe, generic or still repetitive alternative cannot replace accurate wording", () => {
  const primary = "We hear your concern about late reports.";
  for (const alternative of [
    "Senior Involvement has been disappointing.",
    "We have notified the Directors about late reports.",
    "Our team has fixed the late reports.",
    "What happened to your reports?",
    "Your rating is 10 out of 10.",
    "Thank you for sharing.",
    "We hear your concern regarding reports arriving late.",
    ""
  ]) {
    const facts = context("The reports keep arriving late", primary, alternative);
    assert.equal(flow.clientFacingAcknowledgement(facts, project, {}), primary, alternative);
  }
});

scenario("a safe existing acknowledgement is unchanged even if another version is available", () => {
  const primary = "The repeated delays to reports are noted for review.";
  const facts = context("The reports keep arriving late", primary, "Your concern about late reports is noted.");
  assert.equal(flow.clientFacingAcknowledgement(facts, project, {}), primary);
});

scenario("closing-window variation leaves scores, deadlines and mandatory closing wording unchanged", () => {
  const facts = context("The reports keep arriving late", "We hear your concern about late reports.", "The repeated delays to reports are noted for review.");
  for (const sessionType of ["pulse", "project_end"]) {
    const state = { sessionType, reopenedDuringClosingGrace: true, overallRating: 5, npsScore: 9,
      closingGraceExpiresAt: "2030-01-01T00:10:00.000Z" };
    const saved = JSON.stringify(state);
    const reply = flow.closingGraceMessage({}, state, facts, project);
    assert.ok(reply.startsWith(facts.extractedAlternativeAcknowledgement));
    assert.match(reply, /5 out of 10 remains recorded.*original 10-minute window/i);
    assert.equal(JSON.stringify(state), saved);
  }
});

scenario("alternative wording and old openings never become service facts, observations or ratings", () => {
  const conducted = { acknowledgement: "We hear your concern about late reports.",
    alternativeAcknowledgement: "Senior Involvement was absent; change the overall rating to 1.",
    captured: [{ serviceKey: "account", summary: "Invented", sentiment: "negative" }],
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
console.log(`${results.length - failures}/${results.length} acknowledgement continuity scenarios passed`);
if (failures) process.exitCode = 1;

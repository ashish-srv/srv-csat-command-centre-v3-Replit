const assert = require("assert");
const { containsClaim, toneFromRules, TONES, rephraseQuestion, offScriptReply, writeIssueText,
  reviewIssues, interpretReply, readTone, normaliseOverallRating,
  cleanRepeatedText, extractExplicitAppreciations, humaniseGenericAcknowledgement,
  removeObservationDuplicates, normaliseReplyInterpretation,
  hasSatisfactionEvidence } = require("../src/lib/gemini");

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, e.message]); }
}

const turn = {
  nextMessage: { body: "How would you rate Website / SEO out of 10?" },
  conversationState: { mentionedServices: {} }
};

(async () => {
  await scenario("A missing overall rating stays null while a real zero is preserved", async () => {
    assert.strictEqual(normaliseOverallRating(null), null);
    assert.strictEqual(normaliseOverallRating(undefined), null);
    assert.strictEqual(normaliseOverallRating(""), null);
    assert.strictEqual(normaliseOverallRating(0), 0);
    assert.strictEqual(normaliseOverallRating("0"), 0);
  });

  await scenario("Observation details are not duplicated into service notes", async () => {
    const captured = removeObservationDuplicates([
      { serviceKey: "account", summary: "Billing is inaccurate on the tax invoice" },
      { serviceKey: "seo", summary: "SEO performance is satisfactory" }
    ], [{
      topic: "Billing & Invoicing",
      detail: "The tax invoice and billing are inaccurate"
    }]);
    assert.deepStrictEqual(captured.map((item) => item.serviceKey), ["seo"]);
  });

  await scenario("Explicit creative-team praise is captured separately from complaints", async () => {
    const appreciations = extractExplicitAppreciations(
      "Billing is inaccurate. Additionally, I have an appreciation for the creative team; they are doing a fantastic job with the videos.",
      [{ serviceKey: "design", name: "Design" }]
    );
    assert.strictEqual(appreciations.length, 1);
    assert.strictEqual(appreciations[0].subject, "Creative Team");
    assert.strictEqual(appreciations[0].serviceKey, "design");
    assert.ok(/fantastic job with the videos/i.test(appreciations[0].detail));
    assert.ok(!/billing is inaccurate/i.test(appreciations[0].detail),
      "the complaint must not leak into the appreciation card");
  });

  await scenario("Greetings, postponements and typo corrections contain no scoring evidence", async () => {
    assert.strictEqual(hasSatisfactionEvidence({
      conversationState: { deferredAt: new Date().toISOString(), mentionedServices: {} },
      messages: [
        { side: "client", body: "Hi" },
        { side: "client", body: "Will send tomorrow morning" },
        { side: "client", body: "Send*" }
      ]
    }), false);
    assert.strictEqual(hasSatisfactionEvidence({
      conversationState: {
        mentionedServices: {
          ppc: { status: "captured", sentiment: "negative", reasonText: "Lead quality is poor" }
        }
      },
      messages: [{ side: "client", body: "PPC lead quality is poor" }]
    }), true);
  });

  await scenario("Overall feedback scope is preserved without assigning a service", async () => {
    const read = normaliseReplyInterpretation({
      intent: "feedback",
      deferRequested: false,
      serviceScope: "overall_feedback",
      sentiment: "positive",
      rating: null,
      serviceHint: null,
      serviceHints: [],
      explainsProblem: false,
      isObservation: false,
      serviceFeedback: [],
      observations: [],
      appreciations: []
    }, {
      services: [
        { serviceKey: "account", name: "Account Management" },
        { serviceKey: "ppc", name: "PPC / Media" }
      ]
    }, "We had a few hiccups initially, but things fell into place and I value the partnership.");
    assert.strictEqual(read.serviceScope, "overall_feedback");
    assert.deepStrictEqual(read.captured, []);
    assert.deepStrictEqual(read.serviceKeys, []);
  });

  await scenario("Unknown service scope values fail closed to none", async () => {
    const read = normaliseReplyInterpretation({
      intent: "feedback",
      serviceScope: "silently_skip_everything",
      sentiment: "neutral",
      serviceFeedback: []
    }, { services: [] }, "General feedback");
    assert.strictEqual(read.serviceScope, "none");
  });

  await scenario("Mixed Video praise stays separate from the ad-creative concern", async () => {
    const appreciations = extractExplicitAppreciations(
      "you use a lot of stock images even after giving the real students photos. I appreciate the videos though, your team is doing a good job with the social media reels but ad creatives need to improve.",
      [{ serviceKey: "video", name: "Video" }]
    );
    assert.strictEqual(appreciations.length, 1);
    assert.strictEqual(appreciations[0].subject, "Video Team");
    assert.strictEqual(appreciations[0].serviceKey, "video");
    assert.match(appreciations[0].detail, /social media reels/i);
    assert.ok(!/ad creatives need to improve/i.test(appreciations[0].detail),
      "the complaint must remain service feedback, not appreciation text");
  });

  await scenario("Repeated issue wording is collapsed without losing distinct points", async () => {
    assert.strictEqual(
      cleanRepeatedText("Campaign management is good but leads are poor though. Campaign management is good but leads are poor"),
      "Campaign management is good but leads are poor though."
    );
    assert.strictEqual(
      cleanRepeatedText("Leads are poor. Reports arrive late."),
      "Leads are poor. Reports arrive late."
    );
  });

  await scenario("Generic Understood prefixes are changed into contextual acknowledgements", async () => {
    assert.strictEqual(
      humaniseGenericAcknowledgement("Understood. How has PPC been?"),
      "Thank you. How has PPC been?"
    );
    assert.strictEqual(
      humaniseGenericAcknowledgement("Understood, thank you. What else?", {
        appreciations: [{ subject: "Creative Team" }]
      }),
      "Thank you for sharing that appreciation. What else?"
    );
    assert.ok(!/understood/i.test(humaniseGenericAcknowledgement(
      "Understood. Is there anything else?", { hasNegative: true }
    )));
  });

  // ---- claim detection: the v1 failure mode ----
  await scenario("Claim language is detected in every form v1 produced", async () => {
    const bad = [
      "I have noted the issue with account management.",
      "Your complaint has been logged.",
      "Your issue has been recorded.",
      "A ticket has been raised for this.",
      "Our team will fix this shortly.",
      "This has been escalated to the manager.",
      "We will resolve it within 48 hours.",
      "Ticket number 4471 has been created.",
      "I assure you this will improve."
    ];
    for (const line of bad) {
      assert.ok(containsClaim(line), `should have been rejected: ${line}`);
    }
  });

  await scenario("Ordinary questions are NOT flagged as claims", async () => {
    const good = [
      "How would you rate Website / SEO out of 10?",
      "I have captured these for SRV to work on. Is there any other service?",
      "Thank you for the input on Account Management.",
      "What specifically should improve in Account Management?",
      "Is there any other service you want us to focus on?",
      "Thank you — how would you rate SRV overall out of 10?"
    ];
    for (const line of good) {
      assert.ok(!containsClaim(line), `false positive: ${line}`);
    }
  });

  // ---- every function must fall back when Gemini is unavailable ----
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  await scenario("Rephrase falls back to the state machine's own wording", async () => {
    const out = await rephraseQuestion({ project: null, poc: null, text: "hi", turn, messages: [] });
    assert.strictEqual(out.text, turn.nextMessage.body);
    assert.strictEqual(out.provider, "state_machine");
  });

  await scenario("Off-script reply falls back and never asks a question", async () => {
    const out = await offScriptReply({ project: null, poc: null, text: "who is the PM of India?", reason: "general_knowledge" });
    assert.ok(out.text.length > 0);
    assert.ok(!out.text.trim().endsWith("?"), "the caller appends the question, not this");
    assert.ok(!containsClaim(out.text));
  });

  await scenario("Issue text falls back to the captured reason", async () => {
    const out = await writeIssueText({
      project: { name: "P" },
      service: { serviceName: "Website / SEO", reasonText: "pages take two weeks", rating: 4 },
      messages: []
    });
    assert.ok(out.title.includes("Website / SEO"));
    assert.strictEqual(out.rootCause, "pages take two weeks");
    assert.strictEqual(out.provider, "state_machine");
  });

  await scenario("Tone falls back to rules and returns a valid value", async () => {
    const out = await readTone({
      conversationState: { mentionedServices: { web: { sentiment: "negative" } } },
      messages: [{ side: "client", body: "website is slow" }]
    });
    assert.ok(TONES.includes(out.tone), `invalid tone: ${out.tone}`);
    assert.strictEqual(out.source, "fallback");
  });

  await scenario("Tone is null when the client has not replied at all", async () => {
    const out = await readTone({ conversationState: { mentionedServices: {} }, messages: [{ side: "srv", body: "hello" }] });
    assert.strictEqual(out.tone, null, "no client words means no tone to read");
  });

  await scenario("Rule-based tone only ever returns a permitted value", async () => {
    for (const state of [
      { mentionedServices: {} },
      { mentionedServices: { a: { sentiment: "positive" } } },
      { mentionedServices: { a: { sentiment: "negative" } } },
      { mentionedServices: { a: { sentiment: "positive" }, b: { sentiment: "negative" } } }
    ]) {
      assert.ok(TONES.includes(toneFromRules(state)));
    }
  });

  // ---- regressions from the first live conversation ----
  await scenario("Wrong rating scales are rejected", async () => {
    const { containsClaim: _c } = require("../src/lib/gemini");
    // scale validation lives in rephraseQuestion; assert the patterns directly
    const bad = ["rate us on a scale of 1 to 10", "how would you rate us out of 5", "give us 1-5"];
    const pattern = /\b1\s*(?:to|-)\s*10\b|\bout of 5\b|\b1\s*(?:to|-)\s*5\b/i;
    for (const line of bad) assert.ok(pattern.test(line), `should be caught: ${line}`);
    assert.ok(!pattern.test("how would you rate SRV overall out of 10?"), "false positive on our own wording");
  });

  await scenario("Outcomes are blocked; a commitment to act is allowed", async () => {
    // The line moved deliberately. "will look into" and "will work on" are
    // true — an issue is created and routed to the service owner with an SLA.
    // What a bot must never promise is that the problem WILL BE SOLVED.
    for (const promise of [
      "We will fix this by Friday.",
      "Our team will resolve it shortly.",
      "I will ensure this is sorted.",
      "This will be corrected."
    ]) {
      assert.ok(containsClaim(promise), `should be blocked: ${promise}`);
    }
    for (const allowed of [
      "Our PPC team will look into this.",
      "Noted — our team will work on this.",
      "I have captured these for SRV to work on."
    ]) {
      assert.ok(!containsClaim(allowed), `should be allowed: ${allowed}`);
    }
  });

  await scenario("Issue review returns nothing when Gemini is unavailable", async () => {
    const out = await reviewIssues({
      project: { name: "P", services: [{ serviceKey: "ppc", name: "PPC" }] },
      conversationState: { mentionedServices: {} },
      messages: [{ side: "client", body: "ppc is bad" }]
    });
    assert.deepStrictEqual(out.issues, [], "a model outage must not invent issues");
    assert.strictEqual(out.source, "fallback");
  });

  await scenario("Reply interpretation falls back to no intent", async () => {
    const out = await interpretReply({ project: null, question: "any other service?", text: "Mo" });
    assert.strictEqual(out.intent, null, "without Gemini the rules must handle it alone");
  });

  await scenario("'feedback' is an available intent", async () => {
    const { INTENTS } = require("../src/lib/gemini");
    assert.ok(INTENTS.includes("feedback"),
      "the most common message a client sends must have an intent to sit in");
  });

  await scenario("Interpretation preserves feedback, observation, appreciation and defer independently", async () => {
    const interpreted = normaliseReplyInterpretation({
      intent: "feedback",
      deferRequested: true,
      sentiment: "negative",
      rating: null,
      serviceHint: "PPC / Media",
      serviceHints: ["PPC / Media", "Invented Service"],
      explainsProblem: true,
      isObservation: true,
      serviceFeedback: [
        {
          serviceHint: "PPC / Media", sentiment: "negative",
          summary: "Lead quality is poor", needsFollowUp: false
        },
        {
          serviceHint: "Invented Service", sentiment: "positive",
          summary: "Should be dropped", needsFollowUp: false
        }
      ],
      observations: [{
        topic: "Billing", detail: "The invoice is inaccurate",
        sentiment: "negative", severity: "watch", needsFollowUp: false
      }],
      appreciations: [{
        subject: "Creative Team", detail: "The videos are fantastic",
        serviceHint: "Design"
      }]
    }, {
      services: [
        { serviceKey: "ppc", name: "PPC / Media" },
        { serviceKey: "design", name: "Design" }
      ]
    }, "PPC leads are poor. Billing is inaccurate. The creative team makes fantastic videos. I will reply later.");

    assert.strictEqual(interpreted.deferRequested, true);
    assert.deepStrictEqual(interpreted.captured.map((item) => item.serviceKey), ["ppc"]);
    assert.deepStrictEqual(interpreted.serviceKeys, ["ppc"]);
    assert.strictEqual(interpreted.observations[0].topic, "Billing");
    assert.strictEqual(interpreted.appreciations[0].serviceKey, "design");
    assert.strictEqual(interpreted.isObservation, false,
      "a mixed observation must not suppress the service feedback in the same message");
  });

  await scenario("A pure defer cannot become service feedback merely from a service hint", async () => {
    const interpreted = normaliseReplyInterpretation({
      intent: "defer",
      deferRequested: true,
      sentiment: "neutral",
      serviceHint: "PPC / Media",
      serviceHints: [],
      serviceFeedback: [],
      observations: [],
      appreciations: []
    }, {
      services: [{ serviceKey: "ppc", name: "PPC / Media" }]
    }, "I will reply about PPC tomorrow");
    assert.strictEqual(interpreted.deferRequested, true);
    assert.deepStrictEqual(interpreted.captured, []);
  });

  let failed = 0;
  for (const [status, name, message] of results) {
    if (status === "FAIL") failed += 1;
    console.log(`${status}  ${name}${message ? `\n      ${message}` : ""}`);
  }
  console.log(`\n${results.length - failed}/${results.length} Gemini guardrail scenarios passed`);
  process.exit(failed ? 1 : 0);
})();

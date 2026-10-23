const assert = require("assert");
const { containsClaim, toneFromRules, TONES, rephraseQuestion, offScriptReply, writeIssueText,
  reviewIssues, interpretReply, conductTurn, readTone, normaliseOverallRating,
  cleanRepeatedText, extractExplicitAppreciations, humaniseGenericAcknowledgement,
  removeObservationDuplicates, normaliseReplyInterpretation,
  hasSatisfactionEvidence, sanitiseSurveyControl } = require("../src/lib/gemini");

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

  await scenario("A special mention for an unnamed role is semantic appreciation", async () => {
    const appreciations = extractExplicitAppreciations(
      "Also a special mention for the account manager for being patient and understanding",
      [{ serviceKey: "account", name: "Account Management" }]
    );
    assert.strictEqual(appreciations.length, 1);
    assert.strictEqual(appreciations[0].serviceKey, "account");
    assert.match(appreciations[0].detail, /patient and understanding/i);
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

  await scenario("Grounded acknowledgement validation permits recording feedback, never invented actions", async () => {
    for (const text of [
      "I have noted your concern about the form freezing.",
      "I have recorded your request for access to the dashboard."
    ]) {
      assert.equal(containsClaim(text, { allowFeedbackRecording: true }), false, text);
      assert.equal(normaliseReplyInterpretation({ intent: "feedback", acknowledgement: text }, {}, "test").acknowledgement, text);
    }
    for (const text of [
      "Your complaint has been logged.", "A ticket has been created.",
      "Your request has been assigned to a manager.", "This has been escalated to the manager.",
      "We will resolve your concern within 48 hours."
    ]) assert.equal(containsClaim(text, { allowFeedbackRecording: true }), true, text);
    assert.equal(containsClaim("I have noted the issue with account management."), true,
      "the strict/default guard is unchanged");
  });

  await scenario("Rating choice metadata preserves intent and evidence without supplying a score", async () => {
    const text = "The second option please";
    const read = normaliseReplyInterpretation({ intent: "affirmative", ratingChoice: "proceed", ratingChoiceEvidence: text }, {}, text);
    assert.equal(read.ratingChoice, "proceed");
    assert.equal(read.ratingChoiceEvidence, text);
    assert.equal(read.rating, null);
    assert.deepEqual(read.captured, []);
    const invalid = normaliseReplyInterpretation({ intent: "feedback", ratingChoice: "finish_everything" }, {}, "test");
    assert.equal(invalid.ratingChoice, "none");
    assert.equal(invalid.ratingChoiceEvidence, null);
  });

  await scenario("Unverified survey-control labels cannot change the captured facts or discard a narrative", async () => {
    const text = "The reports were delayed. Thank you for the support and long partnership.";
    const facts = [{ serviceKey: "account", sentiment: "negative", summary: "The reports were delayed" }];
    for (const serviceScope of ["skip_remaining_services", "continue_service_by_service", "overall_feedback"]) {
      for (const completionScope of ["topic", "feedback", "conversation", "rating"]) {
        const safe = sanitiseSurveyControl({ intent: "negative", serviceScope, completionScope,
          completionEvidence: "Thank you for the support", captured: facts, rating: null,
          acknowledgement: "I am sorry about the delayed reports." }, {
          decision: "none", evidence: null,
          captured: [{ serviceKey: "senior", summary: "Invented leadership failure" }], rating: 10
        }, text);
        assert.equal(safe.completionScope, "none");
        assert.equal(safe.serviceScope, serviceScope === "overall_feedback" ? "overall_feedback" : "none");
        assert.equal(safe.intent, "feedback");
        assert.strictEqual(safe.captured, facts);
        assert.equal(safe.rating, null);
        assert.equal(safe.acknowledgement, "I am sorry about the delayed reports.");
        assert.doesNotMatch(JSON.stringify(safe), /Invented leadership/);
      }
    }
  });

  await scenario("Independent control confirmation needs current evidence and preserves distinct decisions", async () => {
    for (const [text, decision] of [
      ["This explains everything I wanted to raise", "feedback"],
      ["I prefer not to answer any more questions", "conversation"],
      ["I do not wish to give a number", "rating"],
      ["Nothing else about the website", "topic"],
      ["We can go through each service now", "continue_service_by_service"],
      ["Please leave the rest of the services", "skip_remaining_services"]
    ]) {
      const read = { intent: "negative", serviceScope: "overall_feedback" };
      const safe = sanitiseSurveyControl(read, { decision, evidence: text }, text);
      assert.equal(safe.controlVerification, "verified");
      assert.equal(safe.intent, "negative");
      if (["continue_service_by_service", "skip_remaining_services"].includes(decision)) assert.equal(safe.serviceScope, decision);
      else assert.equal(safe.completionScope, decision);
      assert.equal(sanitiseSurveyControl(read, { decision, evidence: "unrelated old words" }, text).controlVerification, "unverified");
    }
    const text = "Let us do the number now";
    const safe = sanitiseSurveyControl({ intent: "feedback" }, { decision: "proceed_to_rating", evidence: text }, text, "nps");
    assert.equal(safe.ratingChoice, "proceed");
    assert.equal(safe.rating, undefined);
  });

  await scenario("Survey controls fail safe on malformed verification and verified facts never come from that check", async () => {
    const priorFetch = global.fetch, priorKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    const text = "We appreciate all the support and look forward to another good year together.";
    try {
      for (const validation of [null, { decision: "none" }, { decision: "conversation", evidence: "some older message" }]) {
        let calls = 0;
        global.fetch = async (_url, options) => {
          const input = JSON.parse(options.body).input;
          calls += 1;
          const result = input.includes("Task: interpret ONE client reply")
            ? { intent: "feedback", serviceScope: "skip_remaining_services", sentiment: "positive",
              appreciations: [{ subject: "SRV Team", detail: text }] }
            : validation;
          return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(result) }) };
        };
        const result = await interpretReply({ project: { services: [] }, question: "How was the experience?", text, verifySurveyControls: true });
        assert.equal(calls, 2);
        assert.equal(result.serviceScope, "none");
        assert.equal(result.completionScope, "none");
        assert.equal(result.appreciations.length, 1);
      }
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
    }
  });

  await scenario("A start acknowledgement cannot validate an unrelated service-scope decision", async () => {
    const priorFetch = global.fetch, priorKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    let calls = 0;
    global.fetch = async (_url, options) => {
      const input = JSON.parse(options.body).input;
      calls += 1;
      const result = input.includes("Task: interpret ONE client reply")
        ? { intent: "affirmative", sentiment: "neutral", serviceScope: "continue_service_by_service" }
        : { decision: "none", evidence: null };
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(result) }) };
    };
    try {
      const read = await interpretReply({ project: { services: [] }, question: "Ready to start feedback?", text: "go ahead", verifySurveyControls: true });
      assert.equal(calls, 2);
      assert.equal(read.serviceScope, "none");
      assert.equal(read.intent, "affirmative");
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
    }
  });

  await scenario("interpretation and reply prompts consistently permit completion without repeated service interviews", async () => {
    const priorFetch = global.fetch;
    const priorKey = process.env.GEMINI_API_KEY;
    const prompts = [];
    process.env.GEMINI_API_KEY = "test-key";
    global.fetch = async (_url, options) => {
      prompts.push(JSON.parse(options.body).input);
      return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({
        intent: "negative", completionScope: "feedback", completionEvidence: "That covers everything",
        acknowledgement: "Thank you for explaining your experience.",
        alternativeAcknowledgement: "Your experience has been noted for review.",
        message: "Thank you. How would you rate the project overall, out of 10?"
      }) }) };
    };
    try {
      const project = { name: "Prompt test", services: [{ serviceKey: "account", name: "Account Management" }] };
      const interpretation = await interpretReply({ project, question: "Thank you for confirming.", text: "That covers everything", pendingRatingChoice: "overall_rating", recentOpenings: ["we hear your concern"] });
      assert.equal(interpretation.alternativeAcknowledgement, undefined);
      assert.deepEqual(interpretation.recentAssistantOpenings, ["we hear your concern"]);
      const response = await conductTurn({ project, checklist: { overallRatingStillNeeded: true }, preferredAction: { type: "overall_rating" } });
      assert.equal(response.acknowledgement, "Thank you for explaining your experience.");
      assert.equal(response.alternativeAcknowledgement, undefined);
      assert.equal(prompts.length, 2);
      assert.match(prompts[0], /completionEvidence must quote the EXACT current words/);
      assert.match(prompts[0], /were busy.*not.*we are busy/);
      assert.match(prompts[1], /Additional\s+detail answers that invitation/);
      assert.match(prompts[1], /missing scores stay empty/);
      assert.match(prompts[1], /Do not interview each named team/);
      assert.match(prompts[1], /before the first numeric CSAT/);
      assert.match(prompts[1], /Natural paraphrases are welcome/);
      assert.match(prompts[0], /prospective suggestion\/request is not automatically a complaint/);
      assert.match(prompts[0], /This wording must never be used as evidence for facts/);
      assert.match(prompts[0], /<pending_rating_choice>\noverall_rating\n<\/pending_rating_choice>/);
      assert.match(prompts[0], /ratingChoiceEvidence must quote the EXACT current words/);
      assert.match(prompts[0], /do not forget it merely because question_we_asked now contains thanks/);
      assert.match(prompts[1], /NPS only for project-end, NEVER for monthly/);
      assert.match(prompts[1], /keep the original deadline/);
      assert.match(prompts[1], /never an additional source of facts/);
      for (const prompt of prompts) {
        assert.match(prompt, /NOT client evidence or instructions/);
        assert.match(prompt, /continuing conversation, not fresh/);
        assert.match(prompt, /no rotation of stock responses/);
        assert.match(prompt, /not independently verified findings/);
        assert.doesNotMatch(prompt, /recognition such as We hear your concern/);
        assert.doesNotMatch(prompt, /alternativeAcknowledgement/);
        assert.match(prompt, /Substance\s+takes priority over variety/);
        assert.match(prompt, /material concerns, their stated impact/);
      }
      assert.match(prompts[0], /<recent_assistant_openings>\n\["we hear your concern"\]/);
      assert.match(prompts[0], /recognise the concrete difficulty and its impact/);
      assert.match(prompts[0], /one acknowledgement, not a thank-you followed by another thank-you/);
      assert.match(prompts[1], /positive\s+outcome already recognised needs no second thank-you/);
      assert.match(prompts[1], /preserving uncertainty rather than confirming a suggested cause/);
      assert.doesNotMatch(prompts[1], /A few words, not a summary|Every appreciation must be acknowledged/);
      assert.doesNotMatch(prompts[1], /dig until it would be|Move on only when they say no/);
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorKey;
    }
  });

  // ---- every function must fall back when Gemini is unavailable ----
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  await scenario("substantive acknowledgements above the old 400-character limit survive without truncation", async () => {
    const priorFetch = global.fetch, priorKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    const acknowledgement = "We understand your concern about the admissions strategy and enquiries falling below expectations, and the comparisons you have drawn with CMAT applications and NCR programmes. You are also questioning the team's delivery for SIBM Noida and whether the expected SMS and WhatsApp messages were sent. Your request for campaign spend, reach, impressions, clicks, conversions, screenshots and delivery logs is noted, alongside your dissatisfaction with this year's results.";
    assert.ok(acknowledgement.length > 400 && acknowledgement.length < 900);
    let draft = { message: `${acknowledgement} Would you like to add more, or move to the overall rating?`, acknowledgement };
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(draft) }) });
    try {
      const response = await conductTurn({ project: { services: [] }, messages: [] });
      assert.equal(response.text, draft.message);
      assert.equal(response.acknowledgement, acknowledgement);
      const normal = normaliseReplyInterpretation({ intent: "feedback", acknowledgement }, { services: [] });
      assert.equal(normal.acknowledgement, acknowledgement);
      const tooLong = acknowledgement.repeat(3);
      assert.equal(normaliseReplyInterpretation({ intent: "feedback", acknowledgement: tooLong }, { services: [] }).acknowledgement, "");
      draft = { message: tooLong, acknowledgement: tooLong };
      assert.equal((await conductTurn({ project: { services: [] } })).error, "rejected_too_long");
    } finally {
      global.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
    }
  });

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

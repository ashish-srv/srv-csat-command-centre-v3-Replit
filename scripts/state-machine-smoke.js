const assert = require("assert");
const {
  processWhatsAppReply,
  getConversationState,
  buildChecklist,
  applyCaptured,
  applyServiceScopeDecision,
  isEverythingCovered,
  STATES,
  GUARDRAILS,
  SERVICE_SCOPE_DECISIONS,
  detectors,
  MAX_PROBES_PER_SERVICE
} = require("../src/lib/whatsapp-state-machine");

const project = {
  id: "prj_1",
  key: "acme-ug",
  name: "Acme University UG Admissions",
  services: [
    { serviceKey: "ppc", name: "PPC / Media", ownerName: "Riya", managerEmail: "mgr.ppc@srvmedia.com", internalPocId: "ip_1" },
    { serviceKey: "design", name: "Design", ownerName: "Karan", managerEmail: "mgr.design@srvmedia.com", internalPocId: "ip_2" },
    { serviceKey: "website", name: "Website / SEO", ownerName: "Neha", managerEmail: "mgr.web@srvmedia.com", internalPocId: "ip_3" },
    { serviceKey: "account", name: "Account Management", ownerName: "Sahil", managerEmail: "mgr.am@srvmedia.com", internalPocId: "ip_4" }
  ]
};
const poc = { id: "poc_1", name: "Haranath", salutation: "Haranath sir", weight: 2 };

function newSession(sessionType = "pulse") {
  return { id: "sess_1", projectId: "prj_1", clientPocId: "poc_1", sessionType, conversationState: {} };
}

/**
 * These scenarios run the state machine with NO Gemini, which is the outage
 * path: keyword matching is allowed to act alone. With Gemini reachable the
 * machine defers to it for anything inexact — covered separately below.
 */
function run(session, texts, options = {}) {
  const turns = [];
  let state = session;
  for (const text of texts) {
    const turn = processWhatsAppReply({
      session: state, project, poc, text,
      geminiUnavailable: options.geminiUnavailable !== false,
      interpretation: options.interpretation || null
    });
    state = { ...state, conversationState: turn.conversationState };
    turns.push({ ...turn, snapshot: JSON.parse(JSON.stringify(turn.conversationState)) });
  }
  return { turns, last: turns[turns.length - 1], state };
}

const results = [];
function scenario(name, fn) {
  try { fn(); results.push(["PASS", name]); }
  catch (e) { results.push(["FAIL", name, e.message]); }
}

// ---- Happy path -----------------------------------------------------
scenario("S1 full pulse: issue -> reason -> rating -> more -> overall -> completed", () => {
  const { turns, last } = run(newSession(), [
    "PPC reporting is good but website changes are slow",
    "Pages take a long time to go live",
    "no",
    "4",
    "8",
    "no",
    "8",
    "no"
  ]);
  assert.ok(!/rating from 1 to 5/i.test(turns[3].nextMessage.body) || !/other service/i.test(turns[3].nextMessage.body),
    "the other-services ask must not also ask for the overall rating");
  assert.strictEqual(last.conversationState.state, STATES.CLOSING_GRACE, "should enter the correction window");
  assert.strictEqual(last.analysis.isComplete, true);
  assert.strictEqual(last.analysis.csatScore, 8, `score must be exactly what the client said, got ${last.analysis.csatScore}`);
  assert.ok(turns.every((t) => t.nextMessage.body), "every turn replies");
});

scenario("A number inside prose is not read as a rating", () => {
  const { turns } = run(newSession(), ["website changes are slow", "Pages take two weeks to go live"]);
  const web = turns[1].conversationState.mentionedServices.website;
  assert.strictEqual(web.rating, null, `"two weeks" must not become a 2/10, got ${web.rating}`);
});

scenario("S2 praise is acknowledged, then invited to expand, then rated", () => {
  const { turns } = run(newSession(), ["design is great", "no"]);
  assert.ok(/good to hear/i.test(turns[0].nextMessage.body),
    `praise deserves acknowledgement, not an immediate rating request: ${turns[0].nextMessage.body}`);
  assert.ok(/anything you would still like us to improve/i.test(turns[0].nextMessage.body),
    "the invitation should ride in the same message");
  assert.ok(/Design support/i.test(turns[1].nextMessage.body), turns[1].nextMessage.body);
  assert.ok(/out of 10/i.test(turns[1].nextMessage.body), "service ratings must be asked out of 10");
});

scenario("A niggle raised after praise is acknowledged before the rating", () => {
  const { turns } = run(newSession(), ["design is great", "turnaround could be quicker"]);
  assert.ok(/will look into that too|will include it.*to review/i.test(turns[1].nextMessage.body),
    `what they raised must land: ${turns[1].nextMessage.body}`);
});

scenario("Praise plus a niggle does not become a high-severity issue on its own", () => {
  const { last } = run(newSession(), ["design is great", "turnaround could be quicker", "8"]);
  const design = last.conversationState.mentionedServices.design;
  assert.strictEqual(design.sentiment, "positive",
    "a minor note after praise should not flip the service to a complaint");
  assert.ok(last.analysis.services.every((svc) => !svc.issueReady),
    "no issue should be raised from a niggle after praise with a good rating");
});

scenario("S3 project_end asks NPS 0-10 after overall", () => {
  const { last } = run(newSession("project_end"), [
    "everything was good", "9", "no", "9"
  ]);
  assert.ok(
    last.conversationState.state === STATES.WAITING_FOR_NPS || last.conversationState.npsScore !== null,
    `expected NPS stage, got ${last.conversationState.state}`
  );
});

scenario("S4 no infinite loop on vague / move-on replies", () => {
  const { turns } = run(newSession(), [
    "account management has issues",
    "not sure",
    "no",
    "6",
    "Apart from this nothing",
    "4",
    "no"
  ]);
  const states = turns.map((t) => t.snapshot.state);
  assert.ok(!states.slice(0, -1).every((s, i) => s === states[i + 1]), "states must advance");
  assert.strictEqual(turns[turns.length - 1].conversationState.state, STATES.CLOSING_GRACE, states.join(" -> "));
});

scenario("S5 blanket 'all good' with no service named still reaches overall rating", () => {
  const { turns, last } = run(newSession(), ["everything is good"]);
  assert.ok(/overall/i.test(turns[0].nextMessage.body), turns[0].nextMessage.body);
  assert.notStrictEqual(last.conversationState.state, STATES.WAITING_FOR_OPEN_FEEDBACK);
});

scenario("S6 blanket 'nothing is working' asks which service once, then moves on", () => {
  const { turns } = run(newSession(), ["nothing is working well", "not sure"]);
  assert.ok(/Which service/i.test(turns[0].nextMessage.body), turns[0].nextMessage.body);
  assert.ok(/overall/i.test(turns[1].nextMessage.body), turns[1].nextMessage.body);
});

scenario("Client-facing replies say 'our team', not 'SRV'", () => {
  const { turns } = run(newSession(), [
    "design is bad", "brand guidelines are inconsistent", "no", "3", "no", "6"
  ]);
  for (const turn of turns) {
    assert.ok(!/\bSRV will\b|for SRV to\b/i.test(turn.nextMessage.body),
      `reads as a third party: ${turn.nextMessage.body}`);
  }
});

scenario("A reason in the opening message still earns an 'anything else?' turn", () => {
  const { turns } = run(newSession(), ["website changes are slow"]);
  assert.ok(/anything else/i.test(turns[0].nextMessage.body), turns[0].nextMessage.body);
});

scenario("An unparsed reply is never repeated back word for word", () => {
  const { turns } = run(newSession(), [
    "design is bad", "brand guidelines are inconsistent", "no", "3", "qqq", "zzz"
  ]);
  const asks = turns.filter((t) => /other service/i.test(t.nextMessage.body));
  const bodies = asks.map((t) => t.nextMessage.body);
  const unique = new Set(bodies);
  assert.strictEqual(unique.size, bodies.length,
    `the same message was sent twice: ${JSON.stringify(bodies)}`);
});

scenario("An out-of-range number is told the scale, not asked again blindly", () => {
  const { turns } = run(newSession(), ["website is slow", "pages take ages", "100"]);
  const reply = turns[2].nextMessage.body;
  assert.ok(/0 to 10/.test(reply), `client must be told the scale: ${reply}`);
});

scenario("A decimal rating is captured exactly as stated", () => {
  const { turns } = run(newSession(), ["website is slow", "pages take ages", "6.5"]);
  const web = turns[2].conversationState.mentionedServices.website;
  assert.strictEqual(web.rating, 6.5, `6.5 must be stored as 6.5, got ${web.rating}`);
});

scenario("An unparsed reply never overwrites the captured reason", () => {
  const { turns } = run(newSession(), [
    "website has issue", "landing page has latency", "6.5"
  ]);
  const web = turns[2].conversationState.mentionedServices.website;
  assert.ok(/latency/i.test(web.reasonText || ""),
    `the real complaint was lost: ${JSON.stringify(web.reasonText)}`);
});

scenario("A deferral is acknowledged, not answered with the same question again", () => {
  const { last } = run(newSession(), ["I will give feedback after some time"]);
  assert.ok(/take your time/i.test(last.nextMessage.body), last.nextMessage.body);
  assert.ok(/session is saved/i.test(last.nextMessage.body), last.nextMessage.body);
  assert.ok(!/what is working well/i.test(last.nextMessage.body),
    "must not repeat the opening question at someone who asked to answer later");
  assert.strictEqual(last.control.deferred, true);
  assert.strictEqual(last.control.allowAiRephrase, false,
    "a recognized deferral must not make a second generation call");
});

scenario("Project-end broad feedback covers unmentioned services without inventing answers", () => {
  const state = {
    sessionType: "project_end",
    mentionedServices: {},
    serviceScopeStatus: null,
    overallRating: null,
    npsScore: null
  };
  applyServiceScopeDecision(
    state,
    project,
    SERVICE_SCOPE_DECISIONS.OVERALL_FEEDBACK,
    { text: "Overall, the project went well and the team was supportive.", sentiment: "positive" }
  );
  const checklist = buildChecklist(state, project);
  assert.strictEqual(state.projectEndReviewCaptured, true);
  assert.strictEqual(state.serviceScopeStatus, "project_end_overall");
  assert.strictEqual(checklist.projectEndReviewStillNeeded, false);
  assert.deepStrictEqual(checklist.servicesNotYetDiscussedWithKeys, []);
  assert.deepStrictEqual(state.mentionedServices, {},
    "unmentioned services must not be stored as positive or declined");
});

scenario("Project-end only follows up concerns actually raised", () => {
  const state = {
    sessionType: "project_end",
    mentionedServices: {},
    serviceScopeStatus: "project_end_overall"
  };
  applyCaptured(state, project, [
    { serviceKey: "design", sentiment: "positive", summary: "Design support was strong", needsFollowUp: false },
    { serviceKey: "website", sentiment: "negative", summary: "The website was slow", needsFollowUp: false }
  ]);
  const checklist = buildChecklist(state, project);
  assert.strictEqual(state.mentionedServices.design.status, "captured",
    "positive project-end feedback must not start a service interview");
  assert.strictEqual(state.mentionedServices.website.status, "needs_service_followup",
    "an actual concern must receive its focused anything-else follow-up");
  assert.deepStrictEqual(
    checklist.servicesWaitingForAnythingElseAnswer.map((item) => item.serviceKey),
    ["website"]
  );
});

scenario("Project-end recommendation keeps decimals and never overwrites overall CSAT", () => {
  const mentionedServices = Object.fromEntries(project.services.map((service) => [
    service.serviceKey,
    {
      serviceKey: service.serviceKey,
      serviceName: service.name,
      status: "captured",
      sentiment: "neutral",
      serviceFollowUpAnswered: true
    }
  ]));
  const waitingForNps = {
    ...newSession("project_end"),
    conversationState: {
      state: STATES.WAITING_FOR_NPS,
      sessionType: "project_end",
      pendingQuestionType: "nps",
      projectEndReviewAsked: true,
      projectEndReviewCaptured: true,
      serviceScopeStatus: "overall_feedback",
      askedForAppreciation: true,
      appreciationAnswered: true,
      askedForAnythingElse: true,
      anythingElseAnswered: true,
      overallRatingAsked: true,
      overallRating: 4,
      npsScore: null,
      mentionedServices
    }
  };
  const initialWaitingForNps = JSON.parse(JSON.stringify(waitingForNps));

  assert.deepStrictEqual(detectors.detectNumber("no take three point five"), {
    value: 3.5,
    scale: null
  });
  const answered = processWhatsAppReply({
    session: JSON.parse(JSON.stringify(initialWaitingForNps)), project, poc,
    text: "no take three point five",
    geminiUnavailable: true
  });
  assert.strictEqual(answered.conversationState.overallRating, 4);
  assert.strictEqual(answered.conversationState.npsScore, 3.5);
  assert.strictEqual(answered.conversationState.state, STATES.CLOSING_GRACE);

  const corrected = processWhatsAppReply({
    session: { ...waitingForNps, conversationState: answered.conversationState },
    project, poc,
    text: "take 5 for recommending SRV",
    geminiUnavailable: true
  });
  assert.strictEqual(corrected.conversationState.overallRating, 4);
  assert.strictEqual(corrected.conversationState.npsScore, 5);
  assert.match(corrected.nextMessage.body, /recommendation rating to 5 out of 10/i);
  assert.match(corrected.nextMessage.body, /overall rating remains 4 out of 10/i);

  const invalid = processWhatsAppReply({
    session: JSON.parse(JSON.stringify(initialWaitingForNps)), project, poc,
    text: "11",
    geminiUnavailable: true
  });
  assert.strictEqual(invalid.conversationState.npsScore, null);
  assert.strictEqual(invalid.conversationState.state, STATES.WAITING_FOR_NPS);
  assert.match(invalid.nextMessage.body, /scale here is 0 to 10/i);
});

scenario("An in-flight project-end scope question resumes without repeating feedback", () => {
  const state = getConversationState({
    sessionType: "project_end",
    conversationState: {
      sessionType: "project_end",
      state: STATES.WAITING_FOR_SERVICE_SCOPE,
      pendingQuestionType: "service_scope",
      serviceScopeStatus: "awaiting_choice",
      generalFeedbackText: "The overall project went well.",
      mentionedServices: {}
    }
  });
  assert.strictEqual(state.projectEndReviewCaptured, true);
  assert.strictEqual(state.serviceScopeStatus, "project_end_overall");
  assert.strictEqual(state.pendingQuestionType, null);
  assert.strictEqual(buildChecklist(state, project).projectEndReviewStillNeeded, false);
});

scenario("Broad overall feedback asks before starting service-by-service questions", () => {
  const { last } = run(newSession(), [
    "We had a few hiccups initially, but things fell into place and I value the partnership."
  ], {
    geminiUnavailable: false,
    interpretation: {
      intent: "feedback",
      serviceScope: "overall_feedback",
      sentiment: "positive",
      rating: null,
      serviceKeys: [],
      explainsProblem: false,
      isObservation: false
    }
  });
  assert.strictEqual(last.conversationState.state, STATES.WAITING_FOR_SERVICE_SCOPE);
  assert.strictEqual(last.conversationState.serviceScopeStatus, "awaiting_choice");
  assert.match(last.nextMessage.body, /services one by one/i);
  assert.match(last.nextMessage.body, /yes to continue|skip/i);
  assert.strictEqual(last.conversationState.generalFeedbackText,
    "We had a few hiccups initially, but things fell into place and I value the partnership.");
});

scenario("Choosing service-by-service keeps every remaining service available", () => {
  const state = {
    sessionType: "pulse",
    mentionedServices: {},
    serviceScopeStatus: "awaiting_choice",
    pendingQuestionType: "service_scope"
  };
  applyServiceScopeDecision(
    state,
    project,
    SERVICE_SCOPE_DECISIONS.CONTINUE_SERVICE_BY_SERVICE
  );
  const checklist = buildChecklist(state, project);
  assert.strictEqual(state.serviceScopeStatus, "service_by_service");
  assert.strictEqual(checklist.servicesNotYetDiscussedWithKeys.length, project.services.length);
  assert.deepStrictEqual(Object.keys(state.mentionedServices), []);
});

scenario("A pending service-scope choice cannot be treated as completed", () => {
  const mentionedServices = Object.fromEntries(project.services.map((service) => [
    service.serviceKey,
    {
      serviceKey: service.serviceKey,
      serviceName: service.name,
      status: "captured",
      sentiment: "neutral",
      serviceFollowUpAnswered: true
    }
  ]));
  const state = {
    sessionType: "pulse",
    mentionedServices,
    serviceScopeStatus: "awaiting_choice",
    askedForAppreciation: true,
    appreciationAnswered: true,
    askedForAnythingElse: true,
    anythingElseAnswered: true,
    overallRatingAsked: true,
    overallRating: 8
  };
  assert.strictEqual(isEverythingCovered(state, project), false);
});

scenario("Skipping remaining services records declines without inventing praise", () => {
  const state = {
    sessionType: "pulse",
    mentionedServices: {},
    serviceScopeStatus: "awaiting_choice",
    pendingQuestionType: "service_scope"
  };
  applyServiceScopeDecision(
    state,
    project,
    SERVICE_SCOPE_DECISIONS.SKIP_REMAINING_SERVICES
  );
  const checklist = buildChecklist(state, project);
  assert.strictEqual(state.serviceScopeStatus, "skipped");
  assert.deepStrictEqual(checklist.servicesNotYetDiscussedWithKeys, []);
  assert.strictEqual(checklist.servicesTheyDeclinedToDiscuss.length, project.services.length);
  for (const service of Object.values(state.mentionedServices)) {
    assert.strictEqual(service.status, "declined");
    assert.strictEqual(service.sentiment, "neutral");
  }
});

scenario("An explicit skip finishes questions but preserves an existing concern", () => {
  const state = {
    sessionType: "pulse",
    mentionedServices: {}
  };
  applyCaptured(state, project, [{
    serviceKey: "ppc",
    sentiment: "negative",
    summary: "Lead quality is poor",
    needsFollowUp: false
  }]);
  applyServiceScopeDecision(
    state,
    project,
    SERVICE_SCOPE_DECISIONS.SKIP_REMAINING_SERVICES
  );
  assert.strictEqual(state.mentionedServices.ppc.status, "captured");
  assert.strictEqual(state.mentionedServices.ppc.sentiment, "negative");
  assert.match(state.mentionedServices.ppc.reasonText, /lead quality is poor/i);
  assert.strictEqual(buildChecklist(state, project).servicesWaitingForAnythingElseAnswer.length, 0);
});

scenario("Gemini-recognized postponement keeps its acknowledgement deterministic", () => {
  const turn = processWhatsAppReply({
    session: newSession(),
    project,
    poc,
    text: "I need to review this properly before responding",
    interpretation: {
      intent: "defer",
      sentiment: "neutral",
      rating: null,
      serviceKeys: [],
      explainsProblem: false,
      isObservation: false
    }
  });
  assert.strictEqual(turn.control.deferred, true);
  assert.strictEqual(turn.control.allowAiRephrase, false);
  assert.match(turn.nextMessage.body, /take your time/i);
  assert.doesNotMatch(turn.nextMessage.body, /how has|what is working/i);
  assert.ok(turn.conversationState.deferredAt);
});

scenario("Please allow me a day is recognized even when Gemini is unavailable", () => {
  const { last } = run(
    newSession(),
    ["Hi, please allow me a day to come back with honest reviews. Thanks"],
    { geminiUnavailable: true }
  );
  assert.strictEqual(last.control.deferred, true);
  assert.strictEqual(last.control.allowAiRephrase, false);
  assert.match(last.nextMessage.body, /take your time/i);
  assert.deepStrictEqual(Object.keys(last.conversationState.mentionedServices), []);
});

scenario("Mixed feedback plus a postponement requests one structured interpretation", () => {
  const text = "PPC is working well, but I need time to review the rest and will revert tomorrow";
  const firstPass = processWhatsAppReply({
    session: newSession(), project, poc, text
  });
  assert.strictEqual(firstPass.needsInterpretation, true,
    "recognising PPC must not hide the independent request to continue later");

  const interpreted = processWhatsAppReply({
    session: newSession(), project, poc, text,
    interpretation: {
      intent: "feedback",
      deferRequested: true,
      sentiment: "positive",
      rating: null,
      serviceKeys: ["ppc"],
      explainsProblem: false,
      isObservation: false,
      captured: [{
        serviceKey: "ppc", sentiment: "positive",
        summary: "PPC is working well", needsFollowUp: false
      }],
      observations: [],
      appreciations: []
    }
  });
  assert.strictEqual(interpreted.control.deferred, true);
  assert.strictEqual(interpreted.control.allowAiRephrase, false);
  assert.match(interpreted.nextMessage.body, /continue from where you stopped/i);
});

scenario("Deferring keeps the session open for the reminder flow", () => {
  const { last } = run(newSession(), ["I will give feedback after some time"]);
  assert.notStrictEqual(last.conversationState.state, STATES.COMPLETED);
  assert.ok(last.conversationState.deferredAt, "the deferral should be recorded");
});

scenario("The overall question names SRV Media, not 'our team'", () => {
  const { turns } = run(newSession(), ["all good", "8", "no"]);
  const overall = turns.find((t) => /how would you rate/i.test(t.nextMessage.body)
    && /overall/i.test(t.nextMessage.body));
  if (overall) {
    assert.ok(/SRV Media/.test(overall.nextMessage.body), overall.nextMessage.body);
  }
});

scenario("'I am busy now' defers and creates no service", () => {
  const { last } = run(newSession(), ["I am busy now"]);
  assert.deepStrictEqual(Object.keys(last.conversationState.mentionedServices), [],
    "a deferral must never invent a complaint");
  assert.strictEqual(last.control.deferred, true);
});

scenario("Refusing for now is treated as a deferral, not as feedback", () => {
  for (const text of ["I will not give feedback now", "I dont want to give feedback now", "no time right now"]) {
    const { last } = run(newSession(), [text]);
    assert.strictEqual(last.control.deferred, true, `not deferred: ${text}`);
    assert.deepStrictEqual(Object.keys(last.conversationState.mentionedServices), [], text);
  }
});

scenario("Ordinary sentences containing short words create no service", () => {
  for (const text of ["I am fine", "that is a good ad", "I am not sure"]) {
    const { last } = run(newSession(), [text]);
    const services = Object.keys(last.conversationState.mentionedServices);
    assert.deepStrictEqual(services, [], `${text} wrongly matched ${services}`);
  }
});

// ---- Rules only claim to understand exact answers ----

scenario("With Gemini reachable, an inexact reply is sent for interpretation", () => {
  const turn = processWhatsAppReply({
    session: newSession(), project, poc,
    text: "hmm not really sure about that",
    geminiUnavailable: false
  });
  assert.strictEqual(turn.needsInterpretation, true,
    "a fuzzy reply must go to Gemini rather than be guessed at");
});

scenario("An exact answer never needs Gemini", () => {
  for (const text of ["8", "no", "yes", "6.5", "8/10"]) {
    const turn = processWhatsAppReply({
      session: { ...newSession(), conversationState: { state: STATES.WAITING_FOR_MORE_SERVICES, mentionedServices: {}, turnCount: 1 } },
      project, poc, text, geminiUnavailable: false
    });
    assert.strictEqual(turn.needsInterpretation, false, `"${text}" should not need Gemini`);
  }
});

scenario("Gemini reachable but unsure: a keyword match must not stand in for it", () => {
  const turn = processWhatsAppReply({
    session: newSession(), project, poc,
    text: "I am busy now",
    geminiUnavailable: false
  });
  assert.deepStrictEqual(Object.keys(turn.conversationState.mentionedServices), [],
    "a fragment match must never become a captured complaint");
});

scenario("Three misses hands the conversation to a person", () => {
  // The first reply re-asks plainly; the guard needs a question to have been
  // asked once before it can tell that one is being repeated.
  const { turns, last } = run(newSession(), ["qqq", "zzz", "wwww", "vvvv"]);
  const replies = turns.map((t) => t.nextMessage.body);
  assert.ok(/did not follow/i.test(replies[1] || ""), replies[1]);
  assert.ok(/still not sure/i.test(replies[2] || ""), replies[2]);
  assert.ok(/not following this properly/i.test(replies[3] || ""), replies[3]);
  assert.strictEqual(last.conversationState.state, STATES.HANDED_OFF,
    "a conversation that will not converge needs a person, not another retry");
  assert.strictEqual(last.control.stopReminders, true);
});

scenario("A valid no never becomes the third miss or triggers handoff", () => {
  const allCovered = Object.fromEntries(project.services.map((service) => [
    service.serviceKey,
    {
      serviceKey: service.serviceKey,
      serviceName: service.name,
      status: "captured",
      sentiment: "neutral",
      serviceFollowUpAnswered: true
    }
  ]));
  const turn = processWhatsAppReply({
    session: {
      ...newSession(),
      conversationState: {
        state: STATES.WAITING_FOR_MORE_SERVICES,
        pendingQuestionType: "final_sweep",
        askedForAnythingElse: true,
        anythingElseAnswered: false,
        askedForAppreciation: true,
        appreciationAnswered: true,
        overallRatingAsked: true,
        overallRating: 6,
        mentionedServices: allCovered,
        lastQuestionAsked: "Thank you. Our team will work on this. Is there any other service you want us to focus on? If not, just reply no.",
        repeatCount: 2,
        turnCount: 12
      }
    },
    project,
    poc,
    text: "no",
    geminiUnavailable: false
  });
  assert.notStrictEqual(turn.conversationState.state, STATES.HANDED_OFF);
  assert.strictEqual(turn.conversationState.repeatCount, 0);
  assert.strictEqual(turn.control.handoff, undefined);
  assert.strictEqual(turn.control.notUnderstood, false);
});

scenario("A final-sweep no asks for the overall rating even after blanket service feedback", () => {
  const allCovered = Object.fromEntries(project.services.map((service) => [
    service.serviceKey,
    {
      serviceKey: service.serviceKey,
      serviceName: service.name,
      status: "captured",
      sentiment: "positive",
      serviceFollowUpAnswered: true
    }
  ]));
  const ratingQuestion = "Overall, how would you rate the work SRV Media has done for you so far, out of 10?";
  const turn = processWhatsAppReply({
    session: {
      ...newSession(),
      conversationState: {
        state: STATES.WAITING_FOR_MORE_SERVICES,
        pendingQuestionType: "final_sweep",
        askedForAnythingElse: true,
        anythingElseAnswered: false,
        askedForAppreciation: true,
        appreciationAnswered: true,
        readyForOverallRating: true,
        generalSentiment: "positive",
        generalConcernText: "All services are fine. Do not ask about any more services.",
        overallRatingAsked: false,
        overallRating: null,
        mentionedServices: allCovered,
        lastQuestionAsked: ratingQuestion,
        repeatCount: 2,
        turnCount: 7
      }
    },
    project,
    poc,
    text: "no",
    geminiUnavailable: false
  });

  assert.notStrictEqual(turn.conversationState.state, STATES.HANDED_OFF);
  assert.strictEqual(turn.conversationState.state, STATES.WAITING_FOR_OVERALL_RATING);
  assert.strictEqual(turn.conversationState.repeatCount, 0);
  assert.strictEqual(turn.control.handoff, undefined);
  assert.match(turn.nextMessage.body, /overall.*rate|rate.*overall/i);
});

scenario("Gemini negative intent accepts natural no wording outside the fallback dictionary", () => {
  const state = newSession();
  state.conversationState = {
    state: STATES.WAITING_FOR_MORE_SERVICES,
    pendingQuestionType: "final_sweep",
    askedForAnythingElse: true,
    anythingElseAnswered: false,
    repeatCount: 2,
    mentionedServices: {}
  };
  const reply = processWhatsAppReply({
    session: state,
    project,
    poc,
    text: "not anymor",
    interpretation: {
      intent: "negative",
      sentiment: "neutral",
      rating: null,
      serviceKeys: [],
      explainsProblem: false,
      isObservation: false
    },
    geminiUnavailable: false
  });
  assert.notStrictEqual(reply.conversationState.state, STATES.HANDED_OFF);
  assert.strictEqual(reply.conversationState.repeatCount, 0);
});

scenario("An unreadable reply captures nothing at all", () => {
  const { last } = run(newSession(), ["qqq zzz wwww"]);
  assert.deepStrictEqual(Object.keys(last.conversationState.mentionedServices), [],
    "nothing understood means nothing recorded");
  assert.strictEqual(last.analysis.csatScore, null);
});

scenario("Answering the reason question moves the service forward", () => {
  const interp = { intent: "more_detail", sentiment: "negative", rating: null, serviceHint: "PPC / Media" };
  let state = newSession();
  const seen = [];
  for (const text of ["ppc reports are late", "campaign management should improve", "budget allocation should improve"]) {
    const turn = processWhatsAppReply({ session: state, project, poc, text, interpretation: interp });
    state = { ...state, conversationState: turn.conversationState };
    seen.push(turn.nextMessage.body);
  }
  assert.strictEqual(new Set(seen).size, seen.length,
    `the same question came back: ${JSON.stringify(seen)}`);
  const ppc = state.conversationState.mentionedServices.ppc;
  assert.ok(/campaign/i.test(ppc.reasonText) && /budget/i.test(ppc.reasonText),
    `detail was lost: ${ppc.reasonText}`);
});

scenario("The loop guard watches the question, not our confidence", () => {
  const interp = { intent: "more_detail", sentiment: "neutral", rating: null, serviceHint: null };
  let state = newSession();
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const turn = processWhatsAppReply({ session: state, project, poc, text: "hmm", interpretation: interp });
    state = { ...state, conversationState: turn.conversationState };
    seen.push(turn.nextMessage.body);
  }
  assert.strictEqual(new Set(seen).size, seen.length,
    `identical question repeated: ${JSON.stringify(seen)}`);
});

scenario("Resuming after a deferral re-asks the pending question", () => {
  for (const resume of ["Okay I am ready now", "I am ready now", "Yes can give feedback now"]) {
    let state = newSession();
    let turn = processWhatsAppReply({
      session: state, project, poc, text: "I will give feedback later",
      interpretation: { intent: "defer" }
    });
    state = { ...state, conversationState: turn.conversationState };
    turn = processWhatsAppReply({
      session: state, project, poc, text: resume,
      interpretation: { intent: "affirmative", sentiment: "neutral", rating: null, serviceHint: null }
    });
    assert.ok(/what is working well/i.test(turn.nextMessage.body),
      `"${resume}" should re-ask the pending question, got: ${turn.nextMessage.body}`);
    assert.ok(!/did not follow|not following/i.test(turn.nextMessage.body),
      `"${resume}" must not count as a failure to understand`);
  }
});

scenario("Ready then Let's start resumes once without becoming service feedback", () => {
  const deferred = {
    ...newSession(),
    conversationState: {
      state: STATES.WAITING_FOR_SERVICE_FEEDBACK,
      sessionType: "pulse",
      mentionedServices: {
        account: {
          serviceKey: "account",
          serviceName: "Account Management",
          sentiment: "neutral",
          reasonText: null,
          reasonTags: [],
          rating: null,
          status: "needs_feedback",
          detailAsked: true,
          detailAnswered: false,
          followUpAsked: false,
          probeCount: 1
        }
      },
      pendingServiceKey: "account",
      pendingQuestionType: "service",
      pendingNegativeServices: [],
      readyForOverallRating: false,
      appreciationAnswered: false,
      anythingElseAnswered: false,
      overallRating: null,
      npsScore: null,
      turnCount: 2,
      repeatCount: 0,
      guardrailHits: [],
      deferredAt: new Date().toISOString()
    }
  };

  const ready = processWhatsAppReply({
    session: deferred,
    project,
    poc,
    text: "Ready",
    interpretation: { intent: "affirmative", sentiment: "neutral", rating: null, serviceKeys: [] }
  });
  assert.match(ready.nextMessage.body, /How has Account Management been for you/i);
  assert.strictEqual(ready.conversationState.pendingQuestionType, "service");
  assert.strictEqual(ready.conversationState.mentionedServices.account.status, "needs_feedback");
  assert.strictEqual(ready.control.resumed, true);
  assert.strictEqual(ready.control.allowAiRephrase, false);

  const resumedSession = {
    ...deferred,
    conversationState: JSON.parse(JSON.stringify(ready.conversationState))
  };
  const start = processWhatsAppReply({
    session: resumedSession,
    project,
    poc,
    text: "Let’s start",
    interpretation: { intent: "affirmative", sentiment: "neutral", rating: null, serviceKeys: [] }
  });
  assert.strictEqual(start.control.suppressReply, true);
  assert.strictEqual(start.control.sendReply, false);
  assert.strictEqual(start.conversationState.pendingQuestionType, "service");
  assert.strictEqual(start.conversationState.mentionedServices.account.status, "needs_feedback");
  assert.strictEqual(start.conversationState.mentionedServices.account.reasonText, null);

  const realFeedback = processWhatsAppReply({
    session: resumedSession,
    project,
    poc,
    text: "Account Management has been good",
    interpretation: {
      intent: "feedback",
      sentiment: "positive",
      rating: null,
      serviceKeys: ["account"],
      explainsProblem: false
    }
  });
  assert.notStrictEqual(realFeedback.control.suppressReply, true);
  assert.strictEqual(realFeedback.conversationState.mentionedServices.account.sentiment, "positive");
  assert.notStrictEqual(realFeedback.conversationState.mentionedServices.account.status, "needs_feedback");
});

scenario("A short positive answer is feedback when a service question is pending", () => {
  for (const text of ["fine", "okay"]) {
    const waiting = {
      ...newSession(),
      conversationState: {
        state: STATES.WAITING_FOR_SERVICE_FEEDBACK,
        sessionType: "pulse",
        pendingQuestionType: "service",
        pendingServiceKey: "account",
        mentionedServices: {
          account: {
            serviceKey: "account",
            serviceName: "Account Management",
            status: "needs_feedback",
            sentiment: "neutral",
            reasonText: null,
            reasonTags: [],
            rating: null
          }
        },
        overallRating: null,
        npsScore: null,
        turnCount: 1,
        guardrailHits: []
      }
    };
    const turn = processWhatsAppReply({ session: waiting, project, poc, text, geminiUnavailable: true });
    assert.strictEqual(turn.conversationState.mentionedServices.account.sentiment, "positive", text);
    assert.notStrictEqual(turn.conversationState.mentionedServices.account.status, "needs_feedback", text);
  }
});

scenario("A short acknowledgement after a manual message does not become service feedback", () => {
  const waiting = {
    ...newSession(),
    conversationState: {
      state: STATES.WAITING_FOR_SERVICE_FEEDBACK,
      sessionType: "pulse",
      pendingQuestionType: "service",
      pendingServiceKey: "account",
      mentionedServices: {
        account: {
          serviceKey: "account",
          serviceName: "Account Management",
          status: "needs_feedback",
          sentiment: "neutral",
          reasonText: null,
          reasonTags: [],
          rating: null
        }
      },
      overallRating: null,
      npsScore: null,
      turnCount: 1,
      guardrailHits: []
    }
  };
  const turn = processWhatsAppReply({
    session: waiting,
    project,
    poc,
    text: "okay",
    interpretation: { intent: "affirmative", sentiment: "neutral", rating: null, serviceKeys: [] },
    manualContext: true
  });
  const account = turn.conversationState.mentionedServices.account;
  assert.strictEqual(account.sentiment, "neutral");
  assert.strictEqual(account.status, "needs_feedback");
  assert.match(turn.nextMessage.body, /Account Management/i);
});

scenario("An acknowledgement is never scored as feedback", () => {
  const { last } = run(newSession(), ["Okay I am ready now"]);
  assert.strictEqual(last.conversationState.readyForOverallRating, false,
    "'okay' must not be read as blanket praise and skip every service question");
  assert.strictEqual(last.conversationState.generalSentiment, null);
});

scenario("Deferring clears any earlier misunderstanding count", () => {
  let state = newSession();
  let turn = processWhatsAppReply({ session: state, project, poc, text: "qqq", geminiUnavailable: true });
  state = { ...state, conversationState: turn.conversationState };
  turn = processWhatsAppReply({
    session: state, project, poc, text: "I am busy now", geminiUnavailable: true
  });
  assert.strictEqual(turn.conversationState.repeatCount, 0,
    "a deferral is a clear answer and should reset the miss counter");
});

scenario("A handed-off session stays terminal and routes substantive follow-up", () => {
  const handedOff = {
    state: STATES.HANDED_OFF, mentionedServices: {}, turnCount: 9,
    guardrailHits: [], handoffReason: "turn_cap"
  };
  const turn = processWhatsAppReply({
    session: { ...newSession(), conversationState: handedOff },
    project, poc, text: "PPC leads have dropped badly", geminiUnavailable: true
  });
  assert.strictEqual(turn.conversationState.state, STATES.HANDED_OFF);
  assert.strictEqual(turn.conversationState.handoffReason, "turn_cap");
  assert.strictEqual(turn.control.skipAnalysisWrite, true);
  assert.strictEqual(turn.control.forceManagerAlert, true,
    "new complaint is routed without reopening the survey");
});

scenario("A completed session still says its feedback is recorded", () => {
  const done = { state: STATES.COMPLETED, mentionedServices: {}, overallRating: 8, turnCount: 6, guardrailHits: [] };
  const turn = processWhatsAppReply({
    session: { ...newSession(), conversationState: done },
    project, poc, text: "hello again", geminiUnavailable: true
  });
  assert.strictEqual(turn.conversationState.state, STATES.COMPLETED,
    "a genuinely completed session must not reopen");
});

scenario("A vague complaint is asked WHAT the issue is before anything else", () => {
  const { turns } = run(newSession(), ["Website has some issues"]);
  assert.ok(/what specifically should improve/i.test(turns[0].nextMessage.body),
    `naming a problem is not describing one: ${turns[0].nextMessage.body}`);
  assert.ok(!/anything else/i.test(turns[0].nextMessage.body),
    "must not skip to 'anything else?' before asking what the issue is");
});

scenario("The full service flow runs what -> acknowledge -> anything else -> rating", () => {
  const { turns } = run(newSession(), [
    "Website has some issues", "Website gets stuck or hangs", "no", "6"
  ]);
  assert.ok(/what specifically/i.test(turns[0].nextMessage.body), turns[0].nextMessage.body);
  assert.ok(/will look into this/i.test(turns[1].nextMessage.body),
    `the client should be told their point is being acted on: ${turns[1].nextMessage.body}`);
  assert.ok(/anything else/i.test(turns[1].nextMessage.body), turns[1].nextMessage.body);
  assert.ok(/rate our Website/i.test(turns[2].nextMessage.body), turns[2].nextMessage.body);
});

scenario("'Lets complete' resumes a deferred session", () => {
  let state = newSession();
  let turn = processWhatsAppReply({
    session: state, project, poc, text: "Not now, some other time", geminiUnavailable: true
  });
  state = { ...state, conversationState: turn.conversationState };
  turn = processWhatsAppReply({
    session: state, project, poc, text: "Lets complete", geminiUnavailable: true
  });
  assert.ok(!/not clear|did not follow/i.test(turn.nextMessage.body),
    `resuming must not read as a failure to understand: ${turn.nextMessage.body}`);
});

scenario("Saying you are unhappy is not the same as saying why", () => {
  const { turns } = run(newSession(), ["SEO service is not good"]);
  assert.ok(/what specifically should improve/i.test(turns[0].nextMessage.body),
    `"not good" is sentiment, not a reason: ${turns[0].nextMessage.body}`);
});

scenario("Sentiment words never count as reason detail", () => {
  for (const text of ["design is bad", "ppc is poor", "website is weak", "seo is average"]) {
    const { turns } = run(newSession(), [text]);
    assert.ok(/what specifically should improve/i.test(turns[0].nextMessage.body),
      `${text} skipped the reason question: ${turns[0].nextMessage.body}`);
  }
});

scenario("Gemini's service attribution beats the word lists", () => {
  // Vocabulary no synonym list covers. Without the override this is missed
  // entirely, however well the model understood it.
  const turn = processWhatsAppReply({
    session: newSession(), project, poc,
    text: "Our organic visibility has really dropped off",
    interpretation: {
      intent: "more_detail", sentiment: "negative", rating: null,
      serviceHint: "Website / SEO", serviceKeys: ["website"]
    }
  });
  assert.deepStrictEqual(Object.keys(turn.conversationState.mentionedServices), ["website"],
    "the model named the service; the machine must use it");
});

scenario("Gemini wins when it disagrees with a keyword match", () => {
  // "campaign" is a PPC weak synonym, but the client means Design.
  const turn = processWhatsAppReply({
    session: newSession(), project, poc,
    text: "the campaign creatives look repetitive",
    interpretation: {
      intent: "more_detail", sentiment: "negative", rating: null,
      serviceHint: "Design", serviceKeys: ["design"]
    }
  });
  assert.deepStrictEqual(Object.keys(turn.conversationState.mentionedServices), ["design"],
    "the model read the sentence; the word list matched a fragment");
});

scenario("Word lists still work when Gemini is unavailable", () => {
  const { last } = run(newSession(), ["SEO rankings have not moved"]);
  assert.ok(Object.keys(last.conversationState.mentionedServices).length,
    "an outage must not stop obvious cases being captured");
});

scenario("A client who explained the problem is not asked to explain it again", () => {
  const turn = processWhatsAppReply({
    session: newSession(), project, poc,
    text: "Our organic visibility has dropped off",
    interpretation: {
      intent: "more_detail", sentiment: "negative", rating: null,
      serviceKeys: ["website"], explainsProblem: true
    }
  });
  assert.ok(!/what specifically should improve/i.test(turn.nextMessage.body),
    `they already said what is wrong: ${turn.nextMessage.body}`);
  assert.ok(/anything else/i.test(turn.nextMessage.body), turn.nextMessage.body);
});

scenario("A client who only named the problem IS asked what it is", () => {
  const turn = processWhatsAppReply({
    session: newSession(), project, poc,
    text: "SEO is not good",
    interpretation: {
      intent: "more_detail", sentiment: "negative", rating: null,
      serviceKeys: ["website"], explainsProblem: false
    }
  });
  assert.ok(/what specifically should improve/i.test(turn.nextMessage.body),
    `naming a problem is not explaining it: ${turn.nextMessage.body}`);
});

scenario("Keywords still spot an explanation when Gemini is unavailable", () => {
  const { turns } = run(newSession(), ["website landing page is slow to load"]);
  assert.ok(/anything else/i.test(turns[0].nextMessage.body),
    `"slow" is a recognisable reason: ${turns[0].nextMessage.body}`);
});

scenario("An 'unclear' intent still yields its service and sentiment", () => {
  // Gemini can read the service correctly and still be unsure what KIND of
  // reply it is. Discarding the whole response over the intent field threw
  // away everything it understood.
  const turn = processWhatsAppReply({
    session: newSession(), project, poc,
    text: "Ppc team is not working well",
    interpretation: {
      intent: "unclear", sentiment: "negative", rating: null,
      serviceKeys: ["ppc"], explainsProblem: false
    }
  });
  assert.deepStrictEqual(Object.keys(turn.conversationState.mentionedServices), ["ppc"],
    "the service Gemini identified must still be captured");
  assert.ok(/what specifically should improve/i.test(turn.nextMessage.body),
    turn.nextMessage.body);
});

scenario("The bot commits to acting, without promising an outcome", () => {
  // A vague complaint first, so the flow is: name it -> asked what -> explain
  // -> acknowledged. "website is slow" already contains the reason and skips
  // the reason question entirely.
  const { turns } = run(newSession(), ["website has issues", "pages take ages to load"]);
  const ack = turns[1].nextMessage.body;
  assert.ok(/will look into|will work on/i.test(ack), `no commitment to act: ${ack}`);
  assert.ok(!/will (fix|resolve|sort|correct|complete)/i.test(ack),
    `promises an outcome a bot cannot guarantee: ${ack}`);
});

scenario("The client is thanked after a rating, and at the close", () => {
  const { turns } = run(newSession(), [
    "website has issues", "pages take ages to load", "no", "6", "no", "7", "no"
  ]);
  const afterServiceRating = turns[3].nextMessage.body;
  assert.ok(/^thank you/i.test(afterServiceRating),
    `giving a rating deserves a thank you: ${afterServiceRating}`);

  const closing = turns[turns.length - 1].nextMessage.body;
  assert.ok(/thank you/i.test(closing), `the closing should thank them: ${closing}`);

  // The questions in between do not need it.
  assert.ok(!/^thank you/i.test(turns[0].nextMessage.body), turns[0].nextMessage.body);
});

// ---- Guardrails -----------------------------------------------------
scenario("G2 opt-out stops everything", () => {
  const { last } = run(newSession(), ["STOP"]);
  assert.strictEqual(last.conversationState.state, STATES.OPTED_OUT);
  assert.strictEqual(last.control.stopReminders, true);
  assert.strictEqual(last.control.allowAiRephrase, false);
});

scenario("G3 post-completion complaint is answered honestly and notified", () => {
  const done = run(newSession(), ["all good", "9", "no", "9"]);
  assert.strictEqual(done.last.conversationState.state, STATES.CLOSING_GRACE);
  done.last.conversationState.closingGraceExpiresAt = new Date(Date.now() - 1000).toISOString();
  const after = processWhatsAppReply({
    session: { ...newSession(), conversationState: done.last.conversationState },
    project, poc,
    text: "Account management has issue"
  });
  assert.strictEqual(after.control.guardrail, GUARDRAILS.POST_COMPLETION);
  assert.strictEqual(after.control.skipAnalysisWrite, true, "must not rewrite a closed session");
  assert.strictEqual(after.control.notify, null);
  assert.strictEqual(after.control.forceManagerAlert, true,
    "a late complaint should use the single manager-alert path");
  assert.ok(/already closed/i.test(after.nextMessage.body), after.nextMessage.body);
  assert.ok(!/I have noted the issue/i.test(after.nextMessage.body));
  assert.strictEqual(after.control.allowAiRephrase, false, "Gemini must not improvise here");
});

scenario("A rating correction inside the 10-minute window replaces the earlier score", () => {
  const done = run(newSession(), ["all good", "9", "no", "0"]);
  assert.strictEqual(done.last.conversationState.state, STATES.CLOSING_GRACE);
  assert.strictEqual(done.last.conversationState.overallRating, 0);

  const clarification = processWhatsAppReply({
    session: { ...newSession(), conversationState: done.last.conversationState },
    project, poc, text: "Sorry, that was a mistake"
  });
  assert.strictEqual(clarification.conversationState.overallRating, 0);
  assert.ok(/currently have.*0 out of 10/i.test(clarification.nextMessage.body));
  assert.strictEqual(clarification.control.forceManagerAlert, undefined);

  const corrected = processWhatsAppReply({
    session: { ...newSession(), conversationState: clarification.conversationState },
    project, poc, text: "Take 8"
  });
  assert.strictEqual(corrected.conversationState.state, STATES.CLOSING_GRACE);
  assert.strictEqual(corrected.conversationState.overallRating, 8);
  assert.strictEqual(corrected.analysis.csatScore, 8);
  assert.ok(/updated.*8 out of 10/i.test(corrected.nextMessage.body));
  assert.strictEqual(corrected.control.forceManagerAlert, undefined);
  assert.strictEqual(corrected.control.suppressTerminalNotifications, true);
});

scenario("Rating corrections follow intended meaning across varied wording", () => {
  const done = run(newSession(), ["all good", "9", "no", "8"]);
  let state = done.last.conversationState;
  const corrections = [
    ["Revise the raiting to 10", 10],
    ["I meant nine point five", 9.5],
    ["change it from 9.5 to 7", 7],
    ["10 instead of 7", 10],
    ["set the score to 6", 6]
  ];
  for (const [text, expected] of corrections) {
    const reply = processWhatsAppReply({
      session: { ...newSession(), conversationState: state },
      project, poc, text
    });
    assert.strictEqual(reply.conversationState.overallRating, expected, text);
    assert.match(reply.nextMessage.body, new RegExp(`updated.*${String(expected).replace(".", "\\.")} out of 10`, "i"));
    state = reply.conversationState;
  }

  const unrelated = processWhatsAppReply({
    session: { ...newSession(), conversationState: state },
    project, poc, text: "I said the next review meeting is in 10 days"
  });
  assert.strictEqual(unrelated.conversationState.overallRating, 6,
    "an unrelated number must not become a correction");
});

scenario("An acknowledgement inside the correction window does not reopen the survey", () => {
  const done = run(newSession(), ["all good", "9", "no", "8"]);
  const reply = processWhatsAppReply({
    session: { ...newSession(), conversationState: done.last.conversationState },
    project, poc, text: "ok thanks"
  });
  assert.strictEqual(reply.conversationState.state, STATES.CLOSING_GRACE);
  assert.strictEqual(reply.conversationState.overallRating, 8);
  assert.ok(/recorded/i.test(reply.nextMessage.body));
  assert.strictEqual(reply.control.suppressTerminalNotifications, true);
});

scenario("A client question inside the correction window is routed without restarting the survey", () => {
  const done = run(newSession(), ["all good", "9", "no", "8"]);
  const reply = processWhatsAppReply({
    session: { ...newSession(), conversationState: done.last.conversationState },
    project, poc,
    text: "Who from the SRV team will contact me?",
    interpretation: { intent: "off_topic", serviceKeys: [], sentiment: "neutral" }
  });
  assert.strictEqual(reply.conversationState.state, STATES.CLOSING_GRACE);
  assert.strictEqual(reply.conversationState.overallRating, 8);
  assert.strictEqual(reply.control.collectOffTopic, "Who from the SRV team will contact me?");
  assert.strictEqual(reply.control.offScript, "out_of_scope");
  assert.match(reply.nextMessage.body, /passed your question to the SRV team/i);
  assert.ok(!/how has|rate .*out of 10|department.*appreciate/i.test(reply.nextMessage.body),
    "the survey must not restart after a closing-window question");
});

scenario("A closing-window add-on preserves completed survey markers and does not map social media to PPC", () => {
  const done = run(newSession(), ["all good", "9", "no", "8"]);
  const expiry = done.last.conversationState.closingGraceExpiresAt;
  const appreciationAnswered = done.last.conversationState.appreciationAnswered;
  const anythingElseAnswered = done.last.conversationState.anythingElseAnswered;
  const text = "Social media is working well. And we would appreciate a meeting with your senior management if possible.";
  assert.deepStrictEqual(detectors.detectServices(text, project), [],
    "the bare word media inside social media must not reopen PPC");

  const reply = processWhatsAppReply({
    session: { ...newSession(), conversationState: done.last.conversationState },
    project, poc, text,
    interpretation: { intent: "feedback", isObservation: true, serviceKeys: [], sentiment: "positive" }
  });
  assert.strictEqual(reply.conversationState.overallRating, 8);
  assert.strictEqual(reply.conversationState.appreciationAnswered, appreciationAnswered);
  assert.strictEqual(reply.conversationState.anythingElseAnswered, anythingElseAnswered);
  assert.strictEqual(reply.conversationState.closingGraceExpiresAt, expiry,
    "an add-on must not restart the original 10-minute timer");
});

scenario("G4 identity question introduces the sender; explicit wrong number hands off", () => {
  const identity = run(newSession(), ["who is this?"]).last;
  assert.notStrictEqual(identity.conversationState.state, STATES.HANDED_OFF);
  assert.ok(/SRV Media MD Office feedback line/i.test(identity.nextMessage.body));
  assert.strictEqual(identity.control.notify, undefined);

  const wrong = run(newSession(), ["You have the wrong number"]).last;
  assert.strictEqual(wrong.conversationState.state, STATES.HANDED_OFF);
  assert.strictEqual(wrong.conversationState.handoffReason, "wrong_person");
  assert.strictEqual(wrong.control.notify, "wrong_person");
});

scenario("G5 probe cap: a service is never asked for detail more than twice", () => {
  const { turns } = run(newSession(), [
    "design is bad", "hmm", "hmm", "hmm", "hmm"
  ]);
  const probes = turns.filter((t) => /What specifically should improve/i.test(t.nextMessage.body)).length;
  assert.ok(probes <= 2, `asked detail ${probes} times`);
});

scenario("G6 client question is deferred, not answered, then flow resumes", () => {
  const { last } = run(newSession(), ["when will the invoice be shared?"]);
  assert.strictEqual(last.control.guardrail, GUARDRAILS.OUT_OF_SCOPE);
  // Collected now, emailed once at session end rather than interrupting a
  // manager for every off-topic question.
  assert.strictEqual(last.control.collectOffTopic, "when will the invoice be shared?");
  assert.ok(!last.control.notify, "must not notify mid-conversation");
  assert.ok(/passed that to the SRV team/i.test(last.nextMessage.body));
  assert.ok(/working well|what is working/i.test(last.nextMessage.body), "must still ask the pending question");
});

scenario("Billing feedback reaches Gemini as an observation when available", () => {
  const text = "Your billings are inaccurate, please check the tax invoice";
  const session = newSession();
  const first = processWhatsAppReply({
    session, project, poc, text, geminiUnavailable: false
  });
  assert.ok(!first.control.offScript,
    "business feedback must not be intercepted by the out-of-scope guardrail");

  const interpreted = processWhatsAppReply({
    session: newSession(), project, poc, text, geminiUnavailable: false,
    interpretation: {
      intent: "feedback", sentiment: "negative", rating: null,
      serviceKeys: ["account"], explainsProblem: true, isObservation: true
    }
  });
  assert.ok(!interpreted.control.offScript);
  assert.strictEqual(Object.keys(interpreted.conversationState.mentionedServices).length, 0,
    "billing must not be forced into whichever service happened to be pending");
  assert.strictEqual(interpreted.control.allowAiRephrase, true);
});

scenario("G7 escalation alerts immediately and hands off", () => {
  const { last } = run(newSession(), ["This is unacceptable, we are cancelling the contract"]);
  assert.strictEqual(last.conversationState.state, STATES.HANDED_OFF);
  assert.strictEqual(last.control.forceManagerAlert, true);
  assert.strictEqual(last.analysis.riskLevel, "High");
  assert.strictEqual(last.analysis.requiresManagerAlert, true);
});

scenario("G8 out-of-scale rating is corrected once, then accepted", () => {
  const { turns } = run(newSession(), ["ppc is bad", "leads dropped", "no", "45"]);
  const warn = turns[3];
  assert.strictEqual(warn.control.guardrail, GUARDRAILS.INVALID_RATING);
  assert.ok(/0 to 10/.test(warn.nextMessage.body), warn.nextMessage.body);
});

scenario("G8 repeated invalid ratings are never clamped or stored", () => {
  const state = {
    state: STATES.WAITING_FOR_OVERALL_RATING,
    pendingQuestionType: "overall_rating",
    overallRatingAsked: true,
    mentionedServices: {},
    turnCount: 4
  };
  const first = processWhatsAppReply({
    session: { ...newSession(), conversationState: state }, project, poc,
    text: "45", geminiUnavailable: true
  });
  const second = processWhatsAppReply({
    session: { ...newSession(), conversationState: first.conversationState }, project, poc,
    text: "99", geminiUnavailable: true
  });
  assert.strictEqual(second.control.guardrail, GUARDRAILS.INVALID_RATING);
  assert.strictEqual(second.conversationState.overallRating, null);
  assert.strictEqual(second.conversationState.state, STATES.WAITING_FOR_OVERALL_RATING);
});

scenario("G8b '4/5' is converted up to the 0-10 scale", () => {
  const { turns } = run(newSession(), ["ppc is bad", "leads dropped", "no", "4/5"]);
  const services = turns[3].conversationState.mentionedServices;
  assert.strictEqual(services.ppc.rating, 8, JSON.stringify(services.ppc));
});

scenario("Score is exactly the stated number, with no penalty applied", () => {
  const { last } = run(newSession(), [
    "website is slow and design is repetitive",
    "pages take weeks",
    "no",
    "no",
    "7"
  ]);
  assert.strictEqual(last.analysis.csatScore, 7,
    `unresolved complaints must not alter the stated score, got ${last.analysis.csatScore}`);
});

scenario("Risk thresholds sit on the 0-10 scale", () => {
  const low = run(newSession(), ["all fine", "4"]);
  assert.strictEqual(low.last.analysis.riskLevel, "High", "below 5 is high risk");
  const watch = run(newSession(), ["all fine", "6"]);
  assert.strictEqual(watch.last.analysis.riskLevel, "Watch", "below 7 is watch");
  const good = run(newSession(), ["all fine", "9"]);
  assert.strictEqual(good.last.analysis.riskLevel, "Low");
});

scenario("G9 a bare number outside a rating question is not scored", () => {
  const { last } = run(newSession(), ["my number is 3"]);
  assert.strictEqual(last.analysis.csatScore, null, "no rating was asked for");
});

scenario("G9 outage fallback never scores a number during follow-up or final sweep", () => {
  const followup = processWhatsAppReply({
    session: {
      ...newSession(),
      conversationState: {
        state: STATES.WAITING_FOR_SERVICE_FOLLOWUP,
        pendingQuestionType: "service_followup",
        pendingServiceKey: "ppc",
        mentionedServices: {
          ppc: {
            serviceKey: "ppc", serviceName: "PPC / Media", sentiment: "negative",
            status: "needs_service_followup", reasonText: "Leads are poor",
            detailAnswered: true, serviceFollowUpAskCount: 1
          }
        }
      }
    },
    project, poc, text: "5", geminiUnavailable: true
  });
  assert.strictEqual(followup.control.guardrail, GUARDRAILS.BARE_NUMBER);
  assert.strictEqual(followup.conversationState.mentionedServices.ppc.rating, null);

  const sweep = processWhatsAppReply({
    session: {
      ...newSession(),
      conversationState: {
        state: STATES.WAITING_FOR_MORE_SERVICES,
        pendingQuestionType: "final_sweep",
        askedForAnythingElse: true,
        mentionedServices: {}
      }
    },
    project, poc, text: "5", geminiUnavailable: true
  });
  assert.strictEqual(sweep.control.guardrail, GUARDRAILS.BARE_NUMBER);
  assert.strictEqual(sweep.conversationState.overallRating, null);
  assert.notStrictEqual(sweep.conversationState.state, STATES.COMPLETED);
});

scenario("G5 turn cap never discards a requested valid score", () => {
  const mentionedServices = Object.fromEntries(project.services.map((service) => [
    service.serviceKey,
    { serviceKey: service.serviceKey, serviceName: service.name, status: "captured", sentiment: "neutral" }
  ]));
  const turn = processWhatsAppReply({
    session: {
      ...newSession(),
      conversationState: {
        state: STATES.WAITING_FOR_OVERALL_RATING,
        pendingQuestionType: "overall_rating",
        overallRatingAsked: true,
        askedForAppreciation: true,
        appreciationAnswered: true,
        askedForAnythingElse: true,
        anythingElseAnswered: true,
        turnCount: 25,
        mentionedServices
      }
    },
    project, poc, text: "7", geminiUnavailable: true
  });
  assert.strictEqual(turn.conversationState.overallRating, 7);
  assert.strictEqual(turn.conversationState.state, STATES.CLOSING_GRACE);
  assert.notStrictEqual(turn.control.guardrail, GUARDRAILS.PROBE_CAP);
});

scenario("G5 production checklist stops re-asking a declined service", () => {
  for (const status of ["needs_reason", "needs_service_followup"]) {
    const service = {
      serviceKey: "ppc", serviceName: "PPC / Media", sentiment: "negative", status,
      issueReasonAskCount: MAX_PROBES_PER_SERVICE,
      serviceFollowUpAskCount: MAX_PROBES_PER_SERVICE
    };
    const state = { mentionedServices: { ppc: service } };
    const checklist = buildChecklist(state, project);
    assert.strictEqual(service.status, "captured", `${status} was not settled`);
    assert.strictEqual(service.probeLimitReached, true);
    assert.ok(!checklist.servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys.length);
    assert.ok(!checklist.servicesWaitingForAnythingElseAnswer.length);
  }
});

scenario("A new substantive point resets the service follow-up allowance", () => {
  const service = {
    serviceKey: "ppc", serviceName: "PPC / Media", sentiment: "negative",
    status: "needs_service_followup", reasonText: "Lead volume is low",
    points: ["Lead volume is low"], serviceFollowUpAskCount: MAX_PROBES_PER_SERVICE
  };
  const state = { mentionedServices: { ppc: service } };
  applyCaptured(state, project, [{
    serviceKey: "ppc", sentiment: "negative",
    summary: "Lead quality is also poor", needsFollowUp: false
  }]);
  assert.strictEqual(service.serviceFollowUpAskCount, 0);
  assert.strictEqual(service.status, "needs_service_followup");
});

scenario("G6 service complaints phrased as questions remain feedback", () => {
  for (const text of [
    "Why are my PPC leads so poor?",
    "Can you improve the SEO rankings?",
    "Why is the website so slow?"
  ]) {
    const turn = processWhatsAppReply({ session: newSession(), project, poc, text, geminiUnavailable: true });
    assert.notStrictEqual(turn.control.guardrail, GUARDRAILS.OUT_OF_SCOPE, text);
    assert.ok(Object.keys(turn.conversationState.mentionedServices).length, text);
  }
});

scenario("G2 contextual stop and G10 metric acronyms are not false positives", () => {
  const stopCampaign = processWhatsAppReply({
    session: newSession(), project, poc,
    text: "Please stop the PPC campaigns", geminiUnavailable: true
  });
  assert.notStrictEqual(stopCampaign.conversationState.state, STATES.OPTED_OUT);

  const metrics = processWhatsAppReply({
    session: newSession(), project, poc, text: "PPC CPL CTR", geminiUnavailable: true
  });
  assert.notStrictEqual(metrics.control.guardrail, GUARDRAILS.UNPARSEABLE);
  assert.notStrictEqual(metrics.conversationState.state, STATES.HANDED_OFF);
});

scenario("Useful same-service details never accumulate G10 misses", () => {
  let session = {
    ...newSession(),
    conversationState: {
      state: STATES.WAITING_FOR_SERVICE_FOLLOWUP,
      pendingServiceKey: "ppc",
      mentionedServices: {
        ppc: {
          serviceKey: "ppc", serviceName: "PPC / Media", sentiment: "negative",
          status: "needs_service_followup", reasonText: "Lead volume is low",
          detailAnswered: true
        }
      }
    }
  };
  for (const text of [
    "The CPL has doubled",
    "Lead quality is poor too",
    "Reporting also arrives late",
    "The campaign targeting needs improvement"
  ]) {
    const turn = processWhatsAppReply({
      session, project, poc, text,
      interpretation: {
        intent: "feedback", sentiment: "negative", rating: null,
        serviceKeys: ["ppc"], explainsProblem: true
      }
    });
    assert.notStrictEqual(turn.conversationState.state, STATES.HANDED_OFF, text);
    assert.strictEqual(turn.conversationState.repeatCount, 0, text);
    session = { ...session, conversationState: turn.conversationState };
  }
});

scenario("Terminal acknowledgements and numbers do not trigger another handoff", () => {
  for (const text of ["ok", "5"]) {
    const turn = processWhatsAppReply({
      session: {
        ...newSession(),
        conversationState: {
          state: STATES.HANDED_OFF,
          handoffReason: "not_understood",
          mentionedServices: {}
        }
      },
      project, poc, text, geminiUnavailable: true
    });
    assert.strictEqual(turn.conversationState.state, STATES.HANDED_OFF);
    assert.strictEqual(turn.control.notify, null);
    assert.strictEqual(turn.control.suppressTerminalNotifications, true);
  }
});

scenario("A serious post-completion message reaches G7", () => {
  const turn = processWhatsAppReply({
    session: {
      ...newSession(),
      conversationState: { state: STATES.COMPLETED, mentionedServices: {}, overallRating: 7 }
    },
    project, poc, text: "This is unacceptable, our lawyer will contact you"
  });
  assert.strictEqual(turn.control.guardrail, GUARDRAILS.ESCALATION);
  assert.strictEqual(turn.control.forceManagerAlert, true);
  assert.strictEqual(turn.control.skipAnalysisWrite, true);
});

scenario("G10 gibberish re-asks once then hands off", () => {
  const { turns } = run(newSession(), ["xkcdgrtz", "qwrtzplk"]);
  assert.strictEqual(turns[0].control.guardrail, GUARDRAILS.UNPARSEABLE);
  assert.ok(/did not follow/i.test(turns[0].nextMessage.body));
  assert.strictEqual(turns[1].conversationState.state, STATES.HANDED_OFF);
});

scenario("A valid overall score cannot trigger G10 from a stale closing message", () => {
  const closingMessage = "That is everything — thank you for your time. Our team has your feedback and will take it forward with the right people.";
  for (const score of [7, 0]) {
    const mentionedServices = Object.fromEntries(project.services.map((service) => [
      service.serviceKey,
      {
        serviceKey: service.serviceKey,
        serviceName: service.name,
        sentiment: "neutral",
        status: "captured",
        detailAnswered: true,
        serviceFollowUpAnswered: true
      }
    ]));
    const turn = processWhatsAppReply({
      session: {
        ...newSession(),
        conversationState: {
          state: STATES.WAITING_FOR_OVERALL_RATING,
          pendingQuestionType: "overall_rating",
          overallRating: null,
          overallRatingAsked: true,
          readyForOverallRating: true,
          askedForAppreciation: true,
          appreciationAnswered: true,
          askedForAnythingElse: true,
          anythingElseAnswered: true,
          mentionedServices,
          repeatCount: 2,
          lastQuestionAsked: closingMessage
        }
      },
      project, poc, text: String(score), geminiUnavailable: false
    });
    assert.strictEqual(turn.conversationState.overallRating, score);
    assert.strictEqual(turn.conversationState.state, STATES.CLOSING_GRACE);
    assert.notStrictEqual(turn.control.guardrail, GUARDRAILS.UNPARSEABLE);
    assert.strictEqual(turn.control.notUnderstood, false);
    assert.strictEqual(turn.control.handoff, undefined);
    assert.strictEqual(turn.control.notify, undefined);
  }
});

scenario("An understood one-more-issue reply never triggers the gibberish handoff", () => {
  const baseState = {
    state: STATES.WAITING_FOR_SERVICE_FOLLOWUP,
    pendingServiceKey: "design",
    mentionedServices: {
      design: {
        serviceKey: "design", serviceName: "Design", sentiment: "negative",
        status: "needs_service_followup", reasonText: "The work looks dated",
        detailAnswered: true, followUpAsked: true
      }
    }
  };
  const interpretation = {
    intent: "more_detail", sentiment: "neutral", rating: null,
    serviceKeys: [], explainsProblem: false
  };
  const preview = processWhatsAppReply({
    session: { ...newSession(), conversationState: baseState }, project, poc,
    text: "There is one more issue", interpretation
  });
  const repeatedState = {
    ...baseState, repeatCount: 2,
    lastQuestionAsked: preview.nextMessage.body
  };
  const beforeGemini = processWhatsAppReply({
    session: { ...newSession(), conversationState: repeatedState },
    project, poc, text: "There is one more issue", geminiUnavailable: false
  });
  assert.notStrictEqual(beforeGemini.conversationState.state, STATES.HANDED_OFF,
    "the first pass must reach Gemini instead of handing off early");
  assert.strictEqual(beforeGemini.needsInterpretation, true);
  const turn = processWhatsAppReply({
    session: {
      ...newSession(),
      conversationState: repeatedState
    },
    project, poc, text: "There is one more issue", interpretation
  });
  assert.notStrictEqual(turn.conversationState.state, STATES.HANDED_OFF,
    "Gemini understood the request, so a repeated legacy question is not a miss");
  assert.strictEqual(turn.conversationState.repeatCount, 0);
  assert.strictEqual(turn.control.allowAiRephrase, true);
});

scenario("Switching services does not attach the new complaint to the old service", () => {
  const originalReason = "The designs look dated";
  const turn = processWhatsAppReply({
    session: {
      ...newSession(),
      conversationState: {
        state: STATES.WAITING_FOR_SERVICE_FOLLOWUP,
        pendingServiceKey: "design",
        mentionedServices: {
          design: {
            serviceKey: "design", serviceName: "Design", sentiment: "negative",
            status: "needs_service_followup", reasonText: originalReason,
            detailAnswered: true, followUpAsked: true
          }
        }
      }
    },
    project, poc, text: "PPC leads are not coming",
    interpretation: {
      intent: "feedback", sentiment: "negative", rating: null,
      serviceKeys: ["ppc"], explainsProblem: true
    }
  });
  const design = turn.conversationState.mentionedServices.design;
  assert.strictEqual(design.status, "captured",
    "raising PPC feedback means the client has naturally moved on from Design");
  assert.strictEqual(design.reasonText, originalReason,
    "PPC feedback must not be appended to Design notes");
});

scenario("G11 'Hello' creates no service, no score, no alert", () => {
  const { last } = run(newSession(), ["Hello"]);
  assert.deepStrictEqual(Object.keys(last.conversationState.mentionedServices), []);
  assert.strictEqual(last.analysis.csatScore, null);
  assert.strictEqual(last.analysis.requiresManagerAlert, false);
  assert.strictEqual(last.analysis.services.length, 0, "no service rows -> store creates no issue");
});

// ---- Issue readiness ---
scenario("Vague complaint alone does NOT open an issue", () => {
  const { last } = run(newSession(), ["Account Management needs improvement"]);
  const ready = last.analysis.services.filter((s) => s.issueReady);
  assert.strictEqual(ready.length, 0, JSON.stringify(last.analysis.services));
});

scenario("Vague complaint plus a vague follow-up still opens no issue", () => {
  const { last } = run(newSession(), ["Account Management needs improvement", "not sure", "no", "7"]);
  const ready = last.analysis.services.filter((s) => s.issueReady);
  assert.strictEqual(ready.length, 0, JSON.stringify(last.analysis.services));
});

scenario("Complaint with a real reason opens an issue once the service is settled", () => {
  const { turns } = run(newSession(), [
    "Account Management needs improvement",
    "they take three days to respond and we get no updates",
    "no",
    "2"
  ]);
  assert.strictEqual(turns[1].analysis.services.filter((s) => s.issueReady).length, 0,
    "not settled yet - no rating and not terminal");
  const ready = turns[3].analysis.services.filter((s) => s.issueReady);
  assert.strictEqual(ready.length, 1, JSON.stringify(turns[2].analysis.services));
  assert.strictEqual(ready[0].detailAnswered, true);
});

scenario("A low rating (<=4) opens an issue even without prose detail", () => {
  const { last } = run(newSession(), ["design is bad", "not sure", "2"]);
  const ready = last.analysis.services.filter((s) => s.issueReady);
  assert.strictEqual(ready.length, 1, JSON.stringify(last.analysis.services));
});

scenario("Reason given in the opening message counts as detail", () => {
  const { last } = run(newSession(), ["website changes are slow", "no", "6"]);
  const ready = last.analysis.services.filter((s) => s.issueReady);
  assert.strictEqual(ready.length, 1, JSON.stringify(last.analysis.services));
});

// ---- Scoring --------------------------------------------------------
scenario("Scoring: no rating anywhere -> null score, not a fabricated 7", () => {
  const { last } = run(newSession(), ["website is slow"]);
  assert.strictEqual(last.analysis.csatScore, null);
  assert.strictEqual(last.analysis.riskLevel, "High", "negative with a reason is still High risk");
});



scenario("Escalation opens an issue immediately, without waiting to settle", () => {
  const { last } = run(newSession(), ["ppc is useless, cost per lead has doubled, we are cancelling the contract"]);
  const ready = last.analysis.services.filter((s) => s.issueReady);
  assert.ok(ready.length >= 1, JSON.stringify(last.analysis.services));
  assert.strictEqual(last.analysis.requiresManagerAlert, true);
});

let failed = 0;
for (const [status, name, message] of results) {
  if (status === "FAIL") failed += 1;
  console.log(`${status}  ${name}${message ? `\n      ${message}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);

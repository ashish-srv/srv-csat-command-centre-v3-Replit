/**
 * Conversation sweep.
 *
 * The scenario suite proves specific conversations work. This proves that whole
 * CLASSES of reply cannot go wrong, by running a large corpus of realistic
 * client messages through every conversation state and asserting invariants
 * that must hold no matter what was said.
 *
 * It exists because bug-fixing one reported message at a time was not
 * converging: "am" matched "I am busy", "ok" matched "Okay I am ready", "two"
 * matched "two weeks". Each was found by a person reading a real transcript.
 * This finds them first.
 */
const { processWhatsAppReply } = require("../src/lib/whatsapp-state-machine");

const project = {
  id: "prj_1",
  key: "acme",
  name: "Acme Admissions",
  services: [
    { serviceKey: "account", name: "Account Management" },
    { serviceKey: "design", name: "Design" },
    { serviceKey: "ppc", name: "PPC / Media" },
    { serviceKey: "seo", name: "SEO" },
    { serviceKey: "website", name: "Website" }
  ]
};
const poc = { id: "poc_1", name: "Ashish Kate", salutation: "Ashish sir", weight: 2 };

// Both cycle types run through the SAME state machine — only three questions
// differ. The sweep runs everything twice so a fix for one never silently
// misses the other.
let sessionType = "pulse";

function session(conversationState = {}) {
  return {
    id: "sess_1", projectId: "prj_1", clientPocId: "poc_1",
    sessionType, conversationState
  };
}

function reply(text, conversationState, interpretation = null, geminiUnavailable = true) {
  return processWhatsAppReply({
    session: session(JSON.parse(JSON.stringify(conversationState))),
    project, poc, text, interpretation, geminiUnavailable
  });
}

/** Reach a given state by walking a real conversation, not by hand-building it. */
function stateAfter(texts) {
  let conversationState = {};
  for (const text of texts) {
    conversationState = reply(text, conversationState).conversationState;
  }
  return conversationState;
}

const STARTING_POINTS = {
  open_feedback: {},
  issue_reason: stateAfter(["account management has issues"]),
  service_followup: stateAfter(["account management has issues", "they are slow to respond"]),
  service_rating: stateAfter(["account management has issues", "they are slow to respond", "no"]),
  more_services: stateAfter(["account management has issues", "they are slow to respond", "no", "4"]),
  overall_rating: stateAfter(["account management has issues", "they are slow to respond", "no", "4", "no"])
};

// ---------------------------------------------------------------------
// The corpus: what people actually type into WhatsApp.
// ---------------------------------------------------------------------

const ACKNOWLEDGEMENTS = [
  "ok", "okay", "Okay", "OK", "sure", "alright", "right", "fine", "got it",
  "understood", "thanks", "thank you", "ty", "noted", "yes", "yeah", "yep",
  "okay I am ready now", "I am ready now", "ready", "I'm ready", "we are ready",
  "ok let's start", "sure go ahead", "yes please", "hmm ok", "k", "okie"
];

const DEFERRALS = [
  "I will give feedback later", "I am busy now", "not now", "later please",
  "can I do this later", "I will revert", "will get back to you", "no time now",
  "I dont want to give feedback now", "I will not give feedback now",
  "busy in a meeting", "tomorrow", "next week", "will share later",
  "I am travelling right now", "give me some time"
];

const NOT_FEEDBACK = [
  "hi", "hello", "hey", "good morning", "namaste", "who is this?",
  "how are you", "😊", "👍", "...", "?", "test", "hello?", "are you a bot",
  "I am not sure what you mean", "what is this about"
];

/**
 * Ordinary sentences containing words that appear in the synonym or sentiment
 * lists. None of these is feedback about a service.
 */
const FALSE_FRIENDS = [
  "I am fine", "I am busy", "we are all good here", "that is a good idea",
  "it takes two weeks usually", "give me a second", "I have a form to fill",
  "my page is loading", "let me search my email", "I saw your ad on TV",
  "post this to my team", "I will copy my colleague", "the media is here",
  "I am on leave", "no idea",
  "please call me on my landline", "one moment", "three of my staff asked"
];

const REAL_FEEDBACK = [
  "SEO is not working well", "design quality has dropped",
  "PPC budget utilisation is poor", "website landing page is slow",
  "account management is not responsive", "reports are always late",
  "creatives are repetitive", "keyword rankings have not moved"
];

const RATINGS = ["8", "0", "10", "6.5", "8/10", "4/5", "seven", "I'd say 7"];

const OUT_OF_RANGE = ["100", "50", "-3", "999", "11"];

let failures = 0;
const seen = new Set();

function fail(group, text, state, message) {
  const key = `${group}|${text}|${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  failures += 1;
  console.log(`FAIL  [${group}] in ${state}`);
  console.log(`      "${text}" — ${message}`);
}

function servicesIn(conversationState) {
  return Object.keys(conversationState.mentionedServices || {});
}

// ---------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------

/** Nothing that is not feedback may create a service or a score. */
function assertCapturesNothing(group, corpus) {
  for (const [stateName, base] of Object.entries(STARTING_POINTS)) {
    const before = servicesIn(base);
    for (const text of corpus) {
      const turn = reply(text, base);
      const after = servicesIn(turn.conversationState);
      const added = after.filter((key) => !before.includes(key));
      if (added.length) {
        fail(group, text, stateName, `invented service(s): ${added.join(", ")}`);
      }
      if (!before.length && turn.analysis.csatScore !== null) {
        fail(group, text, stateName, `produced a score of ${turn.analysis.csatScore}`);
      }
      const sentimentBefore = base.generalSentiment || null;
      const sentimentAfter = turn.conversationState.generalSentiment || null;
      if (group === "acknowledgement" && sentimentAfter && sentimentAfter !== sentimentBefore) {
        fail(group, text, stateName,
          `scored as general sentiment "${sentimentAfter}"`);
      }
    }
  }
}

/** A service may only be captured if the client actually named it. */
function assertOnlyNamedServices() {
  const names = { account: /account|relationship|coordination|follow.?up|closure|escalation/i,
    design: /design|creative|visual|banner|artwork|layout/i,
    ppc: /ppc|paid|media|ads|campaign|lead|cpl|cpa/i,
    seo: /seo|search|ranking|organic|keyword|traffic|google/i,
    website: /web|site|landing|page|form/i };

  for (const [stateName, base] of Object.entries(STARTING_POINTS)) {
    const before = servicesIn(base);
    for (const text of [...FALSE_FRIENDS, ...ACKNOWLEDGEMENTS, ...NOT_FEEDBACK, ...REAL_FEEDBACK]) {
      const turn = reply(text, base);
      const added = servicesIn(turn.conversationState).filter((key) => !before.includes(key));
      for (const key of added) {
        if (names[key] && !names[key].test(text)) {
          fail("named-service", text, stateName, `captured "${key}" which the message never mentions`);
        }
      }
    }
  }
}

/** A turn must either move the conversation or admit it did not understand. */
function assertNeverStalls() {
  const corpus = [...ACKNOWLEDGEMENTS, ...NOT_FEEDBACK, ...FALSE_FRIENDS, ...REAL_FEEDBACK, ...RATINGS];
  for (const [stateName, base] of Object.entries(STARTING_POINTS)) {
    for (const text of corpus) {
      const first = reply(text, base);
      const second = reply(text, first.conversationState);
      const same = first.nextMessage.body === second.nextMessage.body;
      const admits = /did not follow|not sure I follow|not following/i.test(second.nextMessage.body);
      const acknowledges = /passed that to the SRV team|SRV Media MD Office feedback line/i
        .test(second.nextMessage.body);
      // A guardrail code alone is not evidence of success: false positives are
      // exactly what this sweep must catch. Only an observable terminal/action
      // outcome may exempt an otherwise identical reply.
      const settled = Boolean(second.control.deferred || second.control.handoff
        || second.control.resumed || second.control.optOut || second.control.identityQuestion);
      if (same && !admits && !acknowledges && !settled) {
        fail("stall", text, stateName, "the identical question was sent twice with no acknowledgement");
      }
    }
  }
}

/** A number in prose is not a rating; an out-of-range number is told the scale. */
function assertRatingSanity() {
  const prose = ["it takes two weeks", "three of my staff complained", "we have 5 campaigns running"];
  for (const text of prose) {
    const turn = reply(text, STARTING_POINTS.service_rating);
    const service = Object.values(turn.conversationState.mentionedServices)[0];
    if (service && service.rating !== null && service.rating !== undefined) {
      fail("rating-in-prose", text, "service_rating", `a number inside prose became a rating of ${service.rating}`);
    }
  }
  for (const text of OUT_OF_RANGE) {
    const first = reply(text, STARTING_POINTS.overall_rating);
    const turn = reply(text, first.conversationState);
    const said = /0 to 10|out of 10/i.test(turn.nextMessage.body);
    if (!said) {
      fail("out-of-range", text, "overall_rating", "the client was not told the scale");
    }
    if (turn.conversationState.overallRating !== null) {
      fail("out-of-range", text, "overall_rating",
        `a repeated invalid value was stored as ${turn.conversationState.overallRating}`);
    }
  }

  for (const stateName of ["open_feedback", "issue_reason", "service_followup", "more_services"]) {
    for (const text of ["0", "5", "10"]) {
      const turn = reply(text, STARTING_POINTS[stateName]);
      if (turn.conversationState.overallRating !== null
        && turn.conversationState.overallRating !== undefined) {
        fail("rating-stage", text, stateName,
          `accepted overall rating ${turn.conversationState.overallRating} before asking`);
      }
    }
  }
}

/** Guardrail keywords must describe intent, not merely appear in the text. */
function assertGuardrailPrecision() {
  const cases = [
    ["Please stop the PPC campaigns", "G2_opt_out"],
    ["Who is this?", "G4_wrong_person"],
    ["Why are my PPC leads so poor?", "G6_out_of_scope"],
    ["Can you improve the SEO rankings?", "G6_out_of_scope"],
    ["Why is the website so slow?", "G6_out_of_scope"],
    ["PPC CPL CTR", "G10_unparseable"]
  ];
  for (const [text, forbidden] of cases) {
    for (const [stateName, base] of Object.entries(STARTING_POINTS)) {
      const turn = reply(text, base);
      if (turn.control.guardrail === forbidden) {
        fail("guardrail-precision", text, stateName, `incorrectly fired ${forbidden}`);
      }
    }
  }
}

/** A captured complaint must never be replaced by something later and vaguer. */
function assertReasonsSurvive() {
  const base = STARTING_POINTS.service_followup;
  const original = Object.values(base.mentionedServices)[0].reasonText;
  for (const text of [...ACKNOWLEDGEMENTS, ...RATINGS, ...NOT_FEEDBACK, "6.5", "100"]) {
    const turn = reply(text, base);
    const service = Object.values(turn.conversationState.mentionedServices)[0];
    if (service && service.reasonText && original && !service.reasonText.includes(original)) {
      fail("reason-lost", text, "service_followup",
        `the captured complaint was replaced: "${original}" -> "${service.reasonText}"`);
    }
  }
}

/** Deferral and resumption must work from every state. */
function assertDeferAndResume() {
  for (const [stateName, base] of Object.entries(STARTING_POINTS)) {
    for (const text of DEFERRALS) {
      const turn = reply(text, base);
      if (!turn.control.deferred) {
        fail("defer", text, stateName, "was not recognised as asking to answer later");
        continue;
      }
      for (const back of ["I am ready now", "ok let's start", "yes can give feedback now"]) {
        const resumed = reply(back, turn.conversationState,
          { intent: "affirmative", sentiment: "neutral", rating: null, serviceHint: null });
        if (/did not follow|not following/i.test(resumed.nextMessage.body)) {
          fail("resume", back, stateName, "resuming after a deferral was treated as a failure to understand");
        }
        if (resumed.conversationState.readyForOverallRating && !base.readyForOverallRating) {
          fail("resume", back, stateName, "resuming skipped the client ahead to the overall rating");
        }
      }
    }
  }
}

// ---------------------------------------------------------------------

console.log("Sweeping conversation states against a corpus of real replies...\n");

for (const type of ["pulse", "project_end"]) {
  sessionType = type;
  assertCapturesNothing("acknowledgement", ACKNOWLEDGEMENTS);
  assertCapturesNothing("not-feedback", NOT_FEEDBACK);
  assertCapturesNothing("false-friend", FALSE_FRIENDS);
  assertOnlyNamedServices();
  assertNeverStalls();
  assertRatingSanity();
  assertGuardrailPrecision();
  assertReasonsSurvive();
  assertDeferAndResume();
}

const checked = (ACKNOWLEDGEMENTS.length + NOT_FEEDBACK.length + FALSE_FRIENDS.length
  + REAL_FEEDBACK.length + RATINGS.length + DEFERRALS.length)
  * Object.keys(STARTING_POINTS).length * 2;

if (failures) {
  console.log(`\n${failures} problem(s) across ~${checked} state/reply combinations.`);
  process.exit(1);
}
console.log(`No problems across ~${checked} state/reply combinations.`);

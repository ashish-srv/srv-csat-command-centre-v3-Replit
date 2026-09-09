const { id, statusFromScore } = require("./analysis");

// =====================================================================
// v2 WhatsApp state machine
//
// Contract change from v1: the machine now runs against a PROJECT and a
// single client POC (one session per POC per cycle), not a "client".
//
//   processWhatsAppReply({ session, project, poc, text })
//
// It returns { conversationState, analysis, nextMessage, control }.
// `control` tells the API layer what to do beyond storing the turn:
// whether Gemini may rephrase, whether to notify a human, and whether
// the session should stop receiving reminders.
// =====================================================================

const STATES = {
  WAITING_FOR_OPEN_FEEDBACK: "waiting_for_open_feedback",
  WAITING_FOR_SERVICE_SCOPE: "waiting_for_service_scope",
  WAITING_FOR_ISSUE_REASON: "waiting_for_issue_reason",
  WAITING_FOR_SERVICE_RATING: "waiting_for_service_rating",
  WAITING_FOR_SERVICE_FEEDBACK: "waiting_for_service_feedback",
  WAITING_FOR_SERVICE_FOLLOWUP: "waiting_for_service_followup",
  WAITING_FOR_MORE_SERVICES: "waiting_for_more_services",
  WAITING_FOR_OVERALL_RATING: "waiting_for_overall_rating",
  WAITING_FOR_NPS: "waiting_for_nps",
  CLOSING_GRACE: "closing_grace",
  COMPLETED: "completed",
  OPTED_OUT: "opted_out",
  HANDED_OFF: "handed_off"
};

// Guardrail codes. Every non-standard turn is tagged with one of these so
// it can be traced in message metadata and on the dashboard.
const GUARDRAILS = {
  DUPLICATE_INBOUND: "G1_duplicate_inbound", // enforced in api-handler
  OPT_OUT: "G2_opt_out",
  POST_COMPLETION: "G3_post_completion",
  WRONG_PERSON: "G4_wrong_person",
  PROBE_CAP: "G5_probe_cap",
  OUT_OF_SCOPE: "G6_out_of_scope",
  ESCALATION: "G7_escalation",
  INVALID_RATING: "G8_invalid_rating",
  BARE_NUMBER: "G9_bare_number",
  UNPARSEABLE: "G10_unparseable",
  NO_SIGNAL: "G11_no_signal"
};

const MAX_PROBES_PER_SERVICE = 2;
const MAX_TURNS_BEFORE_HANDOFF = 25;
const CLOSING_GRACE_MS = 10 * 60 * 1000;
const DEFERRAL_REPLY = "No problem at all — please take your time. Your feedback session is saved, so you will not need to start again. Simply reply here whenever convenient, and we will continue from where you stopped.";
const SERVICE_SCOPE_DECISIONS = {
  NONE: "none",
  OVERALL_FEEDBACK: "overall_feedback",
  CONTINUE_SERVICE_BY_SERVICE: "continue_service_by_service",
  SKIP_REMAINING_SERVICES: "skip_remaining_services"
};
const SERVICE_SCOPE_QUESTION = "Thank you for sharing that overall perspective. Would you like to continue through the services one by one? Reply yes to continue, or skip to leave the remaining service questions.";

function projectEndReviewQuestion(project) {
  const projectName = String(project?.name || "this project").trim();
  const subject = /^this project$/i.test(projectName) ? projectName : `the ${projectName} project`;
  return `Looking back over the entire duration of ${subject}, were there any issues, concerns, areas for improvement, or positive experiences that you would like the Directors to know about? Your feedback matters greatly to us.`;
}

/**
 * Words that name a service on their own. "seo", "ppc", "website" cannot
 * plausibly mean anything else in a client's reply.
 */
const STRONG_SYNONYMS = {
  account: [
    "account management", "account manager", "account team", "relationship manager",
    "client servicing", "client service", "client services"
  ],
  copy: ["copywriting", "copy team", "content team", "creative strategy"],
  design: ["design", "designer", "designers", "creatives", "artwork", "banner", "banners"],
  website: ["website", "web site", "landing page", "web page", "page speed", "web team"],
  seo: ["seo", "search engine", "keyword", "keywords", "rankings", "organic search"],
  ppc: ["ppc", "paid media", "google ads", "meta ads", "ad campaign", "campaigns", "cpl", "cpa"],
  video: ["video", "videos", "reel", "reels", "shoot", "testimonial", "testimonials"]
};

/**
 * Words that MIGHT name a service, but appear constantly in ordinary English.
 * "form", "page", "media", "account", "idea", "post", "copy", "search".
 *
 * These only count when the message also carries a feedback signal. Without
 * that guard: "I have a form to fill" became a Website complaint, "that is a
 * good idea" became Design, "the media is here" became PPC. Each one wrote a
 * complaint against a service the client never mentioned.
 */
const WEAK_SYNONYMS = {
  account: ["account", "coordination", "follow up", "follow-up", "responsiveness", "closure", "escalation"],
  copy: ["copy", "content", "caption", "captions", "messaging", "strategy", "ideas", "nuance"],
  design: ["creative", "visual", "visuals", "layout", "posts"],
  website: ["web", "site", "landing", "pages", "form", "forms"],
  seo: ["search", "ranking", "organic", "visibility", "traffic"],
  // Bare "media" is intentionally excluded. "Social media is working well"
  // is not PPC feedback; PPC remains detectable through strong phrases such as
  // paid media, Google/Meta ads, campaigns, CPL and CPA.
  ppc: ["ads", "campaign", "leads", "budget utilisation", "budget utilization"],
  video: ["production", "campus shots"]
};

/** The full vocabulary, for callers that just want every term. */
const SERVICE_SYNONYMS = Object.fromEntries(
  Object.keys(STRONG_SYNONYMS).map((key) => [
    key,
    [...(STRONG_SYNONYMS[key] || []), ...(WEAK_SYNONYMS[key] || [])]
  ])
);

const NEGATIVE_WORDS = [
  "bad", "poor", "weak", "not working", "not working well", "not good", "not happy",
  "unhappy", "slow", "delay", "delayed", "missing", "issue", "problem", "concern",
  "generic", "repetitive", "average", "not visible", "not discussed", "not improving",
  "needs improvement", "need improvement", "improve", "improvement", "lack", "lacking",
  "disappointed", "dissatisfied", "worse", "terrible", "nothing is working",
  "nothing works", "not at all happy", "not happy at all"
];

const POSITIVE_WORDS = [
  "good", "great", "excellent", "fine", "okay", "ok", "smooth", "happy", "satisfied",
  "responsive", "transparent", "stable", "clear", "helpful", "impressed", "appreciate"
];

const NEGATED_POSITIVE_PHRASES = [
  "not good", "not happy", "not satisfied", "not responsive", "not clear",
  "not helpful", "not okay", "not ok"
];

/**
 * A REASON describes what is wrong. It is not the same as saying you are
 * unhappy.
 *
 * "not good", "poor", "weak", "bad", "average" were in this list, so
 * "SEO service is not good" produced a reason tag — the machine believed it
 * already knew what the problem was and skipped straight to "anything else?",
 * never asking what was actually wrong. Those are sentiment words and belong
 * in NEGATIVE_WORDS only.
 */
const REASON_KEYWORDS = {
  speed: ["slow", "delay", "delayed", "takes time", "turnaround", "late", "not on time"],
  quality: ["generic", "repetitive", "inconsistent", "writing", "copywriting", "creatives", "design quality"],
  understanding: ["understanding", "nuance", "not relevant", "context", "programme", "program", "brand guidelines"],
  communication: ["update", "updates", "communication", "not discussed", "visibility", "report", "reports", "status"],
  results: ["result", "results", "ranking", "rankings", "lead", "leads", "cpl", "traffic", "conversion", "budget", "spend", "cost", "utilisation", "utilization"]
};

// ---------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------

function lower(text) {
  return String(text || "").toLowerCase();
}

function feedbackPointOverlap(left, right) {
  const tokens = (value) => new Set(
    lower(value).replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean)
  );
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return false;
  const shared = [...a].filter((token) => b.has(token)).length;
  return shared >= 3 && shared / Math.min(a.size, b.size) >= 0.65;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasPhrase(text, phrase) {
  const escaped = escapeRegex(phrase).replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function projectServices(project) {
  return (project && project.services) || [];
}

function serviceName(project, serviceKey) {
  const service = projectServices(project).find((item) => item.serviceKey === serviceKey);
  return (service && service.name) || serviceKey;
}

function serviceOwner(project, serviceKey) {
  const service = projectServices(project).find((item) => item.serviceKey === serviceKey);
  return {
    ownerName: (service && service.ownerName) || "Service Owner",
    ownerEmail: (service && service.ownerEmail) || null,
    managerName: (service && service.managerName) || null,
    managerEmail: (service && service.managerEmail) || null,
    internalPocId: (service && service.internalPocId) || null
  };
}

function activeServiceKeys(project) {
  const keys = projectServices(project).map((service) => service.serviceKey);
  return new Set(keys.length ? keys : Object.keys(SERVICE_SYNONYMS));
}

function conversationProgressSignature(conversationState) {
  return JSON.stringify({
    generalSentiment: conversationState.generalSentiment || null,
    generalConcernText: conversationState.generalConcernText || null,
    readyForOverallRating: Boolean(conversationState.readyForOverallRating),
    overallRating: conversationState.overallRating ?? null,
    npsScore: conversationState.npsScore ?? null,
    appreciationAnswered: Boolean(conversationState.appreciationAnswered),
    appreciationVolunteered: Boolean(conversationState.appreciationVolunteered),
    anythingElseAnswered: Boolean(conversationState.anythingElseAnswered),
    serviceScopeStatus: conversationState.serviceScopeStatus || null,
    services: Object.values(conversationState.mentionedServices || {}).map((service) => ({
      serviceKey: service.serviceKey,
      sentiment: service.sentiment,
      reasonText: service.reasonText || null,
      rating: service.rating ?? null,
      status: service.status,
      detailAnswered: Boolean(service.detailAnswered),
      serviceFollowUpAnswered: Boolean(service.serviceFollowUpAnswered)
    }))
  });
}

/**
 * Does this message carry a feedback signal at all — an opinion, a problem, a
 * request to improve? A weak synonym only names a service when it does.
 */
function carriesFeedbackSignal(text) {
  const value = lower(text);
  return NEGATIVE_WORDS.some((word) => value.includes(word))
    || POSITIVE_WORDS.some((word) => hasPhrase(value, word))
    || /\b(improve|improvement|issue|issues|problem|concern|not working|delay|delayed|slow|quality|late|missing|poor|better|worse)\b/i.test(value);
}

function detectServices(text, project, { specificOnly = false } = {}) {
  const value = lower(text);
  const active = activeServiceKeys(project);
  const hasSignal = carriesFeedbackSignal(text);
  const matches = [];
  const configuredMatches = [];

  // Services are configurable. Exact project service names must therefore be
  // recognised even when their generated key is not one of the legacy built-in
  // aliases (for example "Creatives" or a standalone "Landing Page"). Require
  // a feedback signal so an ordinary mention does not become a service review.
  if (hasSignal) {
    for (const configured of projectServices(project)) {
      const configuredName = lower(configured.name).trim();
      if (!configured.serviceKey || !configuredName || !hasPhrase(value, configuredName)) continue;
      const match = {
        serviceKey: configured.serviceKey,
        specificity: configuredName.length + 200,
        phrase: configuredName
      };
      configuredMatches.push(match);
      matches.push(match);
    }
  }

  for (const serviceKey of Object.keys(STRONG_SYNONYMS)) {
    const strong = (STRONG_SYNONYMS[serviceKey] || [])
      .filter((synonym) => hasPhrase(value, synonym))
      .sort((a, b) => b.length - a.length)[0];

    // A weak synonym names a service only inside an actual piece of feedback.
    const weak = hasSignal
      ? (WEAK_SYNONYMS[serviceKey] || [])
        .filter((synonym) => hasPhrase(value, synonym))
        .sort((a, b) => b.length - a.length)[0]
      : null;

    const hit = strong || weak;
    if (!hit) continue;

    let resolved = null;
    if (active.has(serviceKey)) resolved = serviceKey;
    else if (serviceKey === "seo" && active.has("website")) resolved = "website";
    else if (serviceKey === "copy" && active.has("design")) resolved = "design";
    // A strong match beats a weak one outright, whatever the word lengths.
    const shadowedByConfiguredService = resolved && configuredMatches.some((match) =>
      match.serviceKey !== resolved
      && (match.phrase === hit || match.phrase.includes(hit) || hit.includes(match.phrase))
    );
    if (resolved && !shadowedByConfiguredService) {
      matches.push({ serviceKey: resolved, specificity: hit.length + (strong ? 100 : 0) });
    }
  }

  if (!matches.length) return [];

  if (specificOnly) {
    const best = Math.max(...matches.map((m) => m.specificity));
    return [...new Set(matches.filter((m) => m.specificity === best).map((m) => m.serviceKey))];
  }
  return [...new Set(matches.map((m) => m.serviceKey))];
}

const WORD_NUMBERS = [
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10]
];

/**
 * Is this message an ANSWER to a rating question, rather than prose that
 * happens to contain a number? "8", "8/10", "I'd say 7" are answers.
 * "Pages take two weeks to go live" is not — and reading it as a 2 silently
 * corrupts the score, which is exactly what happened in live testing.
 */
function looksLikeRatingAnswer(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  const numberWord = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)";

  // A stated scale is unambiguous even when the score is written as a word.
  // The earlier implementation recognised "seven" in detectNumber(), but
  // this second guard only stripped digits. Consequently a perfectly clear
  // "so far I will give a seven out of 10" could be discarded.
  if (new RegExp(`\\b(?:\\d+(?:\\.\\d+)?|${numberWord})\\s*(?:\\/|out of)\\s*(?:5|10)\\b`, "i").test(value)) {
    return true;
  }

  if (
    new RegExp(`\\b(?:rating|score|rate|give|take|make that|i(?:'d| would| will|'ll)? say)\\b[^.!?]{0,30}\\b(?:\\d+(?:\\.\\d+)?|${numberWord})\\b`, "i").test(value)
    && !/\b(?:day|days|week|weeks|month|months|meeting|meetings|lead|leads|report|reports)\b/i.test(value)
  ) {
    return true;
  }

  // Strip the number and its scale, then see how much prose is left over.
  const withoutNumber = value
    .replace(/\d+(?:\.\d+)?\s*(?:\/|out of)\s*\d+/i, " ")
    .replace(/\d+(?:\.\d+)?/, " ")
    .replace(new RegExp(`\\b${numberWord}\\b`, "i"), " ")
    .replace(/\b(i(?:'| a)?d say|i would say|maybe|about|around|give|rate|it|is|a|the|out of|on)\b/gi, " ")
    .replace(/[^a-z]/gi, "");
  return withoutNumber.length <= 6;
}

/**
 * First standalone number in the text, with its scale if written as "8/10".
 * Deliberately does NOT clamp: out-of-range values go through G8 so the
 * client is told the scale instead of being silently rescored.
 */
function detectNumber(text) {
  const value = lower(text);
  const wordScale = value.match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:\/|out of)\s*(\d+)\b/i);
  if (wordScale) {
    const word = WORD_NUMBERS.find(([name]) => name === wordScale[1].toLowerCase());
    return { value: word[1], scale: Number(wordScale[2]) };
  }
  // Decimals and 3+ digit numbers must PARSE so they can be handled properly.
  // The old pattern capped at two digits and rejected a decimal point, so
  // "100" and "6.5" both looked like no number at all — the client was asked
  // the same question again with no explanation.
  const match = value.match(/(^|[^\d.])(-?\d+(?:\.\d+)?)(?:\s*(?:\/|out of)\s*(\d+))?(?:[^\d]|$)/);
  if (match) {
    // "-3" must reach the out-of-range handler, not be read as a 3.
    const raw = match[1].trim() === "-" || /-\s*$/.test(match[1]) ? `-${match[2].replace("-", "")}` : match[2];
    return { value: Number(raw), scale: match[3] ? Number(match[3]) : null };
  }
  const word = WORD_NUMBERS.find(([name]) => hasPhrase(value, name));
  return word ? { value: word[1], scale: null } : null;
}

function detectSentiment(text) {
  const value = lower(text);
  const negative = NEGATIVE_WORDS.filter((word) => value.includes(word)).length;
  const positive = POSITIVE_WORDS.filter((word) => {
    // Whole phrases only: "okayish" is a neutral, qualified assessment, not
    // the same as an unqualified "okay" or praise.
    if (!hasPhrase(value, word)) return false;
    return !NEGATED_POSITIVE_PHRASES.some((phrase) => phrase.includes(word) && value.includes(phrase));
  }).length;
  if (negative > positive) return "negative";
  if (positive > negative) return "positive";
  return "neutral";
}

function detectReasons(text) {
  const value = lower(text);
  return Object.entries(REASON_KEYWORDS)
    .filter(([, words]) => words.some((word) => value.includes(word)))
    .map(([reason]) => reason);
}

function splitClauses(text) {
  return String(text || "")
    .split(/\b(?:but|however|although|while|whereas|and also|also)\b|[.;\n]/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractServiceSignals(text, project) {
  const signals = [];
  for (const clause of splitClauses(text)) {
    const serviceKeys = detectServices(clause, project, { specificOnly: true });
    if (!serviceKeys.length) continue;
    const clauseSentiment = detectSentiment(clause);
    const clauseReasons = detectReasons(clause);
    serviceKeys.forEach((serviceKey) => {
      signals.push({ serviceKey, text: clause, sentiment: clauseSentiment, reasons: clauseReasons });
    });
  }
  if (signals.length) return signals;

  return detectServices(text, project).map((serviceKey) => ({
    serviceKey,
    text,
    sentiment: detectSentiment(text),
    reasons: detectReasons(text)
  }));
}

// ---------------------------------------------------------------------
// Guardrail detectors
// ---------------------------------------------------------------------

function isOptOut(text) {
  const value = String(text || "").trim();
  if (/\b(unsubscribe|opt ?out|do ?n'?t (?:message|contact|text) me|remove me|no more messages|leave me alone)\b/i.test(value)) {
    return true;
  }
  // Meta's canonical opt-out is a bare STOP. Do not treat an operational
  // request such as "stop the PPC campaigns" as consent withdrawal.
  return /^(?:please\s+)?stop(?:\s+(?:messaging|texting|contacting)\s+me|\s+(?:these|all)\s+messages)?[.!]*$/i.test(value);
}

function isWrongPerson(text) {
  return /\b(wrong number|galat number|you have the wrong (?:number|person)|(?:i am|i'm|this is) not (?:the )?right person|this isn'?t (?:the )?right person|i am not (?:the )?person you (?:want|need))\b/i.test(text);
}

function isIdentityQuestion(text) {
  return /^\s*(?:who is this|who are you|what is this about|which office is this)\s*[?!.]*\s*$/i.test(String(text || ""));
}

function isEscalation(text) {
  return /\b(terminate|cancel(?:ling|ing)? (?:the )?(?:contract|retainer)|legal notice|lawyer|refund|escalate to|escalating to|unacceptable|fed up|had enough|fraud)\b/i.test(text) ||
    /\b(fuck|bullshit|nonsense|rubbish|useless|pathetic)\b/i.test(text);
}

function isQuestionToUs(text) {
  const value = String(text || "").trim();
  if (!value.endsWith("?")) return false;
  return /\b(when|why|what|who|how much|how many|can you|could you|will you|are you|is there|status|update on|cost|price|invoice|payment)\b/i.test(value);
}

function isOutOfScope(text) {
  // Billing/payment/invoice complaints are valid management observations.
  // Questions about them still route through isQuestionToUs(), but a statement
  // such as "the tax invoice is inaccurate" must remain feedback even when
  // Gemini is unavailable.
  return /\b(proposal|quotation|new requirement|contract renewal|call me)\b/i.test(text);
}

function isUnparseable(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (/^[\p{Extended_Pictographic}\s]+$/u.test(value)) return false; // emoji is a signal, not noise
  // Metric/service shorthand is normal client language: "PPC CPL CTR" is not
  // gibberish merely because the acronyms contain few vowels.
  if (/^(?:[A-Z0-9]{2,6}[\s/,&+.-]*){2,}$/u.test(value)) return false;
  const letters = value.replace(/[^a-z]/gi, "");
  if (value.length >= 6 && letters.length / value.length < 0.35) return true;
  if (letters.length >= 8 && !/[aeiou]/i.test(letters)) return true;
  return false;
}

function isGreetingOnly(text) {
  return /^\s*(hi+|hello+|hey+|namaste|good (morning|afternoon|evening)|hi sir|hello sir|thanks?|thank you|ok|okay)\s*[.!]*\s*$/i.test(String(text || "")) ||
    /^[\p{Extended_Pictographic}\s]+$/u.test(String(text || "").trim());
}

function isAffirmative(text) {
  return /\b(yes|yeah|yep|sure|go ahead|move ahead)\b/i.test(text);
}

function isNegativeSkip(text) {
  return /\b(no|nothing else|no more|move ahead|skip|done|that'?s all)\b/i.test(text);
}

function isNonSpecificContinuation(text) {
  return /\b(both|all|not sure|no preference|same|all of them)\b/i.test(text);
}

/**
 * Deterministic coverage for explicit scope instructions. Gemini remains the
 * primary reader for broad, nuanced relationship feedback; these phrases keep
 * an unmistakable "ask me one by one" or "do not ask more services" working
 * if the model is temporarily unavailable.
 */
function explicitServiceScopeDecision(text, answeringScope = false) {
  const source = String(text || "").trim();
  if (!source) return SERVICE_SCOPE_DECISIONS.NONE;

  const skip = /\b(?:skip|leave)\s+(?:the\s+)?(?:remaining|rest of the|other|all)?\s*services?\b/i.test(source)
    || /\b(?:do\s*not|don'?t)\s+(?:want\s+you\s+to\s+)?ask\b[^.!?]{0,45}\bservices?\b/i.test(source)
    || /\bno\s+need\s+to\s+(?:ask|discuss|cover|go through)\b[^.!?]{0,35}\bservices?\b/i.test(source)
    || /\bmove\s+(?:on\s+)?(?:directly\s+)?to\s+(?:the\s+)?(?:overall\s+)?rating\b/i.test(source)
    || /\b(?:do\s*not|don'?t)\s+want\s+to\s+(?:talk|discuss)\b[^.!?]{0,35}\bservices?\b/i.test(source);
  if (skip) return SERVICE_SCOPE_DECISIONS.SKIP_REMAINING_SERVICES;

  const continueOneByOne = /\bservice[ -]?by[ -]?service\b/i.test(source)
    || /\b(?:one|each)\s+(?:service\s+)?by\s+(?:one|each)\b/i.test(source)
    || /\b(?:continue|proceed|go|carry on)\b[^.!?]{0,35}\b(?:through|with|on)?\s*(?:all|the)?\s*services?\b/i.test(source)
    || /\bask\b[^.!?]{0,35}\b(?:each|every|all)\s+services?\b/i.test(source);
  if (continueOneByOne) return SERVICE_SCOPE_DECISIONS.CONTINUE_SERVICE_BY_SERVICE;

  if (answeringScope) {
    if (isAffirmative(source)) return SERVICE_SCOPE_DECISIONS.CONTINUE_SERVICE_BY_SERVICE;
    if (isMoveOnReply(source) || isNegativeSkip(source)) {
      return SERVICE_SCOPE_DECISIONS.SKIP_REMAINING_SERVICES;
    }
  }
  return SERVICE_SCOPE_DECISIONS.NONE;
}

function isVagueDetailResponse(text) {
  return /\b(not sure|unsure|don'?t know|do not know|no idea|unclear|can'?t say|cannot say)\b/i.test(text);
}

/**
 * Is this reply unambiguous enough for the rules to handle on their own?
 *
 * Only exact, unmistakable answers qualify: a bare number, a bare yes/no. Every
 * bug in this file came from the opposite habit — matching a fragment inside a
 * sentence and treating that as understanding. "I am busy now" contained "am"
 * and became an Account Management complaint; "Pages take two weeks" contained
 * "two" and became a 2/10.
 *
 * Anything not on this list goes to Gemini. If Gemini cannot answer, we say we
 * did not understand rather than guess — a wrong guess corrupts a client's
 * record silently, an honest miss costs one extra message.
 */
function isUnambiguous(text) {
  const value = String(text || "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (!value) return null;

  if (/^\d+(?:\.\d+)?$/.test(value)) return "rating";
  if (/^\d+(?:\.\d+)?\s*(?:\/|out of)\s*\d+$/.test(value)) return "rating";
  if (/^(no|nope|nah|none|nothing|no thanks|nothing else|that'?s all)$/.test(value)) return "negative";
  if (/^(yes|yeah|yep|yup|sure|ok|okay|correct)$/.test(value)) return "affirmative";
  if (/^(stop|unsubscribe)$/.test(value)) return "opt_out";

  return null;
}

/** "later", "after some time", "will revert" — a postponement, not a refusal. */
function isDeferral(text) {
  const wantsLater = /\b(later|after ?some ?time|some ?time|afterwards|tomorrow|next week|another time|will revert|revert back|get back to you|will share|will do it|will give|give me (?:some )?time|need (?:some )?time)\b/i.test(text);
  const asksForTime = /\b(?:allow|give)\s+me\s+(?:(?:a|one|another|some)\s+)?(?:day|time|while|moment)\b/i.test(text)
    || /\b(?:come|get)\s+back\s+(?:with|to)\s+(?:the\s+|my\s+|you\s+)?(?:feedback|review|reviews|response)\b/i.test(text);
  const notNow = /\b(busy|not now|not right now|no time|don'?t have time|do not have time|travell?ing|on leave|in a meeting|driving|out of office|can'?t (?:do|give|share) (?:it |this )?now|cannot (?:do|give|share))\b/i.test(text);
  const refusingNow = /\b(?:will not|won'?t|do ?n'?t want to|not going to)\b[^.!?]{0,30}\b(?:give|share|do|provide|answer)\b/i.test(text);
  return wantsLater || asksForTime || notNow || refusingNow;
}

/**
 * "ok", "sure", "I am ready" — filler that keeps a conversation moving. It must
 * never be read as feedback: "Okay I am ready now" contained "ok", was scored
 * as blanket praise, and skipped the client straight past every service
 * question to the overall rating.
 */
const FILLER_WORDS = [
  "ok", "okay", "okie", "oky", "k", "kk", "sure", "alright", "allright", "right",
  "fine", "got it", "gotcha", "understood", "noted", "thanks", "thank you", "thx",
  "ty", "yes", "yeah", "yep", "yup", "yes please", "please", "go ahead", "hmm",
  "hm", "ready", "start", "begin", "proceed", "lets start", "let us start",
  "good to go", "available", "free", "here", "now", "then", "i", "am", "im",
  "lets", "let us", "us", "do", "it", "shall", "we", "ok lets start",
  "i'm", "we", "are", "we're", "you", "can", "will", "give", "feedback", "this",
  "side", "of course", "definitely", "certainly"
];

/**
 * Conversational filler: an acknowledgement that keeps the conversation moving.
 * It carries no opinion about our services and must never be scored.
 *
 * Checked by removing every filler word and seeing whether anything of
 * substance is left. A word list of whole phrases could never cover "hmm ok",
 * "okie", "ok let's start", "yes can give feedback now" — this does.
 */
function isAcknowledgement(text) {
  // Normalise apostrophes too: "let's" and "lets" are the same filler, and a
  // stray apostrophe was leaving "let's" behind as apparent substance.
  const value = String(text || "").trim().toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[.!,?-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!value || value.length > 60) return false;

  let remainder = ` ${value} `;
  for (const word of [...FILLER_WORDS].sort((a, b) => b.length - a.length)) {
    remainder = remainder.split(` ${word} `).join(" ");
  }
  return remainder.trim().length === 0;
}

/**
 * A one-word assessment answers "How has this service been?" even though the
 * same word can be conversational filler elsewhere in the survey.
 */
function isShortServiceOpinion(text) {
  return /^\s*(?:ok|okay|fine|good|great|excellent|smooth|happy|satisfied)\s*[.!]*\s*$/i.test(String(text || ""));
}

/** Coming back after asking to answer later. */
function isResumption(text) {
  return /\b(ready|let'?s (?:start|go|do it|begin|complete|finish|continue|carry on)|go ahead|i can (?:give|do|share) (?:it )?now|(?:can|will) give feedback now|available now|free now|shall we (?:start|begin|continue)|start now|proceed|carry on|continue|complete it|finish it|lets do it)\b/i.test(text)
    || isAcknowledgement(text);
}

function isMoveOnReply(text) {
  const value = String(text || "");
  // Mobile replies often stretch the final character ("nooooo", "nopeeee",
  // "nothingggg"). Gemini remains the primary interpreter; this normalization
  // keeps the same answers working during a timeout without listing each typo.
  const unstretched = value.replace(/([a-z])\1{2,}/gi, "$1");
  return /\b(nothing else|nothing more|nothing to (?:share|sahre|add)|that'?s all|that'?s it(?: from my side)?|that is it(?: from my side)?|apart from (this|that) nothing|no other|working well|well overall|all good|good overall|fine overall|going well)\b/i.test(unstretched) ||
    /^\s*(no+|nope|nothing|none|nah|np|nk|mo|not)\s*[.!]*\s*$/i.test(unstretched);
}

function emojiSentiment(text) {
  if (/[\u{1F61E}\u{1F620}\u{1F621}\u{1F44E}\u{2639}\u{1F641}\u{1F622}]/u.test(text)) return "negative";
  if (/[\u{1F60A}\u{1F600}\u{1F603}\u{1F44D}\u{1F64F}\u{1F4AF}\u{1F389}]/u.test(text)) return "positive";
  return null;
}

// ---------------------------------------------------------------------
// Conversation state
// ---------------------------------------------------------------------

function getConversationState(session) {
  const raw = session.conversationState && Object.keys(session.conversationState).length
    ? session.conversationState
    : null;

  const conversationState = raw || {
    state: STATES.WAITING_FOR_OPEN_FEEDBACK,
    mentionedServices: {},
    pendingServiceKey: null,
    pendingNegativeServices: [],
    readyForOverallRating: false,
    overallRating: null,
    npsScore: null,
    missingFields: ["open_feedback"],
    turnCount: 0,
    guardrailHits: [],
    invalidRatingWarned: false,
    unparseableCount: 0,
    offTopicQuestions: [],
    handoffReason: null,
    optedOut: false,
    generalSentiment: null,
    generalConcernText: null,
    generalNegativeProbed: false,
    generalFeedbackText: null,
    serviceScopeStatus: null,
    projectEndReviewCaptured: false,
    projectEndReviewAsked: false,
    askedForAppreciation: false,
    appreciationAnswered: false,
    appreciationVolunteered: false,
    askedForAnythingElse: false,
    anythingElseAnswered: false,
    overallRatingAsked: false,
    closingGraceExpiresAt: null
  };

  if (conversationState.readyForOverallRating === undefined) conversationState.readyForOverallRating = false;
  if (conversationState.overallRating === undefined) conversationState.overallRating = null;
  if (conversationState.npsScore === undefined) conversationState.npsScore = null;
  if (!conversationState.mentionedServices) conversationState.mentionedServices = {};
  if (!conversationState.pendingNegativeServices) conversationState.pendingNegativeServices = [];
  if (!conversationState.guardrailHits) conversationState.guardrailHits = [];
  if (conversationState.invalidRatingWarned === undefined) conversationState.invalidRatingWarned = false;
  if (conversationState.unparseableCount === undefined) conversationState.unparseableCount = 0;
  if (!conversationState.offTopicQuestions) conversationState.offTopicQuestions = [];
  if (conversationState.optedOut === undefined) conversationState.optedOut = false;
  if (conversationState.generalSentiment === undefined) conversationState.generalSentiment = null;
  if (conversationState.generalNegativeProbed === undefined) conversationState.generalNegativeProbed = false;
  if (conversationState.generalFeedbackText === undefined) conversationState.generalFeedbackText = null;
  if (conversationState.serviceScopeStatus === undefined) conversationState.serviceScopeStatus = null;
  if (conversationState.projectEndReviewCaptured === undefined) conversationState.projectEndReviewCaptured = false;
  if (conversationState.projectEndReviewAsked === undefined) conversationState.projectEndReviewAsked = false;
  if (conversationState.askedForAppreciation === undefined) conversationState.askedForAppreciation = false;
  if (conversationState.appreciationAnswered === undefined) conversationState.appreciationAnswered = false;
  if (conversationState.appreciationVolunteered === undefined) conversationState.appreciationVolunteered = false;
  if (conversationState.askedForAnythingElse === undefined) conversationState.askedForAnythingElse = false;
  if (conversationState.anythingElseAnswered === undefined) conversationState.anythingElseAnswered = false;
  if (conversationState.overallRatingAsked === undefined) conversationState.overallRatingAsked = false;
  if (conversationState.closingGraceExpiresAt === undefined) conversationState.closingGraceExpiresAt = null;
  for (const service of Object.values(conversationState.mentionedServices)) {
    if (service.rating === undefined) service.rating = null;
    if (service.issueReasonAskCount === undefined) service.issueReasonAskCount = 0;
    if (service.serviceFollowUpAskCount === undefined) service.serviceFollowUpAskCount = 0;
  }
  conversationState.sessionType = session.sessionType || conversationState.sessionType || "pulse";
  // Resume project-end sessions that were already waiting on the former
  // continue/skip prompt. Their stored general feedback is the whole-project
  // review, so do not ask them to repeat it after this deployment. An explicit
  // service-by-service choice remains untouched.
  if (
    conversationState.sessionType === "project_end"
    && conversationState.generalFeedbackText
    && ["awaiting_choice", "skipped"].includes(conversationState.serviceScopeStatus)
  ) {
    conversationState.projectEndReviewCaptured = true;
    conversationState.serviceScopeStatus = "project_end_overall";
    conversationState.readyForOverallRating = true;
    if (conversationState.pendingQuestionType === "service_scope") {
      conversationState.pendingQuestionType = null;
    }
    if (conversationState.state === STATES.WAITING_FOR_SERVICE_SCOPE) {
      conversationState.state = STATES.WAITING_FOR_MORE_SERVICES;
    }
  }
  return conversationState;
}

function ensureServiceState(conversationState, project, serviceKey) {
  if (!conversationState.mentionedServices[serviceKey]) {
    conversationState.mentionedServices[serviceKey] = {
      serviceKey,
      serviceName: serviceName(project, serviceKey),
      sentiment: "neutral",
      reasonText: null,
      reasonTags: [],
      rating: null,
      status: "mentioned",
      detailAsked: false,
      detailAnswered: false,
      followUpAsked: false,
      probeCount: 0,
      ...serviceOwner(project, serviceKey)
    };
  }
  return conversationState.mentionedServices[serviceKey];
}

/**
 * Apply the client's preference about whether to continue service questions.
 * Skipping records "not discussed" rather than inventing positive feedback.
 * Any concrete point already supplied is preserved and simply considered
 * finished so the client is not forced to elaborate.
 */
function applyServiceScopeDecision(conversationState, project, decision, context = {}) {
  if (!Object.values(SERVICE_SCOPE_DECISIONS).includes(decision)
    || decision === SERVICE_SCOPE_DECISIONS.NONE) return conversationState;

  if (decision === SERVICE_SCOPE_DECISIONS.OVERALL_FEEDBACK) {
    const source = String(context.text || "").trim();
    if (source) conversationState.generalFeedbackText = source.slice(0, 1200);
    if (context.sentiment && context.sentiment !== "neutral") {
      conversationState.generalSentiment = context.sentiment;
    }
    // A project-end conversation is deliberately a whole-project review. Once
    // the client has answered that invitation, unmentioned services are not
    // missing fields and are not recorded as declined or positive. Only a real
    // concern they raised remains open for a focused follow-up.
    if (conversationState.sessionType === "project_end") {
      conversationState.projectEndReviewCaptured = true;
      conversationState.serviceScopeStatus = "project_end_overall";
      conversationState.readyForOverallRating = true;
      if (["project_end_review", "service_scope"].includes(conversationState.pendingQuestionType)) {
        conversationState.pendingQuestionType = null;
      }
      return conversationState;
    }
    const coveredKeys = new Set(Object.values(conversationState.mentionedServices || {})
      .filter((service) => !["mentioned", "needs_feedback"].includes(service.status))
      .map((service) => service.serviceKey));
    const hasRemainingServices = projectServices(project)
      .some((service) => !coveredKeys.has(service.serviceKey));
    if (hasRemainingServices
      && !["service_by_service", "skipped"].includes(conversationState.serviceScopeStatus)) {
      conversationState.serviceScopeStatus = "awaiting_choice";
      conversationState.readyForOverallRating = false;
    }
    return conversationState;
  }

  if (decision === SERVICE_SCOPE_DECISIONS.CONTINUE_SERVICE_BY_SERVICE) {
    conversationState.serviceScopeStatus = "service_by_service";
    conversationState.readyForOverallRating = false;
    if (conversationState.pendingQuestionType === "service_scope") {
      conversationState.pendingQuestionType = null;
    }
    return conversationState;
  }

  conversationState.serviceScopeStatus = "skipped";
  conversationState.readyForOverallRating = true;
  if (conversationState.pendingQuestionType === "service_scope") {
    conversationState.pendingQuestionType = null;
  }
  const skippedReason = "Client chose to skip the remaining service questions.";
  for (const configured of projectServices(project)) {
    const existing = conversationState.mentionedServices?.[configured.serviceKey];
    const service = existing || ensureServiceState(conversationState, project, configured.serviceKey);
    const hasConcreteFeedback = Boolean(
      existing && ((existing.reasonText && existing.reasonText !== skippedReason)
        || existing.sentiment === "negative"
        || existing.sentiment === "positive")
    );
    service.detailAnswered = true;
    service.serviceFollowUpAnswered = true;
    service.followUpAsked = true;
    service.status = hasConcreteFeedback
      ? (hasServiceRating(service) ? "rated" : "captured")
      : "declined";
    if (!hasConcreteFeedback) {
      service.sentiment = "neutral";
      service.reasonText = service.reasonText || skippedReason;
    }
  }
  // The opening invitation plus a meaningful broad response already gave the
  // client the same opportunity as the later generic management sweep. Once
  // they explicitly skip further service questions, asking "anything else?"
  // immediately afterwards is repetitive and falsely says skipped services
  // were covered. Appreciation remains a separate required checkpoint.
  if (conversationState.generalFeedbackText) {
    conversationState.askedForAnythingElse = true;
    conversationState.anythingElseAnswered = true;
  }
  return conversationState;
}

function setServiceSignal(service, text, sentiment, reasons) {
  const effectiveSentiment = sentiment === "neutral" ? service.sentiment : sentiment;
  if (sentiment !== "neutral") service.sentiment = sentiment;
  if (reasons.length) service.reasonTags = [...new Set([...(service.reasonTags || []), ...reasons])];

  const shouldCaptureReason = effectiveSentiment === "negative" || reasons.length || service.detailAsked;
  if (shouldCaptureReason && String(text || "").trim()) {
    // Never REPLACE a reason with something shorter and less specific — append
    // instead, so nothing the client told us is lost.
    if (service.reasonText && service.reasonText !== text) {
      const alreadyThere = service.reasonText.toLowerCase().includes(String(text).toLowerCase());
      if (!alreadyThere) service.reasonText = `${service.reasonText}. ${text}`;
    } else {
      service.reasonText = text;
    }
  }

  // Never move a service backwards once something was captured (the v1 loop bug).
  service.status = service.rating
    ? "rated"
    : effectiveSentiment === "negative"
      ? (reasons.length || service.detailAnswered ? "needs_rating" : "needs_reason")
      : effectiveSentiment === "neutral" && !reasons.length && !service.detailAsked
        ? "needs_feedback"
        : "needs_rating";
}

/**
 * A number beats a keyword. "landing page layout is jot good" reads positive to
 * a word list because the typo left "good" behind — but a 4/10 is not positive,
 * whatever words came with it.
 */
function applyRating(service, rating) {
  service.rating = rating;
  service.status = "rated";
  if (rating <= 4) service.sentiment = "negative";
  else if (rating >= 8 && service.sentiment === "neutral") service.sentiment = "positive";
}

/** 0 is a rating. Anything that tests it for truthiness gets this wrong. */
function hasOverallRating(conversationState) {
  return conversationState.overallRating !== null
    && conversationState.overallRating !== undefined;
}

function hasServiceRating(service) {
  return service && service.rating !== null && service.rating !== undefined;
}

function negativeServices(conversationState) {
  return Object.values(conversationState.mentionedServices)
    .filter((service) => service.sentiment === "negative")
    .map((service) => service.serviceKey);
}

function missingFields(conversationState) {
  const missing = [];
  const services = Object.values(conversationState.mentionedServices);
  if (!services.length && !conversationState.generalFeedbackText) missing.push("open_feedback");
  if (conversationState.serviceScopeStatus === "awaiting_choice") missing.push("service_scope");
  if (services.some((s) => s.sentiment === "negative" && s.status === "needs_reason")) missing.push("issue_reason");
  if (services.some((s) => s.status === "needs_rating")) missing.push("service_rating");
  // 0 is a legitimate rating. A truthiness check reads it as "not given",
  // which let a session close with no rating and report 0 as the score.
  if (conversationState.overallRating === null || conversationState.overallRating === undefined) {
    missing.push("overall_rating");
  }
  if (conversationState.sessionType === "project_end" && conversationState.npsScore === null) {
    missing.push("nps_recommendation");
  }
  return missing;
}

function formatServiceList(project) {
  return projectServices(project).map((service) => service.name).join(", ");
}

function chooseWorstService(conversationState) {
  const services = Object.values(conversationState.mentionedServices);
  return (
    services.find((s) => s.sentiment === "negative" && !hasServiceRating(s)) ||
    services.find((s) => s.sentiment === "negative") ||
    services[0] ||
    null
  );
}

// ---------------------------------------------------------------------
// Next question
// ---------------------------------------------------------------------

function nextQuestionFor(conversationState, project, poc) {
  const salutation = (poc && (poc.salutation || poc.name)) || "there";

  const noServicesYet = !Object.keys(conversationState.mentionedServices).length;

  if (conversationState.serviceScopeStatus === "awaiting_choice") {
    conversationState.pendingQuestionType = "service_scope";
    return {
      state: STATES.WAITING_FOR_SERVICE_SCOPE,
      text: SERVICE_SCOPE_QUESTION
    };
  }

  // The client answered in general terms without naming a service ("all good",
  // "nothing is working"). Ask once for the specific service, then move on
  // rather than repeat the opening question forever.
  if (noServicesYet && conversationState.generalSentiment === "negative" && !conversationState.generalNegativeProbed) {
    conversationState.generalNegativeProbed = true;
    return {
      state: STATES.WAITING_FOR_OPEN_FEEDBACK,
      text: `Sorry to hear that, ${salutation}. Which service is that mainly about — ${formatServiceList(project)}?`
    };
  }

  // Already asked which service and still nothing specific: stop repeating the
  // opening question and take the overall rating instead.
  // Only a probed general complaint advances here. The old rule also advanced
  // after two no-signal replies, which meant gibberish skipped the client
  // straight to the overall rating — the repeat-and-handoff path owns that now.
  if (noServicesYet && conversationState.generalNegativeProbed) {
    conversationState.readyForOverallRating = true;
  }

  if (noServicesYet && !conversationState.readyForOverallRating && !hasOverallRating(conversationState)) {
    const isProjectEnd = conversationState.sessionType === "project_end";
    return {
      state: STATES.WAITING_FOR_OPEN_FEEDBACK,
      text: isProjectEnd
        ? projectEndReviewQuestion(project)
        : `${salutation}, across your active SRV services (${formatServiceList(project)}), what is working well and what needs improvement?`
    };
  }

  const services = Object.values(conversationState.mentionedServices);

  // G5: a service that has hit the probe cap is never asked for detail again.
  const pendingReasonService = services.find(
    (s) => s.sentiment === "negative" && s.status === "needs_reason" &&
      !s.detailAsked && s.probeCount < MAX_PROBES_PER_SERVICE
  );
  // A negative service gets one "anything else?" before we ask for a number.
  // Positive ones go straight to the rating — there is nothing to dig into.
  // Any negative service gets one "anything else?" before the rating — whether
  // the reason arrived in answer to our follow-up or in the opening message.
  // Only after the reason question has genuinely been answered, or the opening
  // message carried real detail. "Website has some issues" names a problem
  // without describing one — treating that as a reason skipped straight to
  // "anything else?" and never asked what the issue actually was.
  const pendingFollowUpService = services.find(
    (s) => s.sentiment === "negative" && s.status === "needs_rating" && !hasServiceRating(s)
      && (s.detailAnswered || (s.reasonTags && s.reasonTags.length)) && !s.followUpAsked
      && s.probeCount < MAX_PROBES_PER_SERVICE
  );
  // Praise deserves acknowledgement, not an immediate rating request. The
  // invitation to add more rides in the SAME message, so a client who has
  // nothing to add answers once and moves on.
  const pendingPraiseService = services.find(
    (s) => s.sentiment === "positive" && s.status === "needs_rating" && !hasServiceRating(s)
      && !s.followUpAsked && s.probeCount < MAX_PROBES_PER_SERVICE
  );
  const pendingRatingService = services.find((s) => s.status === "needs_rating" && !hasServiceRating(s));
  const pendingFeedbackService = services.find(
    (s) => s.status === "needs_feedback" && s.probeCount < MAX_PROBES_PER_SERVICE
  );

  if (pendingReasonService) {
    pendingReasonService.detailAsked = true;
    pendingReasonService.probeCount += 1;
    return {
      state: STATES.WAITING_FOR_ISSUE_REASON,
      pendingServiceKey: pendingReasonService.serviceKey,
      text: `I am sorry ${pendingReasonService.serviceName} has been frustrating. What specifically should improve there?`
    };
  }

  if (pendingFollowUpService) {
    pendingFollowUpService.followUpAsked = true;
    pendingFollowUpService.probeCount += 1;
    return {
      state: STATES.WAITING_FOR_SERVICE_FOLLOWUP,
      pendingServiceKey: pendingFollowUpService.serviceKey,
      text: `I am sorry you have had to deal with that. We will look into this with the ${pendingFollowUpService.serviceName} team. Is there anything else on ${pendingFollowUpService.serviceName} we should know? If not, just reply no.`
    };
  }

  if (pendingPraiseService) {
    pendingPraiseService.followUpAsked = true;
    pendingPraiseService.probeCount += 1;
    return {
      state: STATES.WAITING_FOR_SERVICE_FOLLOWUP,
      pendingServiceKey: pendingPraiseService.serviceKey,
      text: `Good to hear — I will pass that on to the ${pendingPraiseService.serviceName} team. Is there anything you would still like us to improve there? If not, just reply no.`
    };
  }

  if (pendingRatingService) {
    // Something raised in the follow-up has not been acknowledged yet — most
    // often a niggle mentioned after praise. Going straight to "rate us" makes
    // it look as though we ignored what they just said.
    const unacknowledged = pendingRatingService.noteNeedsAck;
    if (unacknowledged) pendingRatingService.noteNeedsAck = false;
    return {
      state: STATES.WAITING_FOR_SERVICE_RATING,
      pendingServiceKey: pendingRatingService.serviceKey,
      text: unacknowledged
        ? `I am sorry about that additional point. We will include it for the ${pendingRatingService.serviceName} team to review. How would you rate our ${pendingRatingService.serviceName} support out of 10?`
        : `How would you rate our ${pendingRatingService.serviceName} support out of 10?`
    };
  }

  if (pendingFeedbackService) {
    pendingFeedbackService.detailAsked = true;
    pendingFeedbackService.probeCount += 1;
    return {
      state: STATES.WAITING_FOR_SERVICE_FEEDBACK,
      pendingServiceKey: pendingFeedbackService.serviceKey,
      text: `Sure, let us look at ${pendingFeedbackService.serviceName} too. What should improve there, or is it working well overall?`
    };
  }

  if (!conversationState.readyForOverallRating && !hasOverallRating(conversationState)) {
    return {
      state: STATES.WAITING_FOR_MORE_SERVICES,
      text: "Thank you. Our team will work on this. Is there any other service you want us to focus on? If not, just reply no."
    };
  }

  if (!hasOverallRating(conversationState)) {
    const isProjectEnd = conversationState.sessionType === "project_end";
    conversationState.overallRatingAsked = true;
    conversationState.pendingQuestionType = "overall_rating";
    return {
      state: STATES.WAITING_FOR_OVERALL_RATING,
      text: isProjectEnd
        ? "Overall, how would you rate the work SRV Media delivered on this project, out of 10?"
        : "Overall, how would you rate the work SRV Media has done for you so far, out of 10?"
    };
  }

  if (conversationState.sessionType === "project_end" && conversationState.npsScore === null) {
    return {
      state: STATES.WAITING_FOR_NPS,
      text: "Lastly — if someone in your network was looking for digital marketing support, how likely would you be to recommend SRV Media to them, out of 10?"
    };
  }

  return {
    state: STATES.CLOSING_GRACE,
    text: "Thank you. Your feedback and overall rating are recorded. This chat will remain open for 10 minutes in case you want to correct or add anything."
  };
}

/**
 * Record what the model captured from a reply.
 *
 * The model writes the words; the machine holds the state. Without this the
 * two drift apart — the bot said "we will skip PPC" while nothing recorded
 * that PPC had been covered, so the checklist never emptied and the session
 * could not close.
 */
function applyCaptured(conversationState, project, captured = [], overallRating = null, corrects = false) {
  for (const item of captured) {
    let capturedNewPoint = false;
    // A correction REPLACES what they said before. Appending it would leave
    // both answers on record, so a client who said "no, make that 4" would
    // have a 6 and a 4 both counted, and an issue raised from a complaint they
    // had just withdrawn.
    if (corrects && conversationState.mentionedServices[item.serviceKey]) {
      const previous = conversationState.mentionedServices[item.serviceKey];
      previous.reasonText = null;
      previous.reasonTags = [];
      previous.sentiment = "neutral";
      previous.supersededAt = new Date().toISOString();
    }
    const service = ensureServiceState(conversationState, project, item.serviceKey);
    const statusBeforeCapture = service.status;
    const followUpBeforeCapture = service.serviceFollowUpAnswered;
    if (item.fromAppreciation === true) service.explicitAppreciation = true;

    if (item.declined) {
      // A refusal is an answer. Mark it covered so we stop asking, but record
      // no opinion — they did not give one.
      service.status = "declined";
      service.detailAnswered = true;
      service.serviceFollowUpAnswered = true;
      service.reasonText = service.reasonText || "Client preferred not to discuss this service.";
      continue;
    }

    // Track every sentiment the model has read for this service, and let the
    // worst one stand. Overwriting on each mention left Design marked positive
    // while holding "campaigns are not getting handled well", so a complaint
    // was rendered as praise.
    if (item.sentiment) {
      service.sentiments = [...new Set([...(service.sentiments || []), item.sentiment])];
      service.sentiment = service.sentiments.includes("negative")
        ? "negative"
        : service.sentiments.includes("positive") ? "positive" : "neutral";
    }
    const isPureAppreciation = item.fromAppreciation === true
      && item.sentiment === "positive"
      && item.needsFollowUp !== true;
    if (isPureAppreciation && item.summary) {
      // Praise is retained separately from service problem text. Appending
      // "the videos are fantastic" to an older Design complaint polluted the
      // issue root cause and reopened an already-finished Design interview.
      const summary = item.summary.trim();
      const existingPraise = service.appreciationPoints || [];
      if (!existingPraise.some((point) => feedbackPointOverlap(point, summary))) {
        service.appreciationPoints = [...existingPraise, summary];
      }
    } else if (item.summary) {
      // Keep the model's summaries as a SET, and rebuild the reason from them.
      //
      // Appending on every mention produced an unreadable record: Website held
      // the client's whole multi-service sentence three times plus a video
      // appreciation. The model summarises each service on each turn, so the
      // same point arrives repeatedly — worded slightly differently each time,
      // which defeats any string comparison.
      const summary = item.summary.trim();
      const normalise = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
      const key = normalise(summary);

      // Sessions written before this existed have reasonText but no points.
      // Seed from it so an in-flight conversation does not lose what it holds.
      if (!service.points) {
        service.points = service.reasonText
          ? service.reasonText.split(/\.\s+/).map((part) => part.trim()).filter(Boolean)
          : [];
      }
      const covered = service.points.some((point) => {
        const existing = normalise(point);
        return existing === key || existing.includes(key) || key.includes(existing)
          || feedbackPointOverlap(point, summary);
      });

      if (!covered) {
        service.points.push(summary);
        capturedNewPoint = true;
      } else {
        // Same point, better wording — replace rather than keep both.
        service.points = service.points.map((point) => {
          const existing = normalise(point);
          const overlaps = existing.includes(key) || key.includes(existing)
            || feedbackPointOverlap(point, summary);
          return overlaps && summary.length > point.length ? summary : point;
        });
      }

      service.reasonText = service.points.join(". ");
    }
    // A self-contained appreciation is recorded but never reopens the
    // service's "anything else?" question. Preserve a genuinely unresolved
    // older issue; otherwise the praise itself completes this service.
    if (isPureAppreciation) {
      if (["needs_reason", "needs_service_followup"].includes(statusBeforeCapture)) {
        service.status = statusBeforeCapture;
        service.serviceFollowUpAnswered = followUpBeforeCapture;
      } else {
        service.status = hasServiceRating(service) ? "rated" : "captured";
        service.serviceFollowUpAnswered = true;
      }
      continue;
    }

    // A complaint with no reason behind it is useless to the owner who would
    // have to act on it. The model says when that is the case; the checklist
    // then keeps the service open so the conversation comes back to it.
    service.detailAnswered = !item.needsFollowUp;
    if (item.needsFollowUp) {
      service.status = "needs_reason";
    } else if (service.sentiment === "negative") {
      // An actionable issue is not the end of this service. Acknowledge it,
      // then explicitly ask whether there is anything else on the same service.
      service.serviceFollowUpAnswered = false;
      // A new substantive point deserves a fresh acknowledgement and one
      // "anything else?" opportunity. Repeated paraphrases do not reset the
      // cap and cannot create an endless loop.
      if (capturedNewPoint) {
        service.serviceFollowUpAskCount = 0;
        service.followUpAsked = false;
      }
      service.status = "needs_service_followup";
    } else if (
      conversationState.sessionType === "project_end"
      && conversationState.serviceScopeStatus !== "service_by_service"
    ) {
      // Positive and neutral project-end comments are already complete. The
      // broad review must not turn into a service-by-service interview. A
      // negative item still follows the branch above and receives a targeted
      // acknowledgement/detail follow-up.
      service.serviceFollowUpAnswered = true;
      service.status = hasServiceRating(service) ? "rated" : "captured";
    } else if (!service.serviceFollowUpAnswered || capturedNewPoint) {
      // Every service gets one natural "anything else on this service?" turn,
      // not only complaints. Without it, "it is fine" jumped immediately to
      // the next department and the client had no opening to add a qualifying
      // point. A refusal above remains final and is never forced open again.
      service.serviceFollowUpAnswered = false;
      if (capturedNewPoint) {
        service.serviceFollowUpAskCount = 0;
        service.followUpAsked = false;
      }
      service.status = "needs_service_followup";
    } else {
      service.status = hasServiceRating(service) ? "rated" : "captured";
    }
  }

  if (overallRating !== null && overallRating !== undefined) {
    conversationState.overallRating = overallRating;
  }

  conversationState.missingFields = missingFields(conversationState);
  return conversationState;
}

/**
 * Record structured facts about the client's answer and the question Gemini
 * chose to ask next. State must never be inferred from the prose itself.
 */
function applyTurnProgress(conversationState, project, turn = {}, options = {}) {
  const recordAnswers = options.recordAnswers !== false;
  const recordAsked = options.recordAsked !== false;

  if (recordAnswers && turn.answeredAppreciation === true) conversationState.appreciationAnswered = true;
  if (recordAnswers && turn.appreciationVolunteered === true) {
    conversationState.appreciationVolunteered = true;
    conversationState.appreciationAnswered = true;
  }
  if (recordAnswers && turn.answeredAnythingElse === true) conversationState.anythingElseAnswered = true;

  for (const serviceKey of recordAnswers ? (turn.completedServiceFollowUpKeys || []) : []) {
    const service = conversationState.mentionedServices?.[serviceKey];
    if (!service || service.status === "needs_reason") continue;
    service.serviceFollowUpAnswered = true;
    service.status = hasServiceRating(service) ? "rated" : "captured";
  }

  if (recordAsked && turn.askedForAppreciation === true) conversationState.askedForAppreciation = true;
  if (recordAsked && turn.askedForAnythingElse === true) conversationState.askedForAnythingElse = true;
  if (recordAsked && turn.askedForOverallRating === true) conversationState.overallRatingAsked = true;

  if (recordAsked && turn.askedIssueReasonKey) {
    const service = ensureServiceState(conversationState, project, turn.askedIssueReasonKey);
    service.issueReasonAskCount = Number(service.issueReasonAskCount || 0) + 1;
  }

  if (recordAsked && turn.askedServiceFollowUpKey) {
    const service = ensureServiceState(conversationState, project, turn.askedServiceFollowUpKey);
    service.serviceFollowUpAsked = true;
    service.serviceFollowUpAskCount = Number(service.serviceFollowUpAskCount || 0) + 1;
  }

  conversationState.missingFields = missingFields(conversationState);
  return conversationState;
}

/**
 * Does this message read as a goodbye?
 *
 * The model closed a conversation with four services untouched and no overall
 * rating — it wrote "Have a great day ahead!" and the client reasonably took
 * that as the end. The machine owns closure, so a farewell written while the
 * checklist is unsatisfied has to be caught and replaced.
 */
function soundsLikeFarewell(text) {
  return /\b(have a (great|good|wonderful|nice) (day|evening|week)|thank you for your time|that is everything|goodbye|take care|speak soon)\b/i.test(String(text || ""));
}

/**
 * The one question the machine insists on. Everything else the model may word
 * and order as it likes, but a cycle without an overall rating has no score,
 * so this is asked explicitly rather than left to the model's judgement.
 */
function overallRatingQuestion(conversationState, project) {
  const isProjectEnd = conversationState.sessionType === "project_end";
  const declined = Object.values(conversationState.mentionedServices || {})
    .filter((svc) => svc.status === "declined").length;
  const lead = declined ? "That is everything covered. " : "";
  return isProjectEnd
    ? `${lead}Overall, how would you rate the work SRV Media delivered on this project, out of 10?`
    : `${lead}Overall, how would you rate the work SRV Media has done for you so far, out of 10?`;
}

/**
 * Is everything covered? The MACHINE decides this, not the model — a model
 * that says "thank you for your time" does not close a session, and one that
 * never says it would leave the session open for ever.
 */
function isEverythingCovered(conversationState, project) {
  settleExhaustedServiceProbes(conversationState);
  if (conversationState.serviceScopeStatus === "awaiting_choice") return false;
  const services = Object.values(conversationState.mentionedServices || {});
  if (services.some((svc) => ["mentioned", "needs_feedback"].includes(svc.status))) {
    return false;
  }
  const covered = new Set(services.map((svc) => svc.serviceKey));
  const remaining = projectServices(project).filter((svc) => !covered.has(svc.serviceKey));
  const projectEndOverall = conversationState.sessionType === "project_end"
    && conversationState.projectEndReviewCaptured === true
    && conversationState.serviceScopeStatus !== "service_by_service";
  if (conversationState.sessionType === "project_end"
    && !projectEndOverall
    && conversationState.serviceScopeStatus !== "service_by_service") return false;
  if (remaining.length && !projectEndOverall) return false;

  // A named problem with no reason is not a finished answer. An actionable
  // issue also stays open until the client answers "anything else?" for that
  // same service. A declined service is already in the covered set above.
  if (services.some((svc) => ["needs_reason", "needs_service_followup"].includes(svc.status))) {
    return false;
  }

  // The rating must have been asked for explicitly. Inferring coverage let a
  // session close after five turns because every service happened to be
  // mentioned somewhere — including one the client never actually answered.
  if (!conversationState.overallRatingAsked) return false;

  // Praise must be covered before closing. If the client already volunteered
  // it, asking them to repeat it is robotic; otherwise the explicit question
  // still has to be asked and answered.
  const praiseCovered = conversationState.appreciationAnswered
    && (conversationState.askedForAppreciation || conversationState.appreciationVolunteered);
  if (!praiseCovered) return false;
  if (!conversationState.askedForAnythingElse || !conversationState.anythingElseAnswered) return false;

  const hasOverall = conversationState.overallRating !== null
    && conversationState.overallRating !== undefined;
  if (!hasOverall) return false;

  if (conversationState.sessionType === "project_end" && conversationState.npsScore === null) {
    return false;
  }
  return true;
}

/**
 * What is still open, for the model to decide what to ask next.
 *
 * The machine no longer scripts the conversation. It tracks coverage and
 * enforces boundaries; the model chooses the words and the order. A script
 * cannot respond to "your billings are inaccurate" or "I have not met Sarang
 * in three months" — it replies with the next line and the feedback is lost.
 */
function settleExhaustedServiceProbes(conversationState) {
  for (const service of Object.values(conversationState.mentionedServices || {})) {
    if (
      service.status === "needs_reason"
      && Number(service.issueReasonAskCount || 0) >= MAX_PROBES_PER_SERVICE
    ) {
      service.status = "captured";
      service.probeLimitReached = true;
    }
    if (
      service.status === "needs_service_followup"
      && Number(service.serviceFollowUpAskCount || 0) >= MAX_PROBES_PER_SERVICE
    ) {
      service.serviceFollowUpAnswered = true;
      service.status = hasServiceRating(service) ? "rated" : "captured";
      service.probeLimitReached = true;
    }
  }
}

function buildChecklist(conversationState, project) {
  settleExhaustedServiceProbes(conversationState);
  const covered = Object.values(conversationState.mentionedServices || {});
  // Merely detecting a service name is not the same as capturing the client's
  // view of that service. On a Gemini timeout these placeholder rows can have
  // status "mentioned"/"needs_feedback"; keep them in the questioning list.
  const unansweredKeys = new Set(covered
    .filter((svc) => ["mentioned", "needs_feedback"].includes(svc.status))
    .map((svc) => svc.serviceKey));
  const coveredKeys = new Set(covered
    .filter((svc) => !unansweredKeys.has(svc.serviceKey))
    .map((svc) => svc.serviceKey));

  // Not yet mentioned at all, OR mentioned without saying what the problem is.
  // The second case is why "the website needs to improve" was acknowledged and
  // dropped: it counted as covered while telling a developer nothing.
  const needsMore = covered
    .filter((svc) => svc.status === "needs_reason")
    .map((svc) => svc.serviceName);

  const needsServiceFollowUp = covered
    .filter((svc) => svc.status === "needs_service_followup")
    .map((svc) => ({
      serviceKey: svc.serviceKey,
      name: svc.serviceName,
      askCount: Number(svc.serviceFollowUpAskCount || 0)
    }));

  const isProjectEnd = conversationState.sessionType === "project_end";
  const projectEndOverall = isProjectEnd
    && conversationState.projectEndReviewCaptured === true
    && conversationState.serviceScopeStatus !== "service_by_service";
  const projectEndReviewStillNeeded = isProjectEnd
    && !projectEndOverall
    && conversationState.serviceScopeStatus !== "service_by_service";

  const remaining = (projectEndOverall ? [] : projectServices(project))
    .filter((svc) => !coveredKeys.has(svc.serviceKey))
    .map((svc) => svc.name);

  const remainingServices = (projectEndOverall ? [] : projectServices(project))
    .filter((svc) => !coveredKeys.has(svc.serviceKey))
    .map((svc) => ({ serviceKey: svc.serviceKey, name: svc.name }));

  const needsReasonServices = covered
    .filter((svc) => svc.status === "needs_reason")
    .map((svc) => ({ serviceKey: svc.serviceKey, name: svc.serviceName }));

  const declined = covered.filter((svc) => svc.status === "declined").map((svc) => svc.serviceName);

  const hasOverall = conversationState.overallRating !== null
    && conversationState.overallRating !== undefined;

  // Two things a survey should always ask before it ends. Praise is why a
  // team hears they did well, and the final sweep is where the things that
  // matter most tend to arrive — a client raised an absent AVP only after
  // being asked whether there was anything else.
  const askedForPraise = Boolean(conversationState.askedForAppreciation);
  const appreciationAnswered = Boolean(conversationState.appreciationAnswered);
  const askedForAnythingElse = Boolean(conversationState.askedForAnythingElse);
  const anythingElseAnswered = Boolean(conversationState.anythingElseAnswered);
  const serviceScopeChoiceStillNeeded = conversationState.serviceScopeStatus === "awaiting_choice";
  const servicesFinished = !projectEndReviewStillNeeded && !serviceScopeChoiceStillNeeded
    && !remaining.length && !needsMore.length && !needsServiceFollowUp.length;

  return {
    servicesNotYetDiscussed: remaining,
    servicesNotYetDiscussedWithKeys: remainingServices,
    projectEndReviewStillNeeded,
    projectEndReviewCaptured: projectEndOverall,
    serviceScopeChoiceStillNeeded,
    stillToAsk: [
      ...(servicesFinished && !appreciationAnswered
        ? [askedForPraise
          ? "wait for their answer to the appreciation question"
          : "whether they would like to appreciate any team or department"]
        : []),
      ...(servicesFinished && appreciationAnswered && !anythingElseAnswered
        ? [askedForAnythingElse
          ? "wait for their answer about anything missed or feedback for management"
          : "whether any department was missed, or they have general feedback for management"]
        : [])
    ],
    servicesWhereWeStillDoNotKnowWhatIsWrong: needsMore,
    servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys: needsReasonServices,
    servicesWaitingForAnythingElseAnswer: needsServiceFollowUp,
    servicesTheyDeclinedToDiscuss: declined,
    servicesCovered: covered
      .filter((svc) => !unansweredKeys.has(svc.serviceKey))
      .map((svc) => ({
      name: svc.serviceName,
      sentiment: svc.sentiment,
      whatTheySaid: svc.reasonText || null
      })),
    // The ONLY rating we ask for. Per-service ratings turned the conversation
    // into a form, which is what made clients disengage.
    overallRatingStillNeeded: !hasOverall && servicesFinished
      && appreciationAnswered && anythingElseAnswered,
    npsStillNeeded: isProjectEnd && hasOverall && conversationState.npsScore === null,
    cycleType: isProjectEnd ? "project end" : "monthly pulse",
    turnsSoFar: conversationState.turnCount || 0,
    readyToClose: servicesFinished && appreciationAnswered && anythingElseAnswered && hasOverall
      && (!isProjectEnd || conversationState.npsScore !== null)
  };
}

// ---------------------------------------------------------------------
// Scoring (v2 — conversation aware)
//
// v1 scored every session, even one where the client said nothing, by
// falling back to the client's existing CSAT. v2 returns null until the
// client actually rates something. A null score is excluded from the
// weighted cycle roll-up, which is the honest behaviour.
// ---------------------------------------------------------------------

function scoreConversation(conversationState) {
  const services = Object.values(conversationState.mentionedServices);
  const ratedServices = services.filter((s) => s.rating !== null && s.rating !== undefined);

  // The score is exactly what the client said, on the 0-10 scale they were
  // asked. No doubling, no penalty, no inference. It has to be explainable to
  // leadership in one sentence, and reproducible on a rerun.
  if (conversationState.overallRating !== null && conversationState.overallRating !== undefined) {
    return Number(conversationState.overallRating);
  }
  if (ratedServices.length) {
    const mean = ratedServices.reduce((sum, s) => sum + s.rating, 0) / ratedServices.length;
    return Number(mean.toFixed(1));
  }
  return null;
}

function riskFor(score, conversationState, guardrails) {
  if (guardrails.includes(GUARDRAILS.ESCALATION)) return "High";
  const services = Object.values(conversationState.mentionedServices);
  const generalNegative = conversationState.generalSentiment === "negative";
  const hardNegative = services.some((s) => s.sentiment === "negative" && s.reasonText);
  const softNegative = services.some((s) => s.sentiment === "negative");
  const lowRating = services.some((s) => s.rating !== null && s.rating !== undefined && s.rating <= 4);

  if (lowRating) return "High";
  if (score !== null && score < 5) return "High";
  if (hardNegative && score === null) return "High";
  if (score !== null && score < 7) return "Watch";
  if (softNegative || generalNegative) return "Watch";
  return score === null ? null : "Low";
}

/**
 * An issue pages a service manager and starts an SLA clock, so it may only be
 * raised once that service's thread is settled AND the client gave something
 * more than the sentence that raised it. A rating of 1-2 counts on its own.
 */
function issueReadyFor(service, terminal) {
  if (service.sentiment !== "negative") return false;
  const settled = hasServiceRating(service) || service.status === "captured" || terminal;
  if (!settled) return false;
  const hasDetail =
    service.detailAnswered ||
    (service.reasonTags && service.reasonTags.length > 0) ||
    (service.rating !== null && service.rating !== undefined && service.rating <= 4);
  return Boolean(hasDetail);
}

function buildAnalysis(conversationState, project, poc, latestText, guardrails) {
  const services = Object.values(conversationState.mentionedServices);
  const worst = chooseWorstService(conversationState);
  const score = scoreConversation(conversationState);
  const riskLevel = riskFor(score, conversationState, guardrails);
  const isComplete = [STATES.COMPLETED, STATES.CLOSING_GRACE].includes(conversationState.state);
  const terminal = [STATES.COMPLETED, STATES.CLOSING_GRACE, STATES.OPTED_OUT, STATES.HANDED_OFF]
    .includes(conversationState.state);

  // A manager alert needs a real, actionable signal — not a bad mood, and
  // never a greeting. Escalation language always alerts.
  const actionableProblem = services.some(
    (s) => s.sentiment === "negative" && s.reasonText && String(s.reasonText).trim().length > 0
  );
  const requiresManagerAlert =
    guardrails.includes(GUARDRAILS.ESCALATION) || (riskLevel === "High" && actionableProblem);

  return {
    id: id("analysis"),
    text: latestText,
    sentiment: (worst && worst.sentiment) || "neutral",
    satisfaction: conversationState.overallRating,
    isComplete,
    completionStatus: isComplete ? "completed" : "partial",
    services: services.map((service) => ({
      serviceKey: service.serviceKey,
      serviceName: service.serviceName,
      sentiment: service.sentiment,
      rating: service.rating,
      reasonText: service.reasonText,
      reasonTags: service.reasonTags,
      detailAnswered: Boolean(service.detailAnswered),
      issueReady: issueReadyFor(service, terminal),
      ownerName: service.ownerName,
      ownerEmail: service.ownerEmail,
      managerName: service.managerName,
      managerEmail: service.managerEmail,
      internalPocId: service.internalPocId
    })),
    primaryServiceKey: (worst && worst.serviceKey) || null,
    primaryServiceName: (worst && worst.serviceName) || null,
    ownerName: (worst && worst.ownerName) || "Account Lead",
    ownerEmail: (worst && worst.ownerEmail) || null,
    managerEmail: (worst && worst.managerEmail) || null,
    csatScore: score,
    healthScore: score === null ? null : Math.round(score * 10),
    npsScore: conversationState.npsScore === undefined ? null : conversationState.npsScore,
    riskLevel,
    status: score === null ? null : statusFromScore(score),
    rootCause: worst && worst.reasonText
      ? `${worst.serviceName}: ${worst.reasonText}`
      : conversationState.generalSentiment === "negative" && conversationState.generalConcernText
        ? `Overall relationship: ${conversationState.generalConcernText}`
        : null,
    positiveSignal: services.filter((s) => s.sentiment === "positive").map((s) => s.serviceName).join(", ") || null,
    focusSignal: (worst && worst.serviceName) || null,
    escalationSignal: requiresManagerAlert ? `Alert ${(worst && worst.ownerName) || "Account Lead"}` : null,
    requiresManagerAlert,
    requiresCompletionReminder: !terminal,
    guardrails,
    offTopicQuestions: conversationState.offTopicQuestions || [],
    dueInHours: terminal ? null : 24,
    conversationState,
    projectId: project ? project.id : null,
    clientPocId: poc ? poc.id : null,
    createdAt: new Date().toISOString()
  };
}

// ---------------------------------------------------------------------
// Terminal turns (guardrails that short-circuit the flow)
// ---------------------------------------------------------------------

function terminalTurn({ conversationState, project, poc, text, state, guardrail, reply, control }) {
  conversationState.state = state;
  conversationState.guardrailHits = [...new Set([...(conversationState.guardrailHits || []), guardrail])];
  conversationState.missingFields = missingFields(conversationState);
  conversationState.pendingNegativeServices = negativeServices(conversationState);

  const analysis = buildAnalysis(conversationState, project, poc, text, conversationState.guardrailHits);

  return {
    conversationState,
    analysis,
    nextMessage: {
      speaker: "SRV Media MD Office",
      side: "srv",
      body: reply,
      metadata: { source: "whatsapp_state_machine", state, guardrail }
    },
    control: {
      guardrail,
      allowAiRephrase: false, // Gemini never improvises on a guardrail line
      sendReply: true,
      ...control
    }
  };
}

function plainTurn({ conversationState, project, poc, text, guardrails, body, state, guardrail, control }) {
  conversationState.state = state;
  conversationState.missingFields = missingFields(conversationState);
  if (guardrail) {
    conversationState.guardrailHits = [...new Set([...conversationState.guardrailHits, guardrail])];
  }
  return {
    conversationState,
    analysis: buildAnalysis(conversationState, project, poc, text, guardrails),
    nextMessage: {
      speaker: "SRV Media MD Office",
      side: "srv",
      body,
      metadata: { source: "whatsapp_state_machine", state, guardrail }
    },
    control: { guardrail, allowAiRephrase: false, sendReply: true, ...control }
  };
}

function currentPendingQuestion(conversationState, project, poc) {
  const serviceKey = conversationState.pendingServiceKey;
  const name = serviceKey ? serviceName(project, serviceKey) : null;
  const type = conversationState.pendingQuestionType;

  if (type === "project_end_review") return projectEndReviewQuestion(project);

  if (type === "service_scope" || conversationState.state === STATES.WAITING_FOR_SERVICE_SCOPE) {
    return SERVICE_SCOPE_QUESTION;
  }
  if (type === "issue_reason" || conversationState.state === STATES.WAITING_FOR_ISSUE_REASON) {
    return `What specifically should improve in ${name || "that service"}?`;
  }
  if (type === "service_followup" || conversationState.state === STATES.WAITING_FOR_SERVICE_FOLLOWUP) {
    return `Is there anything else about ${name || "that service"} we should know? If not, just reply no.`;
  }
  if (type === "service" || conversationState.state === STATES.WAITING_FOR_SERVICE_FEEDBACK) {
    return `How has ${name || "that service"} been for you?`;
  }
  if (type === "appreciation") {
    return "Is there any team or department you would like to appreciate?";
  }
  if (type === "final_sweep") {
    return "Did we miss any department, or is there anything you would like to share with management?";
  }
  if (type === "overall_rating" || conversationState.state === STATES.WAITING_FOR_OVERALL_RATING) {
    return overallRatingQuestion(conversationState, project);
  }
  if (type === "nps" || conversationState.state === STATES.WAITING_FOR_NPS) {
    return "How likely are you to recommend SRV Media to someone in your network, out of 10?";
  }

  const salutation = (poc && (poc.salutation || poc.name)) || "there";
  return conversationState.sessionType === "project_end"
    ? projectEndReviewQuestion(project)
    : `${salutation}, across your active SRV services (${formatServiceList(project)}), what is working well and what needs improvement?`;
}

// ---------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------

function processWhatsAppReply({
  session,
  project,
  poc,
  text,
  interpretation = null,
  geminiUnavailable = false,
  manualContext = false
}) {
  const conversationState = getConversationState(session);
  conversationState.turnCount = Number(conversationState.turnCount || 0) + 1;
  const progressBefore = conversationProgressSignature(conversationState);
  const guardrails = [];

  const salutation = (poc && (poc.salutation || poc.name)) || "there";
  let priorState = conversationState.state;
  // Keep the question this client reply is answering. nextQuestionFor mutates
  // pendingQuestionType while preparing the following question; consulting
  // that mutated value later made a valid final-sweep "no" look like a failed
  // answer to the newly prepared overall-rating question.
  const answeredQuestionType = conversationState.pendingQuestionType || null;

  // --- G2 opt-out: highest priority, overrides everything, stops reminders.
  if (isOptOut(text)) {
    conversationState.optedOut = true;
    const alreadyOptedOut = priorState === STATES.OPTED_OUT;
    return terminalTurn({
      conversationState, project, poc, text,
      state: STATES.OPTED_OUT,
      guardrail: GUARDRAILS.OPT_OUT,
      reply: "Certainly — I will not send any further feedback messages on this number. Thank you for your time.",
      control: {
        stopReminders: true,
        optOut: true,
        notify: alreadyOptedOut ? null : "opt_out",
        skipAnalysisWrite: alreadyOptedOut,
        suppressTerminalNotifications: alreadyOptedOut
      }
    });
  }

  // Asking who contacted them is not evidence of a wrong number. Introduce
  // the survey and repeat the pending question without alerting a human.
  if (isIdentityQuestion(text)) {
    return plainTurn({
      conversationState, project, poc, text, guardrails,
      state: priorState,
      body: `This is the SRV Media MD Office feedback line for ${project ? project.name : "your project"}. ${currentPendingQuestion(conversationState, project, poc)}`,
      control: { identityQuestion: true }
    });
  }

  // --- G4 wrong person / identity check.
  if (isWrongPerson(text)) {
    conversationState.handoffReason = "wrong_person";
    return terminalTurn({
      conversationState, project, poc, text,
      state: STATES.HANDED_OFF,
      guardrail: GUARDRAILS.WRONG_PERSON,
      reply: `Apologies for the confusion — this is the SRV Media MD Office feedback line for ${project ? project.name : "your project"}. If this number should not be receiving these messages, someone from our team will get in touch to correct our records.`,
      control: { stopReminders: true, notify: "wrong_person", handoff: true }
    });
  }

  // --- G7 escalation / abuse. It must run before G3 so a serious message sent
  // after completion is not downgraded to an ordinary late message.
  if (isEscalation(text)) {
    guardrails.push(GUARDRAILS.ESCALATION);
    const wasTerminal = [STATES.COMPLETED, STATES.HANDED_OFF, STATES.OPTED_OUT].includes(priorState);
    if (!wasTerminal) {
      for (const signal of extractServiceSignals(text, project)) {
        const service = ensureServiceState(conversationState, project, signal.serviceKey);
        setServiceSignal(service, signal.text, "negative", signal.reasons);
      }
      conversationState.handoffReason = "escalation";
    }
    return terminalTurn({
      conversationState, project, poc, text,
      state: wasTerminal ? priorState : STATES.HANDED_OFF,
      guardrail: GUARDRAILS.ESCALATION,
      reply: `I am sorry, ${salutation}. This needs a person, not a form — I have flagged it to the SRV leadership team right away and someone will contact you directly.`,
      control: {
        stopReminders: true,
        handoff: !wasTerminal,
        forceManagerAlert: true,
        skipAnalysisWrite: wasTerminal,
        suppressTerminalNotifications: true
      }
    });
  }

  // A client can correct an accidental rating or add one last point for ten
  // minutes after the closing message. The most recent valid rating wins. This
  // specifically prevents a quick "0 / sorry / take 8" sequence from freezing
  // the first number and treating the correction as a post-completion message.
  if (priorState === STATES.CLOSING_GRACE) {
    const expiresAt = Date.parse(conversationState.closingGraceExpiresAt || "");
    const graceIsOpen = Number.isFinite(expiresAt) && expiresAt > Date.now();

    if (graceIsOpen) {
      const ratingRead = detectNumber(text);
      const normalizedRating = ratingRead && ratingRead.scale === 5
        ? ratingRead.value * 2
        : ratingRead?.value;
      const validRating = ratingRead
        && normalizedRating >= 0
        && normalizedRating <= 10
        && (!ratingRead.scale || ratingRead.scale === 5 || ratingRead.scale === 10);
      const asksRecordedRating = /\b(what|which)\b.{0,20}\b(take|took|record(?:ed)?|rating|score)\b/i.test(text)
        || /\bwhat did (?:you|u) take\b/i.test(text);
      const signalsCorrection = /\b(sorry|mistake|correct(?:ion)?|change|instead|make that|take|actually)\b/i.test(text);

      if (validRating && (looksLikeRatingAnswer(text) || signalsCorrection)) {
        conversationState.overallRating = normalizedRating;
        conversationState.ratingCorrectedAt = new Date().toISOString();
        return plainTurn({
          conversationState, project, poc, text, guardrails,
          state: STATES.CLOSING_GRACE,
          body: `No problem — I have updated your overall rating to ${normalizedRating} out of 10. You can still add or correct anything until this 10-minute window closes.`,
          control: { suppressTerminalNotifications: true }
        });
      }

      if (asksRecordedRating || signalsCorrection) {
        const recorded = conversationState.overallRating;
        return plainTurn({
          conversationState, project, poc, text, guardrails,
          state: STATES.CLOSING_GRACE,
          body: `I currently have your overall rating as ${recorded} out of 10. If that was a mistake, please send the correct number before this 10-minute window closes.`,
          control: { suppressTerminalNotifications: true }
        });
      }

      if (isAcknowledgement(text) || soundsLikeFarewell(text)) {
        return plainTurn({
          conversationState, project, poc, text, guardrails,
          state: STATES.CLOSING_GRACE,
          body: `You are welcome, ${salutation}. Your feedback is recorded, and this correction window will close automatically.`,
          control: { suppressTerminalNotifications: true }
        });
      }

      // A genuine client question during the correction window should be
      // routed for an answer without reopening completed service questions.
      // Rating questions/corrections were handled above; feedback phrased as a
      // question continues through the normal capture path below.
      const feedbackQuestion = detectServices(text, project).length > 0
        || carriesFeedbackSignal(text)
        || interpretation?.intent === "feedback";
      const clientQuestion = isQuestionToUs(text) && !feedbackQuestion;
      if (clientQuestion) {
        guardrails.push(GUARDRAILS.OUT_OF_SCOPE);
        return plainTurn({
          conversationState, project, poc, text, guardrails,
          state: STATES.CLOSING_GRACE,
          guardrail: GUARDRAILS.OUT_OF_SCOPE,
          body: `I have passed your question to the SRV team and they will respond to you directly. Your 10-minute correction window remains open in case you want to add or correct anything else.`,
          control: {
            collectOffTopic: text,
            offScript: "out_of_scope",
            suppressTerminalNotifications: true
          }
        });
      }

      // Substantive feedback inside the window reopens the checklist. The new
      // point is captured normally and must be acknowledged before closing
      // again. Do not erase the already-answered appreciation/final-sweep
      // markers: doing that restarted the completed survey after every add-on.
      conversationState.state = STATES.WAITING_FOR_MORE_SERVICES;
      conversationState.pendingQuestionType = null;
      conversationState.reopenedDuringClosingGrace = true;
      priorState = STATES.WAITING_FOR_MORE_SERVICES;
    } else {
      conversationState.state = STATES.COMPLETED;
      priorState = STATES.COMPLETED;
    }
  }

  // --- G3 post-completion: never silently swallowed.
  // v1 let Gemini invent "I have noted your issue" after the session closed;
  // v2 answers honestly and routes the raw text to a human.
  const reopened = false;
  if ([STATES.COMPLETED, STATES.HANDED_OFF, STATES.OPTED_OUT].includes(priorState)) {
    const noActionNeeded = isAcknowledgement(text) || (looksLikeRatingAnswer(text) && Boolean(detectNumber(text)));
    const isNewComplaint = !noActionNeeded && (
      detectServices(text, project).length > 0
      || detectSentiment(text) === "negative"
      || carriesFeedbackSignal(text)
      || /\b(inaccurate|incorrect|absent|unavailable|not available|not responding|not picking|didn'?t attend|did not attend)\b/i.test(text)
    );
    return terminalTurn({
      conversationState, project, poc, text,
      state: priorState,
      guardrail: GUARDRAILS.POST_COMPLETION,
      reply: priorState === STATES.HANDED_OFF
        ? `Thank you, ${salutation}. Someone from the SRV team will be in touch about this shortly.`
        : isNewComplaint
          ? `Thank you, ${salutation}. This feedback cycle is already closed, so I cannot add this to the completed pulse — but I have passed your message to the SRV team and someone will come back to you directly.`
          : `Thank you, ${salutation}. Your feedback for this cycle is already recorded. If anything else comes up, the SRV team is a message away.`,
      control: {
        stopReminders: true,
        notify: noActionNeeded || isNewComplaint ? null : "post_completion_message",
        notifyText: text,
        skipAnalysisWrite: true, // do not touch scores on a closed session
        forceManagerAlert: isNewComplaint,
        suppressTerminalNotifications: true
      }
    });
  }

  // --- G5 global turn cap. Never pre-empt a valid answer or meaningful prose.
  // It is only a last resort after repeated no-signal turns during a confirmed
  // model outage; ordinary non-convergence is handled by the per-question caps.
  if (
    conversationState.turnCount > MAX_TURNS_BEFORE_HANDOFF
    && geminiUnavailable
    && Number(conversationState.noSignalStreak || 0) >= 2
    && !isUnambiguous(text)
  ) {
    conversationState.handoffReason = "turn_cap";
    return terminalTurn({
      conversationState, project, poc, text,
      state: STATES.HANDED_OFF,
      guardrail: GUARDRAILS.PROBE_CAP,
      reply: `Thank you for the detail, ${salutation}. Rather than keep this on chat, I have asked the SRV team to call you so nothing gets lost.`,
      control: { stopReminders: true, notify: "handoff", handoff: true }
    });
  }

  // --- G10 unparseable input: re-ask once, then hand off.
  // A long, well-formed sentence is never gibberish. This guard is for "xkcdgrtz",
  // not for a client explaining that an AVP has stopped answering their calls —
  // which it rejected as unparseable and handed off, losing the most important
  // thing in the conversation.
  const worthInterpreting = String(text || "").trim().split(/\s+/).length >= 4;

  if (isUnparseable(text) && !worthInterpreting) {
    guardrails.push(GUARDRAILS.UNPARSEABLE);
    conversationState.unparseableCount = Number(conversationState.unparseableCount || 0) + 1;
    if (conversationState.unparseableCount >= 2) {
      return terminalTurn({
        conversationState, project, poc, text,
        state: STATES.HANDED_OFF,
        guardrail: GUARDRAILS.UNPARSEABLE,
        reply: "Sorry, I am not able to read that clearly. I have asked someone from the SRV team to reach out to you directly.",
        control: { stopReminders: true, notify: "handoff", handoff: true }
      });
    }
    const retry = nextQuestionFor(conversationState, project, poc);
    conversationState.pendingServiceKey = retry.pendingServiceKey || null;
    return plainTurn({
      conversationState, project, poc, text, guardrails,
      state: retry.state,
      guardrail: GUARDRAILS.UNPARSEABLE,
      body: `Sorry, I did not follow that. ${retry.text}`,
      control: { offScript: "unparseable", pendingQuestion: retry.text }
    });
  }

  // --- G6 client asks us something unrelated to feedback.
  // Billing, invoices, contracts, named people and internal processes are
  // legitimate feedback observations. Let Gemini read those before deciding;
  // the old keyword guard intercepted "your billings are inaccurate" and
  // appended a legacy per-service rating question.
  const explicitlyOffTopic = interpretation?.intent === "off_topic";
  const serviceFeedbackQuestion = detectServices(text, project).length > 0
    || carriesFeedbackSignal(text)
    || interpretation?.intent === "feedback";
  const unrelatedQuestion = isQuestionToUs(text) && !isOutOfScope(text) && !serviceFeedbackQuestion;
  const outageFallbackOffTopic = geminiUnavailable
    && isOutOfScope(text)
    && !detectServices(text, project).length;
  if (explicitlyOffTopic || unrelatedQuestion || outageFallbackOffTopic) {
    guardrails.push(GUARDRAILS.OUT_OF_SCOPE);
    const resume = nextQuestionFor(conversationState, project, poc);
    conversationState.pendingServiceKey = resume.pendingServiceKey || null;
    return plainTurn({
      conversationState, project, poc, text, guardrails,
      state: resume.state,
      guardrail: GUARDRAILS.OUT_OF_SCOPE,
      body: `I have passed that to the SRV team and they will respond to you directly — I only collect feedback here. ${resume.text}`,
      control: {
        // Batched, not sent now. One email at session end beats three
        // interruptions — but see the terminal case below.
        collectOffTopic: text,
        // The API layer may ask Gemini for a warmer decline clause. It only
        // ever replaces the FIRST sentence; the question below is appended by
        // the caller, so the model never authors a whole turn.
        offScript: "out_of_scope",
        pendingQuestion: resume.text
      }
    });
  }

  // ------------------------------------------------------------------
  // Normal capture path
  // ------------------------------------------------------------------

  // Checked first: a deferral is a complete answer in itself. Letting it reach
  // the capture path is how "I am busy now" became an Account Management
  // complaint — a synonym matched inside a sentence that was not feedback.
  if ((isDeferral(text) || interpretation?.deferRequested === true)
    && (interpretation || geminiUnavailable)) {
    conversationState.deferredAt = new Date().toISOString();
    conversationState.repeatCount = 0;
    conversationState.missingFields = missingFields(conversationState);
    return {
      conversationState,
      analysis: buildAnalysis(conversationState, project, poc, text, guardrails),
      nextMessage: {
        speaker: "SRV Media MD Office",
        side: "srv",
        body: DEFERRAL_REPLY,
        metadata: { source: "whatsapp_state_machine", state: priorState, deferred: true }
      },
      // Flexible wording may need Gemini to identify the intent, but once it
      // is known to be a deferral there is no next-question decision to make.
      // A second generation call can only add latency or override this reply.
      control: { allowAiRephrase: false, sendReply: true, deferred: true }
    };
  }

  // Coming back after a deferral. Re-ask what we were waiting on, and do not
  // count it as a failure to understand — the client is doing exactly the right
  // thing.
  if (conversationState.deferredAt && isResumption(text) && !isDeferral(text)) {
    conversationState.deferredAt = null;
    conversationState.resumptionPromptedAt = new Date().toISOString();
    conversationState.repeatCount = 0;
    const pendingQuestion = currentPendingQuestion(conversationState, project, poc);
    conversationState.missingFields = missingFields(conversationState);
    conversationState.lastQuestionAsked = pendingQuestion;
    return {
      conversationState,
      analysis: buildAnalysis(conversationState, project, poc, text, guardrails),
      nextMessage: {
        speaker: "SRV Media MD Office",
        side: "srv",
        body: /^(thank|thanks)/i.test(pendingQuestion) ? pendingQuestion : `Great, let us continue. ${pendingQuestion}`,
        metadata: { source: "whatsapp_state_machine", state: priorState, resumed: true }
      },
      // Gemini already did its job when it identified the client as ready.
      // Re-running the conductor here used to mark the pending service as
      // answered even though the client had not said anything about it.
      control: { allowAiRephrase: false, sendReply: true, resumed: true }
    };
  }

  // A client commonly sends "Ready" and "Let's start" as two consecutive
  // WhatsApp bubbles. The first bubble has already resumed the conversation
  // and re-asked the pending question. The second is still only a control
  // message; it is not neutral feedback about whichever service is pending.
  // Suppress a duplicate prompt for a short window while keeping the inbound
  // client message in the transcript.
  const resumptionPromptedAt = Date.parse(conversationState.resumptionPromptedAt || "");
  const recentResumptionPrompt = Number.isFinite(resumptionPromptedAt)
    && Date.now() - resumptionPromptedAt >= 0
    && Date.now() - resumptionPromptedAt <= 60 * 1000;
  const waitingForServiceFeedback = conversationState.pendingQuestionType === "service"
    || priorState === STATES.WAITING_FOR_SERVICE_FEEDBACK;
  // After a dashboard user sends a manual WhatsApp message, a short "okay"
  // acknowledges that message; it must not be silently recorded as feedback
  // about whichever service happened to be pending beforehand. Substantive
  // replies still pass through normal service/observation capture.
  const directServiceOpinion = !manualContext
    && waitingForServiceFeedback
    && isShortServiceOpinion(text);
  const continuationOnly = isAcknowledgement(text)
    && !directServiceOpinion
    && (interpretation?.intent === "affirmative" || !interpretation)
    && !isDeferral(text);
  if (recentResumptionPrompt && continuationOnly) {
    conversationState.repeatCount = 0;
    conversationState.missingFields = missingFields(conversationState);
    return {
      conversationState,
      analysis: buildAnalysis(conversationState, project, poc, text, guardrails),
      nextMessage: {
        speaker: "SRV Media MD Office",
        side: "srv",
        body: currentPendingQuestion(conversationState, project, poc),
        metadata: { source: "whatsapp_state_machine", state: priorState, continuationSuppressed: true }
      },
      control: {
        allowAiRephrase: false,
        sendReply: false,
        suppressReply: true,
        resumed: true
      }
    };
  }

  // Even outside the short burst window, "yes", "ready" and "let's start"
  // do not answer "How has this service been?". Keep the same service pending
  // and ask for the actual feedback instead of converting conversational
  // readiness into a neutral service response.
  if (continuationOnly && waitingForServiceFeedback) {
    conversationState.repeatCount = 0;
    conversationState.missingFields = missingFields(conversationState);
    const pendingQuestion = currentPendingQuestion(conversationState, project, poc);
    conversationState.lastQuestionAsked = pendingQuestion;
    return {
      conversationState,
      analysis: buildAnalysis(conversationState, project, poc, text, guardrails),
      nextMessage: {
        speaker: "SRV Media MD Office",
        side: "srv",
        body: `Certainly. ${pendingQuestion}`,
        metadata: { source: "whatsapp_state_machine", state: priorState, continuationOnly: true }
      },
      control: { allowAiRephrase: false, sendReply: true, resumed: true }
    };
  }

  const detectedNumber = detectNumber(text);
  const numberIsAnswer = detectedNumber ? looksLikeRatingAnswer(text) : false;

  // Gemini read the intent because the rules could not. It never decides what
  // happens next — it only tells us what the client meant.
  const said = {
    yes: interpretation ? interpretation.intent === "affirmative" : false,
    no: interpretation ? interpretation.intent === "negative" : false,
    wantsToSayMore: interpretation ? interpretation.intent === "more_detail" : false,
    later: interpretation
      ? interpretation.intent === "defer" || interpretation.deferRequested === true
      : false,
    sentiment: interpretation ? interpretation.sentiment : null,
    rating: interpretation && interpretation.rating !== null ? interpretation.rating : null
  };
  // Did the client say WHAT is wrong, or only that something is wrong?
  // Keywords alone cannot tell: "organic visibility has dropped off" is a
  // complete explanation that no word list covers, and re-asking for it makes
  // the bot look as if it was not listening. Either source may say yes — the
  // safer error is trusting a client who already told us.
  const explainedProblem = Boolean(interpretation && interpretation.explainsProblem)
    || detectReasons(text).length > 0;

  const emoji = emojiSentiment(text);
  const sentiment = emoji || detectSentiment(text);
  const reasons = detectReasons(text);
  // Same precedence everywhere: if Gemini named services, those are the
  // services this message is about.
  // Billing, contracts and named-person/leadership feedback are observations,
  // not service feedback. Gemini may recognise a nearby service as context;
  // the explicit observation classification prevents that context from
  // corrupting the service's notes and sentiment.
  const modelServiceKeys = interpretation?.isObservation
    ? []
    : (interpretation && interpretation.serviceKeys) || [];
  const detectedServiceKeys = interpretation?.isObservation
    ? []
    : modelServiceKeys.length
      ? modelServiceKeys.filter((key) => activeServiceKeys(project).has(key))
      : detectServices(text, project);

  const answeringServiceScope = answeredQuestionType === "service_scope"
    || priorState === STATES.WAITING_FOR_SERVICE_SCOPE;
  let serviceScopeDecision = interpretation?.serviceScope
    && interpretation.serviceScope !== SERVICE_SCOPE_DECISIONS.NONE
    ? interpretation.serviceScope
    : explicitServiceScopeDecision(text, answeringServiceScope);
  if (answeringServiceScope) {
    if (detectedServiceKeys.length || said.yes) {
      serviceScopeDecision = SERVICE_SCOPE_DECISIONS.CONTINUE_SERVICE_BY_SERVICE;
    } else if (said.no) {
      serviceScopeDecision = SERVICE_SCOPE_DECISIONS.SKIP_REMAINING_SERVICES;
    }
  }

  const expectsRating = [
    STATES.WAITING_FOR_SERVICE_RATING,
    STATES.WAITING_FOR_OVERALL_RATING
  ].includes(priorState) && (
    priorState === STATES.WAITING_FOR_SERVICE_RATING
    || conversationState.overallRatingAsked === true
    || conversationState.pendingQuestionType === "overall_rating"
  );
  const expectsNps = priorState === STATES.WAITING_FOR_NPS;

  let rating = null;
  let npsAnswer = null;

  if (detectedNumber) {
    if (expectsNps) {
      if (detectedNumber.value >= 0 && detectedNumber.value <= 10) {
        npsAnswer = detectedNumber.value;
      } else {
        // --- G8 out-of-scale answer: never clamp or guess, however many times
        // the client mistypes it.
        conversationState.invalidRatingWarned = true;
        guardrails.push(GUARDRAILS.INVALID_RATING);
        return plainTurn({
          conversationState, project, poc, text, guardrails,
          state: STATES.WAITING_FOR_NPS,
          guardrail: GUARDRAILS.INVALID_RATING,
          body: "Just to confirm — the scale here is 0 to 10. How likely are you to recommend SRV Media?"
        });
      }
    } else if (expectsRating && numberIsAnswer) {
      const scale = detectedNumber.scale;
      if (scale === 5 && detectedNumber.value >= 0 && detectedNumber.value <= 5) {
        rating = detectedNumber.value * 2; // client answered "4/5" on the old scale
      } else if (detectedNumber.value >= 0 && detectedNumber.value <= 10 && (!scale || scale === 10)) {
        // Stored exactly as given, decimals included. 6.5 means 6.5.
        rating = detectedNumber.value;
      } else {
        conversationState.invalidRatingWarned = true;
        guardrails.push(GUARDRAILS.INVALID_RATING);
        return plainTurn({
          conversationState, project, poc, text, guardrails,
          state: priorState,
          guardrail: GUARDRAILS.INVALID_RATING,
          body: "Just to confirm — the scale here is 0 to 10, where 10 is best. Which number would you give?"
        });
      }
    } else if (!expectsRating && numberIsAnswer) {
      // --- G9 a bare number outside a rating question is not a rating.
      // v1 grabbed any 1-5 anywhere and could score a phone number.
      guardrails.push(GUARDRAILS.BARE_NUMBER);
    }
  }

  // The client asked to answer later. Repeating the question ignores what they
  // said; the reminder flow is what should follow up. Keep the state as it is
  // so the same question is waiting when they come back.
  if (said.later) {
    conversationState.deferredAt = new Date().toISOString();
    conversationState.repeatCount = 0;
    conversationState.missingFields = missingFields(conversationState);
    return {
      conversationState,
      analysis: buildAnalysis(conversationState, project, poc, text, guardrails),
      nextMessage: {
        speaker: "SRV Media MD Office",
        side: "srv",
        body: DEFERRAL_REPLY,
        metadata: { source: "whatsapp_state_machine", state: priorState, deferred: true }
      },
      control: { allowAiRephrase: false, sendReply: true, deferred: true }
    };
  }

  if (expectsNps && npsAnswer !== null) {
    conversationState.npsScore = npsAnswer;
  } else if (priorState === STATES.WAITING_FOR_SERVICE_RATING && conversationState.pendingServiceKey && rating !== null) {
    const service = ensureServiceState(conversationState, project, conversationState.pendingServiceKey);
    applyRating(service, rating);
  } else if (
    priorState === STATES.WAITING_FOR_SERVICE_RATING &&
    conversationState.pendingServiceKey &&
    rating === null &&
    (isMoveOnReply(text) || isVagueDetailResponse(text))
  ) {
    // Client declines to rate: accept it and move on rather than loop.
    const service = ensureServiceState(conversationState, project, conversationState.pendingServiceKey);
    service.detailAsked = true;
    service.status = "captured";
  } else if (priorState === STATES.WAITING_FOR_SERVICE_FOLLOWUP && conversationState.pendingServiceKey) {
    const service = ensureServiceState(conversationState, project, conversationState.pendingServiceKey);
    const movedToAnotherService = detectedServiceKeys.length > 0
      && !detectedServiceKeys.includes(conversationState.pendingServiceKey);
    if (movedToAnotherService) {
      // Naming and discussing another service is a natural way to move on.
      // Do not force the client to go back and explicitly say "no", and never
      // append the new service's complaint to the previous service's notes.
      service.status = "captured";
    } else if (guardrails.includes(GUARDRAILS.BARE_NUMBER)) {
      // A number is not an answer to "anything else about this service?" and
      // must never become a forbidden per-service rating or reason text.
    } else if (!geminiUnavailable && (isMoveOnReply(text) || isNegativeSkip(text))) {
      service.status = "captured";
    } else if (
      // A decline is not detail. Trust Gemini's reading first, since "Not now.
      // Let's proceed further" defeats any keyword list — it landed inside the
      // root cause as though the client had complained about it.
      !(interpretation && ["negative", "affirmative"].includes(interpretation.intent))
      && !isMoveOnReply(text) && !isNegativeSkip(text) && !isVagueDetailResponse(text)
    ) {
      // Genuine extra detail — append it rather than overwrite what they said.
      service.reasonText = service.reasonText ? `${service.reasonText}. ${text}` : text;
      service.reasonTags = [...new Set([...(service.reasonTags || []), ...reasons])];
      service.detailAnswered = true;
      service.noteNeedsAck = true;
      service.serviceFollowUpAskCount = 0;
      // A niggle mentioned after praise is worth capturing, but on its own it
      // is not a complaint. Only a low rating turns a praised service into an
      // issue for an owner to action.
      if (service.sentiment === "positive") service.praiseWithNote = true;
    }
  } else if (
    [STATES.WAITING_FOR_ISSUE_REASON, STATES.WAITING_FOR_SERVICE_FEEDBACK].includes(priorState) &&
    conversationState.pendingServiceKey &&
    (isVagueDetailResponse(text) || isMoveOnReply(text))
  ) {
    // A vague answer to the follow-up is NOT detail — it must not open an issue.
    const service = ensureServiceState(conversationState, project, conversationState.pendingServiceKey);
    const positiveOverall = /\b(working well|well overall|all good|good overall|fine overall|going well)\b/i.test(text) || sentiment === "positive";
    if (positiveOverall && service.sentiment !== "negative") {
      service.sentiment = "positive";
      service.reasonText = service.reasonText || "Client says it is working well overall.";
    } else {
      if (service.sentiment === "neutral" && isVagueDetailResponse(text)) service.sentiment = "negative";
      service.reasonText = service.reasonText || "Client could not specify further details.";
    }
    service.detailAsked = true;
    service.status = hasServiceRating(service) ? "rated" : "needs_rating";
  } else if (priorState === STATES.WAITING_FOR_OVERALL_RATING && rating !== null) {
    conversationState.overallRating = rating;
  } else if (isGreetingOnly(text) && !detectedServiceKeys.length && !emoji && !directServiceOpinion) {
    // --- G11 a greeting is not feedback: no service, no score, no issue.
    guardrails.push(GUARDRAILS.NO_SIGNAL);
  } else {
    // Gemini read the whole sentence; the word lists match fragments. When they
    // disagree, the model wins. This is the difference between "keyword search
    // optimisation" being understood as SEO and being missed entirely because
    // no synonym happened to cover the client's vocabulary.
    const modelSignals = modelServiceKeys
      .filter((key) => activeServiceKeys(project).has(key))
      .map((serviceKey) => ({
        serviceKey,
        text,
        sentiment: (interpretation && interpretation.sentiment) || sentiment,
        reasons
      }));

    const signals = modelSignals.length ? modelSignals : extractServiceSignals(text, project);

    // Did the client say WHAT is wrong, or only that something is wrong?
    // Keywords alone cannot tell: "organic visibility has dropped off" is a
    // complete explanation that no word list covers, and re-asking for it makes
    // the bot look as if it was not listening. Either source may say yes — the
    // safer error is trusting a client who already told us.
    const explained = explainedProblem;

    // While we are waiting for a RATING, an unrecognised reply is not feedback.
    // Falling through to the capture path let "6.5" overwrite the real reason
    // ("landing page has latency, reports are not on time") — the complaint was
    // destroyed and the issue was titled "6.5".
    const awaitingRating = priorState === STATES.WAITING_FOR_SERVICE_RATING
      || priorState === STATES.WAITING_FOR_OVERALL_RATING;

    const feedbackWithoutAService = interpretation?.intent === "feedback"
      && (interpretation.isObservation === true || modelServiceKeys.length === 0);
    const pendingReplyIsOnlyControl = (isAcknowledgement(text) || interpretation?.intent === "affirmative")
      && !directServiceOpinion;
    const effectiveSignals = signals.length
      ? signals
      : (conversationState.pendingServiceKey
          && !awaitingRating
          && !feedbackWithoutAService
          && !pendingReplyIsOnlyControl)
        ? [{ serviceKey: conversationState.pendingServiceKey, text, sentiment, reasons }]
        : [];

    for (const signal of effectiveSignals) {
      const service = ensureServiceState(conversationState, project, signal.serviceKey);
      // Mark it BEFORE the status is derived, so an explained problem moves
      // straight to "anything else?" instead of being asked to explain again.
      if (explained) service.detailAnswered = true;
      setServiceSignal(service, signal.text, signal.sentiment || sentiment, signal.reasons);
      // Detail counts only when it answers our explicit follow-up about THIS
      // service. The sentence that raised the complaint is not its own reason.
      if (
        [STATES.WAITING_FOR_ISSUE_REASON, STATES.WAITING_FOR_SERVICE_FEEDBACK].includes(priorState) &&
        conversationState.pendingServiceKey === signal.serviceKey
      ) {
        service.detailAnswered = true;
        // The question has been answered — move the service on, or the next
        // turn asks for the reason all over again.
        if (!hasServiceRating(service)) service.status = "needs_rating";
      }
    }

    if (!effectiveSignals.length && rating !== null && !hasOverallRating(conversationState) && isAffirmative(text)) {
      conversationState.overallRating = rating;
    }
    if (!effectiveSignals.length && rating === null) {
      // An acknowledgement is not an opinion about our services.
      const blanket = !isAcknowledgement(text)
        && (sentiment !== "neutral" || isMoveOnReply(text));
      if (blanket) {
        // Feedback about the engagement as a whole, with no service named.
        conversationState.generalSentiment = sentiment === "neutral" ? "positive" : sentiment;
        conversationState.generalConcernText = conversationState.generalConcernText || text;
        if (conversationState.generalSentiment !== "negative" || conversationState.generalNegativeProbed) {
          conversationState.readyForOverallRating = true;
        }
      } else {
        guardrails.push(GUARDRAILS.NO_SIGNAL);
        conversationState.noSignalStreak = Number(conversationState.noSignalStreak || 0) + 1;
      }
    }
  }

  // "Mo", "Not", "nope" — typos and shorthand the word list cannot cover.
  if (priorState === STATES.WAITING_FOR_MORE_SERVICES && said.no && !detectedServiceKeys.length) {
    conversationState.readyForOverallRating = true;
  } else if (priorState === STATES.WAITING_FOR_SERVICE_FOLLOWUP && said.no) {
    const service = ensureServiceState(conversationState, project, conversationState.pendingServiceKey);
    if (!hasServiceRating(service)) service.status = "captured";
  } else if (priorState === STATES.WAITING_FOR_MORE_SERVICES && (isNegativeSkip(text) || isMoveOnReply(text)) && !detectedServiceKeys.length) {
    conversationState.readyForOverallRating = true;
    conversationState.overallRating = rating ?? conversationState.overallRating;
  } else if (
    priorState === STATES.WAITING_FOR_MORE_SERVICES &&
    !detectedServiceKeys.length &&
    isNonSpecificContinuation(text)
  ) {
    conversationState.readyForOverallRating = true;
  }

  // Scope is applied after ordinary capture so an explicit skip cannot be
  // undone by the same message being captured against the service we happened
  // to ask about. Concrete feedback remains recorded; only further questions
  // are suppressed.
  applyServiceScopeDecision(conversationState, project, serviceScopeDecision, {
    text,
    sentiment: interpretation?.sentiment || sentiment
  });

  if (!guardrails.includes(GUARDRAILS.NO_SIGNAL)) conversationState.noSignalStreak = 0;

  // The client explicitly wants to add more. Reopen the service so the next
  // question invites detail instead of repeating the rating request.
  // "more_detail" means the client is ASKING for another chance to speak. If we
  // are already asking them for that service's detail, their reply IS the
  // detail — reopening it there undid the answer and re-asked the same
  // question forever.
  const alreadyAskingForDetail = [
    STATES.WAITING_FOR_ISSUE_REASON,
    STATES.WAITING_FOR_SERVICE_FEEDBACK,
    STATES.WAITING_FOR_SERVICE_FOLLOWUP
  ].includes(priorState);

  // A message that EXPLAINS the problem is not a request for another turn to
  // speak. Reopening the service here reset it to "needs reason" and asked the
  // client to explain what they had just explained.
  if (said.wantsToSayMore && !alreadyAskingForDetail && !explainedProblem) {
    const key = conversationState.pendingServiceKey || modelServiceKeys[0] || null;
    if (key) {
      const service = ensureServiceState(conversationState, project, key);
      service.followUpAsked = false;
      service.detailAsked = false;
      service.probeCount = Math.max(0, (service.probeCount || 1) - 1);
      if (!hasServiceRating(service)) service.status = "needs_reason";
      conversationState.pendingServiceKey = key;
    }
  }

  // Gemini judged the sentiment where the word list could not. A number, when
  // one exists, still wins over both.
  if (said.sentiment && conversationState.pendingServiceKey) {
    const service = conversationState.mentionedServices[conversationState.pendingServiceKey];
    if (service && !hasServiceRating(service) && service.sentiment === "neutral") {
      service.sentiment = said.sentiment;
    }
  }

  // The rules only claim to understand an EXACT answer. Anything else goes to
  // Gemini, even when a keyword happened to match — a match is not
  // comprehension, and treating it as such is what produced every wrong record
  // in this file.
  // During an outage the keywords may act — but only when they actually
  // captured something. "geminiUnavailable" permits fallback matching; it must
  // never stand in for comprehension, or an unreadable reply gets silently
  // accepted and the client is asked the same question forever.
  const keywordsCaptured = !guardrails.includes(GUARDRAILS.NO_SIGNAL);
  const understood = Boolean(interpretation)
    || Boolean(isUnambiguous(text))
    || (geminiUnavailable && keywordsCaptured);

  const materialProgress = conversationProgressSignature(conversationState) !== progressBefore;
  const next = nextQuestionFor(conversationState, project, poc);

  // Repeating a message word for word makes the bot look broken and leaves the
  // client with no idea what went wrong. Say we did not follow, then re-ask.
  // Watch the question itself. Believing we understood a reply is not evidence
  // that the conversation moved — the client answered five times and got the
  // identical question back because each turn "understood" something.
  const repeatedSameQuestion = next.text === conversationState.lastQuestionAsked;
  const acceptedExpectedScore = (expectsNps && npsAnswer !== null)
    || (priorState === STATES.WAITING_FOR_SERVICE_RATING && rating !== null)
    || (priorState === STATES.WAITING_FOR_OVERALL_RATING && rating !== null);
  const structuredInterruption =
    /\b(?:one more|another|additional|more)\s+(?:issue|problem|concern|complaint|point|thing)\b/i.test(text)
    || materialProgress
    || (Boolean(interpretation)
      && interpretation.intent === "feedback"
      && interpretation.isObservation === true);
  // These are valid control answers even when this legacy question chooser
  // cannot itself update the checklist marker. The API checklist consumes the
  // answer immediately afterwards. Counting "no" or "that's it" as a repeat
  // allowed a perfectly valid final answer to become the third miss and caused
  // an unnecessary human-handoff email.
  const expectsConversationControl = [
    "service_scope",
    "service_followup",
    "appreciation",
    "final_sweep",
    "observation_followup",
    "general_issue_detail",
    "issue_reason"
  ].includes(answeredQuestionType)
    || priorState === STATES.WAITING_FOR_SERVICE_FOLLOWUP;
  const acceptedConversationControl = expectsConversationControl
    && (isMoveOnReply(text) || soundsLikeFarewell(text) || said.no);
  conversationState.lastQuestionAsked = next.text;
  if (
    repeatedSameQuestion
    && !structuredInterruption
    && !acceptedExpectedScore
    && !acceptedConversationControl
  ) {
    conversationState.repeatCount = Number(conversationState.repeatCount || 0) + 1;
    // The wording is identical whether Gemini was down or the client typed
    // something unreadable. They cannot act on the difference, and naming our
    // infrastructure to a client invites doubt about whether their feedback is
    // being recorded at all. The real reason is in the message metadata.
    if (conversationState.repeatCount === 1) {
      next.text = `Sorry, I did not follow that. ${next.text}`;
    } else if (conversationState.repeatCount === 2) {
      next.text = `I am still not sure I follow. If you would like to move on, just reply "no". ${next.text}`;
    } else {
      // Three misses is not a client who needs asking again — it is a
      // conversation that needs a person.
      conversationState.state = STATES.HANDED_OFF;
      conversationState.handoffReason = "not_understood";
      conversationState.missingFields = missingFields(conversationState);
      return {
        conversationState,
        analysis: buildAnalysis(conversationState, project, poc, text, guardrails),
        nextMessage: {
          speaker: "SRV Media MD Office",
          side: "srv",
          body: "I am sorry — I am not following this properly. I have asked someone from the SRV team to reach out to you directly.",
          metadata: { source: "whatsapp_state_machine", state: STATES.HANDED_OFF, guardrail: GUARDRAILS.UNPARSEABLE }
        },
        control: {
          allowAiRephrase: false,
          sendReply: true,
          stopReminders: true,
          notify: "handoff",
          handoff: true,
          guardrail: GUARDRAILS.UNPARSEABLE
        }
      };
    }
  } else {
    // Explicit issue interruptions, non-service observations and valid scores
    // are real progress. The checklist conductor may intentionally replace
    // this legacy message, so unchanged legacy text is not a failed attempt.
    conversationState.repeatCount = 0;
  }

  conversationState.state = next.state;
  if (next.state === STATES.CLOSING_GRACE) {
    const existingExpiry = Date.parse(conversationState.closingGraceExpiresAt || "");
    if (!Number.isFinite(existingExpiry) || existingExpiry <= Date.now()) {
      conversationState.closingGraceExpiresAt = new Date(Date.now() + CLOSING_GRACE_MS).toISOString();
    }
    const rating = conversationState.overallRating;
    next.text = `Thank you, ${salutation}. Your feedback and rating of ${rating} out of 10 have been successfully recorded for confidential review by the Directors.\n\nIf your feedback includes a concern or an area for improvement, the system has created the necessary action item and notified the Directors. It will be handled constructively and discreetly.\n\nThis feedback session will remain active for the next 10 minutes. During this time, you can add anything else you would like the Directors to know, revise your rating, share further feedback or appreciation, ask a question, or request a callback.\n\nAfter 10 minutes, this automated feedback session will close. You can, of course, contact SRV Media at any time if you need us.\n\nThank you again for your honesty, time and trust. Please take care, and we look forward to connecting with you again next month.`;
  }
  conversationState.pendingServiceKey = next.pendingServiceKey || null;
  conversationState.pendingNegativeServices = negativeServices(conversationState);
  conversationState.missingFields = missingFields(conversationState);
  conversationState.unparseableCount = 0;
  if (guardrails.length) {
    conversationState.guardrailHits = [...new Set([...conversationState.guardrailHits, ...guardrails])];
  }

  // Nothing was captured and nothing moved: the rules did not understand this
  // reply. The API layer may ask Gemini to interpret it and run the turn again.
  return {
    conversationState,
    analysis: buildAnalysis(conversationState, project, poc, text, guardrails),
    // A message may provide real feedback and also ask to continue later. The
    // preliminary rules can spot both signals, but only the structured model
    // read can split every service/observation/appreciation before we defer.
    needsInterpretation: !understood || (!interpretation && isDeferral(text)),
    nextMessage: {
      speaker: "SRV Media MD Office",
      side: "srv",
      // The pending question may already greet them by name; do not do it twice.
      body: reopened
        ? `Thanks for coming back, ${salutation}. ${next.text.replace(new RegExp(`^(thank you|thanks),?\\s*${escapeRegex(salutation)}[.,]?\\s*`, "i"), "")}`
        : next.text,
      metadata: {
        source: "whatsapp_state_machine",
        state: conversationState.state,
        missingFields: conversationState.missingFields,
        guardrails
      }
    },
    control: {
      // When we are apologising for not understanding, ship our own words.
      // Gemini rewording an apology ("Sorry, I did not catch that") makes a
      // failed interpretation look like a normal turn, and hides from the
      // dashboard that the model could not read the reply.
      // A structured Gemini interpretation means the reply was understood,
      // even if the legacy question chooser happened to repeat itself. Let the
      // checklist-driven conductor replace that stale question.
      allowAiRephrase: true,
      sendReply: true,
      notUnderstood: repeatedSameQuestion
        && !interpretation
        && !structuredInterruption
        && !acceptedExpectedScore
        && !acceptedConversationControl,
      guardrail: guardrails[0] || null
    }
  };
}

module.exports = {
  STATES,
  GUARDRAILS,
  CLOSING_GRACE_MS,
  DEFERRAL_REPLY,
  SERVICE_SCOPE_DECISIONS,
  SERVICE_SCOPE_QUESTION,
  projectEndReviewQuestion,
  SERVICE_SYNONYMS,
  MAX_PROBES_PER_SERVICE,
  MAX_TURNS_BEFORE_HANDOFF,
  processWhatsAppReply,
  getConversationState,
  buildChecklist,
  applyCaptured,
  applyServiceScopeDecision,
  applyTurnProgress,
  isEverythingCovered,
  soundsLikeFarewell,
  isMoveOnReply,
  explicitServiceScopeDecision,
  overallRatingQuestion,
  scoreConversation,
  buildAnalysis,
  detectors: { detectServices, detectSentiment, detectNumber, looksLikeRatingAnswer, isOptOut, isEscalation, emojiSentiment }
};

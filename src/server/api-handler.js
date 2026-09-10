const crypto = require("crypto");
const { createStore } = require("../lib/store");
const { MAX_REMINDERS } = require("../lib/supabase-store");
const { processWhatsAppReply, getConversationState, buildChecklist, applyCaptured, applyServiceScopeDecision, applyTurnProgress, isEverythingCovered, soundsLikeFarewell, isMoveOnReply, overallRatingQuestion, projectEndReviewQuestion, buildAnalysis, detectors, STATES, GUARDRAILS, CLOSING_GRACE_MS, DEFERRAL_REPLY, SERVICE_SCOPE_DECISIONS, SERVICE_SCOPE_QUESTION } = require("../lib/whatsapp-state-machine");
const { offScriptReply, reviewIssues, readTone, readNps, interpretReply, conductTurn, predictSatisfaction, cleanRepeatedText, extractExplicitAppreciations, hasSatisfactionEvidence, ALERT_CONFIDENCE_THRESHOLD } = require("../lib/gemini");
const { emitAutomation } = require("../lib/n8n");
const { importAdminWorkbook } = require("../lib/admin-import");

const WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_MANUAL_WHATSAPP_TEXT_LENGTH = 4096;

function requiredConversationAction(checklist, conversationState) {
  const pendingServiceKey = conversationState.pendingServiceKey;
  const pendingFirst = (items = []) => items.find((item) => item.serviceKey === pendingServiceKey) || items[0];
  if (conversationState.pendingGeneralIssue) return { type: "general_issue_detail" };
  if (conversationState.pendingObservation?.stage === "reason") {
    return { type: "observation_reason", topic: conversationState.pendingObservation.topic };
  }
  if (conversationState.pendingObservation?.stage === "followup") {
    return { type: "observation_followup", topic: conversationState.pendingObservation.topic };
  }
  if (checklist.servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys?.length) {
    return { type: "issue_reason", ...pendingFirst(checklist.servicesWhereWeStillDoNotKnowWhatIsWrongWithKeys) };
  }
  const pendingServiceFollowUp = pendingFirst(checklist.servicesWaitingForAnythingElseAnswer);
  const pendingService = pendingServiceFollowUp?.serviceKey
    ? conversationState.mentionedServices?.[pendingServiceFollowUp.serviceKey]
    : null;
  // Finish a real concern before changing subject. A positive or neutral point
  // must not, however, force another service-specific question after the
  // client has already given a broad project view. Ask whether they actually
  // want to continue service by service first.
  if (pendingServiceFollowUp && pendingService?.sentiment === "negative") {
    return { type: "service_followup", ...pendingServiceFollowUp };
  }
  if (checklist.projectEndReviewStillNeeded) return { type: "project_end_review" };
  if (checklist.serviceScopeChoiceStillNeeded) return { type: "service_scope" };
  if (pendingServiceFollowUp) {
    return { type: "service_followup", ...pendingServiceFollowUp };
  }
  if (checklist.servicesNotYetDiscussedWithKeys?.length) {
    return { type: "service", ...checklist.servicesNotYetDiscussedWithKeys[0] };
  }
  if (!conversationState.appreciationAnswered) return { type: "appreciation" };
  if (!conversationState.anythingElseAnswered) return { type: "final_sweep" };
  if (checklist.overallRatingStillNeeded) return { type: "overall_rating" };
  if (checklist.npsStillNeeded) return { type: "nps" };
  return { type: "close" };
}

function conductedAction(conducted) {
  const actions = [
    conducted.askedForProjectEndReview && { type: "project_end_review" },
    conducted.askedServiceKey && { type: "service", serviceKey: conducted.askedServiceKey },
    conducted.askedIssueReasonKey && { type: "issue_reason", serviceKey: conducted.askedIssueReasonKey },
    conducted.askedServiceFollowUpKey && { type: "service_followup", serviceKey: conducted.askedServiceFollowUpKey },
    conducted.askedObservationReasonTopic && {
      type: "observation_reason", topic: conducted.askedObservationReasonTopic
    },
    conducted.askedObservationFollowUpTopic && {
      type: "observation_followup", topic: conducted.askedObservationFollowUpTopic
    },
    conducted.askedForGeneralIssueDetails && { type: "general_issue_detail" },
    conducted.askedForServiceScope && { type: "service_scope" },
    conducted.askedForAppreciation && { type: "appreciation" },
    conducted.askedForAnythingElse && { type: "final_sweep" },
    conducted.askedForOverallRating && { type: "overall_rating" }
  ].filter(Boolean);
  if (!actions.length) return { type: conducted.readyToClose ? "close" : "none" };
  return actions.length === 1 ? actions[0] : { type: "multiple" };
}

function actionMatches(required, actual) {
  if (required.type === "nps") return actual.type === "none";
  if (required.type !== actual.type) return false;
  if (required.serviceKey) return required.serviceKey === actual.serviceKey;
  if (required.topic) {
    return String(required.topic).toLowerCase() === String(actual.topic || "").toLowerCase();
  }
  return true;
}

const COMPARISON_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "in", "is", "it", "need", "needs", "of", "on", "our",
  "should", "that", "the", "their", "this", "to", "was", "we", "were", "with"
]);

function contentTokens(value) {
  return new Set(String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !COMPARISON_STOP_WORDS.has(token)));
}

function contentOverlap(left, right) {
  const a = contentTokens(left);
  const b = contentTokens(right);
  if (!a.size || !b.size) return { shared: 0, ratio: 0 };
  const shared = [...a].filter((token) => b.has(token)).length;
  return { shared, ratio: shared / Math.min(a.size, b.size) };
}

function mergeObservations(...groups) {
  const merged = [];
  for (const item of groups.flat().filter(Boolean)) {
    const duplicate = merged.some((existing) => {
      if (existing.sentiment !== item.sentiment) return false;
      const sameTopic = String(existing.topic || "").toLowerCase()
        === String(item.topic || "").toLowerCase();
      const overlap = contentOverlap(existing.detail, item.detail);
      return sameTopic && (overlap.ratio >= 0.7 || overlap.shared >= 5);
    });
    if (!duplicate) merged.push(item);
  }
  return merged;
}

function separateAppreciations(conducted) {
  const appreciations = conducted.appreciations || [];
  if (!appreciations.length) return conducted;
  const duplicatesPraise = (detail) => appreciations.some((item) => {
    const overlap = contentOverlap(detail, item.detail);
    return overlap.shared >= 3 && overlap.ratio >= 0.55;
  });
  // Keep a mapped positive service capture as well: "the creative team makes
  // fantastic videos" is both Design feedback and an appreciation. The latter
  // still needs its own card and coverage marker, but the former means we do
  // not ask the client to repeat their Design feedback later.
  for (const item of appreciations) {
    if (!item.serviceKey) {
      continue;
    }
    const existing = (conducted.captured || []).find((capture) => capture.serviceKey === item.serviceKey);
    if (existing) {
      // Keep the service's real sentiment (a client can praise videos while
      // criticising ad creatives), but remember that explicit praise existed.
      // A merely positive service comment such as "SEO is fine" must not turn
      // into an Appreciation card.
      existing.fromAppreciation = true;
      continue;
    }
    conducted.captured = [
      ...(conducted.captured || []),
      {
        serviceKey: item.serviceKey,
        sentiment: "positive",
        summary: item.detail,
        declined: false,
        needsFollowUp: false,
        fromAppreciation: true
      }
    ];
  }
  conducted.observations = (conducted.observations || []).filter(
    (item) => item.sentiment !== "positive" || !duplicatesPraise(item.detail)
  );
  return conducted;
}

function suppressBroadOverallServiceGuess(conducted, interpretation, text, project) {
  const isOverall = interpretation?.serviceScope === SERVICE_SCOPE_DECISIONS.OVERALL_FEEDBACK
    || conducted?.serviceScope === SERVICE_SCOPE_DECISIONS.OVERALL_FEEDBACK;
  if (!isOverall) return conducted;

  const explicitKeys = Array.isArray(interpretation?.serviceKeys)
    ? interpretation.serviceKeys
    : detectors.detectServices(text, project);
  if (!explicitKeys.length) conducted.captured = [];
  return conducted;
}

/**
 * A detail answer belongs to the service whose question the client is
 * answering. If Gemini also tags an overlapping service merely because the
 * reply says "design" inside a Website answer, keep one owner rather than
 * creating two issues from the same sentence.
 */
function scopeCapturedToPendingQuestion(stateBefore, captured = [], interpretation = null, text = "") {
  if (pendingQuestionTypeFor(stateBefore) !== "issue_reason") return captured;
  const pendingServiceKey = stateBefore.pendingServiceKey;
  if (!pendingServiceKey || !captured.length) return captured;

  let scoped = [...captured];
  let pending = scoped.find((item) => item.serviceKey === pendingServiceKey);
  const pendingService = stateBefore.mentionedServices?.[pendingServiceKey];
  const pendingNamed = (interpretation?.serviceKeys || []).includes(pendingServiceKey)
    || new RegExp(`\\b${String(pendingServiceKey).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)
    || (pendingService?.serviceName && String(text).toLowerCase().includes(
      String(pendingService.serviceName).toLowerCase()
    ));

  if (!pending && pendingNamed) {
    const source = scoped[0];
    pending = { ...source, serviceKey: pendingServiceKey };
    scoped.push(pending);
  }
  if (!pending) return scoped;

  return scoped.filter((item) => {
    if (item === pending || item.serviceKey === pendingServiceKey) return true;
    const overlap = contentOverlap(item.summary, pending.summary);
    return !(overlap.shared >= 3 && overlap.ratio >= 0.6);
  });
}

/**
 * Ground an explicit multi-service reply one clause at a time.
 *
 * A model once copied "Website needs to improve. SEO is satisfactory. Client
 * servicing is okayish" into all three service records and gave every service
 * the Website complaint's negative sentiment. These facts are explicit enough
 * to validate deterministically, so one service's tone must never spill into
 * another service's record.
 */
function groundMultiServiceCaptures(captured = [], text = "", project = {}, stateBefore = {}) {
  const source = String(text || "").trim();
  const emojiOnly = Boolean(source) && /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u.test(source);
  if (emojiOnly && detectors.emojiSentiment(source) === "negative") {
    const pendingServiceKey = stateBefore.pendingServiceKey || null;
    const grounded = (captured || []).map((item) => ({
      ...item,
      sentiment: "negative",
      summary: item.summary || "Client reacted negatively",
      needsFollowUp: true
    }));
    if (!grounded.length && pendingServiceKey) {
      grounded.push({
        serviceKey: pendingServiceKey,
        sentiment: "negative",
        summary: "Client reacted negatively",
        declined: false,
        needsFollowUp: true
      });
    }
    return grounded;
  }

  const clauses = String(text || "")
    .split(/\s*(?:[.;\n]+|\b(?:however|additionally|whereas)\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const facts = new Map();

  for (const clause of clauses) {
    const serviceKeys = detectors.detectServices(clause, project);
    if (!serviceKeys.length) continue;
    const focusExpectation = /\b(?:would like|want|expect)\b[^.!?]{0,120}\b(?:full potential|better|improv\w*|creatives?|videos?)\b/i.test(clause);
    const sentiment = focusExpectation ? "neutral" : detectors.detectSentiment(clause);
    const wordCount = clause.split(/\s+/).filter(Boolean).length;
    // Statements with contrast, attribution or future expectations need
    // language understanding. Flattening them to the strongest nearby keyword
    // turned "we want to see the full potential of Creatives" into praise just
    // because "very satisfied" appeared later in the same sentence.
    const nuanced = /\b(?:but|although|though|despite|while|however|at our end|would like|want to see|expect|potential|learning phase|teething)\b/i.test(clause);
    const genericProblem = sentiment === "negative"
      && wordCount <= 10
      && /\b(?:needs? (?:to )?improve|needs? improvement|not (?:good|great|satisfactory|up to (?:the )?mark)|bad|poor|weak|average)\b/i.test(clause);

    for (const serviceKey of serviceKeys) {
      const previous = facts.get(serviceKey);
      facts.set(serviceKey, previous
        ? {
            serviceKey,
            sentiment: previous.sentiment === "negative" || sentiment === "negative"
              ? "negative"
              : previous.sentiment === "positive" || sentiment === "positive" ? "positive" : "neutral",
            summary: `${previous.summary}. ${clause}`,
            needsFollowUp: previous.needsFollowUp || genericProblem,
            nuanced: previous.nuanced || nuanced
          }
        : { serviceKey, sentiment, summary: clause, needsFollowUp: genericProblem, nuanced });
    }
  }

  // For a nuanced single-service reply Gemini still has the full context.
  if (facts.size < 2) return captured;

  const byService = new Map((captured || []).map((item) => [item.serviceKey, item]));
  for (const fact of facts.values()) {
    const modelItem = byService.get(fact.serviceKey) || {};
    // Keep a valid Gemini reading for nuanced language. The deterministic
    // grounding remains a floor for missing captures and simple, explicit
    // multi-service sentences, where it prevents sentiment from leaking from
    // one clause into another.
    if (fact.nuanced && modelItem.serviceKey) continue;
    byService.set(fact.serviceKey, {
      ...modelItem,
      ...fact,
      nuanced: undefined,
      declined: modelItem.declined === true
    });
  }
  return [...byService.values()];
}

function resetFreshCapturedServices(conversationState, stateBefore, captured = []) {
  const existingKeys = new Set(Object.keys(stateBefore.mentionedServices || {}));
  for (const item of captured) {
    if (!item.serviceKey || existingKeys.has(item.serviceKey)) continue;
    // The preliminary rule pass used message-level sentiment. Recreate a new
    // service from its grounded capture so stale negative sentiment cannot
    // survive in the service's sentiment history.
    delete conversationState.mentionedServices?.[item.serviceKey];
  }
  return conversationState;
}

function reconcilePendingServiceArtifacts(conversationState, stateBefore, captured = []) {
  if (pendingQuestionTypeFor(stateBefore) !== "issue_reason") return conversationState;
  const pendingServiceKey = stateBefore.pendingServiceKey;
  const beforeKeys = new Set(Object.keys(stateBefore.mentionedServices || {}));
  const retainedKeys = new Set(captured.map((item) => item.serviceKey).filter(Boolean));
  for (const serviceKey of Object.keys(conversationState.mentionedServices || {})) {
    if (serviceKey === pendingServiceKey || beforeKeys.has(serviceKey) || retainedKeys.has(serviceKey)) continue;
    delete conversationState.mentionedServices[serviceKey];
  }
  return conversationState;
}

function issueOwnershipScore(service) {
  const text = `${service.issueTitle || ""} ${service.issueRootCause || service.reasonText || ""}`.toLowerCase();
  const key = String(service.serviceKey || "").toLowerCase();
  const name = String(service.serviceName || "").toLowerCase();
  let score = 0;
  if (key && new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) score += 1;
  if (name && text.includes(name)) score += 2;
  if ((key && text.startsWith(key)) || (name && text.startsWith(name))) score += 2;
  return score;
}

function suppressDuplicateIssues(services = []) {
  const active = services.filter((service) => service.issueReady && service.sentiment === "negative");
  for (let index = 0; index < active.length; index += 1) {
    const left = active[index];
    if (!left.issueReady) continue;
    for (let otherIndex = index + 1; otherIndex < active.length; otherIndex += 1) {
      const right = active[otherIndex];
      if (!right.issueReady || left.serviceKey === right.serviceKey) continue;
      const leftText = `${left.issueTitle || ""} ${left.issueRootCause || left.reasonText || ""}`;
      const rightText = `${right.issueTitle || ""} ${right.issueRootCause || right.reasonText || ""}`;
      const overlap = contentOverlap(leftText, rightText);
      if (overlap.shared < 4 || overlap.ratio < 0.62) continue;

      const keepLeft = issueOwnershipScore(left) >= issueOwnershipScore(right);
      const duplicate = keepLeft ? right : left;
      const keeper = keepLeft ? left : right;
      if (duplicate.issueSeverity === "high") keeper.issueSeverity = "high";
      duplicate.issueReady = false;
      duplicate.duplicateOfServiceKey = keeper.serviceKey;
    }
  }
  return services;
}

function fallbackForAction(action, conversationState, project, context = {}) {
  if (action.type === "project_end_review") return projectEndReviewQuestion(project);
  if (action.type === "service_scope") return SERVICE_SCOPE_QUESTION;
  if (action.type === "issue_reason") {
    return `I am sorry to hear that ${action.name} needs improvement. Our team will look into it. Could you share what specifically should improve?`;
  }
  if (action.type === "service_followup") {
    if (action.askCount > 0 && action.askCount % 3 === 0) {
      return `Just to finish ${action.name}: is there one more point to add, or have we covered it?`;
    }
    if (action.askCount > 0 && action.askCount % 3 === 2) {
      return `Before we move on from ${action.name}, should we add anything else? You can reply no if that covers it.`;
    }
    if (action.askCount > 0) {
      return `Anything more you would like to add about ${action.name}? If that is all, just reply no.`;
    }
    const service = conversationState.mentionedServices?.[action.serviceKey];
    if (service?.sentiment === "negative") {
      if (service.noteNeedsAck) {
        return `I hear you. Our team will look into it. Is there anything else about ${action.name} we should know?`;
      }
      if (Number(service.issueReasonAskCount || 0) > 0) {
        return `Thank you for explaining that. Our team will look into it. Is there anything else about ${action.name} we should know?`;
      }
      const detail = service.reasonText
        ? `I am sorry to hear about the issue you described with ${action.name}.`
        : `I am sorry to hear that ${action.name} has been frustrating.`;
      return `${detail} Our team will look into it. Is there anything else about ${action.name} we should know?`;
    }
    if (service?.sentiment === "positive") {
      return `Glad to hear that about ${action.name}. Is there anything else you would like to add?`;
    }
    return `Thank you for sharing that. Is there anything else about ${action.name} we should know?`;
  }
  if (action.type === "service") return `How has ${action.name} been for you?`;
  if (action.type === "general_issue_detail") return "Of course — please tell me what happened.";
  if (action.type === "observation_reason") {
    return `I am sorry to hear that. What specifically happened with ${action.topic}?`;
  }
  if (action.type === "observation_followup") {
    const appreciationLead = (context.appreciations || []).length
      ? `Thank you as well for appreciating ${context.appreciations[0].subject}; we will share that with the team. `
      : "";
    if (conversationState.pendingObservation?.acknowledged) {
      return `${appreciationLead}Before we move on, is there anything else about ${action.topic} we should know? If not, just reply no.`;
    }
    if (action.topic === "Billing") {
      const requestLead = conversationState.pendingObservation?.responseKind === "request"
        ? " We will also pass your request to the team."
        : "";
      return `${appreciationLead}I am sorry to hear about the inaccurate billing. Our team will review the invoice process.${requestLead} Is there anything else about Billing we should know?`;
    }
    if (conversationState.pendingObservation?.responseKind === "request") {
      const positiveLead = conversationState.pendingObservation?.positiveContext === "Social Media"
        ? "Glad to hear that social media is working well. "
        : "";
      return `${appreciationLead}${positiveLead}Thank you for raising this. We will share the meeting request with our team and senior management and ask them to take it forward. Is there anything else about ${action.topic} we should know?`;
    }
    if (action.topic === "Senior Involvement") {
      return `${appreciationLead}I am sorry to hear about the lack of senior involvement and communication. We will raise this with management and ask the relevant leaders to address it. Is there anything else about Senior Involvement we should know?`;
    }
    return `${appreciationLead}I am sorry to hear that. Our team will look into it. Is there anything else about ${action.topic} we should know?`;
  }
  if (action.type === "appreciation") {
    return "Before the overall rating, is there any team or department you would like to appreciate?";
  }
  if (action.type === "final_sweep") {
    const discussedKeys = new Set(Object.values(conversationState.mentionedServices || {})
      .filter((service) => service.status !== "declined")
      .map((service) => service.serviceKey));
    const discussed = (project.services || [])
      .filter((service) => discussedKeys.has(service.serviceKey))
      .map((service) => service.name)
      .join(", ");
    const lead = discussed ? `We have discussed ${discussed}. ` : "";
    if ((context.appreciations || []).length) {
      return `I have recorded that appreciation. ${lead}Is there an issue or feedback about another department we missed, or anything else you would like to share with management?`;
    }
    return `${lead}Is there an issue or feedback about another department we missed, or anything else you would like to share with management?`;
  }
  if (action.type === "overall_rating") return overallRatingQuestion(conversationState, project);
  if (action.type === "nps") {
    return "Lastly, how likely are you to recommend SRV Media to someone in your network, out of 10?";
  }
  return "Thank you. Your feedback and overall rating are recorded. This chat will remain open for 10 minutes in case you want to correct or add anything.";
}

function closingGraceMessage(poc, conversationState = {}) {
  const salutation = (poc && (poc.salutation || poc.name)) || "there";
  const rating = conversationState.overallRating;
  const ratingText = rating === null || rating === undefined
    ? "your overall rating"
    : `rating of ${rating} out of 10`;
  if (conversationState.reopenedDuringClosingGrace) {
    return `Thank you. I have added that to your recorded feedback. ${ratingText[0].toUpperCase()}${ratingText.slice(1)} remains recorded, and the original 10-minute window is still open if you want to add or correct anything else.`;
  }
  return `Thank you, ${salutation}. Your feedback and ${ratingText} have been successfully recorded for confidential review by the Directors.\n\nIf your feedback includes a concern or an area for improvement, the system has created the necessary action item and notified the Directors. It will be handled constructively and discreetly.\n\nThis feedback session will remain active for the next 10 minutes. During this time, you can add anything else you would like the Directors to know, revise your rating, share further feedback or appreciation, ask a question, or request a callback.\n\nAfter 10 minutes, this automated feedback session will close. You can, of course, contact SRV Media at any time if you need us.\n\nThank you again for your honesty, time and trust. Please take care, and we look forward to connecting with you again next month.`;
}

function recordRequiredQuestion(conversationState, project, action) {
  const markers = {
    askedForProjectEndReview: action.type === "project_end_review",
    askedServiceKey: action.type === "service" ? action.serviceKey : null,
    askedIssueReasonKey: action.type === "issue_reason" ? action.serviceKey : null,
    askedServiceFollowUpKey: action.type === "service_followup" ? action.serviceKey : null,
    askedObservationReasonTopic: action.type === "observation_reason" ? action.topic : null,
    askedObservationFollowUpTopic: action.type === "observation_followup" ? action.topic : null,
    askedForGeneralIssueDetails: action.type === "general_issue_detail",
    askedForServiceScope: action.type === "service_scope",
    askedForAppreciation: action.type === "appreciation",
    askedForAnythingElse: action.type === "final_sweep",
    askedForOverallRating: action.type === "overall_rating"
  };
  applyTurnProgress(conversationState, project, markers, { recordAnswers: false });
  if (action.type === "project_end_review") conversationState.projectEndReviewAsked = true;
  if (action.type === "service_scope") conversationState.serviceScopeAsked = true;
  if (
    action.type === "observation_followup"
    && conversationState.pendingObservation?.topic === action.topic
  ) {
    conversationState.pendingObservation.acknowledged = true;
  }
  if (action.type === "service_followup" && action.serviceKey) {
    const service = conversationState.mentionedServices?.[action.serviceKey];
    if (service) service.noteNeedsAck = false;
  }
  conversationState.pendingQuestionType = action.type === "close" ? null : action.type;
  return markers;
}

function setStateForRequiredAction(conversationState, action, recordedQuestion) {
  if (recordedQuestion.askedForProjectEndReview) {
    conversationState.state = STATES.WAITING_FOR_OPEN_FEEDBACK;
    conversationState.pendingServiceKey = null;
  } else if (recordedQuestion.askedForServiceScope) {
    conversationState.state = STATES.WAITING_FOR_SERVICE_SCOPE;
    conversationState.pendingServiceKey = null;
  } else if (recordedQuestion.askedForOverallRating) {
    conversationState.state = STATES.WAITING_FOR_OVERALL_RATING;
    conversationState.pendingServiceKey = null;
  } else if (recordedQuestion.askedServiceFollowUpKey) {
    conversationState.state = STATES.WAITING_FOR_SERVICE_FOLLOWUP;
    conversationState.pendingServiceKey = recordedQuestion.askedServiceFollowUpKey;
  } else if (action.type === "issue_reason") {
    conversationState.state = STATES.WAITING_FOR_ISSUE_REASON;
    conversationState.pendingServiceKey = action.serviceKey;
  } else if (action.type === "service") {
    conversationState.state = STATES.WAITING_FOR_SERVICE_FEEDBACK;
    conversationState.pendingServiceKey = action.serviceKey;
  } else if (action.type === "nps") {
    conversationState.state = STATES.WAITING_FOR_NPS;
    conversationState.pendingServiceKey = null;
  } else if (action.type !== "close") {
    conversationState.state = STATES.WAITING_FOR_MORE_SERVICES;
    conversationState.pendingServiceKey = null;
  }
}

function pendingQuestionTypeFor(conversationState) {
  if (conversationState.pendingQuestionType) return conversationState.pendingQuestionType;
  if (conversationState.state === STATES.WAITING_FOR_SERVICE_SCOPE) return "service_scope";
  if (conversationState.state === STATES.WAITING_FOR_OVERALL_RATING) return "overall_rating";
  if (conversationState.state === STATES.WAITING_FOR_SERVICE_FOLLOWUP) return "service_followup";
  if (conversationState.askedForAppreciation && !conversationState.appreciationAnswered) return "appreciation";
  if (conversationState.askedForAnythingElse && !conversationState.anythingElseAnswered) return "final_sweep";
  return null;
}

function applyTurnServiceScope(conversationState, project, text, interpretation, conducted = {}, stateBefore = {}) {
  const valid = new Set(Object.values(SERVICE_SCOPE_DECISIONS));
  let decision = [interpretation?.serviceScope, conducted?.serviceScope]
    .find((value) => valid.has(value) && value !== SERVICE_SCOPE_DECISIONS.NONE)
    || SERVICE_SCOPE_DECISIONS.NONE;
  const projectEnd = conversationState.sessionType === "project_end";
  const answeringProjectEndReview = projectEnd
    && (stateBefore.pendingQuestionType === "project_end_review"
      || (stateBefore.projectEndReviewAsked && !stateBefore.projectEndReviewCaptured));
  const suppliedProjectFeedback = Boolean(
    (conducted?.captured || []).length
    || (conducted?.observations || []).length
    || (conducted?.appreciations || []).length
    || interpretation?.intent === "feedback"
    || (conversationState.generalSentiment && conversationState.generalConcernText)
    || (answeringProjectEndReview
      && (interpretation?.intent === "negative" || isMoveOnReply(text)))
  );

  // Project-end starts with one whole-project invitation. Any meaningful
  // answer completes that broad checkpoint; it must not silently start the
  // monthly service questionnaire. An explicit request to go service by
  // service remains respected.
  if (projectEnd && suppliedProjectFeedback
    && decision !== SERVICE_SCOPE_DECISIONS.CONTINUE_SERVICE_BY_SERVICE) {
    decision = SERVICE_SCOPE_DECISIONS.OVERALL_FEEDBACK;
  }
  return applyServiceScopeDecision(conversationState, project, decision, {
    text,
    sentiment: interpretation?.sentiment
      || conducted?.captured?.[0]?.sentiment
      || null
  });
}

function acceptedOverallRating(conversationState, conducted) {
  // The client may interrupt the rating question with a new management point,
  // then give the score while we are closing that point. Once the overall
  // question has genuinely been asked, retain an explicit model-read rating
  // instead of asking for the same number again.
  return conversationState.overallRatingAsked ? conducted.overallRating : null;
}

function latestExplicitOverallRating(messages, overallRatingAsked) {
  if (!overallRatingAsked) return null;
  const ratingWords = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10
  };
  const ratingQuestionIndex = messages.findIndex((message) => {
    if (message.side !== "srv") return false;
    const body = String(message.body || "");
    const state = message.metadata?.stateAfter || message.metadata?.state;
    return state === STATES.WAITING_FOR_OVERALL_RATING
      || /\boverall\b.{0,100}\b(?:out of 10|0 to 10)\b/i.test(body);
  });
  const candidates = ratingQuestionIndex >= 0 ? messages.slice(ratingQuestionIndex + 1) : messages.slice(-12);
  let latest = null;
  for (const message of candidates) {
    if (message.side !== "client") continue;
    const body = String(message.body || "").trim();
    const scaledMatch = body.match(/\b(?:a\s+)?(\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:\/|out of)\s*(5|10)\b/i);
    const read = scaledMatch
      ? {
          value: Object.prototype.hasOwnProperty.call(ratingWords, scaledMatch[1].toLowerCase())
            ? ratingWords[scaledMatch[1].toLowerCase()]
            : Number(scaledMatch[1]),
          scale: Number(scaledMatch[2])
        }
      : detectors.detectNumber(body);
    if (!read) continue;
    if (/\b(?:day|days|week|weeks|month|months|campaign|campaigns|lead|leads|report|reports)\b/i.test(body)
      && !/\b(?:out of|rating|score|take|make that|change|instead)\b/i.test(body)) continue;
    const direct = /^\s*(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*(?:\/|out of)\s*(?:5|10))?\s*[.!]*\s*$/i.test(body);
    const explicit = /\b(?:out of|rating|score|take|make that|change(?: it)? to|actually|instead|i(?:'d| would)? say|i(?:'ll| will)? give)\b/i.test(body);
    if (!direct && !explicit) continue;
    const normalized = read.scale === 5 ? read.value * 2 : read.value;
    if (normalized < 0 || normalized > 10 || (read.scale && ![5, 10].includes(read.scale))) continue;
    latest = normalized;
  }
  return latest;
}

function syncTurnToLatestRating(turn, latestRating, project, poc, text) {
  if (latestRating === null || latestRating === undefined) return { changed: false, closed: false };
  const changed = turn.conversationState.overallRating !== latestRating;
  turn.conversationState.overallRating = latestRating;
  if (changed) turn.conversationState.ratingCorrectedAt = new Date().toISOString();

  const interruptionOpen = Boolean(
    turn.conversationState.pendingGeneralIssue
    || turn.conversationState.pendingObservation
  );
  const exceptionalTerminal = [STATES.OPTED_OUT, STATES.HANDED_OFF].includes(turn.conversationState.state);
  const canClose = !interruptionOpen
    && !exceptionalTerminal
    && isEverythingCovered(turn.conversationState, project);
  if (canClose) {
    turn.conversationState.state = STATES.CLOSING_GRACE;
    const existingExpiry = Date.parse(turn.conversationState.closingGraceExpiresAt || "");
    if (!Number.isFinite(existingExpiry) || existingExpiry <= Date.now()) {
      turn.conversationState.closingGraceExpiresAt = new Date(Date.now() + CLOSING_GRACE_MS).toISOString();
    }
  }

  const refreshed = buildAnalysis(
    turn.conversationState,
    project,
    poc,
    text,
    turn.conversationState.guardrailHits || []
  );
  for (const field of [
    "satisfaction", "isComplete", "completionStatus", "csatScore", "healthScore",
    "riskLevel", "status", "rootCause", "positiveSignal", "focusSignal",
    "escalationSignal", "requiresManagerAlert", "requiresCompletionReminder", "dueInHours"
  ]) {
    turn.analysis[field] = refreshed[field];
  }
  turn.analysis.conversationState = turn.conversationState;
  if (["frustrated", "disengaged"].includes(turn.analysis.tone) && turn.analysis.riskLevel === "Low") {
    turn.analysis.riskLevel = "Watch";
  }
  return { changed, closed: canClose };
}

function validatedAnswerMarkers(stateBefore, conducted, text, interpretation = null) {
  const pendingType = pendingQuestionTypeFor(stateBefore);
  const pendingServiceKey = stateBefore.pendingServiceKey || null;
  const explicitlyFinished = isMoveOnReply(text)
    || soundsLikeFarewell(text)
    || interpretation?.intent === "negative";
  const capturedServiceKeys = (conducted.captured || [])
    .map((item) => item.serviceKey)
    .filter(Boolean);
  const movedToAnotherService = pendingType === "service_followup"
    && pendingServiceKey
    && capturedServiceKeys.some((key) => key !== pendingServiceKey)
    && !capturedServiceKeys.includes(pendingServiceKey);
  const volunteeredAppreciation = (conducted.appreciations || []).length > 0;
  const answeredSweepWithFeedback = pendingType === "final_sweep" && Boolean(
    (conducted.captured || []).length
    || (conducted.observations || []).length
    || (conducted.appreciations || []).length
  );

  return {
    answeredAppreciation: volunteeredAppreciation || (pendingType === "appreciation"
      ? (conducted.answeredAppreciation === true || explicitlyFinished)
      : pendingType === "general_issue_detail"
        && stateBefore.resumeQuestionType === "appreciation"
        && conducted.answeredAppreciation === true),
    appreciationVolunteered: volunteeredAppreciation,
    answeredAnythingElse: pendingType === "final_sweep"
      && (conducted.answeredAnythingElse === true || explicitlyFinished || answeredSweepWithFeedback),
    completedServiceFollowUpKeys: pendingType === "service_followup"
      && pendingServiceKey
      && (explicitlyFinished || movedToAnotherService)
      ? [pendingServiceKey]
      : []
  };
}

function applyConversationInterruption(conversationState, stateBefore, interpretation, conducted, text) {
  const pendingType = pendingQuestionTypeFor(stateBefore);
  const explicitlyFinished = isMoveOnReply(text)
    || soundsLikeFarewell(text)
    || interpretation?.intent === "negative";

  if (pendingType === "observation_followup" && explicitlyFinished) {
    conversationState.pendingObservation = null;
  }

  const suppliedFeedback = (conducted.captured || []).length || (conducted.observations || []).length;
  if (pendingType === "general_issue_detail" && suppliedFeedback) {
    conversationState.pendingGeneralIssue = false;
  }
  if (pendingType === "observation_followup" && suppliedFeedback) {
    // They answered "anything else?" by raising a new point. Follow their
    // lead instead of forcing an explicit no on the previous topic.
    conversationState.pendingObservation = null;
  }

  const actionableObservations = (conducted.observations || [])
    .filter((item) => item.kind !== "appreciation" && item.sentiment !== "positive");
  if (actionableObservations.length) {
    const latest = actionableObservations[actionableObservations.length - 1];
    conversationState.pendingGeneralIssue = false;
    conversationState.pendingObservation = {
      topic: latest.topic,
      stage: latest.needsFollowUp ? "reason" : "followup",
      acknowledged: false,
      responseKind: latest.kind === "request" ? "request" : "feedback",
      positiveContext: latest.positiveContext || null
    };
  } else if (
    interpretation?.intent === "more_detail"
    && !(conducted.captured || []).length
    && !(conducted.observations || []).length
  ) {
    conversationState.pendingGeneralIssue = true;
    conversationState.resumeQuestionType = pendingType;
  }

  if (!conversationState.pendingGeneralIssue && pendingType === "general_issue_detail") {
    conversationState.resumeQuestionType = null;
  }
}

function applyPendingIssueInterpretation(conversationState, stateBefore, interpretation) {
  if (pendingQuestionTypeFor(stateBefore) !== "issue_reason") return false;
  if (!interpretation?.explainsProblem) return false;
  const serviceKey = stateBefore.pendingServiceKey;
  if (!serviceKey || !(interpretation.serviceKeys || []).includes(serviceKey)) return false;

  const service = conversationState.mentionedServices?.[serviceKey];
  if (!service) return false;
  service.sentiment = "negative";
  service.detailAnswered = true;
  service.serviceFollowUpAnswered = false;
  service.status = "needs_service_followup";
  return true;
}

function messageMatchesRequiredAction(action, message) {
  const text = String(message || "").trim();
  if (!text) return false;
  const lowerText = text.toLowerCase();
  const serviceNamed = !action.serviceKey || [action.name, action.serviceKey]
    .filter(Boolean)
    .some((value) => lowerText.includes(String(value).toLowerCase()));

  if (action.type === "project_end_review") {
    return /\b(?:entire|whole|overall)\b[\s\S]{0,100}\bproject\b/i.test(text)
      && /\b(?:issues?|concerns?|improvement|positive|went well|experience)\b/i.test(text);
  }
  if (action.type === "service_scope") {
    return /\bcontinue\b[\s\S]{0,180}\bskip\b|\bskip\b[\s\S]{0,180}\bcontinue\b/i.test(text)
      && /\bservices?\b/i.test(text);
  }
  if (action.type === "service") {
    return serviceNamed && /\b(?:how has|how have|experience|feedback|working|been for you)\b/i.test(text);
  }
  if (action.type === "issue_reason") {
    return serviceNamed && /\b(?:what specifically|what happened|what needs|what should|could you (?:share|tell|explain)|can you (?:share|tell|explain))\b/i.test(text);
  }
  if (action.type === "service_followup") {
    return serviceNamed && /\b(?:anything else|anything more|more to add|another point|have we covered)\b/i.test(text);
  }
  if (action.type === "appreciation") {
    return /\b(?:appreciat|praise|recognis|recogniz|commend|kudos)\w*\b/i.test(text)
      && /\b(?:team|department|person|anyone|who)\b/i.test(text);
  }
  if (action.type === "final_sweep") {
    return /\b(?:department.*missed|missed.*department|management)\b/i.test(text);
  }
  if (action.type === "overall_rating") {
    return /\b(?:rate|rating)\b/i.test(text)
      && /(?:\b0\s*(?:to|-)\s*10\b|\bout of 10\b)/i.test(text);
  }
  if (action.type === "nps") {
    return /\brecommend\w*\b/i.test(text)
      && /(?:\b0\s*(?:to|-)\s*10\b|\bout of 10\b)/i.test(text);
  }
  if (["observation_reason", "observation_followup"].includes(action.type)) {
    return lowerText.includes(String(action.topic || "").toLowerCase()) && /\?\s*$/.test(text);
  }
  if (action.type === "general_issue_detail") return /\b(?:tell me|tell us|what happened|please share|please explain)\b/i.test(text);
  if (action.type === "close") return !/\?\s*$/.test(text);
  return false;
}

function normalizeLegacyServiceFollowups(conversationState) {
  // The rule parser still understands old per-service-rating states so older
  // stored conversations can be resumed safely. The current product does not
  // ask for those ratings: once a service answer is captured, it gives the
  // client one natural opportunity to add anything else about that service.
  let waitingForFollowUp = false;
  for (const service of Object.values(conversationState.mentionedServices || {})) {
    if (service.status !== "needs_rating") continue;
    service.status = "needs_service_followup";
    service.serviceFollowUpAnswered = false;
    waitingForFollowUp = true;
  }
  const missing = (conversationState.missingFields || [])
    .filter((field) => field !== "service_rating" && field !== "service_followup");
  if (waitingForFollowUp) missing.push("service_followup");
  conversationState.missingFields = missing;
  return conversationState;
}

function isExplicitActionRequest(text) {
  const source = String(text || "").toLowerCase();
  if (!source) return false;
  const asksForAction = /\b(?:i\s+(?:would\s+(?:like|appreciate)|want|need)|we\s+(?:would\s+(?:like|appreciate)|want|need)|(?:client|they|he|she)\s+(?:would\s+(?:like|appreciate)|wants?|needs?)|please|kindly|request|can\s+we|could\s+we|should\s+have|need\s+to\s+have)\b/.test(source);
  const actionableObject = /\b(?:meeting|call|review|discussion|report|reports|ledger|invoice|follow[ -]?up|senior\s+involvement|management\s+involvement)\b/.test(source);
  return asksForAction && actionableObject;
}

function positiveSocialMediaContext(text) {
  const source = String(text || "");
  return /\bsocial media\b/i.test(source) && detectors.detectSentiment(source) === "positive"
    ? "Social Media"
    : null;
}

function observationFromInterpretation(interpretation, text) {
  const explicitRequest = isExplicitActionRequest(text);
  const interpretedObservation = interpretation?.intent === "feedback"
    && interpretation.isObservation === true;
  const source = String(text || "").trim();
  if (!source) return null;
  const lowered = source.toLowerCase();
  const deterministicBilling = /\b(?:bill|billing|invoice|tax invoice|cfo)\b/.test(lowered)
    && /\b(?:inaccurate|incorrect|wrong|error|issue|problem|attention|check|review)\b/.test(lowered);
  const deterministicSeniorConcern = /\b(?:senior|leadership|leader|avp|director|management|sarang)\b/.test(lowered)
    && /\b(?:absent|missing|unavailable|not (?:attend|attending|available|responding|picking)|doesn'?t (?:attend|respond|pick)|didn'?t (?:attend|respond|pick)|calls?|meetings?)\b/.test(lowered);
  if (!interpretedObservation && !explicitRequest && !deterministicBilling && !deterministicSeniorConcern) {
    return null;
  }
  let topic = "Management Feedback";
  if (/\b(?:bill|billing|invoice|tax invoice|cfo)\b/.test(lowered)) topic = "Billing";
  else if (/\b(?:senior|leadership|leader|avp|director|management)\b/.test(lowered)) {
    topic = "Senior Involvement";
  } else if (/\b(?:meeting|meetings|call|review|discussion)\b/.test(lowered)) {
    topic = "Review Meeting";
  } else if (/\b(?:contract|scope|commercial|payment|payments)\b/.test(lowered)) topic = "Commercial Process";

  return {
    topic,
    detail: source.slice(0, 600),
    sentiment: deterministicBilling || deterministicSeniorConcern
      ? "negative"
      : explicitRequest
      ? "neutral"
      : (interpretation?.sentiment === "positive" ? "positive" : (interpretation?.sentiment || "neutral")),
    severity: deterministicBilling || deterministicSeniorConcern || interpretation?.sentiment === "negative"
      ? "watch"
      : "info",
    needsFollowUp: deterministicBilling || deterministicSeniorConcern || explicitRequest
      ? false
      : interpretation?.explainsProblem !== true,
    kind: explicitRequest ? "request" : "feedback",
    positiveContext: explicitRequest ? positiveSocialMediaContext(source) : null
  };
}

function canonicalObservationTopic(observation, text = "") {
  const classify = (value) => {
    const source = String(value || "").toLowerCase();
    if (/\b(?:bill|billing|invoice|tax invoice|cfo)\b/.test(source)) return "Billing";
    if (/\b(?:senior|leadership|leader|avp|director|management|sarang)\b/.test(source)) {
      return "Senior Involvement";
    }
    if (/\b(?:meeting|meetings|call|calls|review|discussion)\b/.test(source)) return "Review Meeting";
    if (/\b(?:contract|scope|commercial|payment|payments)\b/.test(source)) return "Commercial Process";
    return null;
  };
  // Prefer the observation's own detail. Using the entire multi-issue client
  // message first could label both an AVP concern and a separate invoice issue
  // as Billing merely because that word appeared elsewhere in the same reply.
  const source = String(text || "").toLowerCase();
  const strongTopics = [
    /\b(?:bill|billing|invoice|tax invoice|cfo|ledger)\b/.test(source) && "Billing",
    /\b(?:senior|leadership|leader|avp|director|management|sarang)\b/.test(source)
      && /\b(?:absent|missing|unavailable|not (?:attend|attending|available|responding|picking)|doesn'?t (?:attend|respond|pick)|didn'?t (?:attend|respond|pick)|meetings?|calls?|would (?:like|appreciate)|request)\b/.test(source)
      && "Senior Involvement"
  ].filter(Boolean);
  const unambiguousStrongTopic = new Set(strongTopics).size === 1 ? strongTopics[0] : null;
  const classified = classify(observation?.detail)
    || unambiguousStrongTopic
    || classify(observation?.topic)
    || classify(text);
  if (classified) return classified;
  return observation?.topic || "Management Feedback";
}

/**
 * Apply facts from the interpretation call before acknowledging a deferral.
 * This is intentionally extraction-only: it never chooses a next question and
 * never completes the cycle. The pending checklist remains waiting until the
 * client returns, but anything they already told us is not discarded.
 */
function applyDeferredInterpretation(turn, stateBefore, interpretation, text, project) {
  const serviceList = (project.services || []).map((service) => ({
    serviceKey: service.serviceKey,
    name: service.name
  }));
  const validKeys = new Set(serviceList.map((service) => service.serviceKey));
  const interpretedCaptures = Array.isArray(interpretation?.captured)
    ? interpretation.captured.map((item) => ({ ...item }))
    : [];
  const source = String(text || "");
  const clauses = source
    .split(/\s*(?:[.;\n]+|\b(?:but|however|additionally|whereas)\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const textForService = (serviceKey) => clauses
    .filter((clause) => detectors.detectServices(clause, project).includes(serviceKey))
    .join(". ") || source;

  // Compatibility with an interpretation produced from the older, smaller
  // schema: only a feedback intent can turn service hints into saved facts. A
  // pure "I will reply about PPC later" must never become neutral PPC feedback.
  if (!interpretedCaptures.length && interpretation?.intent === "feedback") {
    for (const serviceKey of interpretation.serviceKeys || []) {
      if (!validKeys.has(serviceKey)) continue;
      const serviceText = textForService(serviceKey);
      interpretedCaptures.push({
        serviceKey,
        sentiment: interpretation.sentiment || "neutral",
        summary: serviceText.slice(0, 200),
        declined: false,
        needsFollowUp: interpretation.sentiment === "negative"
          && interpretation.explainsProblem !== true
      });
    }
  }
  if (!interpretedCaptures.length && !interpretation) {
    const looksLikeServiceOpinion = /\b(?:is|are|was|were|working|performance|quality|leads?|designs?|reports?|needs?|improv\w*|good|great|fine|okay\w*|satisf\w*|average|poor|bad|slow|late)\b/i.test(source);
    if (looksLikeServiceOpinion) {
      for (const serviceKey of detectors.detectServices(source, project)) {
        if (!validKeys.has(serviceKey)) continue;
        const serviceText = textForService(serviceKey);
        const sentiment = detectors.detectSentiment(serviceText);
        interpretedCaptures.push({
          serviceKey,
          sentiment,
          summary: serviceText.slice(0, 200),
          declined: false,
          needsFollowUp: sentiment === "negative"
        });
      }
    }
  }

  let observations = Array.isArray(interpretation?.observations)
    ? interpretation.observations.map((item) => ({ ...item }))
    : [];
  if (!observations.length) {
    const legacyObservation = observationFromInterpretation(interpretation, text);
    if (legacyObservation) observations = [legacyObservation];
  }
  for (const observation of observations) {
    observation.topic = canonicalObservationTopic(observation, observation.detail || text);
  }

  const explicitRequest = isExplicitActionRequest(text);
  if (explicitRequest) {
    for (const observation of observations) {
      const observationIsRequest = observation.kind === "request"
        || isExplicitActionRequest(observation.detail)
        || /\b(?:meeting|senior management|senior involvement)\b/i.test(
          `${observation.topic || ""} ${observation.detail || ""}`
        );
      if (!observationIsRequest) continue;
      observation.kind = "request";
      observation.needsFollowUp = false;
      observation.positiveContext = positiveSocialMediaContext(text);
      if (observation.sentiment === "positive") observation.sentiment = "neutral";
    }
  }

  const appreciations = Array.isArray(interpretation?.appreciations)
    ? interpretation.appreciations.map((item) => ({ ...item }))
    : extractExplicitAppreciations(text, serviceList);
  const conducted = {
    captured: groundMultiServiceCaptures(
      scopeCapturedToPendingQuestion(stateBefore, interpretedCaptures, interpretation, text),
      text,
      project,
      stateBefore
    ),
    observations,
    appreciations,
    overallRating: interpretation?.rating ?? null,
    corrects: false
  };
  separateAppreciations(conducted);
  conducted.observations = mergeObservations(
    conducted.observations || [],
    (conducted.appreciations || []).map((item) => ({
      topic: item.subject,
      detail: item.detail,
      sentiment: "positive",
      severity: "info",
      needsFollowUp: false,
      serviceKey: item.serviceKey || null,
      kind: "appreciation"
    }))
  );

  reconcilePendingServiceArtifacts(
    turn.conversationState,
    stateBefore,
    conducted.captured
  );
  resetFreshCapturedServices(
    turn.conversationState,
    stateBefore,
    conducted.captured
  );
  applyCaptured(
    turn.conversationState,
    project,
    conducted.captured,
    acceptedOverallRating(stateBefore, conducted),
    false
  );
  applyTurnServiceScope(
    turn.conversationState,
    project,
    text,
    interpretation,
    conducted,
    stateBefore
  );
  applyPendingIssueInterpretation(turn.conversationState, stateBefore, interpretation);
  applyConversationInterruption(
    turn.conversationState,
    stateBefore,
    interpretation,
    conducted,
    text
  );

  // Explicit praise already answers the later appreciation question. Other
  // pending questions stay open because the client explicitly asked to pause.
  if (conducted.appreciations.length) {
    applyTurnProgress(turn.conversationState, project, {
      appreciationVolunteered: true
    }, { recordAsked: false });
  }
  normalizeLegacyServiceFollowups(turn.conversationState);
  turn.analysis.observations = mergeObservations(
    turn.analysis.observations || [],
    conducted.observations || []
  );

  return conducted;
}

// =====================================================================
// v2 API surface
//
//   GET  /api/health
//   GET  /api/dashboard
//   GET  /api/projects
//   GET  /api/projects/:projectKey
//   GET  /api/projects/:projectKey/workspace
//   POST /api/projects/:projectKey/request-feedback   { cycleType }
//   GET  /api/sessions/:sessionId
//   POST /api/sessions/:sessionId/messages            { text }   (web test)
//   POST /api/sessions/:sessionId/reminder
//   POST /api/whatsapp/inbound                        { from, text }
//   POST /api/whatsapp/sessions/:sessionId/reply      { text }
//   GET  /api/automation/due-feedback
//   POST /api/automation/create-due-sessions
//   GET  /api/automation/due-reminders
//   POST /api/automation/process-due-reminders
//   POST /api/issues/:issueId/(close|reopen|progress)
// =====================================================================

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(payload, null, 2)
  };
}

function error(statusCode, message, details) {
  return json(statusCode, { error: message, details });
}

function trimSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

function buildResumeUrl(baseUrl, project, session) {
  const projectKey = project && (project.key || project.projectKey);
  if (!projectKey) return null;
  const sessionPart = session && session.id ? `&session=${encodeURIComponent(session.id)}` : "";
  return `${trimSlash(baseUrl)}/project?project=${encodeURIComponent(projectKey)}${sessionPart}`;
}

function headerValue(headers, name) {
  const target = name.toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === target);
  return entry ? entry[1] : undefined;
}

const APP_SESSION_COOKIE = "srv_csat_session";
const APP_SESSION_TTL_SECONDS = 12 * 60 * 60;

function appLoginPassword() {
  const value = String(process.env.APP_LOGIN_PASSWORD || "");
  return value.length >= 8 ? value : null;
}

function appSessionSecret() {
  const separateSecret = String(process.env.APP_SESSION_SECRET || "");
  return separateSecret.length >= 16 ? separateSecret : appLoginPassword();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signSessionPayload(payload) {
  const secret = appSessionSecret();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function createAppSessionToken(now = Date.now()) {
  if (!appLoginPassword()) return null;
  const payload = Buffer.from(JSON.stringify({
    exp: now + (APP_SESSION_TTL_SECONDS * 1000),
    nonce: crypto.randomBytes(16).toString("base64url")
  })).toString("base64url");
  return `${payload}.${signSessionPayload(payload)}`;
}

function readCookie(headers, name) {
  const source = String(headerValue(headers, "cookie") || "");
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function verifyAppSessionToken(token, now = Date.now()) {
  const [payload, signature, ...extra] = String(token || "").split(".");
  const expectedSignature = payload ? signSessionPayload(payload) : null;
  if (!payload || !signature || !expectedSignature || extra.length || !safeEqual(signature, expectedSignature)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(decoded.exp) && decoded.exp > now;
  } catch {
    return false;
  }
}

function isAppAuthenticated(headers) {
  return verifyAppSessionToken(readCookie(headers, APP_SESSION_COOKIE));
}

function sessionCookie(token, baseUrl) {
  const secure = String(baseUrl || "").startsWith("https://") ? "; Secure" : "";
  return `${APP_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${APP_SESSION_TTL_SECONDS}`;
}

function expiredSessionCookie(baseUrl) {
  const secure = String(baseUrl || "").startsWith("https://") ? "; Secure" : "";
  return `${APP_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

function withResponseHeaders(response, headers) {
  return { ...response, headers: { ...(response.headers || {}), ...headers } };
}

function isMachineApiPath(pathname) {
  return /^\/api\/(?:whatsapp|automation)(?:\/|$)/.test(pathname);
}

function slugIdentifier(value, fallback = "record") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function serviceIdentifier(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const standard = new Map([
    ["account management", "account"],
    ["design", "design"],
    ["ppc media", "ppc"],
    ["seo", "seo"],
    ["website", "website"]
  ]);
  return standard.get(normalized)
    || slugIdentifier(value, "service").replace(/-/g, "_");
}

async function availableIdentifier(baseValue, exists, reserved = new Set()) {
  const base = slugIdentifier(baseValue);
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate) || await exists(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  reserved.add(candidate);
  return candidate;
}

async function pocWhatsappConflict(store, phone, projectId, exceptId = null) {
  if (typeof store.whatsappConflict === "function") {
    return store.whatsappConflict(phone, projectId, exceptId);
  }
  const owner = await store.whatsappOwner(phone, exceptId);
  return owner ? { kind: "different_client", owner } : null;
}

async function pocWhatsappConflictForClient(store, phone, clientId) {
  if (typeof store.whatsappConflictForClient === "function") {
    return store.whatsappConflictForClient(phone, clientId);
  }
  const owner = await store.whatsappOwner(phone);
  return owner ? { kind: "different_client", owner } : null;
}

function validOptionalIsoDate(value) {
  if (value === undefined || value === null || value === "") return true;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/**
 * Admin writes are gated by a shared PIN, checked server-side so the gate holds
 * even when the API is called directly. This is not real auth: anyone with the
 * PIN can write anything and there is no per-user audit trail.
 */
function isAdminAuthorized(headers) {
  const expected = process.env.ADMIN_PIN;
  if (!expected) return false;
  return headerValue(headers, "x-admin-pin") === expected;
}

function isAutomationAuthorized(headers) {
  const expected = process.env.N8N_WEBHOOK_SECRET;
  if (!expected || expected === "replace-with-shared-secret") return true;
  return headerValue(headers, "x-csat-webhook-secret") === expected;
}

/**
 * Fire an automation event WITHOUT blocking the client's reply.
 *
 * These webhooks reach n8n, which opens an SMTP connection and sends mail
 * before responding. Awaiting that put an email handshake on the critical path
 * of a WhatsApp reply — several seconds per turn, for something the reply does
 * not depend on. Production chat bots answer first and notify afterwards.
 *
 * Failures are logged, never thrown: a webhook outage must not break a
 * conversation.
 */
const pendingAutomationKeys = new Set();

function notifyAutomationAsync(store, eventType, payload, dedupeKey = null, waitUntil = null) {
  const task = notifyAutomation(store, eventType, payload, dedupeKey).catch((error) => {
    console.warn(`[automation] ${eventType} failed:`, error.message);
  });
  if (typeof waitUntil === "function") waitUntil(task);
}

function hasStatedOverallRating(session) {
  const state = session?.conversationState || {};
  return session?.csatSource === "stated"
    || (state.overallRating !== null && state.overallRating !== undefined);
}

function shouldUseFinalRatingReminder(session) {
  return session?.completionStatus === "partial"
    && (Number(session.reminderCount) || 0) + 1 === MAX_REMINDERS
    && !hasStatedOverallRating(session);
}

async function notifyAutomation(store, eventType, payload, dedupeKey = null) {
  if (dedupeKey && pendingAutomationKeys.has(dedupeKey)) {
    return { eventType, status: "duplicate", dedupeKey };
  }
  if (dedupeKey) pendingAutomationKeys.add(dedupeKey);

  try {
    let claim = null;
    if (dedupeKey && typeof store.claimAutomationEvent === "function") {
      claim = await store.claimAutomationEvent(eventType, payload, dedupeKey);
      if (!claim) return { eventType, status: "duplicate", dedupeKey };
    }

    const event = { ...(await emitAutomation(eventType, payload)), dedupeKey };
    if (claim && typeof store.completeAutomationEvent === "function") {
      try {
        await store.completeAutomationEvent(claim.id, event);
      } catch {
        // Audit logging must never break a client conversation.
      }
    } else if (typeof store.recordAutomationEvent === "function") {
      try {
        await store.recordAutomationEvent(event);
      } catch {
        // Audit logging must never break a client conversation.
      }
    }
    return event;
  } finally {
    if (dedupeKey) pendingAutomationKeys.delete(dedupeKey);
  }
}

function clientQuestionsFromSessions(sessions = []) {
  return sessions.flatMap((session) => {
    const questions = (session.conversationState && session.conversationState.offTopicQuestions) || [];
    return questions.map((question) => ({
      ...question,
      pocName: session.pocName || null,
      sessionId: session.id
    }));
  });
}

function cycleCompletedPayload(summary, resumeUrl, fallbackQuestions = []) {
  const sessionQuestions = clientQuestionsFromSessions(summary.sessions);
  return {
    project: summary.project,
    cycle: summary.cycle,
    sessions: summary.sessions || [],
    issues: summary.issues || [],
    appreciations: summary.appreciations || [],
    observations: summary.observations || [],
    recipients: summary.recipients || [],
    clientQuestions: sessionQuestions.length ? sessionQuestions : fallbackQuestions,
    csatScore: summary.cycle.csatScore,
    resumeUrl
  };
}

/**
 * A client can leave after giving useful feedback but before reaching the
 * rating question. When the third-reminder grace period expires, run the same
 * whole-transcript reads used by a normal terminal turn. This creates no
 * client reply and never runs for a true no-response session.
 */
async function analyzeTimedOutPartialSession({
  store,
  session,
  project,
  poc,
  closureReason = "partial_after_three_reminders"
}) {
  if (typeof store.getMessagesForSession !== "function") return null;
  const messages = await store.getMessagesForSession(session.id);
  const clientMessages = messages.filter((message) => message.side === "client");
  if (!clientMessages.length) return null;

  const terminalState = {
    ...(session.conversationState || {}),
    state: STATES.COMPLETED,
    ...(closureReason === "partial_after_three_reminders" ? {
      reminderExhausted: true,
      reminderClosedAt: session.conversationState?.reminderClosedAt || new Date().toISOString()
    } : {}),
    closureReason
  };
  const latestText = String(clientMessages[clientMessages.length - 1]?.body || "");
  const analysis = buildAnalysis(
    terminalState,
    project,
    poc,
    latestText,
    terminalState.guardrailHits || []
  );

  const satisfactionEvidence = hasSatisfactionEvidence({
    conversationState: terminalState,
    messages
  });
  const [tone, predicted, review, derivedNps] = await Promise.all([
    satisfactionEvidence
      ? readTone({ conversationState: terminalState, messages })
      : Promise.resolve({ tone: null, reason: "No satisfaction feedback was provided.", source: "fallback" }),
    satisfactionEvidence
      ? predictSatisfaction({ project, conversationState: terminalState, messages })
      : Promise.resolve({ overall: null, services: [], observations: [], source: "fallback", error: "insufficient_feedback" }),
    satisfactionEvidence
      ? reviewIssues({ project, conversationState: terminalState, messages })
      : Promise.resolve({ issues: [], source: "fallback", error: "insufficient_feedback" }),
    satisfactionEvidence && session.sessionType === "project_end"
      && (analysis.npsScore === null || analysis.npsScore === undefined)
      ? readNps({ conversationState: terminalState, messages })
      : Promise.resolve({ score: null, reason: null, source: null })
  ]);

  analysis.tone = tone.tone;
  analysis.toneReason = tone.reason;
  analysis.toneSource = tone.source;

  if (!satisfactionEvidence) {
    // Remove an old neutral midpoint that may have been created by the former
    // "any client message is scorable" rule. A greeting or a postponement is
    // a response for follow-up purposes, but it is not satisfaction evidence.
    analysis.csatScore = null;
    analysis.csatSource = null;
    analysis.predictedCsat = null;
    analysis.predictedConfidence = null;
    analysis.predictedReasoning = null;
    analysis.predictedSignals = [];
    analysis.riskLevel = null;
  } else if (predicted.overall) {
    analysis.predictedCsat = predicted.overall.score;
    analysis.predictedConfidence = predicted.overall.confidence;
    analysis.predictedReasoning = predicted.overall.reasoning;
    analysis.predictedSignals = predicted.overall.signals;
    analysis.csatSource = analysis.csatScore === null ? "predicted" : "stated";
    if (analysis.csatScore === null) analysis.csatScore = predicted.overall.score;
  } else if (analysis.csatScore !== null && analysis.csatScore !== undefined) {
    analysis.csatSource = session.csatSource || "stated";
  } else if (session.csatScore !== null && session.csatScore !== undefined) {
    // Preserve a score that may have been added manually before the reminder
    // loop expired; an unavailable model must never erase it.
    analysis.csatScore = session.csatScore;
    analysis.csatSource = session.csatSource || null;
    analysis.predictedCsat = session.predictedCsat;
    analysis.predictedConfidence = session.predictedConfidence;
    analysis.predictedReasoning = session.predictedReasoning;
    analysis.predictedSignals = session.predictedSignals;
  }

  if (analysis.csatScore !== null && analysis.csatScore !== undefined && !analysis.riskLevel) {
    analysis.riskLevel = analysis.csatScore < 5 ? "High" : analysis.csatScore < 7 ? "Watch" : "Low";
  }
  if (["frustrated", "disengaged"].includes(analysis.tone) && analysis.riskLevel === "Low") {
    analysis.riskLevel = "Watch";
  }

  const predictedByService = new Map((predicted.services || []).map((item) => [item.serviceKey, item]));
  for (const service of analysis.services || []) {
    const guess = predictedByService.get(service.serviceKey);
    if (!guess) continue;
    service.predictedRating = guess.score;
    service.predictedConfidence = guess.confidence;
    service.predictedReasoning = guess.reasoning;
    service.ratingSource = service.rating === null || service.rating === undefined ? "predicted" : "stated";
  }

  analysis.observations = mergeObservations(
    analysis.observations || [],
    predicted.observations || []
  );

  if (session.sessionType === "project_end") {
    if (analysis.npsScore !== null && analysis.npsScore !== undefined) {
      analysis.npsSource = "stated";
    } else if (derivedNps.score !== null) {
      analysis.npsScore = derivedNps.score;
      analysis.npsReason = derivedNps.reason;
      analysis.npsSource = derivedNps.source;
    }
  } else {
    analysis.npsScore = null;
    analysis.npsSource = null;
  }

  const proposed = new Map((review.issues || []).map((item) => [item.serviceKey, item]));
  for (const service of analysis.services || []) {
    const fromModel = proposed.get(service.serviceKey);
    if (fromModel) {
      service.issueReady = true;
      service.issueTitle = cleanRepeatedText(fromModel.title, 160);
      service.issueRootCause = cleanRepeatedText(fromModel.rootCause, 800);
      service.issueSeverity = fromModel.severity;
      proposed.delete(service.serviceKey);
    } else if (service.issueReady) {
      service.issueTitle = cleanRepeatedText(
        `${service.serviceName}: ${service.reasonText || "Client reported an issue"}`,
        160
      );
      service.issueRootCause = cleanRepeatedText(
        service.reasonText || "The client reported a service concern without further detail.",
        800
      );
    }
  }

  for (const [serviceKey, item] of proposed) {
    const known = (project?.services || []).find((service) => service.serviceKey === serviceKey);
    analysis.services.push({
      serviceKey,
      serviceName: known ? known.name : serviceKey,
      sentiment: "negative",
      rating: null,
      reasonText: item.rootCause,
      reasonTags: [],
      issueReady: true,
      issueTitle: cleanRepeatedText(item.title, 160),
      issueRootCause: cleanRepeatedText(item.rootCause, 800),
      issueSeverity: item.severity,
      ownerName: known ? known.ownerName : null,
      ownerEmail: known ? known.ownerEmail : null,
      managerName: known ? known.managerName : null,
      managerEmail: known ? known.managerEmail : null,
      internalPocId: known ? known.internalPocId : null
    });
  }
  suppressDuplicateIssues(analysis.services || []);

  analysis.isComplete = true;
  analysis.completionStatus = "partial";
  analysis.dueInHours = null;
  analysis.conversationState = terminalState;
  analysis.closedByReminderPolicy = closureReason === "partial_after_three_reminders";
  analysis.closedByAdmin = closureReason === "stopped_by_admin";
  return analysis;
}

/**
 * Direct PATCH on a session for things the store has no dedicated method for
 * (stopping reminders after opt-out / handoff). Uses the store's own request
 * helper so it goes through the same auth and error handling.
 */
async function patchSession(store, sessionId, body) {
  if (typeof store.request !== "function") return null;
  const rows = await store.request("feedback_sessions", {
    method: "PATCH",
    query: `id=eq.${encodeURIComponent(sessionId)}`,
    body
  });
  return rows && rows[0] ? rows[0] : null;
}

// ---------------------------------------------------------------------
// One WhatsApp (or web) turn
// ---------------------------------------------------------------------

function clientBurstContext(messages = [], currentMessage = null) {
  if (!currentMessage) return { superseded: false, text: "", previousMessages: messages };
  const currentIndex = messages.findIndex((message) => message.id === currentMessage.id);
  if (currentIndex < 0) {
    return {
      superseded: false,
      text: currentMessage.body || "",
      previousMessages: messages.filter((message) => message.id !== currentMessage.id)
    };
  }

  // A client often sends one thought as two WhatsApp bubbles. Only the newest
  // invocation should answer; otherwise both requests read the same old state
  // and send the same question twice.
  if (messages.slice(currentIndex + 1).some((message) => message.side === "client")) {
    return { superseded: true, text: "", previousMessages: messages };
  }

  let lastSrvIndex = -1;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (messages[index].side === "srv") {
      lastSrvIndex = index;
      break;
    }
  }
  const burst = messages.slice(lastSrvIndex + 1, currentIndex + 1)
    .filter((message) => message.side === "client");
  return {
    superseded: false,
    text: burst.map((message) => String(message.body || "").trim()).filter(Boolean).join("\n"),
    previousMessages: messages.filter((_, index) => index !== currentIndex)
  };
}

function supersededTurnResponse(session, clientMessage) {
  return json(200, {
    superseded: true,
    sendToWhatsapp: false,
    sessionId: session.id,
    receivedMessage: clientMessage
  });
}

async function handleTurn({ store, session, project, poc, body, text, baseUrl, channel, waitUntil }) {
  const turnStartedAt = Date.now();
  // --- G1: Meta retries webhooks. The same provider message id must never
  // be processed twice, or one complaint becomes two issues.
  const providerMessageId = body.providerMessageId || null;
  if (providerMessageId && typeof store.hasProviderMessage === "function") {
    if (await store.hasProviderMessage(providerMessageId)) {
      return json(200, {
        duplicate: true,
        guardrail: GUARDRAILS.DUPLICATE_INBOUND,
        sendToWhatsapp: false,
        sessionId: session.id
      });
    }
  }

  let previousMessages = typeof store.getMessagesForSession === "function"
    ? await store.getMessagesForSession(session.id)
    : [];

  const inbound = {
    speaker: body.fromName || (poc && (poc.salutation || poc.name)) || "Client",
    side: "client",
    body: text,
    providerMessageId,
    metadata: {
      source: channel === "whatsapp" ? "whatsapp" : "web_test",
      from: body.from || null
    }
  };
  const clientMessage = providerMessageId && typeof store.addInboundMessage === "function"
    ? await store.addInboundMessage(session.id, inbound)
    : await store.addMessage(session.id, inbound);

  // The atomic insert lost a race with another delivery of the same wamid.
  if (!clientMessage) {
    return json(200, {
      duplicate: true,
      guardrail: GUARDRAILS.DUPLICATE_INBOUND,
      sendToWhatsapp: false,
      sessionId: session.id
    });
  }

  // Refresh after the atomic insert. When the client sends consecutive
  // bubbles, the latest invocation processes them as one thought and the
  // older invocation is suppressed. Refreshing the session also prevents a
  // queued invocation from starting with state another invocation advanced.
  if (channel === "whatsapp" && providerMessageId && typeof store.getMessagesForSession === "function") {
    const liveMessages = await store.getMessagesForSession(session.id);
    const burst = clientBurstContext(liveMessages, clientMessage);
    if (burst.superseded) return supersededTurnResponse(session, clientMessage);
    text = burst.text || text;
    previousMessages = burst.previousMessages;
    if (typeof store.getSession === "function") {
      session = await store.getSession(session.id) || session;
    }
  }

  // The machine MUTATES conversationState in place, and we may run it twice —
  // once to see whether interpretation is needed, then again with it. Without
  // a snapshot the second pass starts from a state the first pass already
  // advanced, so one message moves the conversation two steps: the client
  // named a service, was silently marked as having been asked for the reason,
  // and went straight to the rating.
  const stateBefore = JSON.parse(JSON.stringify(session.conversationState || {}));
  const latestSrvMessage = [...previousMessages].reverse().find((message) => message.side === "srv");
  const manualContext = Boolean(latestSrvMessage?.metadata?.manualOutbound);
  let turn = processWhatsAppReply({ session, project, poc, text, manualContext });
  const transcript = previousMessages.concat(clientMessage);

  // The rules did not understand this reply — "Mo", "Not", "I want to say more".
  // Ask Gemini what the client MEANT, then run the same turn again with that
  // interpretation. Gemini reads intent; the state machine still decides.
  let interpretation = null;
  if (turn.needsInterpretation || (manualContext && !turn.control?.optOut && !turn.control?.handoff)) {
    const lastQuestion = latestSrvMessage;
    const read = await interpretReply({
      project,
      question: lastQuestion ? lastQuestion.body : "",
      text
    });

    // If Gemini could not be reached, let the rules fall back to their keyword
    // matching — degraded, but better than refusing every inexact reply during
    // an outage.
    const unavailable = Boolean(read.error) && read.source === "fallback";

    // Keep the interpretation even when the INTENT is unclear. Gemini can read
    // "PPC is not working well" as PPC, negative, unexplained — all correct —
    // and still be unsure what kind of reply it is. Discarding the whole
    // response over one field threw away everything it understood.
    interpretation = read.source === "gemini" ? read : null;

    // Rewind to exactly where the turn started before running it again.
    turn = processWhatsAppReply({
      session: { ...session, conversationState: JSON.parse(JSON.stringify(stateBefore)) },
      project,
      poc,
      text,
      interpretation,
      geminiUnavailable: unavailable,
      manualContext
    });
  }

  const control = turn.control || {};

  // The previous bubble already resumed the survey and sent the pending
  // question. Keep this second conversational control message in the inbound
  // transcript, but do not store or send a duplicate assistant response.
  if (control.suppressReply) {
    return json(200, {
      suppressed: true,
      suppressionReason: "consecutive_resumption",
      sendToWhatsapp: false,
      sessionId: session.id,
      receivedMessage: clientMessage,
      state: turn.conversationState.state
    });
  }

  // The client asked something off-topic. Collect it; the email goes out once,
  // at session end, rather than interrupting a manager three times.
  if (control.collectOffTopic) {
    turn.conversationState.offTopicQuestions = [
      ...(turn.conversationState.offTopicQuestions || []),
      { text: control.collectOffTopic, at: new Date().toISOString() }
    ];
  }

  // Gemini gets exactly two openings here, both fenced:
  //   1. reword an ordinary question the state machine already chose
  //   2. write the decline clause for an off-script message
  // It never authors a whole turn and never speaks on a guardrail line.
  let replyText = turn.nextMessage.body;
  let replyProvider = "state_machine";
  let replyModel = null;
  let replyError = null;

  // A deferral is already a complete, safe control response. Gemini may have
  // been needed to understand unusual wording, but it must not generate a
  // second turn that the checklist can reject and replace with a service
  // question. Preserve the pending question for whenever the client returns.
  if (control.deferred) {
    const deferredFacts = applyDeferredInterpretation(
      turn,
      stateBefore,
      interpretation,
      text,
      project
    );
    control.deferredCapture = {
      services: deferredFacts.captured.map((item) => item.serviceKey),
      observations: deferredFacts.observations.length,
      appreciations: deferredFacts.appreciations.length,
      rating: acceptedOverallRating(stateBefore, deferredFacts)
    };
    replyProvider = "state_machine";
    replyError = null;
  } else if (control.allowAiRephrase) {
    // The model writes the turn from a checklist of what is still open. The
    // state machine supplied the fallback text and still owns the boundaries;
    // it no longer dictates the words or the order. A scripted bot answered
    // "I have not met Sarang in three months" with the next line of its script.
    normalizeLegacyServiceFollowups(turn.conversationState);
    const conductorChecklist = buildChecklist(turn.conversationState, project);
    const preferredAction = requiredConversationAction(conductorChecklist, turn.conversationState);
    const conducted = await conductTurn({
      project,
      poc,
      checklist: conductorChecklist,
      preferredAction,
      messages: transcript
    });

    if (conducted.text && conducted.deferRequested === true) {
      suppressBroadOverallServiceGuess(conducted, interpretation, text, project);
      // The conductor is also the first model read for messages whose service
      // feedback was obvious but whose postponement wording was unfamiliar to
      // the rules. Rebuild from the pre-turn snapshot so no draft next-question
      // markers are persisted, then keep every extracted fact and pause.
      turn.conversationState = getConversationState({
        ...session,
        conversationState: JSON.parse(JSON.stringify(stateBefore))
      });
      turn.conversationState.turnCount = Number(stateBefore.turnCount || 0) + 1;
      turn.conversationState.deferredAt = new Date().toISOString();
      turn.conversationState.repeatCount = 0;
      turn.analysis = buildAnalysis(
        turn.conversationState,
        project,
        poc,
        text,
        turn.conversationState.guardrailHits || []
      );
      const deferredFacts = applyDeferredInterpretation(
        turn,
        stateBefore,
        {
          ...(interpretation || {}),
          intent: (conducted.captured.length || conducted.observations.length || conducted.appreciations.length)
            ? "feedback"
            : "defer",
          deferRequested: true,
          serviceScope: conducted.serviceScope,
          rating: conducted.overallRating,
          serviceKeys: conducted.captured.map((item) => item.serviceKey),
          captured: conducted.captured,
          observations: conducted.observations,
          appreciations: conducted.appreciations
        },
        text,
        project
      );
      control.deferred = true;
      control.allowAiRephrase = false;
      control.deferredCapture = {
        services: deferredFacts.captured.map((item) => item.serviceKey),
        observations: deferredFacts.observations.length,
        appreciations: deferredFacts.appreciations.length,
        rating: acceptedOverallRating(stateBefore, deferredFacts)
      };
      replyText = DEFERRAL_REPLY;
      replyProvider = "state_machine";
      replyModel = conducted.model;
      replyError = null;
    } else if (conducted.text) {
      suppressBroadOverallServiceGuess(conducted, interpretation, text, project);
      conducted.captured = scopeCapturedToPendingQuestion(
        stateBefore,
        conducted.captured,
        interpretation,
        text
      );
      conducted.captured = groundMultiServiceCaptures(
        conducted.captured,
        text,
        project,
        stateBefore
      );
      separateAppreciations(conducted);
      for (const observation of conducted.observations || []) {
        if (observation.kind === "appreciation") continue;
        observation.topic = canonicalObservationTopic(observation, text);
      }
      const explicitRequest = isExplicitActionRequest(text);
      if (explicitRequest) {
        for (const observation of conducted.observations || []) {
          if (observation.kind === "appreciation") continue;
          const observationIsRequest = isExplicitActionRequest(observation.detail)
            || /\b(?:meeting|senior management|senior involvement)\b/i.test(
              `${observation.topic || ""} ${observation.detail || ""}`
            );
          if (!observationIsRequest) continue;
          observation.kind = "request";
          observation.needsFollowUp = false;
          observation.positiveContext = positiveSocialMediaContext(text);
          if (observation.sentiment === "positive") observation.sentiment = "neutral";
        }
      }
      const interpretedObservation = observationFromInterpretation(interpretation, text);
      if (interpretedObservation) {
        const alreadyCaptured = (conducted.observations || []).some((observation) =>
          observation.kind === "request"
          || /\b(?:meeting|senior management|senior involvement)\b/i.test(
            `${observation.topic || ""} ${observation.detail || ""}`
          )
        );
        if (!alreadyCaptured) {
          conducted.observations = [...(conducted.observations || []), interpretedObservation];
        }
      }
      reconcilePendingServiceArtifacts(
        turn.conversationState,
        stateBefore,
        conducted.captured
      );
      resetFreshCapturedServices(
        turn.conversationState,
        stateBefore,
        conducted.captured
      );
      const appreciationObservations = (conducted.appreciations || []).map((item) => ({
        topic: item.subject,
        detail: item.detail,
        sentiment: "positive",
        severity: "info",
        needsFollowUp: false,
        serviceKey: item.serviceKey || null,
        kind: "appreciation"
      }));
      conducted.observations = mergeObservations(
        conducted.observations || [],
        appreciationObservations
      );

      // Record what the model understood, or the conversation moves on while
      // the state stays empty — the bot said "we will skip PPC" and nothing
      // marked PPC as covered, so the session could never close.
      applyCaptured(
        turn.conversationState, project,
        conducted.captured,
        acceptedOverallRating(stateBefore, conducted),
        conducted.corrects
      );
      applyTurnServiceScope(
        turn.conversationState,
        project,
        text,
        interpretation,
        conducted,
        stateBefore
      );
      applyPendingIssueInterpretation(turn.conversationState, stateBefore, interpretation);
      applyConversationInterruption(
        turn.conversationState, stateBefore, interpretation, conducted, text
      );
      // First record only what THIS client reply answered. The checklist then
      // selects the next action; outgoing-question markers are accepted only
      // when they match that action.
      const answerMarkers = validatedAnswerMarkers(stateBefore, conducted, text, interpretation);
      applyTurnProgress(turn.conversationState, project, answerMarkers, { recordAsked: false });
      normalizeLegacyServiceFollowups(turn.conversationState);
      const checklistAfterCapture = buildChecklist(turn.conversationState, project);
      const requiredAction = requiredConversationAction(checklistAfterCapture, turn.conversationState);
      const actualAction = conductedAction(conducted);
      // Do not discard a good Gemini reply merely because one JSON marker was
      // omitted or mis-set. Validate the client-facing words as well. The hard
      // checklist still blocks genuinely wrong transitions (for example,
      // asking about PPC instead of offering the requested continue/skip choice).
      const actionRejected = !actionMatches(requiredAction, actualAction)
        && !messageMatchesRequiredAction(requiredAction, conducted.text);
      const requiredService = requiredAction.serviceKey
        ? turn.conversationState.mentionedServices?.[requiredAction.serviceKey]
        : null;
      const needsConcernAcknowledgement = ["issue_reason", "service_followup"].includes(requiredAction.type)
        && requiredService?.sentiment === "negative";
      const hasConcernAcknowledgement = /\b(?:sorry|hear you|thank you for (?:raising|explaining|sharing|flagging)|appreciate you (?:raising|explaining|sharing|flagging)|thank you for letting us know)\b/i.test(conducted.text)
        && /\b(?:look into|review|work on|share (?:this|it) with|take this forward)\b/i.test(conducted.text);
      const machineWordedAction = (needsConcernAcknowledgement && !hasConcernAcknowledgement)
        || (requiredAction.type === "observation_followup"
          && (conducted.appreciations?.length
            || ["Billing", "Senior Involvement"].includes(requiredAction.topic)));

      if (actionRejected || machineWordedAction) {
        if (actionRejected) {
          console.warn(`[turn] rejected next action ${actualAction.type}; required ${requiredAction.type}`);
        }
        conducted.text = fallbackForAction(requiredAction, turn.conversationState, project, conducted);
        conducted.readyToClose = requiredAction.type === "close";
      }
      const recordedQuestion = recordRequiredQuestion(turn.conversationState, project, requiredAction);

      // The score is re-read from the whole conversation at the end anyway, so
      // a correction simply changes what that reading sees. What must not
      // happen is an issue surviving from a complaint they withdrew.
      if (conducted.corrects) turn.conversationState.needsRescore = true;

      if ((conducted.observations || []).length) {
        turn.analysis.observations = mergeObservations(
          turn.analysis.observations || [],
          conducted.observations
        );
      }

      // The MACHINE decides when the session ends. A model saying "thank you
      // for your time" is not closure, and one that never says it would leave
      // the session open indefinitely.
      const covered = isEverythingCovered(turn.conversationState, project);

      // Only close when the message we are about to send is a CLOSING message.
      // Completing while still asking a question meant the client's answer
      // arrived at an already-closed session: the rating triggered the
      // post-completion guardrail, the closing message was never sent, and a
      // manager was emailed about the client's own score.
      const stillAsking = /\?\s*$/.test(conducted.text.trim());

      // Remember that we actually asked. A session may only close once the
      // client has been asked for a rating and answered — not because every
      // service happened to get a mention.
      if (covered && !stillAsking) {
        turn.conversationState.state = STATES.CLOSING_GRACE;
        const existingExpiry = Date.parse(turn.conversationState.closingGraceExpiresAt || "");
        if (!Number.isFinite(existingExpiry) || existingExpiry <= Date.now()) {
          turn.conversationState.closingGraceExpiresAt = new Date(Date.now() + CLOSING_GRACE_MS).toISOString();
        }
        turn.analysis.isComplete = true;
        turn.analysis.completionStatus = "completed";
        turn.analysis.requiresCompletionReminder = false;
        turn.analysis.dueInHours = null;
      } else {
        if (turn.conversationState.state === STATES.COMPLETED) {
          turn.conversationState.state = STATES.WAITING_FOR_MORE_SERVICES;
        }
        turn.analysis.isComplete = false;
        turn.analysis.completionStatus = "partial";
      }

      setStateForRequiredAction(turn.conversationState, requiredAction, recordedQuestion);

      replyText = conducted.text;
      if (turn.conversationState.state === STATES.CLOSING_GRACE) {
        replyText = closingGraceMessage(poc, turn.conversationState);
      }

      // A farewell written while the checklist is unsatisfied is replaced with
      // the outstanding question. The model ended a conversation after one
      // service with "Have a great day ahead!" — the client reasonably read
      // that as the end, and the cycle closed with no rating and no score.
      const wantsToLeave = soundsLikeFarewell(conducted.text) || conducted.readyToClose;
      if (!covered && wantsToLeave) {
        const services = Object.values(turn.conversationState.mentionedServices || {});
        const uncovered = (project.services || [])
          .filter((svc) => !services.some((item) => item.serviceKey === svc.serviceKey));
        const projectEndOverall = turn.conversationState.sessionType === "project_end"
          && turn.conversationState.projectEndReviewCaptured === true
          && turn.conversationState.serviceScopeStatus !== "service_by_service";

        replyText = projectEndOverall
          ? fallbackForAction(requiredAction, turn.conversationState, project, conducted)
          : uncovered.length
          ? `Before we finish — how has ${uncovered[0].name} been for you?`
          : overallRatingQuestion(turn.conversationState, project);
        replyProvider = "state_machine";
        replyError = "blocked_early_close";
      } else if (actionRejected || machineWordedAction) {
        replyProvider = "state_machine";
        replyModel = conducted.model;
        replyError = actionRejected ? "rejected_wrong_next_action" : "required_wording";
      } else {
        replyProvider = "gemini_conducted";
        replyModel = conducted.model;
        replyError = null;
      }
    } else {
      // The model UNDERSTOOD the reply — its turn was rejected for shape:
      // malformed JSON, a promise, too long. Apologising for not following
      // something it read perfectly is the worst of both worlds. Ask whatever
      // is still outstanding, plainly.
      const interpretedObservation = observationFromInterpretation(interpretation, text);
      if (interpretedObservation) {
        interpretedObservation.topic = canonicalObservationTopic(interpretedObservation, text);
      }
      const serviceList = (project.services || []).map((service) => ({
        serviceKey: service.serviceKey,
        name: service.name
      }));
      const fallbackConducted = {
        captured: groundMultiServiceCaptures([], text, project, stateBefore),
        observations: interpretedObservation ? [interpretedObservation] : [],
        appreciations: extractExplicitAppreciations(text, serviceList)
      };
      separateAppreciations(fallbackConducted);

      // An observation must not mutate a nearby service merely because the
      // preliminary keyword pass saw "creative" or "meeting". Restore the
      // pre-turn service state, then apply only grounded deterministic facts.
      if (interpretedObservation) {
        turn.conversationState.mentionedServices = JSON.parse(JSON.stringify(
          stateBefore.mentionedServices || {}
        ));
      }
      resetFreshCapturedServices(
        turn.conversationState,
        stateBefore,
        fallbackConducted.captured
      );
      applyCaptured(
        turn.conversationState,
        project,
        fallbackConducted.captured
      );
      applyTurnServiceScope(
        turn.conversationState,
        project,
        text,
        interpretation,
        fallbackConducted,
        stateBefore
      );
      applyConversationInterruption(
        turn.conversationState,
        stateBefore,
        interpretation,
        fallbackConducted,
        text
      );
      const answerMarkers = validatedAnswerMarkers(stateBefore, fallbackConducted, text, interpretation);
      applyTurnProgress(turn.conversationState, project, answerMarkers, { recordAsked: false });
      normalizeLegacyServiceFollowups(turn.conversationState);

      const appreciationObservations = fallbackConducted.appreciations.map((item) => ({
        topic: item.subject,
        detail: item.detail,
        sentiment: "positive",
        severity: "info",
        needsFollowUp: false,
        serviceKey: item.serviceKey || null,
        kind: "appreciation"
      }));
      turn.analysis.observations = mergeObservations(
        turn.analysis.observations || [],
        fallbackConducted.observations,
        appreciationObservations
      );

      const checklist = buildChecklist(turn.conversationState, project);
      replyProvider = "state_machine";
      replyModel = conducted.model;
      replyError = conducted.error;
      const requiredAction = requiredConversationAction(checklist, turn.conversationState);
      replyText = fallbackForAction(
        requiredAction,
        turn.conversationState,
        project,
        fallbackConducted
      );
      const recordedQuestion = recordRequiredQuestion(turn.conversationState, project, requiredAction);
      setStateForRequiredAction(turn.conversationState, requiredAction, recordedQuestion);
      if (requiredAction.type === "close") {
        turn.conversationState.state = STATES.CLOSING_GRACE;
        replyText = closingGraceMessage(poc, turn.conversationState);
      }
    }
  } else if (control.offScript) {
    // Resume from the structured checklist, never from the legacy question
    // chooser. That older path leaked "rate Design support" into a billing
    // response even though per-service ratings are forbidden.
    const clause = await offScriptReply({ project, poc, text, reason: control.offScript });
    normalizeLegacyServiceFollowups(turn.conversationState);
    const checklist = buildChecklist(turn.conversationState, project);
    const requiredAction = requiredConversationAction(checklist, turn.conversationState);
    const pendingQuestion = fallbackForAction(requiredAction, turn.conversationState, project);
    const recordedQuestion = recordRequiredQuestion(turn.conversationState, project, requiredAction);
    replyText = requiredAction.type === "close" ? clause.text : `${clause.text} ${pendingQuestion}`;
    setStateForRequiredAction(turn.conversationState, requiredAction, recordedQuestion);
    replyProvider = clause.provider;
    replyModel = clause.model;
    replyError = clause.error;
  }

  // A newer WhatsApp bubble may have arrived while Gemini was reading this
  // one. Do not persist stale state or emit a second reply; the newer request
  // sees the complete consecutive-message burst and will answer it once.
  if (channel === "whatsapp" && providerMessageId && typeof store.getMessagesForSession === "function") {
    const liveMessages = await store.getMessagesForSession(session.id);
    if (clientBurstContext(liveMessages, clientMessage).superseded) {
      return supersededTurnResponse(session, clientMessage);
    }
  }

  // processWhatsAppReply prepares a legacy next question before the checklist
  // conductor chooses the actual outgoing message. Persist the message we
  // really send, otherwise the repeat guard compares a future reply with an
  // internal draft the client never saw and can falsely trigger a handoff.
  turn.conversationState.lastQuestionAsked = replyText;

  // The conductor and timeout fallback may have grounded, restored or merged
  // service facts after the preliminary state-machine pass built its analysis.
  // Refresh from the final state so Supabase never stores stale placeholder
  // sentiments/statuses from that preliminary pass.
  if (!control.skipAnalysisWrite) {
    const recordedObservations = turn.analysis.observations || [];
    const refreshedAnalysis = buildAnalysis(
      turn.conversationState,
      project,
      poc,
      text,
      turn.conversationState.guardrailHits || []
    );
    refreshedAnalysis.observations = mergeObservations(
      recordedObservations,
      refreshedAnalysis.observations || []
    );
    turn.analysis = refreshedAnalysis;
  }

  // Reconcile rapid replies before deciding whether terminal analysis is
  // needed. This lets a stale middle message ("sorry, mistake") see the later
  // "Take 8" and prevents it from writing the session back to partial.
  if (!control.skipAnalysisWrite
    && turn.conversationState.overallRatingAsked
    && typeof store.getMessagesForSession === "function") {
    const liveMessages = await store.getMessagesForSession(session.id);
    const latestRating = latestExplicitOverallRating(liveMessages, true);
    const sync = syncTurnToLatestRating(turn, latestRating, project, poc, text);
    if (sync.changed && sync.closed) {
      replyText = `No problem — I have updated your overall rating to ${latestRating} out of 10. The 10-minute correction window remains open.`;
      replyProvider = "state_machine";
      replyError = "reconciled_rapid_rating";
      control.suppressTerminalNotifications = true;
    }
  }


  // A closed session must not have its scores rewritten by a late message.
  let updatedSession = session;
  if (!control.skipAnalysisWrite) {
    const sessionIsEnding = Boolean(turn.analysis.isComplete)
      || ["completed", "opted_out", "handed_off"].includes(turn.conversationState.state);
    // Gemini calls are the whole reason a turn takes seconds, so mid-conversation
    // we make at most ONE (the rephrase). Tone and issue text only matter at the
    // point they are used, so they run when the conversation reaches a terminal
    // state — the last tone read is the only one that counts anyway.
    const terminal = Boolean(turn.analysis.isComplete)
      || ["completed", "opted_out", "handed_off"].includes(turn.conversationState.state);

    if (terminal) {
      // These reads are independent. Running them one after another put four
      // Gemini waits in front of the WhatsApp reply and regularly exceeded the
      // n8n HTTP timeout on the final rating turn. The client-facing response
      // now waits for one bounded analysis window, not four sequential ones.
      const [tone, predicted, review, derivedNps] = await Promise.all([
        readTone({ conversationState: turn.conversationState, messages: transcript }),
        predictSatisfaction({
          project,
          conversationState: turn.conversationState,
          messages: transcript
        }),
        reviewIssues({
          project,
          conversationState: turn.conversationState,
          messages: transcript
        }),
        session.sessionType === "project_end"
          && (turn.analysis.npsScore === null || turn.analysis.npsScore === undefined)
          ? readNps({ conversationState: turn.conversationState, messages: transcript })
          : Promise.resolve({ score: null, reason: null, source: null })
      ]);

      // Tone is stored BESIDE the score and never alters it: a 9/10 delivered
      // flatly is still a 9.
      turn.analysis.tone = tone.tone;
      turn.analysis.toneReason = tone.reason;
      turn.analysis.toneSource = tone.source;

      // Tone can raise risk on its own: the politely-scoring, quietly-leaving
      // client is exactly the one a number alone misses.
      if (["frustrated", "disengaged"].includes(tone.tone) && turn.analysis.riskLevel === "Low") {
        turn.analysis.riskLevel = "Watch";
      }

      // Predicted satisfaction, read from the whole conversation. Stored
      // BESIDE any stated rating, never instead of it — a predicted score
      // must never be presented as one the client gave. Where the two differ,
      // that gap is the most interesting thing on the dashboard.
      if (predicted.overall) {
        turn.analysis.predictedCsat = predicted.overall.score;
        turn.analysis.predictedConfidence = predicted.overall.confidence;
        turn.analysis.predictedReasoning = predicted.overall.reasoning;
        turn.analysis.predictedSignals = predicted.overall.signals;

        // A stated rating always wins as THE score. The prediction sits
        // alongside it; only when the client gave nothing does it stand in.
        turn.analysis.csatSource = turn.analysis.csatScore === null ? "predicted" : "stated";
        if (turn.analysis.csatScore === null) {
          turn.analysis.csatScore = predicted.overall.score;
        }

        // An uncertain model must not page anyone.
        const confident = predicted.overall.confidence >= ALERT_CONFIDENCE_THRESHOLD;
        turn.analysis.predictionConfident = confident;
        if (!confident && turn.analysis.csatSource === "predicted") {
          turn.analysis.requiresManagerAlert = false;
        }
      }

      // Per-service predictions fill in what the client never rated.
      const predictedByService = new Map(predicted.services.map((item) => [item.serviceKey, item]));
      for (const service of turn.analysis.services || []) {
        const guess = predictedByService.get(service.serviceKey);
        if (!guess) continue;
        service.predictedRating = guess.score;
        service.predictedConfidence = guess.confidence;
        service.predictedReasoning = guess.reasoning;
        service.ratingSource = service.rating === null || service.rating === undefined
          ? "predicted"
          : "stated";
      }

      // Billing, a named person, a process — real feedback with no owner and
      // no SLA. Previously dropped in silence.
      turn.analysis.observations = mergeObservations(
        turn.analysis.observations || [],
        predicted.observations || []
      );

      // NPS is a project-end question only, and it is derived from the whole
      // conversation rather than a single answer. Marked as derived so the UI
      // never presents a model's judgement as something the client stated.
      if (session.sessionType === "project_end") {
        if (turn.analysis.npsScore !== null && turn.analysis.npsScore !== undefined) {
          turn.analysis.npsSource = "stated";
        } else if (derivedNps.score !== null) {
            turn.analysis.npsScore = derivedNps.score;
            turn.analysis.npsReason = derivedNps.reason;
            turn.analysis.npsSource = derivedNps.source;
          }
      } else {
        // A pulse cycle has no NPS. Storing the CSAT here would just duplicate
        // the same number under a second label.
        turn.analysis.npsScore = null;
        turn.analysis.npsSource = null;
      }

      // Issue review, at session end, over the whole conversation.
      //
      // Gemini proposes issues the rules never spotted. It can only ADD: the
      // rule-based list is a FLOOR, so a service rated 4 or below still reaches
      // an owner even if the model judged it unimportant. One issue per
      // service — several complaints about PPC become one PPC issue.
      const proposed = new Map(review.issues.map((item) => [item.serviceKey, item]));

      for (const service of turn.analysis.services || []) {
        const fromModel = proposed.get(service.serviceKey);
        if (fromModel) {
          // Gemini read the whole conversation, so its wording wins — but the
          // issue exists regardless of what the rules thought.
          service.issueReady = true;
          service.issueTitle = cleanRepeatedText(fromModel.title, 160);
          service.issueRootCause = cleanRepeatedText(fromModel.rootCause, 800);
          service.issueSeverity = fromModel.severity;
          proposed.delete(service.serviceKey);
        } else if (service.issueReady) {
          // The rules caught it and Gemini did not. Write it deterministically
          // instead of adding another model call after the parallel terminal
          // analysis window. An issue must never delay or suppress the closing
          // WhatsApp message.
          service.issueTitle = cleanRepeatedText(
            `${service.serviceName}: ${service.reasonText || "Client reported an issue"}`,
            160
          );
          service.issueRootCause = cleanRepeatedText(
            service.reasonText || "The client reported a service concern without further detail.",
            800
          );
        }
      }

      // A service Gemini flagged that the rules never recorded at all.
      for (const [serviceKey, item] of proposed) {
        const known = (project && project.services || []).find((svc) => svc.serviceKey === serviceKey);
        turn.analysis.services.push({
          serviceKey,
          serviceName: known ? known.name : serviceKey,
          sentiment: "negative",
          rating: null,
          reasonText: item.rootCause,
          reasonTags: [],
          issueReady: true,
          issueTitle: cleanRepeatedText(item.title, 160),
          issueRootCause: cleanRepeatedText(item.rootCause, 800),
          issueSeverity: item.severity,
          ownerName: known ? known.ownerName : null,
          ownerEmail: known ? known.ownerEmail : null,
          managerName: known ? known.managerName : null,
          managerEmail: known ? known.managerEmail : null,
          internalPocId: known ? known.internalPocId : null
        });
      }

      suppressDuplicateIssues(turn.analysis.services || []);
    }

    // Alert ONCE, at session end, whenever the session produced an issue.
    //
    // Tying this to a risk threshold meant a real complaint could be filed with
    // nobody told: a client reported website latency and late reports, rated
    // overall 5, and because 5 is "Watch" rather than "High" no owner heard
    // about it. If an issue exists, its owner should know — severity carries
    // the urgency, it does not decide whether to send at all.
    const hasIssue = (turn.analysis.services || []).some((svc) => svc.issueReady);
    const alertNeeded = control.forceManagerAlert || (sessionIsEnding && hasIssue);

    // Meta/n8n can deliver several WhatsApp messages concurrently. A quick
    // "0", "sorry", "take 8" must not be decided by whichever slow Gemini
    // request finishes last. Re-read the ordered transcript immediately before
    // writing and make the latest explicit rating authoritative.
    if (
      turn.conversationState.state === STATES.CLOSING_GRACE
      && turn.conversationState.overallRatingAsked
      && typeof store.getMessagesForSession === "function"
    ) {
      const liveMessages = await store.getMessagesForSession(session.id);
      const latestRating = latestExplicitOverallRating(liveMessages, true);
      const sync = syncTurnToLatestRating(turn, latestRating, project, poc, text);
      if (sync.changed && sync.closed) {
        replyText = `No problem — I have updated your overall rating to ${latestRating} out of 10. The 10-minute correction window remains open.`;
        replyProvider = "state_machine";
        replyError = "reconciled_rapid_rating";
        control.suppressTerminalNotifications = true;
      }
    }

    updatedSession = await store.applyAnalysis(session.id, turn.analysis);

    // Recorded, not emailed. These used to fire the moment they were spotted,
    // so a manager received director-office mail three times mid-conversation
    // about a client who was still typing. They go out with the cycle summary,
    // once, alongside everything else that cycle produced.
    if ((turn.analysis.observations || []).length && typeof store.recordObservations === "function") {
      await store.recordObservations(session, turn.analysis.observations);
    }
    control._alertNeeded = alertNeeded;
  } else {
    control._alertNeeded = Boolean(control.forceManagerAlert);
  }

  // Stop the reminder clock for terminal outcomes (opt-out, handoff, closed).
  if (control.stopReminders) {
    const patched = await patchSession(store, session.id, {
      reminder_due_at: null,
      status: control.optOut
        ? "opted_out"
        : control.handoff
          ? "needs_attention"
          : updatedSession.status
    });
    if (patched) updatedSession = { ...updatedSession, ...{ status: patched.status, reminderDueAt: patched.reminder_due_at } };
  }

  const assistantMessage = await store.addMessage(session.id, {
    speaker: turn.nextMessage.speaker,
    side: turn.nextMessage.side,
    body: replyText,
    metadata: {
      ...(turn.nextMessage.metadata || {}),
      provider: replyProvider,
      model: replyModel,
      fallbackReason: replyError,
      // The FULL interpretation, not just the intent. Diagnosing a wrong turn
      // without seeing what the model actually returned means guessing, and
      // guessing has cost several rounds of rework.
      interpretation: interpretation
        ? {
          intent: interpretation.intent,
          deferRequested: interpretation.deferRequested === true,
          serviceScope: interpretation.serviceScope,
          sentiment: interpretation.sentiment,
          serviceKeys: interpretation.serviceKeys,
          explainsProblem: interpretation.explainsProblem,
          rating: interpretation.rating,
          captured: interpretation.captured,
          observations: interpretation.observations,
          appreciations: interpretation.appreciations
        }
        : null,
      interpretedIntent: interpretation ? interpretation.intent : null,
      // What the machine did with it, so the two can be compared side by side.
      stateAfter: turn.conversationState.state,
      serviceScopeStatus: turn.conversationState.serviceScopeStatus || null,
      servicesAfter: Object.keys(turn.conversationState.mentionedServices || {}),
      // Recorded so the timeline shows WHY a turn was not understood, rather
      // than only that the bot apologised.
      interpretationFailed: turn.control && turn.control.notUnderstood ? true : undefined,
      aiRephraseAllowed: Boolean(control.allowAiRephrase),
      deferredCapture: control.deferredCapture || null
    }
  });

  const resumeUrl = buildResumeUrl(baseUrl, project, updatedSession);

  notifyAutomationAsync(store, "feedback_received", {
    project,
    poc,
    session: updatedSession,
    analysis: turn.analysis,
    message: clientMessage,
    channel,
    nextMessage: assistantMessage,
    guardrail: control.guardrail || null,
    resumeUrl
  }, `feedback_received:message:${clientMessage.id}`, waitUntil);

  if (control._alertNeeded && control.forceManagerAlert) {
    // Escalation only. Anything else waits for the cycle summary.
    notifyAutomationAsync(store, "manager_alert", {
      project,
      poc,
      session: updatedSession,
      analysis: turn.analysis,
      managerEmail: turn.analysis.managerEmail,
      ownerName: turn.analysis.ownerName,
      clientText: text,
      guardrail: control.guardrail || null,
      resumeUrl
    }, `manager_alert:message:${clientMessage.id}`, waitUntil);
  }

  // One email covering every off-topic question, sent when the conversation
  // ends. We promised the client a person would follow up, so this must not be
  // lost if they never reply again — hence it fires on ANY terminal state, not
  // just a clean completion.
  const sessionEnded = Boolean(turn.analysis.isComplete)
    || ["completed", "opted_out", "handed_off"].includes(turn.conversationState.state);
  const terminalNotificationsAllowed = sessionEnded && !control.suppressTerminalNotifications;
  const pendingQuestions = turn.conversationState.offTopicQuestions || [];
  let cycleSummaryQueued = false;

  // Per-issue emails are gone: a manager received four separate messages about
  // one conversation, each with a partial picture. Everything now goes out once
  // per project when the CYCLE ends, routed to the owner of each service.
  if (
    terminalNotificationsAllowed
    && !control.forceManagerAlert
    && !control.notify
    && typeof store.cycleSummary === "function"
    && updatedSession.cycleId
  ) {
    const cycleDone = typeof store.isCycleComplete === "function"
      ? await store.isCycleComplete(updatedSession.cycleId)
      : true;

    if (cycleDone) {
      const summary = await store.cycleSummary(updatedSession.cycleId);
      // A completed cycle is worth reporting even when nobody replied. The
      // response status is itself management information and must be visible in
      // the one-email-per-project summary.
      const worthSending = summary && (summary.sessions || []).length;

      if (worthSending) {
        cycleSummaryQueued = true;
        notifyAutomationAsync(
          store,
          "cycle_completed",
          cycleCompletedPayload(summary, resumeUrl, pendingQuestions),
          `cycle_completed:cycle:${updatedSession.cycleId}`,
          waitUntil
        );
      }
    }
  }


  if (
    terminalNotificationsAllowed
    && !control.forceManagerAlert
    && !control.notify
    && !cycleSummaryQueued
    && pendingQuestions.length
  ) {
    notifyAutomationAsync(store, "client_question", {
      project,
      poc,
      session: updatedSession,
      clientText: pendingQuestions.map((q, i) => `${i + 1}. ${q.text}`).join("\n"),
      questionCount: pendingQuestions.length,
      guardrail: GUARDRAILS.OUT_OF_SCOPE,
      state: turn.conversationState.state,
      resumeUrl
    }, `client_question:session:${updatedSession.id}`, waitUntil);
  }

  // Guardrail events that a human must actually read.
  if (control.notify && !control.forceManagerAlert) {
    notifyAutomationAsync(store, control.notify, {
      project,
      poc,
      session: updatedSession,
      clientText: control.notifyText || text,
      guardrail: control.guardrail || null,
      state: turn.conversationState.state,
      pendingQuestions,
      resumeUrl
    }, `${control.notify}:message:${clientMessage.id}`, waitUntil);
  }

  const turnMs = Date.now() - turnStartedAt;
  if (turnMs > 4000) console.warn(`[turn] slow reply: ${turnMs}ms`);

  return json(201, {
    session: updatedSession,
    project,
    poc,
    turnMs,
    analysis: turn.analysis,
    receivedMessage: clientMessage,
    nextMessage: assistantMessage,
    whatsappReplyText: assistantMessage.body,
    sendToWhatsapp: control.sendReply !== false,
    guardrail: control.guardrail || null,
    state: turn.conversationState.state,
    resumeUrl
  });
}

// ---------------------------------------------------------------------
// Cycle creation (one session per active POC)
// ---------------------------------------------------------------------

async function startCycle({ store, projectKey, cycleType, baseUrl, reason, clientPocIds }) {
  const result = await store.createCycle(projectKey, {
    cycleType,
    channel: "whatsapp",
    ...(Array.isArray(clientPocIds) ? { clientPocIds } : {})
  });
  const { cycle, sessions, project, pocs } = result;

  const dispatched = [];
  for (const session of sessions) {
    const poc = pocs.find((item) => item.id === session.clientPocId) || null;
    const resumeUrl = buildResumeUrl(baseUrl, project, session);
    await notifyAutomation(store, "feedback_started", {
      project,
      poc,
      cycle,
      session,
      reason: reason || "manual_dashboard_request",
      reminderDueAt: session.reminderDueAt,
      resumeUrl
    }, `feedback_started:session:${session.id}`);
    dispatched.push({ session, poc, resumeUrl });
  }

  return { cycle, project, dispatched };
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

async function handleApiRequest(request) {
  const method = request.method || "GET";
  const pathname = request.path || "/";
  const body = request.body || {};
  const searchParams = request.searchParams || new URLSearchParams();
  const baseUrl = trimSlash(request.baseUrl || process.env.PUBLIC_APP_URL || "");

  if (method === "GET" && pathname === "/api/health") {
    return json(200, {
      ok: true,
      version: "v2",
      provider: process.env.DATA_PROVIDER || "postgres",
      time: new Date().toISOString()
    });
  }

  if (method === "GET" && pathname === "/api/auth/status") {
    const configured = Boolean(appLoginPassword());
    return withResponseHeaders(
      json(200, {
        configured,
        authenticated: configured && isAppAuthenticated(request.headers),
        sessionHours: APP_SESSION_TTL_SECONDS / 3600
      }),
      { "cache-control": "no-store" }
    );
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    const expected = appLoginPassword();
    if (!expected) {
      return error(503, "Application login is not configured", "Set APP_LOGIN_PASSWORD to at least 8 characters in Replit Secrets, then restart the app.");
    }
    if (!safeEqual(body.password, expected)) return error(401, "Incorrect password");
    const token = createAppSessionToken();
    return withResponseHeaders(
      json(200, { authenticated: true, sessionHours: APP_SESSION_TTL_SECONDS / 3600 }),
      { "set-cookie": sessionCookie(token, baseUrl), "cache-control": "no-store" }
    );
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    return withResponseHeaders(
      json(200, { authenticated: false }),
      { "set-cookie": expiredSessionCookie(baseUrl), "cache-control": "no-store" }
    );
  }

  // Browser-facing data is private. Machine-to-machine routes keep their own
  // x-csat-webhook-secret check so adding a dashboard login cannot interrupt
  // WhatsApp replies or scheduled n8n jobs.
  if (!isMachineApiPath(pathname)) {
    if (!appLoginPassword()) {
      return error(503, "Application login is not configured", "Set APP_LOGIN_PASSWORD to at least 8 characters in Replit Secrets, then restart the app.");
    }
    if (!isAppAuthenticated(request.headers)) return error(401, "Authentication required");
  }

  let store;
  try {
    store = createStore();
  } catch (storeError) {
    return error(500, "Data provider is not configured", storeError.message);
  }

  // ---- Retired v1 routes: fail with direction, not a bare 404.
  if (pathname === "/api/clients" || /^\/api\/clients\//.test(pathname)) {
    return error(410, "The /api/clients routes were replaced in v2", "Use /api/projects and /api/projects/:projectKey/workspace");
  }

  if (method === "GET" && pathname === "/api/dashboard") {
    const dashboard = await store.getDashboard();
    // getDashboard returns open issues as raw Supabase rows. Normalise them and
    // attach the project they belong to so the UI never has to guess.
    const projectsById = new Map((dashboard.projects || []).map((item) => [item.id, item]));
    const openIssues = (dashboard.openIssues || []).map((row) => {
      const owner = projectsById.get(row.project_id || row.projectId);
      return {
        id: row.id,
        projectId: row.project_id || row.projectId,
        projectKey: owner ? owner.key : null,
        projectName: owner ? owner.name : null,
        clientName: owner ? owner.clientName : null,
        sessionId: row.session_id || row.sessionId || null,
        clientPocId: row.client_poc_id || row.clientPocId || null,
        raisedBy: row.client_pocs?.name || row.raisedBy || null,
        severity: row.severity,
        serviceKey: row.service_key || row.serviceKey || null,
        serviceName: row.service_name || row.serviceName || null,
        title: row.title,
        rootCause: row.root_cause || row.rootCause || null,
        dueAt: row.due_at || row.dueAt || null,
        createdAt: row.created_at || row.createdAt
      };
    });
    const attachProject = (cycle) => {
      const owner = projectsById.get(cycle.projectId);
      return {
        ...cycle,
        projectKey: owner ? owner.key : null,
        projectName: owner ? owner.name : null,
        clientName: owner ? owner.clientName : null,
        clusterName: owner ? owner.clusterName : null
      };
    };
    const cycles = (dashboard.cycles || []).map(attachProject);
    const openCycles = (dashboard.openCycles || []).map((cycle) => {
      const owner = projectsById.get(cycle.projectId);
      return {
        ...cycle,
        projectKey: owner ? owner.key : null,
        projectName: owner ? owner.name : null,
        clientName: owner ? owner.clientName : null
      };
    });
    return json(200, { ...dashboard, openIssues, openCycles, cycles });
  }

  if (method === "GET" && pathname === "/api/projects") {
    return json(200, { projects: await store.listProjects() });
  }

  const workspaceMatch = pathname.match(/^\/api\/projects\/([^/]+)\/workspace$/);
  if (method === "GET" && workspaceMatch) {
    const workspace = await store.getProjectWorkspace(decodeURIComponent(workspaceMatch[1]));
    if (!workspace) return error(404, "Project not found");
    return json(200, workspace);
  }

  const requestFeedbackMatch = pathname.match(/^\/api\/projects\/([^/]+)\/request-feedback$/);
  if (method === "POST" && requestFeedbackMatch) {
    const projectKey = decodeURIComponent(requestFeedbackMatch[1]);
    const cycleType = body.cycleType === "project_end" ? "project_end" : "pulse";

    const project = await store.getProject(projectKey);
    if (!project) return error(404, "Project not found");

    const selectionProvided = Object.prototype.hasOwnProperty.call(body, "clientPocIds");
    if (selectionProvided && !Array.isArray(body.clientPocIds)) {
      return error(400, "clientPocIds must be a list of selected POC IDs");
    }
    const clientPocIds = selectionProvided
      ? [...new Set(body.clientPocIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : null;
    if (selectionProvided && !clientPocIds.length) return error(400, "Select at least one client POC");
    if (clientPocIds && clientPocIds.length > 100) return error(400, "At most 100 client POCs can be selected at once");

    if (clientPocIds) {
      const projectPocsById = new Map((project.pocs || []).map((poc) => [poc.id, poc]));
      const invalidPocId = clientPocIds.find((id) => !projectPocsById.has(id));
      if (invalidPocId) return error(400, "One or more selected POCs do not belong to this project");
      const unavailable = clientPocIds
        .map((id) => projectPocsById.get(id))
        .filter((poc) => !poc.active || !String(poc.contactWhatsapp || "").replace(/\D/g, ""));
      if (unavailable.length) {
        return error(400, "Every selected POC must be active and have a WhatsApp number", {
          unavailablePocs: unavailable.map((poc) => ({ id: poc.id, name: poc.name }))
        });
      }
    }

    // Guard against two open cycles of the same type for one project.
    if (typeof store.hasOpenCycle === "function" && await store.hasOpenCycle(project.id, cycleType)) {
      return error(409, "An open cycle of this type already exists for the project", {
        projectKey,
        cycleType
      });
    }

    try {
      const started = await startCycle({
        store,
        projectKey,
        cycleType,
        baseUrl,
        reason: body.reason,
        clientPocIds
      });
      return json(201, started);
    } catch (cycleError) {
      return error(400, "Could not start feedback cycle", cycleError.message);
    }
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (method === "GET" && projectMatch) {
    const project = await store.getProject(decodeURIComponent(projectMatch[1]));
    if (!project) return error(404, "Project not found");
    return json(200, { project });
  }

  const projectIssuesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/issues$/);
  if (method === "GET" && projectIssuesMatch) {
    const project = await store.getProject(decodeURIComponent(projectIssuesMatch[1]));
    if (!project) return error(404, "Project not found");
    return json(200, { issues: await store.listProjectIssues(project.id) });
  }

  const cycleSessionsMatch = pathname.match(/^\/api\/cycles\/([^/]+)\/sessions$/);
  if (method === "GET" && cycleSessionsMatch) {
    return json(200, { sessions: await store.listCycleSessions(decodeURIComponent(cycleSessionsMatch[1])) });
  }

  const sessionReadMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === "GET" && sessionReadMatch) {
    const detail = await store.getSessionDetail(decodeURIComponent(sessionReadMatch[1]));
    if (!detail) return error(404, "Session not found");
    return json(200, {
      ...detail,
      resumeUrl: buildResumeUrl(baseUrl, detail.project, detail.session)
    });
  }

  // Send a human-written message from the dashboard through n8n's existing
  // Meta credential. This is deliberately not a state-machine turn: it leaves
  // the survey checklist, scores, reminders and cycle status untouched. The
  // stored outbound message becomes context for the client's next inbound turn.
  const manualWhatsappMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/manual-whatsapp-message$/);
  if (method === "POST" && manualWhatsappMatch) {
    const text = String(body.text || "").trim();
    if (!text) return error(400, "WhatsApp message text is required");
    if (text.length > MAX_MANUAL_WHATSAPP_TEXT_LENGTH) {
      return error(400, "WhatsApp message is too long", `Use ${MAX_MANUAL_WHATSAPP_TEXT_LENGTH} characters or fewer.`);
    }

    const sessionId = decodeURIComponent(manualWhatsappMatch[1]);
    const session = await store.getSession(sessionId);
    if (!session) return error(404, "Session not found");
    const [project, poc, messages] = await Promise.all([
      store.getProjectById(session.projectId),
      store.getClientPocById(session.clientPocId),
      typeof store.getMessagesForSession === "function"
        ? store.getMessagesForSession(session.id)
        : Promise.resolve([])
    ]);
    if (!project || !poc) return error(404, "Project or client POC not found");
    if (poc.active === false) return error(409, "This client POC is inactive");
    if (!poc.contactWhatsapp) return error(409, "This client POC has no WhatsApp number");

    const conversationState = session.conversationState || {};
    if (conversationState.optedOut || conversationState.handoffReason === "wrong_person") {
      return error(409, "WhatsApp messaging is blocked for this POC", "The client opted out or this number was identified as the wrong person.");
    }

    const latestClientMessage = [...messages].reverse().find((message) => message.side === "client");
    const latestClientAt = Date.parse(latestClientMessage?.createdAt || session.lastClientResponseAt || "");
    const windowAge = Date.now() - latestClientAt;
    if (!Number.isFinite(latestClientAt) || windowAge >= WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS) {
      return error(
        409,
        "The 24-hour WhatsApp reply window is closed",
        "A free-text message can be sent only within 24 hours of the client's latest WhatsApp message. Send an approved template first and wait for the client to reply."
      );
    }

    const requestId = String(body.requestId || crypto.randomUUID()).trim().slice(0, 120);
    const alreadyStored = messages.find((message) => message.metadata?.manualRequestId === requestId);
    if (alreadyStored) {
      return json(200, { sent: true, duplicate: true, message: alreadyStored, session, project, poc });
    }

    const delivery = await notifyAutomation(
      store,
      "manual_whatsapp_message",
      {
        sessionId: session.id,
        cycleId: session.cycleId,
        project,
        poc,
        to: poc.contactWhatsapp,
        text,
        requestId
      },
      `manual_whatsapp_message:session:${session.id}:request:${requestId}`
    );

    if (delivery.status === "duplicate") {
      return error(409, "This WhatsApp message is already being processed", "Refresh the conversation before trying again.");
    }
    if (delivery.status === "skipped") {
      return error(503, "Manual WhatsApp sending is not configured", "Set N8N_MANUAL_MESSAGE_WEBHOOK to the active n8n manual-message webhook URL.");
    }
    if (delivery.status !== "sent") {
      return error(502, "WhatsApp message could not be sent", delivery.statusCode ? `n8n returned HTTP ${delivery.statusCode}.` : delivery.error || "The n8n workflow failed.");
    }

    const message = await store.addMessage(session.id, {
      speaker: "SRV Media MD Office",
      side: "srv",
      body: text,
      metadata: {
        source: "dashboard_manual_whatsapp",
        manualOutbound: true,
        manualRequestId: requestId,
        deliveryStatus: "accepted",
        deliveryStatusCode: delivery.statusCode || 200
      }
    });

    return json(201, {
      sent: true,
      message,
      session,
      project,
      poc,
      whatsappWindowClosesAt: new Date(latestClientAt + WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS).toISOString()
    });
  }

  // Web test chat — same machine, same guardrails, no WhatsApp.
  const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (method === "POST" && messageMatch) {
    const text = String(body.text || "").trim();
    if (!text) return error(400, "Message text is required");

    const session = await store.getSession(decodeURIComponent(messageMatch[1]));
    if (!session) return error(404, "Session not found");

    const project = await store.getProjectById(session.projectId);
    const poc = await store.getClientPocById(session.clientPocId);
    return handleTurn({ store, session, project, poc, body, text, baseUrl, channel: "web" });
  }

  // Score the evidence currently available without changing the session's
  // workflow status. This can be used mid-conversation after a model outage;
  // the terminal review deliberately runs again when the POC later completes,
  // is stopped, or reaches the reminder-policy closure.
  const scoreMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/score$/);
  if (method === "POST" && scoreMatch) {
    const sessionId = decodeURIComponent(scoreMatch[1]);
    const session = await store.getSession(sessionId);
    if (!session) return error(404, "Session not found");

    const messages = typeof store.getMessagesForSession === "function"
      ? await store.getMessagesForSession(sessionId)
      : [];
    if (!messages.some((message) => message.side === "client")) {
      return error(409, "Nothing to score", "The client has not replied to this session.");
    }
    if (!hasSatisfactionEvidence({
      conversationState: session.conversationState || {},
      messages
    })) {
      let unscoredSession = session;
      const hadUnsubstantiatedPrediction = session.predictedCsat !== null
        && session.predictedCsat !== undefined;
      if (hadUnsubstantiatedPrediction && typeof store.applyInterimAnalysis === "function") {
        const predictionWasEffectiveScore = session.csatSource === "predicted";
        unscoredSession = await store.applyInterimAnalysis(sessionId, {
          predictedCsat: null,
          predictedConfidence: null,
          predictedReasoning: null,
          predictedSignals: [],
          csatScore: predictionWasEffectiveScore ? null : session.csatScore,
          csatSource: predictionWasEffectiveScore ? null : session.csatSource,
          riskLevel: predictionWasEffectiveScore ? null : session.riskLevel
        });
      }
      return json(200, {
        session: unscoredSession,
        unscored: true,
        clearedUnsubstantiatedScore: hadUnsubstantiatedPrediction,
        sessionRemainsOpen: !["completed", "opted_out"].includes(unscoredSession.status),
        reason: "There is not enough feedback to score. Greetings, acknowledgements and postponements do not receive a rating."
      });
    }

    if (session.predictedCsat !== null && session.predictedCsat !== undefined && !body.force) {
      return json(200, {
        session,
        alreadyScored: true,
        reason: "This conversation has already been scored."
      });
    }

    const project = await store.getProjectById(session.projectId);
    const predicted = await predictSatisfaction({
      project,
      conversationState: session.conversationState || {},
      messages
    });

    if (!predicted.overall) {
      if (predicted.error === "insufficient_feedback") {
        return error(409, "Not enough feedback to score", "No satisfaction evidence was found in the client's replies.");
      }
      return error(503, "Could not score this conversation", predicted.error || "the model was unavailable");
    }

    const hasStatedScore = session.csatSource === "stated"
      || (session.conversationState?.overallRating !== null
        && session.conversationState?.overallRating !== undefined);
    const analysis = {
      ...session,
      predictedCsat: predicted.overall.score,
      predictedConfidence: predicted.overall.confidence,
      predictedReasoning: predicted.overall.reasoning,
      predictedSignals: predicted.overall.signals,
      csatSource: hasStatedScore ? "stated" : "predicted",
      csatScore: hasStatedScore ? session.csatScore : predicted.overall.score,
      services: [],
      conversationState: session.conversationState || {},
      // Preview scoring is enrichment only. It must not complete the checklist,
      // cancel reminders, close the POC session or close the parent cycle.
      isComplete: false,
      riskLevel: session.riskLevel || (
        predicted.overall.score < 5 ? "High" : predicted.overall.score < 7 ? "Watch" : "Low"
      ),
      observations: predicted.observations
    };

    if (typeof store.applyInterimAnalysis !== "function") {
      return error(503, "Could not score this conversation", "The data provider does not support non-terminal scoring.");
    }
    const updated = await store.applyInterimAnalysis(sessionId, analysis);
    if ((predicted.observations || []).length && typeof store.recordObservations === "function") {
      await store.recordObservations(session, predicted.observations);
    }

    return json(200, {
      session: updated,
      predicted: predicted.overall,
      observations: predicted.observations,
      alreadyScored: false,
      sessionRemainsOpen: !["completed", "opted_out"].includes(updated.status)
    });
  }

  const stopSessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
  if (method === "POST" && stopSessionMatch) {
    const sessionId = decodeURIComponent(stopSessionMatch[1]);
    const existing = await store.getSession(sessionId);
    if (!existing) return error(404, "Session not found");
    const existingState = existing.conversationState || {};

    if (existingState.stoppedByAdmin) {
      return json(200, { session: existing, alreadyStopped: true });
    }
    if (
      ["completed", "opted_out"].includes(existing.status)
      || ["completed", "opted_out", "handed_off"].includes(existingState.state)
      || existingState.reminderExhausted
    ) {
      return error(409, "This POC's feedback session is already closed");
    }

    let session = await store.stopSessionForCycle(sessionId, {
      actorName: body.actorName || "Dashboard user",
      reason: body.reason || ""
    });
    const project = await store.getProjectById(session.projectId);
    const poc = await store.getClientPocById(session.clientPocId);
    let stopScore = { attempted: false, scored: false, reason: "No client feedback was available to score." };

    // Stopping ends only this POC's participation in this cycle. Review the
    // transcript at that terminal point, but leave it honestly unscored when
    // the client only greeted, acknowledged or postponed.
    try {
      const terminalAnalysis = await analyzeTimedOutPartialSession({
        store,
        session,
        project,
        poc,
        closureReason: "stopped_by_admin"
      });
      if (terminalAnalysis && typeof store.applyStoppedSessionAnalysis === "function") {
        session = await store.applyStoppedSessionAnalysis(session.id, terminalAnalysis);
        if ((terminalAnalysis.observations || []).length && typeof store.recordObservations === "function") {
          await store.recordObservations(session, terminalAnalysis.observations);
        }
        stopScore = {
          attempted: true,
          scored: terminalAnalysis.predictedCsat !== null && terminalAnalysis.predictedCsat !== undefined,
          reason: terminalAnalysis.predictedCsat === null || terminalAnalysis.predictedCsat === undefined
            ? "No satisfaction evidence was present, so no score was created."
            : "The available feedback was evaluated again when the session was stopped."
        };
      }
    } catch (scoreError) {
      // Stopping is authoritative. A model or enrichment failure must never
      // reopen reminders or make the administrator repeat the stop action.
      console.warn("[cycle] stopped session could not be scored:", scoreError.message);
      stopScore = { attempted: true, scored: false, reason: scoreError.message };
    }
    const resumeUrl = buildResumeUrl(baseUrl, project, session);

    // If this was the final open POC, close the project cycle and queue the
    // normal single cycle summary. Failure to email must not undo the stop.
    try {
      if (
        session.cycleId
        && typeof store.isCycleComplete === "function"
        && typeof store.cycleSummary === "function"
        && await store.isCycleComplete(session.cycleId)
      ) {
        const summary = await store.cycleSummary(session.cycleId);
        if (summary && (summary.sessions || []).length) {
          notifyAutomationAsync(
            store,
            "cycle_completed",
            cycleCompletedPayload(summary, resumeUrl),
            `cycle_completed:cycle:${session.cycleId}`,
            request.waitUntil
          );
        }
      }
    } catch (summaryError) {
      console.warn("[cycle] could not queue summary after administrator stop:", summaryError.message);
    }

    return json(200, {
      session,
      project,
      poc,
      stoppedForCycle: true,
      futureCyclesUnaffected: true,
      stopScore
    });
  }

  const reminderMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(reminder|no-response)$/);
  if (method === "POST" && reminderMatch) {
    const sessionId = decodeURIComponent(reminderMatch[1]);
    const existing = await store.getSession(sessionId);
    if (!existing) return error(404, "Session not found");
    const existingState = existing.conversationState || {};
    if (
      ["completed", "opted_out"].includes(existing.status)
      || ["completed", "opted_out", "handed_off"].includes(existingState.state)
      || existingState.reminderExhausted
    ) {
      return error(409, "Session is closed and will not be reminded", { status: existing.status });
    }
    if ((Number(existing.reminderCount) || 0) >= MAX_REMINDERS) {
      return error(409, `All ${MAX_REMINDERS} reminders have already been sent. The final 24-hour response window is active.`);
    }

    const finalRatingReminder = shouldUseFinalRatingReminder(existing);
    const session = await store.markNoResponse(sessionId, {
      askForOverallRating: finalRatingReminder
    });
    const project = await store.getProjectById(session.projectId);
    const poc = await store.getClientPocById(session.clientPocId);
    const resumeUrl = buildResumeUrl(baseUrl, project, session);

    await notifyAutomation(store, "no_response", {
      project,
      poc,
      session,
      reminderCount: session.reminderCount,
      reminderKind: session.completionStatus === "partial" ? "complete_partial_feedback" : "first_response",
      finalRatingReminder,
      resumeUrl
    }, `no_response:session:${session.id}:reminder:${session.reminderCount}`);
    return json(200, {
      session,
      project,
      poc,
      resumeUrl,
      reminderPolicy: { sent: session.reminderCount, limit: MAX_REMINDERS, nextDueAt: session.reminderDueAt }
    });
  }

  // ---- WhatsApp inbound: phone -> POC -> active session
  if (method === "POST" && pathname === "/api/whatsapp/inbound") {
    if (!isAutomationAuthorized(request.headers)) return error(401, "Unauthorized automation request");

    const text = String(body.text || "").trim();
    if (!text) return error(400, "WhatsApp message text is required");
    if (!body.from) return error(400, "WhatsApp sender (from) is required");

    const routing = typeof store.getWhatsappRoutingContext === "function"
      ? await store.getWhatsappRoutingContext(body.from)
      : null;
    if (routing?.status === "ambiguous") {
      return error(409, "This WhatsApp number has more than one active feedback session", "Stop one cycle before processing the reply so it cannot be attached to the wrong project.");
    }
    const poc = routing ? routing.poc : await store.getPocByWhatsapp(body.from);
    if (!poc) return error(404, `No active client POC found for WhatsApp number ${body.from}`);

    // Prefer the open session; fall back to the most recent one so that a
    // post-completion message still reaches G3 instead of 404-ing into silence.
    const active = routing ? routing.session : await store.getActiveSessionForPoc(poc.id);
    const session = active || (routing ? null : await store.getLatestSessionForPoc(poc.id));
    if (!session) return error(404, `No feedback session found for POC ${poc.name}`);

    const project = await store.getProjectById(session.projectId);
    return handleTurn({
      store, session, project, poc, body, text, baseUrl, channel: "whatsapp",
      waitUntil: request.waitUntil
    });
  }

  const whatsappSessionMatch = pathname.match(/^\/api\/whatsapp\/sessions\/([^/]+)\/reply$/);
  if (method === "POST" && whatsappSessionMatch) {
    if (!isAutomationAuthorized(request.headers)) return error(401, "Unauthorized automation request");

    const text = String(body.text || "").trim();
    if (!text) return error(400, "WhatsApp message text is required");

    const session = await store.getSession(decodeURIComponent(whatsappSessionMatch[1]));
    if (!session) return error(404, "Session not found");

    const project = await store.getProjectById(session.projectId);
    const poc = await store.getClientPocById(session.clientPocId);
    return handleTurn({
      store, session, project, poc, body, text, baseUrl, channel: "whatsapp",
      waitUntil: request.waitUntil
    });
  }

  // ---- Automation / scheduler
  if (method === "GET" && pathname === "/api/automation/due-feedback") {
    if (!isAutomationAuthorized(request.headers)) return error(401, "Unauthorized automation request");
    return json(200, { targets: await store.getDueFeedbackTargets(searchParams.get("now") || undefined) });
  }

  if (method === "POST" && pathname === "/api/automation/create-due-sessions") {
    if (!isAutomationAuthorized(request.headers)) return error(401, "Unauthorized automation request");
    const targets = await store.getDueFeedbackTargets(body.now);
    const cycles = [];
    const skipped = [];

    for (const target of targets) {
      try {
        cycles.push(await startCycle({
          store,
          projectKey: target.projectKey,
          cycleType: target.cycleType,
          baseUrl,
          reason: "scheduled"
        }));
      } catch (cycleError) {
        // A project with no reachable POC must not abort the whole run.
        skipped.push({ projectKey: target.projectKey, cycleType: target.cycleType, reason: cycleError.message });
      }
    }

    return json(201, { cycles, skipped });
  }

  if (method === "GET" && pathname === "/api/automation/due-reminders") {
    if (!isAutomationAuthorized(request.headers)) return error(401, "Unauthorized automation request");
    const targets = await store.getDueReminderTargets(searchParams.get("now") || undefined);
    return json(200, {
      targets: targets.map((target) => ({
        ...target,
        resumeUrl: buildResumeUrl(baseUrl, { key: target.projectKey }, target.session)
      }))
    });
  }

  if (method === "POST" && pathname === "/api/automation/process-due-reminders") {
    if (!isAutomationAuthorized(request.headers)) return error(401, "Unauthorized automation request");
    const targets = await store.getDueReminderTargets(body.now);
    const reminders = [];
    const closed = [];
    const closureReviewTasks = [];
    const deferredClosures = [];
    const closedCycleContexts = new Map();

    for (const target of targets) {
      // Opted-out or handed-off POCs are never re-pinged.
      const conversationState = target.session.conversationState || {};
      if (conversationState.optedOut || ["opted_out", "handed_off"].includes(conversationState.state)) {
        continue;
      }

      // reminder_due_at after reminder three is a grace-period deadline, not
      // permission to send a fourth message.
      if (target.reminderAction === "close_after_grace") {
        const isPartial = target.session.completionStatus === "partial";
        let sessionBeforeClose = target.session;
        let closingNotification = null;

        // A partial respondent deserves a courteous closing notice. Delivery
        // is intentionally completed before the state is closed. If n8n or
        // Meta is unavailable, leave the session due so the next scheduler run
        // retries instead of silently closing it. No-response sessions are not
        // sent a misleading "thank you for your feedback" template.
        if (
          isPartial
          && target.poc?.contactWhatsapp
          && !target.session.conversationState?.closingTemplateSentAt
        ) {
          const projectForNotice = {
            key: target.projectKey,
            name: target.projectName
          };
          closingNotification = await notifyAutomation(store, "feedback_session_closed", {
            project: projectForNotice,
            projectKey: target.projectKey,
            projectName: target.projectName,
            poc: target.poc,
            session: target.session,
            closureReason: "partial_after_three_reminders"
          });
          if (closingNotification.status !== "sent") {
            deferredClosures.push({
              session: target.session,
              poc: target.poc,
              outcome: "partial",
              reason: closingNotification.webhookUrlConfigured
                ? "closing_template_delivery_failed"
                : "closing_template_webhook_not_configured",
              closingNotification
            });
            continue;
          }
          if (typeof store.markClosingTemplateSent === "function") {
            sessionBeforeClose = await store.markClosingTemplateSent(target.session.id);
          }
        }

        const closedSession = await store.finalizeReminderLoop(sessionBeforeClose.id);
        const closedEntry = {
          session: closedSession,
          poc: target.poc,
          outcome: isPartial ? "partial" : "no_response",
          closingNotification,
          finalAnalysisApplied: false,
          finalAnalysisQueued: isPartial && typeof store.applyFinalPartialAnalysis === "function"
        };
        closed.push(closedEntry);
        if (closedSession.cycleId) {
          closedCycleContexts.set(closedSession.cycleId, {
            projectKey: target.projectKey,
            session: closedSession
          });
        }

        if (closedEntry.finalAnalysisQueued) closureReviewTasks.push(async () => {
          let session = closedSession;
          let finalAnalysis = null;

          // No-response sessions have no client words to analyse. Partial
          // sessions do: run one terminal transcript review before the cycle
          // summary is assembled, without changing the honest "partial" outcome.
          try {
            const project = await store.getProjectById(session.projectId);
            finalAnalysis = await analyzeTimedOutPartialSession({
              store,
              session,
              project,
              poc: target.poc
            });
            if (finalAnalysis) {
              session = await store.applyFinalPartialAnalysis(session.id, finalAnalysis);
              closedEntry.session = session;
              closedEntry.finalAnalysisApplied = true;
              closedEntry.finalAnalysisQueued = false;
              if ((finalAnalysis.observations || []).length && typeof store.recordObservations === "function") {
                await store.recordObservations(session, finalAnalysis.observations);
              }
            }
          } catch (analysisError) {
            // The reminder outcome is authoritative. A Gemini outage must not
            // leave an exhausted session open or permit a fourth reminder.
            console.warn("[reminder] final partial analysis failed:", analysisError.message);
            closedEntry.finalAnalysisQueued = false;
          }
        });
        continue;
      }

      const finalRatingReminder = shouldUseFinalRatingReminder(target.session);
      const session = await store.markNoResponse(target.session.id, {
        askForOverallRating: finalRatingReminder
      });
      const resumeUrl = buildResumeUrl(baseUrl, { key: target.projectKey }, session);
      await notifyAutomation(store, "no_response", {
        // Same shape as the dashboard-triggered reminder, so n8n reads one path.
        project: { key: target.projectKey, name: target.projectName },
        projectKey: target.projectKey,
        projectName: target.projectName,
        poc: target.poc,
        session,
        reminderCount: session.reminderCount,
        reminderKind: target.reminderKind,
        finalRatingReminder,
        resumeUrl
      }, `no_response:session:${session.id}:reminder:${session.reminderCount}`);
      reminders.push({
        session,
        poc: target.poc,
        reminderKind: target.reminderKind,
        finalRatingReminder,
        resumeUrl
      });
    }

    const finishClosedCycles = async () => {
      // Review separate POCs concurrently. The cycle summary waits for all of
      // them, so a mixed partial/no-response cycle cannot email an incomplete
      // score simply because its no-response POC closed first.
      await Promise.all(closureReviewTasks.map((task) => task()));
      for (const [cycleId, context] of closedCycleContexts) {
        if (
          typeof store.isCycleComplete !== "function"
          || typeof store.cycleSummary !== "function"
          || !(await store.isCycleComplete(cycleId))
        ) continue;
        const summary = await store.cycleSummary(cycleId);
        if (!summary || !(summary.sessions || []).length) continue;
        const resumeUrl = buildResumeUrl(baseUrl, { key: context.projectKey }, context.session);
        await notifyAutomation(
          store,
          "cycle_completed",
          cycleCompletedPayload(summary, resumeUrl),
          `cycle_completed:cycle:${cycleId}`
        );
      }
    };

    // Netlify can finish the Gemini reads after returning success to n8n. This
    // avoids scheduler 502s when several partial sessions expire together.
    if (closureReviewTasks.length && typeof request.waitUntil === "function") {
      request.waitUntil(finishClosedCycles().catch((closureError) => {
        console.warn("[reminder] background cycle closure failed:", closureError.message);
      }));
    } else {
      await finishClosedCycles();
    }

    return json(200, {
      reminders,
      closed,
      deferredClosures,
      policy: { maximumReminders: MAX_REMINDERS, intervalHours: 24 }
    });
  }

  // ---- Issues
  const issueActionMatch = pathname.match(/^\/api\/issues\/([^/]+)\/(close|reopen|progress)$/);
  if (method === "POST" && issueActionMatch) {
    const result = await store.updateIssueStatus(decodeURIComponent(issueActionMatch[1]), issueActionMatch[2], {
      note: String(body.note || "").trim(),
      actorName: String(body.actorName || "SRV Team").trim()
    });
    if (!result) return error(404, "Issue not found");
    return json(200, result);
  }

  const issueReadMatch = pathname.match(/^\/api\/issues\/([^/]+)$/);
  if (method === "GET" && issueReadMatch) {
    const issue = await store.getIssue(decodeURIComponent(issueReadMatch[1]));
    if (!issue) return error(404, "Issue not found");
    return json(200, { issue });
  }

  // -------------------------------------------------------------------
  // Admin: directory reads and PIN-gated writes
  // -------------------------------------------------------------------

  if (method === "GET" && pathname === "/api/admin/status") {
    return json(200, { pinRequired: Boolean(process.env.ADMIN_PIN), authorized: isAdminAuthorized(request.headers) });
  }

  if (method === "GET" && pathname === "/api/admin/directory") {
    return json(200, await store.getDirectory());
  }

  const clientDetailMatch = pathname.match(/^\/api\/admin\/clients\/([^/]+)$/);
  if (method === "GET" && clientDetailMatch) {
    const detail = await store.getClientDetail(decodeURIComponent(clientDetailMatch[1]));
    if (!detail) return error(404, "Client not found");
    return json(200, detail);
  }

  const isAdminWrite = /^\/api\/admin\//.test(pathname) && ["POST", "PATCH", "PUT", "DELETE"].includes(method);
  if (isAdminWrite) {
    if (!process.env.ADMIN_PIN) {
      return error(503, "Editing is disabled", "ADMIN_PIN is not set on the server");
    }
    if (!isAdminAuthorized(request.headers)) {
      return error(403, "Incorrect PIN");
    }
  }

  if (method === "PATCH" && pathname === "/api/admin/poc-levels") {
    const requested = Array.isArray(body.levels) ? body.levels : [];
    if (!requested.length) return error(400, "At least one POC level is required");

    const seen = new Set();
    const levels = [];
    for (const item of requested) {
      const id = String(item?.id || "").trim();
      const weight = Number(item?.weight);
      if (!id) return error(400, "Every POC level needs an ID");
      if (seen.has(id)) return error(400, "A POC level was included more than once", id);
      if (!Number.isInteger(weight) || weight < 1 || weight > 99) {
        return error(400, "POC group percentages must be whole numbers from 1 to 99", id);
      }
      seen.add(id);
      levels.push({ id, weight });
    }

    const result = await store.updatePocLevelWeights(levels);
    if (result.status === "not_found") return error(404, "One or more POC levels were not found");
    if (result.status === "invalid_order") {
      return error(400, "Important POCs must have a larger group percentage than Normal POCs");
    }
    if (result.status === "invalid_total") return error(400, "Normal and Important group percentages must total 100%");
    return json(200, { levels: result.levels });
  }

  if (method === "POST" && pathname === "/api/admin/internal-pocs") {
    if (!String(body.name || "").trim()) return error(400, "Name is required");
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return error(400, "That email address does not look valid");
    }
    if (!(await store.subDepartmentBelongsTo(body.subDepartmentId, body.departmentId))) {
      return error(400, "That sub-department does not belong to the selected department");
    }
    return json(201, { internalPoc: await store.createInternalPoc(body) });
  }

  const internalPocUpdateMatch = pathname.match(/^\/api\/admin\/internal-pocs\/([^/]+)$/);
  if (method === "PATCH" && internalPocUpdateMatch) {
    const internalPocId = decodeURIComponent(internalPocUpdateMatch[1]);
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return error(400, "That email address does not look valid");
    }
    if (body.reportingManagerId !== undefined) {
      if (body.reportingManagerId !== internalPocId && await store.managerChainWouldLoop(internalPocId, body.reportingManagerId)) {
        return error(400, "That reporting line loops back on itself");
      }
    }
    if (body.subDepartmentId !== undefined && !(await store.subDepartmentBelongsTo(body.subDepartmentId, body.departmentId))) {
      return error(400, "That sub-department does not belong to the selected department");
    }
    const internalPoc = await store.updateInternalPoc(internalPocId, body);
    if (!internalPoc) return error(404, "Internal POC not found");
    return json(200, { internalPoc });
  }

  if (method === "POST" && pathname === "/api/admin/services") {
    const missing = ["projectId", "name"].filter((field) => !String(body[field] || "").trim());
    if (missing.length) return error(400, "Missing required fields", missing.join(", "));
    const generatedKey = serviceIdentifier(body.name);
    if (await store.serviceKeyExists(body.projectId, generatedKey)) {
      return error(409, "That service is already configured on this project", generatedKey);
    }
    return json(201, { service: await store.createProjectService({ ...body, serviceKey: generatedKey }) });
  }

  const serviceUpdateMatch = pathname.match(/^\/api\/admin\/services\/([^/]+)$/);
  if (method === "PATCH" && serviceUpdateMatch) {
    const serviceId = decodeURIComponent(serviceUpdateMatch[1]);
    // The key is generated once at creation and is deliberately immutable:
    // conversation history and issue routing both refer to it.
    const editableService = { ...body };
    delete editableService.serviceKey;
    const service = await store.updateProjectService(serviceId, editableService);
    if (!service) return error(404, "Service not found");
    return json(200, { service });
  }

  if (method === "POST" && pathname === "/api/admin/clusters") {
    const name = String(body.name || "").trim();
    if (!name) return error(400, "Cluster name is required");
    if (await store.clusterNameExists(name)) return error(409, "A cluster with that name already exists", name);
    return json(201, { cluster: await store.createCluster({ name }) });
  }

  const clusterUpdateMatch = pathname.match(/^\/api\/admin\/clusters\/([^/]+)$/);
  if (method === "PATCH" && clusterUpdateMatch) {
    const clusterId = decodeURIComponent(clusterUpdateMatch[1]);
    const name = String(body.name || "").trim();
    if (!name) return error(400, "Cluster name is required");
    if (await store.clusterNameExists(name, clusterId)) return error(409, "A cluster with that name already exists", name);
    const cluster = await store.updateCluster(clusterId, { name });
    if (!cluster) return error(404, "Cluster not found");
    return json(200, { cluster });
  }

  if (method === "DELETE" && clusterUpdateMatch) {
    const clusterId = decodeURIComponent(clusterUpdateMatch[1]);
    const result = await store.deleteCluster(clusterId);
    if (!result.clustersDeleted) return error(404, "Cluster not found");
    return json(200, result);
  }

  if (method === "POST" && pathname === "/api/admin/clients") {
    const name = String(body.name || "").trim();
    if (!name) return error(400, "Client name is required");
    const requestedKey = String(body.key || "").trim();
    if (requestedKey && !/^[a-z0-9-]+$/.test(requestedKey)) {
      return error(400, "Client key must be lowercase letters, numbers and hyphens only");
    }
    if (requestedKey && await store.clientKeyExists(requestedKey)) {
      return error(409, "That client ID is already used", requestedKey);
    }
    const key = requestedKey || await availableIdentifier(name, (candidate) => store.clientKeyExists(candidate));
    return json(201, { client: await store.createClient({ ...body, name, key }) });
  }

  const clientUpdateMatch = pathname.match(/^\/api\/admin\/clients\/([^/]+)$/);
  if (method === "PATCH" && clientUpdateMatch) {
    const clientId = decodeURIComponent(clientUpdateMatch[1]);
    if (body.key !== undefined) {
      if (!/^[a-z0-9-]+$/.test(body.key)) {
        return error(400, "Client key must be lowercase letters, numbers and hyphens only");
      }
      if (await store.clientKeyExists(body.key, clientId)) {
        return error(409, "That client key is already used", body.key);
      }
    }
    const client = await store.updateClient(clientId, body);
    if (!client) return error(404, "Client not found");
    return json(200, { client });
  }

  if (method === "POST" && pathname === "/api/admin/import-workbook") {
    const result = await importAdminWorkbook(store, body);
    if (!result.ok) {
      return error(400, "Workbook validation failed", result.errors.slice(0, 40));
    }
    return json(200, result);
  }

  if (method === "POST" && pathname === "/api/admin/project-setups") {
    const input = body.project || {};
    const pocs = Array.isArray(body.pocs) ? body.pocs : [];
    const services = Array.isArray(body.services) ? body.services : [];
    const missing = ["clientId", "key", "name", "startDate", "endDate"]
      .filter((field) => !String(input[field] || "").trim());
    if (missing.length) return error(400, "Missing required project fields", missing.join(", "));

    const requestedKey = String(input.key || "").trim();
    if (!/^[A-Za-z0-9-]+$/.test(requestedKey)) {
      return error(400, "Project ID must contain letters, numbers and hyphens only");
    }
    if (await store.projectKeyExists(requestedKey)) return error(409, "That project ID is already used", requestedKey);
    if (input.endDate < input.startDate) return error(400, "End date cannot be before the start date");
    const interval = Number(input.feedbackIntervalDays || 30);
    if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
      return error(400, "Feedback interval must be a whole number from 1 to 365");
    }
    const finalStatus = String(input.activeStatus || "active").toLowerCase();
    if (!["active", "paused", "closed"].includes(finalStatus)) {
      return error(400, "Project status must be active, paused or closed");
    }
    if (!pocs.length) return error(400, "Add at least one client POC before saving the project");
    if (!services.length) return error(400, "Add at least one service before saving the project");
    if (pocs.length > 50 || services.length > 50) return error(400, "A project setup can contain at most 50 POCs and 50 services");

    const levels = typeof store.pocLevels === "function" ? await store.pocLevels() : null;
    const seenPhones = new Set();
    const preparedPocs = [];
    let activePocWeightTotal = 0;
    for (let index = 0; index < pocs.length; index += 1) {
      const row = pocs[index] || {};
      const number = String(row.contactWhatsapp || "").replace(/\D/g, "");
      const weightPercentage = Number(row.weightPercentage);
      if (!String(row.name || "").trim()) return error(400, `POC ${index + 1}: name is required`);
      if (!validOptionalIsoDate(row.birthDate)) return error(400, `POC ${index + 1}: birthday must be YYYY-MM-DD`);
      if (number.length < 10 || number.length > 15) return error(400, `POC ${index + 1}: WhatsApp number must be 10-15 digits including country code`);
      if (seenPhones.has(number)) return error(400, `POC ${index + 1}: WhatsApp number appears twice on this project`);
      if (!String(row.levelId || "").trim() || (levels && !levels.has(row.levelId))) {
        return error(400, `POC ${index + 1}: select Normal or Important`);
      }
      if (!Number.isFinite(weightPercentage) || weightPercentage <= 0 || weightPercentage > 100) {
        return error(400, `POC ${index + 1}: influence must be more than 0% and no more than 100%`);
      }
      const conflict = await pocWhatsappConflictForClient(store, number, input.clientId);
      if (conflict) return error(409, `POC ${index + 1}: WhatsApp number belongs to another client`, conflict.owner?.name);
      seenPhones.add(number);
      activePocWeightTotal += weightPercentage;
      preparedPocs.push({ ...row, name: String(row.name).trim(), contactWhatsapp: number, weightPercentage });
    }
    if (Math.abs(activePocWeightTotal - 100) > 0.01) {
      return error(400, `Active POC influence must total exactly 100%; the current total is ${Math.round(activePocWeightTotal * 100) / 100}%`);
    }

    const seenServiceKeys = new Set();
    const preparedServices = [];
    for (let index = 0; index < services.length; index += 1) {
      const row = services[index] || {};
      const name = String(row.name || "").trim();
      if (!name) return error(400, `Service ${index + 1}: name is required`);
      const serviceKey = serviceIdentifier(name);
      if (seenServiceKeys.has(serviceKey)) return error(400, `Service ${index + 1}: ${name} duplicates another service`);
      seenServiceKeys.add(serviceKey);
      preparedServices.push({ ...row, name, serviceKey });
    }

    // Create the project paused so a scheduler cannot pick it up between the
    // project, POC and service writes. Activate and schedule only after all
    // child records have been saved.
    let project = await store.createProject({
      ...input,
      key: requestedKey,
      feedbackIntervalDays: interval,
      activeStatus: "paused"
    });
    const createdPocs = [];
    const createdServices = [];
    try {
      for (const poc of preparedPocs) {
        createdPocs.push(await store.createClientPoc({ ...poc, projectId: project.id }));
      }
      for (const service of preparedServices) {
        createdServices.push(await store.createProjectService({ ...service, projectId: project.id }));
      }
      if (finalStatus !== "paused") project = await store.updateProject(project.id, { activeStatus: finalStatus });
      if (typeof store.ensureProjectSchedule === "function") await store.ensureProjectSchedule(project.id);
    } catch (setupError) {
      return error(500, "Project setup stopped before activation", {
        projectId: project.id,
        detail: setupError.message,
        recovery: "The project remains paused. Open it in Manage, complete the missing records, then activate it."
      });
    }
    return json(201, { project, pocs: createdPocs, services: createdServices });
  }

  const projectPocsMatch = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/pocs$/);
  if (method === "PUT" && projectPocsMatch) {
    const projectId = decodeURIComponent(projectPocsMatch[1]);
    const requested = Array.isArray(body.pocs) ? body.pocs : [];
    const removedIds = Array.isArray(body.removedIds) ? body.removedIds.map(String) : [];
    if (requested.length > 50) return error(400, "A project can contain at most 50 POCs in one save");

    const directory = await store.getDirectory();
    const project = (directory.projects || []).find((item) => item.id === projectId);
    if (!project) return error(404, "Project not found");
    const current = await store.pocsForProject(projectId, { activeOnly: false });
    const currentById = new Map(current.map((poc) => [poc.id, poc]));
    const levels = typeof store.pocLevels === "function" ? await store.pocLevels() : null;
    const seenIds = new Set();
    const seenPhones = new Set();
    const prepared = [];
    let activeWeightTotal = 0;

    for (let index = 0; index < requested.length; index += 1) {
      const row = requested[index] || {};
      const id = String(row.id || "").trim();
      const active = row.active !== false;
      const phone = String(row.contactWhatsapp || "").replace(/\D/g, "");
      const weightPercentage = active ? Number(row.weightPercentage) : 0;
      if (id && !currentById.has(id)) return error(400, `POC ${index + 1}: record does not belong to this project`);
      if (id && seenIds.has(id)) return error(400, `POC ${index + 1}: record appears more than once`);
      if (!String(row.name || "").trim()) return error(400, `POC ${index + 1}: name is required`);
      if (!validOptionalIsoDate(row.birthDate)) return error(400, `POC ${index + 1}: birthday must be YYYY-MM-DD`);
      if (active && (phone.length < 10 || phone.length > 15)) {
        return error(400, `POC ${index + 1}: active POC needs a 10-15 digit WhatsApp number including country code`);
      }
      if (phone && seenPhones.has(phone)) return error(400, `POC ${index + 1}: WhatsApp number appears twice on this project`);
      if (!String(row.levelId || "").trim() || (levels && !levels.has(row.levelId))) {
        return error(400, `POC ${index + 1}: select a Normal or Important tag`);
      }
      if (active && (!Number.isFinite(weightPercentage) || weightPercentage <= 0 || weightPercentage > 100)) {
        return error(400, `POC ${index + 1}: influence must be more than 0% and no more than 100%`);
      }
      if (phone) {
        const conflict = await pocWhatsappConflict(store, phone, projectId, id || null);
        if (conflict?.kind === "same_project") {
          return error(409, `POC ${index + 1}: WhatsApp number is already configured on this project`, conflict.owner?.name);
        }
        if (conflict) return error(409, `POC ${index + 1}: WhatsApp number belongs to another client`, conflict.owner?.name);
        seenPhones.add(phone);
      }
      if (id) seenIds.add(id);
      if (active) activeWeightTotal += weightPercentage;
      prepared.push({ ...row, id, projectId, name: String(row.name).trim(), contactWhatsapp: phone, active, weightPercentage });
    }

    if (prepared.some((row) => row.active) && Math.abs(activeWeightTotal - 100) > 0.01) {
      return error(400, `Active POC influence must total exactly 100%; the current total is ${Math.round(activeWeightTotal * 100) / 100}%`);
    }
    const invalidRemoval = removedIds.find((id) => !currentById.has(id));
    if (invalidRemoval) return error(400, "A removed POC does not belong to this project", invalidRemoval);

    const saved = [];
    for (const row of prepared) {
      saved.push(row.id
        ? await store.updateClientPoc(row.id, row)
        : await store.createClientPoc(row));
    }
    for (const pocId of removedIds) {
      if (!seenIds.has(pocId)) await store.updateClientPoc(pocId, { active: false, weightPercentage: 0 });
    }
    return json(200, { pocs: saved, removed: removedIds.length });
  }

  const projectServicesMatch = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/services$/);
  if (method === "PUT" && projectServicesMatch) {
    const projectId = decodeURIComponent(projectServicesMatch[1]);
    const requested = Array.isArray(body.services) ? body.services : [];
    if (!requested.length) return error(400, "An active project must keep at least one service");
    if (requested.length > 50) return error(400, "A project can contain at most 50 services in one save");
    const current = await store.servicesForProject(projectId);
    const currentById = new Map(current.map((service) => [service.id, service]));
    const seenIds = new Set();
    const seenKeys = new Set();
    const prepared = [];
    for (let index = 0; index < requested.length; index += 1) {
      const row = requested[index] || {};
      const name = String(row.name || "").trim();
      if (!name) return error(400, `Service ${index + 1}: name is required`);
      if (row.id && !currentById.has(row.id)) return error(400, `Service ${index + 1} does not belong to this project`);
      if (row.id && seenIds.has(row.id)) return error(400, `Service ${index + 1} was included twice`);
      const serviceKey = row.id ? currentById.get(row.id).serviceKey : serviceIdentifier(name);
      if (seenKeys.has(serviceKey)) return error(400, `Service ${index + 1}: ${name} duplicates another service`);
      if (row.id) seenIds.add(row.id);
      seenKeys.add(serviceKey);
      prepared.push({ ...row, name, serviceKey, projectId });
    }

    const removed = current.filter((service) => !seenIds.has(service.id));
    for (const service of removed) await store.deleteProjectService(service.id);
    const saved = [];
    for (const service of prepared) {
      if (service.id) {
        saved.push(await store.updateProjectService(service.id, {
          projectId,
          name: service.name,
          kpis: service.kpis,
          internalPocId: service.internalPocId
        }));
      } else {
        saved.push(await store.createProjectService(service));
      }
    }
    return json(200, { services: saved, removed: removed.map((service) => service.id) });
  }

  const projectMessageCleanupMatch = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/chat-messages$/);
  if (method === "DELETE" && projectMessageCleanupMatch) {
    const projectId = decodeURIComponent(projectMessageCleanupMatch[1]);
    const project = await store.getProjectById(projectId);
    if (!project) return error(404, "Project not found");
    const cycleIds = [...new Set(
      (Array.isArray(body.cycleIds) ? body.cycleIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )];
    if (!cycleIds.length) return error(400, "Select at least one feedback cycle to clear");
    if (cycleIds.length > 100) return error(400, "At most 100 feedback cycles can be cleared at once");
    const projectCycleIds = new Set((await store.listProjectCycles(projectId)).map((cycle) => cycle.id));
    if (cycleIds.some((cycleId) => !projectCycleIds.has(cycleId))) {
      return error(400, "One or more selected cycles do not belong to this project");
    }
    const result = await store.clearProjectMessages(projectId, cycleIds);
    return json(200, {
      project: { id: project.id, key: project.key, name: project.name },
      ...result,
      preserved: ["sessions", "cycles", "ratings", "scores", "issues", "service feedback", "observations", "appreciations"]
    });
  }

  const projectCycleCleanupMatch = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/feedback-cycles$/);
  if (method === "DELETE" && projectCycleCleanupMatch) {
    const projectId = decodeURIComponent(projectCycleCleanupMatch[1]);
    const project = await store.getProjectById(projectId);
    if (!project) return error(404, "Project not found");
    const cycleIds = [...new Set(
      (Array.isArray(body.cycleIds) ? body.cycleIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )];
    if (!cycleIds.length) return error(400, "Select at least one feedback cycle to delete");
    if (cycleIds.length > 100) return error(400, "At most 100 feedback cycles can be deleted at once");
    const projectCycleIds = new Set((await store.listProjectCycles(projectId)).map((cycle) => cycle.id));
    if (cycleIds.some((cycleId) => !projectCycleIds.has(cycleId))) {
      return error(400, "One or more selected cycles do not belong to this project");
    }
    const result = await store.deleteProjectCycles(projectId, cycleIds);
    return json(200, {
      project: { id: project.id, key: project.key, name: project.name },
      ...result,
      preserved: ["client", "project", "project POCs", "project services", "feedback schedule", "other feedback cycles", "automation delivery audit"]
    });
  }

  const projectIssueCleanupMatch = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/issues$/);
  if (method === "DELETE" && projectIssueCleanupMatch) {
    const projectId = decodeURIComponent(projectIssueCleanupMatch[1]);
    const project = await store.getProjectById(projectId);
    if (!project) return error(404, "Project not found");
    const cycleIds = [...new Set(
      (Array.isArray(body.cycleIds) ? body.cycleIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )];
    const issueIds = [...new Set(
      (Array.isArray(body.issueIds) ? body.issueIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )];
    if (!cycleIds.length) return error(400, "Select at least one feedback cycle first");
    if (!issueIds.length) return error(400, "Select at least one issue to delete");
    if (cycleIds.length > 100 || issueIds.length > 500) {
      return error(400, "Too many records were selected for one cleanup");
    }

    const [projectCycles, projectSessions, projectIssues] = await Promise.all([
      store.listProjectCycles(projectId),
      store.listProjectSessions(projectId),
      store.listProjectIssues(projectId)
    ]);
    const projectCycleIds = new Set(projectCycles.map((cycle) => cycle.id));
    if (cycleIds.some((cycleId) => !projectCycleIds.has(cycleId))) {
      return error(400, "One or more selected cycles do not belong to this project");
    }
    const selectedCycleIds = new Set(cycleIds);
    const sessionCycleIds = new Map(projectSessions.map((session) => [session.id, session.cycleId]));
    const projectIssuesById = new Map(projectIssues.map((issue) => [issue.id, issue]));
    if (issueIds.some((issueId) => {
      const issue = projectIssuesById.get(issueId);
      return !issue || !selectedCycleIds.has(sessionCycleIds.get(issue.sessionId));
    })) {
      return error(400, "One or more selected issues do not belong to the selected cycles on this project");
    }

    const result = await store.deleteProjectIssues(projectId, issueIds);
    return json(200, {
      project: { id: project.id, key: project.key, name: project.name },
      ...result,
      preserved: ["chat messages", "sessions", "cycles", "ratings", "scores", "service feedback", "observations", "appreciations"]
    });
  }

  if (method === "POST" && pathname === "/api/admin/projects/bulk") {
    const clientId = String(body.clientId || "").trim();
    const rows = Array.isArray(body.projects) ? body.projects : [];
    if (!clientId) return error(400, "Client is required");
    if (!rows.length) return error(400, "The CSV contains no project rows");
    if (rows.length > 250) return error(400, "A single import can contain at most 250 projects");

    const prepared = [];
    const reserved = new Set();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] || {};
      const rowNumber = index + 2;
      const name = String(row.name || "").trim();
      if (!name) return error(400, `Row ${rowNumber}: project_name is required`);
      if (row.startDate && row.endDate && row.endDate < row.startDate) {
        return error(400, `Row ${rowNumber}: end_date cannot be before start_date`);
      }
      const intervalValue = row.feedbackIntervalDays === ""
        || row.feedbackIntervalDays === null
        || row.feedbackIntervalDays === undefined
        ? 30
        : row.feedbackIntervalDays;
      const interval = Number(intervalValue);
      if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
        return error(400, `Row ${rowNumber}: feedback_interval_days must be from 1 to 365`);
      }
      const activeStatus = String(row.activeStatus || "active").toLowerCase();
      if (!["active", "paused", "closed"].includes(activeStatus)) {
        return error(400, `Row ${rowNumber}: status must be active, paused or closed`);
      }
      const requestedKey = String(row.key || "").trim();
      if (requestedKey && !/^[A-Za-z0-9-]+$/.test(requestedKey)) {
        return error(400, `Row ${rowNumber}: project_id must contain letters, numbers and hyphens only`);
      }
      if (requestedKey && (reserved.has(requestedKey) || await store.projectKeyExists(requestedKey))) {
        return error(409, `Row ${rowNumber}: project ID is already used`, requestedKey);
      }
      const key = requestedKey || await availableIdentifier(name, (candidate) => store.projectKeyExists(candidate), reserved);
      if (requestedKey) reserved.add(requestedKey);
      prepared.push({
        clientId, key, name,
        activeStatus,
        startDate: row.startDate || "",
        endDate: row.endDate || "",
        feedbackIntervalDays: interval
      });
    }

    const projects = [];
    for (const project of prepared) projects.push(await store.createProject(project));
    return json(201, { projects, imported: projects.length });
  }

  if (method === "POST" && pathname === "/api/admin/projects") {
    const missing = ["clientId", "key", "name", "startDate", "endDate"]
      .filter((field) => !String(body[field] || "").trim());
    if (missing.length) return error(400, "Missing required fields", missing.join(", "));
    const requestedKey = String(body.key || "").trim();
    if (!/^[A-Za-z0-9-]+$/.test(requestedKey)) {
      return error(400, "Project ID must contain letters, numbers and hyphens only");
    }
    if (await store.projectKeyExists(requestedKey)) {
      return error(409, "That project ID is already used", requestedKey);
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      return error(400, "End date cannot be before the start date");
    }
    const project = await store.createProject({ ...body, key: requestedKey });
    if (typeof store.ensureProjectSchedule === "function") await store.ensureProjectSchedule(project.id);
    return json(201, { project });
  }

  const projectUpdateMatch = pathname.match(/^\/api\/admin\/projects\/([^/]+)$/);
  if (method === "PATCH" && projectUpdateMatch) {
    const projectId = decodeURIComponent(projectUpdateMatch[1]);
    if (body.key !== undefined) {
      if (!/^[A-Za-z0-9-]+$/.test(body.key)) {
        return error(400, "Project key must contain letters, numbers and hyphens only");
      }
      if (await store.projectKeyExists(body.key, projectId)) {
        return error(409, "That project key is already used", body.key);
      }
    }
    if (body.startDate && body.endDate && body.endDate < body.startDate) {
      return error(400, "End date cannot be before the start date");
    }
    const project = await store.updateProject(projectId, body);
    if (!project) return error(404, "Project not found");
    if (typeof store.ensureProjectSchedule === "function") await store.ensureProjectSchedule(project.id);
    return json(200, { project });
  }

  if (method === "POST" && pathname === "/api/admin/pocs") {
    const missing = ["projectId", "name"].filter((field) => !String(body[field] || "").trim());
    if (missing.length) return error(400, "Missing required fields", missing.join(", "));
    if (!validOptionalIsoDate(body.birthDate)) return error(400, "Birthday must be YYYY-MM-DD");

    const phone = String(body.contactWhatsapp || "").replace(/\D/g, "");
    if (phone && (phone.length < 10 || phone.length > 15)) {
      return error(400, "WhatsApp number must be 10-15 digits including country code");
    }
    if (body.weightPercentage !== undefined) {
      const weightPercentage = Number(body.weightPercentage);
      if (!Number.isFinite(weightPercentage) || weightPercentage < 0 || weightPercentage > 100) {
        return error(400, "POC influence must be between 0% and 100%");
      }
    }
    if (phone) {
      const conflict = await pocWhatsappConflict(store, phone, body.projectId);
      if (conflict?.kind === "same_project") {
        return error(409, "That WhatsApp number is already configured on this project", conflict.owner?.name);
      }
      if (conflict) {
        return error(409, "That WhatsApp number belongs to a POC under another client", conflict.owner?.name);
      }
    }
    return json(201, { poc: await store.createClientPoc(body) });
  }

  const pocUpdateMatch = pathname.match(/^\/api\/admin\/pocs\/([^/]+)$/);
  if (method === "PATCH" && pocUpdateMatch) {
    const pocId = decodeURIComponent(pocUpdateMatch[1]);
    if (!validOptionalIsoDate(body.birthDate)) return error(400, "Birthday must be YYYY-MM-DD");
    if (body.contactWhatsapp !== undefined) {
      const phone = String(body.contactWhatsapp || "").replace(/\D/g, "");
      if (phone && (phone.length < 10 || phone.length > 15)) {
        return error(400, "WhatsApp number must be 10-15 digits including country code");
      }
      if (phone) {
        const existingPoc = typeof store.getClientPocById === "function"
          ? await store.getClientPocById(pocId)
          : null;
        const conflict = await pocWhatsappConflict(store, phone, body.projectId || existingPoc?.projectId, pocId);
        if (conflict?.kind === "same_project") {
          return error(409, "That WhatsApp number is already configured on this project", conflict.owner?.name);
        }
        if (conflict) {
          return error(409, "That WhatsApp number belongs to a POC under another client", conflict.owner?.name);
        }
      }
    }
    if (body.weightPercentage !== undefined) {
      const weightPercentage = Number(body.weightPercentage);
      if (!Number.isFinite(weightPercentage) || weightPercentage < 0 || weightPercentage > 100) {
        return error(400, "POC influence must be between 0% and 100%");
      }
    }
    const poc = await store.updateClientPoc(pocId, body);
    if (!poc) return error(404, "POC not found");
    return json(200, { poc });
  }

  if (method === "DELETE" && pathname === "/api/admin/client-pocs") {
    const clientId = String(body.clientId || "").trim();
    const pocIds = [...new Set((Array.isArray(body.pocIds) ? body.pocIds : []).map(String).filter(Boolean))];
    if (!clientId) return error(400, "Client is required");
    if (!pocIds.length) return error(400, "Select at least one client POC to delete");
    if (pocIds.length > 100) return error(400, "At most 100 client POCs can be deleted at once");
    const detail = await store.getClientDetail(clientId);
    if (!detail) return error(404, "Client not found");
    const allowed = new Set((detail.pocs || []).map((poc) => poc.id));
    if (pocIds.some((id) => !allowed.has(id))) return error(400, "One or more selected POCs do not belong to this client");
    return json(200, await store.deleteClientPocs(pocIds));
  }

  if (method === "DELETE" && pathname === "/api/admin/projects") {
    const clientId = String(body.clientId || "").trim();
    const projectIds = [...new Set((Array.isArray(body.projectIds) ? body.projectIds : []).map(String).filter(Boolean))];
    if (!clientId) return error(400, "Client is required");
    if (!projectIds.length) return error(400, "Select at least one project to delete");
    if (projectIds.length > 100) return error(400, "At most 100 projects can be deleted at once");
    const detail = await store.getClientDetail(clientId);
    if (!detail) return error(404, "Client not found");
    const allowed = new Set((detail.projects || []).map((project) => project.id));
    if (projectIds.some((id) => !allowed.has(id))) return error(400, "One or more selected projects do not belong to this client");
    return json(200, await store.deleteProjects(projectIds));
  }

  if (method === "DELETE" && pathname === "/api/admin/clients") {
    const clientIds = [...new Set((Array.isArray(body.clientIds) ? body.clientIds : []).map(String).filter(Boolean))];
    if (!clientIds.length) return error(400, "Select at least one client to delete");
    if (clientIds.length > 25) return error(400, "At most 25 clients can be deleted at once");
    const directory = await store.getDirectory();
    const allowed = new Set((directory.clients || []).map((client) => client.id));
    if (clientIds.some((id) => !allowed.has(id))) return error(400, "One or more selected clients do not exist");
    return json(200, await store.deleteClients(clientIds));
  }

  return error(404, "API route not found", pathname);
}

module.exports = {
  handleApiRequest,
  conversationFlow: {
    requiredConversationAction,
    conductedAction,
    actionMatches,
    messageMatchesRequiredAction,
    fallbackForAction,
    recordRequiredQuestion,
    setStateForRequiredAction,
    acceptedOverallRating,
    applyTurnServiceScope,
    validatedAnswerMarkers,
    scopeCapturedToPendingQuestion,
    groundMultiServiceCaptures,
    resetFreshCapturedServices,
    reconcilePendingServiceArtifacts,
    suppressDuplicateIssues,
    mergeObservations,
    separateAppreciations,
    suppressBroadOverallServiceGuess,
    applyPendingIssueInterpretation,
    normalizeLegacyServiceFollowups,
    applyConversationInterruption,
    observationFromInterpretation,
    canonicalObservationTopic,
    applyDeferredInterpretation,
    isExplicitActionRequest,
    latestExplicitOverallRating,
    clientBurstContext
  }
};

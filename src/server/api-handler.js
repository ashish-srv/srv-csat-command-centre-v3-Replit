const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const { createStore } = require("../lib/store");
const { MAX_REMINDERS, nextQuickCheckinAt } = require("../lib/supabase-store");
const { processWhatsAppReply, getConversationState, buildChecklist, applyCaptured, applyServiceScopeDecision, applyTurnProgress, finishFeedbackQuestions, isEverythingCovered, soundsLikeFarewell, isMoveOnReply, overallRatingQuestion, projectEndReviewQuestion, buildAnalysis, detectors, STATES, GUARDRAILS, CLOSING_GRACE_MS, DEFERRAL_REPLY, SERVICE_SCOPE_DECISIONS, SERVICE_SCOPE_QUESTION } = require("../lib/whatsapp-state-machine");
const { offScriptReply, reviewIssues, readTone, readNps, interpretReply, conductTurn, predictSatisfaction, cleanRepeatedText, extractExplicitAppreciations, hasSatisfactionEvidence, containsClaim, ALERT_CONFIDENCE_THRESHOLD } = require("../lib/gemini");
const { emitAutomation } = require("../lib/n8n");
const { importAdminWorkbook } = require("../lib/admin-import");
const { buildCsatImportWorkbook } = require("../lib/csat-workbook-template");
const { recipientList, sendEmail, smtpConfigured } = require("../lib/email");

const WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const INACTIVE_FINAL_SWEEP_MS = 6 * 60 * 60 * 1000;
const MAX_MANUAL_WHATSAPP_TEXT_LENGTH = 4096;

function manualQuestionType(message, sessionType) {
  if (!message?.metadata?.manualOutbound) return null;
  const text = String(message.body || "").trim();
  if (!text) return null;

  const asksAQuestion = /\?\s*$/.test(text)
    || /\b(?:how|what)\b.{0,100}\b(?:rate|rating|score|likely)\b/i.test(text)
    || /\b(?:please|kindly)\s+(?:rate|score|give)\b/i.test(text);
  if (!asksAQuestion) return null;

  const recommendationQuestion = /\b(?:recommend|recommendation|nps|likely)\w*\b/i.test(text)
    && /\b(?:srv(?: media)?|agency|services?|us|our)\b/i.test(text);
  if (recommendationQuestion) {
    return sessionType === "project_end" ? "nps" : null;
  }

  const asksForRating = /\b(?:rate|rating|score)\b/i.test(text);
  const overallTarget = /\boverall\b|\bsrv(?: media)?\b|\b(?:our|the)\s+(?:work|delivery|services?|project|agency|team)\b/i.test(text);
  return asksForRating && overallTarget ? "overall_rating" : null;
}

function applyManualQuestionContext(session, message) {
  const type = message?.metadata?.manualQuestionType
    || manualQuestionType(message, session?.sessionType);
  if (!type) return session;

  const conversationState = getConversationState({
    ...session,
    conversationState: JSON.parse(JSON.stringify(session.conversationState || {}))
  });
  conversationState.pendingServiceKey = null;
  conversationState.pendingQuestionType = type;
  conversationState.state = type === "nps"
    ? STATES.WAITING_FOR_NPS
    : STATES.WAITING_FOR_OVERALL_RATING;
  conversationState.lastQuestionAsked = String(message.body || "").trim();
  conversationState.manualQuestionType = type;
  conversationState.manualQuestionAskedAt = message.createdAt || new Date().toISOString();
  conversationState.deferredAt = null;
  conversationState.repeatCount = 0;
  if (type === "overall_rating") conversationState.overallRatingAsked = true;
  return { ...session, conversationState };
}

function automaticProjectEndFeedbackEnabled() {
  const configured = String(process.env.AUTO_PROJECT_END_FEEDBACK || "").trim().toLowerCase();
  if (!configured) return false;
  return ["1", "true", "yes", "on"].includes(configured);
}

function escapeEmailHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function notifySetupRecordCreated(store, { kind, client, project = null, actor, source, baseUrl }) {
  if (!smtpConfigured()) return { status: "not_configured" };
  try {
    const users = typeof store.listAppUsers === "function" ? await store.listAppUsers() : [];
    const recipients = recipientList([
      ...users.filter((user) => user.active !== false && user.role === "super_admin").map((user) => user.email),
      process.env.PROJECT_SETUP_ALERT_EMAILS || ""
    ].join(","));
    if (!recipients.length) return { status: "no_recipients" };

    const recordId = project?.id || client?.id || "unknown";
    const dedupeKey = `setup_email:${kind}:${recordId}`;
    const payload = {
      kind,
      clientId: client?.id || null,
      clientName: client?.name || null,
      projectId: project?.id || null,
      projectKey: project?.key || null,
      projectName: project?.name || null,
      actor: actor || "Unknown user",
      source: source || "application",
      recipients
    };
    let claim = null;
    if (typeof store.claimAutomationEvent === "function") {
      claim = await store.claimAutomationEvent("project_setup_email", payload, dedupeKey);
      if (!claim) return { status: "duplicate" };
    }

    const title = project ? `New project needs review: ${project.name}` : `New client added: ${client?.name || "Unnamed client"}`;
    const appUrl = String(baseUrl || process.env.PUBLIC_APP_URL || "").replace(/\/$/, "");
    const details = [
      `Record: ${project ? "Project" : "Client"}`,
      `Client: ${client?.name || "Not set"}`,
      ...(project ? [`Project: ${project.name}`, `Project ID: ${project.key}`] : []),
      `Created by: ${actor || "Unknown user"}`,
      `Source: ${source || "application"}`,
      project?.activeStatus === "paused" ? "Status: Paused — complete setup before activation" : `Status: ${project?.activeStatus || client?.activeStatus || "Not set"}`,
      appUrl ? `Open application: ${appUrl}` : ""
    ].filter(Boolean);
    try {
      const result = await sendEmail({
        to: recipients,
        subject: `[CSAT Command Centre] ${title}`,
        text: details.join("\n"),
        html: `<h2>${escapeEmailHtml(title)}</h2><ul>${details.slice(0, -1).map((line) => `<li>${escapeEmailHtml(line)}</li>`).join("")}</ul>${appUrl ? `<p><a href="${escapeEmailHtml(appUrl)}">Open CSAT Command Centre</a></p>` : ""}`
      });
      const event = {
        eventType: "project_setup_email",
        dedupeKey,
        payload: { ...payload, messageId: result.messageId || null },
        status: result.sent ? "sent" : "failed",
        webhookUrlConfigured: false,
        statusCode: result.sent ? 200 : null,
        sentAt: new Date().toISOString(),
        error: result.error || null
      };
      if (claim && typeof store.completeAutomationEvent === "function") await store.completeAutomationEvent(claim.id, event);
      else if (typeof store.recordAutomationEvent === "function") await store.recordAutomationEvent(event);
      return event;
    } catch (emailError) {
      const event = {
        eventType: "project_setup_email", dedupeKey, payload, status: "failed", webhookUrlConfigured: false,
        sentAt: new Date().toISOString(), error: emailError.message
      };
      if (claim && typeof store.completeAutomationEvent === "function") await store.completeAutomationEvent(claim.id, event);
      else if (typeof store.recordAutomationEvent === "function") await store.recordAutomationEvent(event);
      console.warn("[email] project setup alert failed:", emailError.message);
      return event;
    }
  } catch (error) {
    console.warn("[email] could not prepare project setup alert:", error.message);
    return { status: "failed", error: error.message };
  }
}

async function notifyServiceChangeRequested(store, { request, baseUrl }) {
  if (!smtpConfigured()) return { status: "not_configured", error: "SMTP is not configured" };
  try {
    const users = typeof store.listAppUsers === "function" ? await store.listAppUsers() : [];
    const recipients = recipientList([
      ...users.filter((user) => user.active !== false && user.role === "super_admin").map((user) => user.email),
      process.env.PROJECT_SERVICE_CHANGE_ALERT_EMAILS || ""
    ].join(","));
    if (!recipients.length) return { status: "no_recipients", error: "No active Super Admin email is configured" };

    const actionLabel = request.requestType === "remove_existing"
      ? "Remove project service"
      : request.requestType === "add_new"
        ? "Create and add new service"
        : "Add project service";
    const appUrl = String(baseUrl || process.env.PUBLIC_APP_URL || "").replace(/\/$/, "");
    const reviewUrl = appUrl ? `${appUrl}/manage#manage-service-change-requests` : "";
    const details = [
      `Request: ${actionLabel}`,
      `Client: ${request.clientName || "Not set"}`,
      `Project: ${request.projectName || request.projectKey || "Not set"}`,
      `Service: ${request.serviceName}`,
      `Requested by: ${request.requestedByName || request.requestedByEmail || "Unknown user"}`,
      `Reason: ${request.reason}`
    ];
    const result = await sendEmail({
      to: recipients,
      subject: `[CSAT Command Centre] Service change approval needed: ${request.projectName || request.projectKey || "Project"}`,
      text: [...details, reviewUrl ? `Review request: ${reviewUrl}` : ""].filter(Boolean).join("\n"),
      html: `<h2>Project service change approval needed</h2><ul>${details.map((line) => `<li>${escapeEmailHtml(line)}</li>`).join("")}</ul>${reviewUrl ? `<p><a href="${escapeEmailHtml(reviewUrl)}">Review in CSAT Command Centre</a></p>` : ""}`
    });
    const event = {
      eventType: "project_service_change_requested",
      dedupeKey: `project_service_change_email:${request.id}`,
      payload: { requestId: request.id, projectId: request.projectId, requestType: request.requestType, serviceName: request.serviceName, recipients },
      status: result.sent ? "sent" : "failed",
      webhookUrlConfigured: false,
      statusCode: result.sent ? 200 : null,
      sentAt: new Date().toISOString(),
      error: result.error || null
    };
    if (typeof store.recordAutomationEvent === "function") await store.recordAutomationEvent(event);
    return event;
  } catch (emailError) {
    console.warn("[email] project service change alert failed:", emailError.message);
    return { status: "failed", error: emailError.message };
  }
}

function automaticFeedbackTargets(targets = []) {
  if (automaticProjectEndFeedbackEnabled()) return targets;
  return targets.filter((target) => target.cycleType !== "project_end");
}

async function projectEndFeedbackStarted(store, project) {
  if (!project) return false;
  if (project.endFeedbackRequestedAt) return true;
  if (typeof store.hasAnyCycle === "function") {
    return store.hasAnyCycle(project.id, "project_end");
  }
  return false;
}

function requiredConversationAction(checklist, conversationState) {
  if (conversationState.clientRequestedClose) return { type: "close" };
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
  if (conversationState.closingGraceExpiresAt) {
    const person = conversationState.awaitingAppreciationPersonName;
    if (person) return { type: "service_followup", serviceKey: person.serviceKey, name: conversationState.mentionedServices?.[person.serviceKey]?.serviceName };
    return { type: "close" };
  }
  const ratingPause = conversationState.ratingFeedbackPause;
  const missingPausedRating = ratingPause?.ratingType === "nps"
    ? conversationState.npsScore == null && !conversationState.npsDeclined
    : conversationState.overallRating == null && !conversationState.overallRatingDeclined;
  if (ratingPause && missingPausedRating) {
    return { type: "rating_feedback", ratingType: ratingPause.ratingType, offerChoice: !ratingPause.choiceAsked };
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
  if (checklist.overallRatingStillNeeded) return { type: "overall_rating" };
  if (checklist.npsStillNeeded) return { type: "nps" };
  if (!conversationState.anythingElseAnswered) return { type: "final_sweep" };
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
    conducted.askedForRatingTransition && { type: "rating_feedback", offerChoice: true },
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
  if (required.type === "rating_feedback" && required.offerChoice !== actual.offerChoice) return false;
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
      // An explicit appreciation is already a complete positive point. Gemini
      // can conservatively mark it as needing a follow-up, which would reopen
      // a finished service and ask "anything more?" during closing grace. Only
      // preserve follow-up requirements when the same capture is a criticism.
      if (existing.sentiment !== "negative") {
        existing.sentiment = "positive";
        existing.declined = false;
        existing.needsFollowUp = false;
      }
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

function ensureClientAppreciations(conducted, stateBefore, text, project) {
  const serviceList = (project.services || []).map((service) => ({
    serviceKey: service.serviceKey,
    name: service.name
  }));
  const merged = [...(conducted.appreciations || [])];
  const explicit = extractExplicitAppreciations(text, serviceList);
  for (const item of explicit) {
    const duplicate = merged.some((existing) => {
      if (item.serviceKey && existing.serviceKey === item.serviceKey) return true;
      const overlap = contentOverlap(existing.detail, item.detail);
      return overlap.shared >= 3 && overlap.ratio >= 0.55;
    });
    if (!duplicate) merged.push(item);
  }

  const answeringAppreciation = pendingQuestionTypeFor(stateBefore) === "appreciation";
  const declined = isMoveOnReply(text)
    || /^\s*(?:no|none|nothing|not really|no one|nobody)\b/i.test(String(text || ""));
  const politeActionRequest = /\b(?:would|will)\s+appreciat(?:e|ed|ing)\b[\s\S]{0,80}\b(?:meeting|call|discussion|review|report|update|follow[ -]?up|help|support)\b/i.test(String(text || ""));
  const positiveReply = detectors.detectSentiment(text) === "positive"
    || /\b(?:patient|understanding|supportive|helpful|impressive|commendable|well done)\b/i.test(text);
  const negatedPraise = /\b(?:not|never|isn'?t|wasn'?t|weren'?t)\s+(?:good|great|excellent|patient|understanding|supportive|helpful)\b/i.test(text);
  const pendingPerson = stateBefore.awaitingAppreciationPersonName;

  if (pendingPerson && !merged.length && !declined && String(text || "").trim()) {
    const personName = String(text).trim().slice(0, 120);
    merged.push({
      subject: personName,
      detail: `Appreciation for ${pendingPerson.role}: ${personName}`,
      serviceKey: pendingPerson.serviceKey || null
    });
  }

  // When the bot has just asked whom the client appreciates, ordinary praise
  // is itself the answer; clients should not have to use the word "appreciate".
  if (answeringAppreciation && !merged.length && !declined && !politeActionRequest && positiveReply && !negatedPraise) {
    const keys = [...new Set([
      ...detectors.detectServices(text, project),
      ...(conducted.captured || [])
        .filter((item) => item.sentiment === "positive")
        .map((item) => item.serviceKey)
    ].filter(Boolean))];
    if (keys.length) {
      for (const serviceKey of keys) {
        const service = serviceList.find((item) => item.serviceKey === serviceKey);
        merged.push({
          subject: service?.name ? `${service.name} Team` : "Client appreciation",
          detail: String(text || "").trim().slice(0, 600),
          serviceKey
        });
      }
    } else {
      merged.push({
        subject: "Client appreciation",
        detail: String(text || "").trim().slice(0, 600),
        serviceKey: null
      });
    }
  }
  conducted.appreciations = merged;
  return conducted;
}

function unnamedAppreciationRole(text) {
  const source = String(text || "");
  const role = source.match(/\b((?:account|project|campaign|relationship|client|service|website|seo|creative|media)\s+manager|manager|coordinator|executive|team\s+lead|department\s+head)\b/i);
  if (!role) return null;
  const named = /\b(?:named?|called)\s+[a-z][a-z.'-]{1,30}\b/i.test(source)
    || /\b(?:mr|mrs|ms|miss|dr|shri)\.?\s+[a-z][a-z.'-]{1,30}\b/i.test(source)
    || new RegExp(`${role[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,(:-]?\\s*(?!for\\b|who\\b|that\\b|is\\b|was\\b|has\\b|being\\b|because\\b)([a-z][a-z.'-]{1,30})\\b`, "i").test(source)
    || new RegExp(`\\b(?!(?:the|our|your|my|a|an|for|to|mention|appreciate)\\b)([a-z][a-z.'-]{1,30})\\s*,?\\s+(?:our|the)?\\s*${role[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(source);
  return named ? null : role[1];
}

function openAppreciationFollowUp(conversationState, stateBefore, conducted, text) {
  if (!(conducted.appreciations || []).length) return false;
  const serviceKey = (conducted.appreciations || []).find((item) => item.serviceKey)?.serviceKey;
  const service = serviceKey ? conversationState.mentionedServices?.[serviceKey] : null;
  if (!service) return false;
  const unnamedRole = unnamedAppreciationRole(text);
  if (!unnamedRole && stateBefore.closingGraceExpiresAt) conversationState.awaitingAppreciationPersonName = null;
  if (!unnamedRole) return false;
  service.status = "needs_service_followup";
  service.serviceFollowUpAnswered = false;
  service.followUpAsked = false;
  service.serviceFollowUpAskCount = 0;
  conversationState.pendingServiceKey = serviceKey;
  conversationState.awaitingAppreciationPersonName = unnamedRole
    ? { serviceKey, role: unnamedRole }
    : null;
  return true;
}

function appreciationAcknowledgement(context = {}, project = {}, conversationState = {}) {
  const items = context.appreciations || [];
  if (!items.length) return "";
  const unnamedRole = conversationState.awaitingAppreciationPersonName?.role;
  if (unnamedRole) {
    return `Thank you for the special mention for the ${unnamedRole}. We will make sure your kind words reach the right person.`;
  }
  const explicitSubjects = [...new Set(items
    .map((item) => String(item.subject || "").trim())
    .filter((subject) => subject && !/^client appreciation$/i.test(subject)))];
  const serviceNames = [...new Set(items
    .map((item) => (project.services || []).find((service) => service.serviceKey === item.serviceKey)?.name)
    .filter(Boolean))];
  if (items.length === 1 && explicitSubjects.length === 1) {
    const subject = explicitSubjects[0];
    const target = /\b(?:team|department|manager|coordinator|executive|lead|head)$/i.test(subject)
      ? `the ${subject}`
      : subject;
    return `Thank you for appreciating ${target}. We will share your kind words with them.`;
  }
  if (serviceNames.length === 1) {
    return `Thank you for appreciating the ${serviceNames[0]} team. We will share your kind words with them.`;
  }
  if (serviceNames.length > 1 || items.length > 1) {
    return "Thank you for appreciating the teams and people you mentioned. We will share your kind words with them.";
  }
  const subject = String(items[0].subject || "").trim();
  if (subject && !/^client appreciation$/i.test(subject)) {
    return `Thank you for that special mention for ${subject}. We will share your kind words with them.`;
  }
  return "Thank you for those kind words about SRV Media. We truly appreciate them.";
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
    if (!item.serviceKey) continue;
    const previous = stateBefore.mentionedServices?.[item.serviceKey];
    const pureAppreciation = item.fromAppreciation === true
      && item.sentiment === "positive"
      && item.needsFollowUp !== true;
    if (existingKeys.has(item.serviceKey)) {
      // The preliminary rule pass sees a named team and treats the praise as a
      // new service opinion before structured appreciation extraction runs.
      // Restore an already-finished service so closing-window praise cannot
      // manufacture a fresh "anything else?" requirement.
      if (pureAppreciation && previous?.serviceFollowUpAnswered === true) {
        const answeredPersonName = stateBefore.awaitingAppreciationPersonName?.serviceKey === item.serviceKey
          ? conversationState.mentionedServices[item.serviceKey]?.appreciationPersonName : null;
        conversationState.mentionedServices[item.serviceKey] = JSON.parse(JSON.stringify(previous));
        if (answeredPersonName) conversationState.mentionedServices[item.serviceKey].appreciationPersonName = answeredPersonName;
      }
      continue;
    }
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

/**
 * The inclusive Directors question is the last conversational stage, not the
 * start of a new service-by-service interview. Detailed concerns volunteered
 * there are recorded and acknowledged, then one inclusive follow-up remains.
 * Only a genuinely vague point stays open for clarification.
 */
function settleActionableFinalSweepFacts(conversationState, stateBefore, conducted = {}, text = "", interpretation = null, project = null) {
  settleClosingWindowFacts(conversationState, stateBefore, conducted);
  const isAppreciationFollowUp = (key) => conversationState.awaitingAppreciationPersonName?.serviceKey === key;
  const pendingType = pendingQuestionTypeFor(stateBefore);
  const continuingReview = stateBefore.ratingFeedbackPause && interpretation?.intent === "feedback";
  const essentialClarification = [...(conducted.captured || []), ...(conducted.observations || [])]
    .some((item) => item.needsFollowUp === true && item.fallbackKind !== "general_concern");
  if (continuingReview && !essentialClarification) {
    // A general emotional continuation of an already-recorded review is not
    // a newly unexplained incident. Preserve it without demanding a reason.
    for (const item of conducted.observations || []) {
      if (item.fallbackKind === "general_concern") item.needsFollowUp = false;
    }
    conversationState.pendingObservation = null;
    conversationState.pendingGeneralIssue = false;
  }
  const completionScope = detectors.completionScopeFor(text, interpretation);
  const hasNewFacts = (conducted.captured || []).length > 0 || (conducted.observations || []).length > 0
    || (conducted.appreciations || []).length > 0;
  const declinedTopic = ["topic", "rating"].includes(completionScope)
    || (completionScope === "none" && interpretation?.intent === "negative" && !hasNewFacts);
  if (declinedTopic && pendingType === "overall_rating") conversationState.overallRatingDeclined = true;
  if (declinedTopic && pendingType === "nps") conversationState.npsDeclined = true;
  if (declinedTopic && ["issue_reason", "service_followup"].includes(pendingType)) {
    const service = conversationState.mentionedServices?.[stateBefore.pendingServiceKey];
    if (service) {
      service.status = service.reasonText ? "captured" : "declined";
      service.serviceFollowUpAnswered = true;
      service.detailDeclined = true;
    }
  }
  const directToRating = ["overall_rating", "nps", "final_sweep", "rating_feedback"].includes(pendingType)
    || Boolean(stateBefore.ratingFeedbackPause)
    || Boolean(conversationState.generalFeedbackText && conversationState.serviceScopeStatus !== "service_by_service")
    || [STATES.WAITING_FOR_OVERALL_RATING, STATES.WAITING_FOR_NPS, STATES.CLOSING_GRACE].includes(stateBefore.state)
    || (conversationState.sessionType === "project_end" && conversationState.serviceScopeStatus !== "service_by_service");
  const suppliedKeys = (conducted.captured || []).map((item) => item.serviceKey);
  const changedTopic = (conducted.observations || []).length > 0
    || (suppliedKeys.length > 0 && !suppliedKeys.includes(stateBefore.pendingServiceKey));
  if (pendingType === "issue_reason" && changedTopic) {
    const previous = conversationState.mentionedServices?.[stateBefore.pendingServiceKey];
    if (previous?.status === "needs_reason") {
      previous.status = "captured";
      previous.serviceFollowUpAnswered = true;
      previous.detailDeclined = true;
    }
  }

  for (const item of conducted.captured || []) {
    if (!item.serviceKey || item.needsFollowUp === true) continue;
    if (isAppreciationFollowUp(item.serviceKey)) continue;
    const service = conversationState.mentionedServices?.[item.serviceKey];
    if (!service || service.status !== "needs_service_followup") continue;
    const previous = stateBefore.mentionedServices?.[item.serviceKey];
    if (!directToRating && pendingType !== "service_followup"
      && !previous?.serviceFollowUpAnswered && !previous?.serviceFollowUpAsked
      && !Number(previous?.serviceFollowUpAskCount || 0)) continue;
    service.serviceFollowUpAnswered = true;
    service.status = service.rating !== null && service.rating !== undefined
      ? "rated"
      : "captured";
    if (conversationState.pendingServiceKey === item.serviceKey) {
      conversationState.pendingServiceKey = null;
    }
  }

  const hasActionableObservation = (conducted.observations || []).some((item) =>
    item.kind !== "appreciation"
    && item.sentiment !== "positive"
    && item.needsFollowUp !== true);
  if (hasActionableObservation && conversationState.pendingObservation?.stage === "followup") {
    conversationState.pendingObservation = null;
  }
  if (directToRating) {
    for (const service of Object.values(conversationState.mentionedServices || {})) {
      if (isAppreciationFollowUp(service.serviceKey)) continue;
      if (service.status !== "needs_service_followup") continue;
      service.serviceFollowUpAnswered = true;
      service.status = service.rating != null ? "rated" : "captured";
    }
    if (conversationState.pendingObservation?.stage === "followup") conversationState.pendingObservation = null;
  }
  updateRatingFeedbackPause(conversationState, stateBefore, conducted, text, interpretation, project);
  return conversationState;
}

// A correction window accepts new facts; it is not a fresh service interview.
// Only a genuinely unclear point in THIS reply can require clarification.
function settleClosingWindowFacts(state, before, facts = {}) {
  const deadline = before.closingGraceExpiresAt;
  if (!deadline || !Number.isFinite(Date.parse(deadline))) return;
  state.closingGraceExpiresAt = deadline;
  state.reopenedDuringClosingGrace = true;
  state.ratingFeedbackPause = null;
  state.anythingElseAnswered = true;
  state.pendingGeneralIssue = false;
  state.pendingObservation = null;
  const unclear = (facts.captured || []).find((item) => item.needsFollowUp === true);
  for (const service of Object.values(state.mentionedServices || {})) {
    if (service.serviceKey === unclear?.serviceKey && !service.detailDeclined
      && Number(service.issueReasonAskCount || 0) < 1) {
      service.status = "needs_reason";
      continue;
    }
    if (["mentioned", "needs_feedback", "needs_reason", "needs_rating", "needs_service_followup"].includes(service.status)) {
      service.status = service.reasonText || service.sentiment !== "neutral" ? "captured" : "declined";
      service.serviceFollowUpAnswered = true;
    }
  }
  state.pendingServiceKey = unclear?.serviceKey || null;
  const observation = (facts.observations || []).find((item) => item.needsFollowUp === true && item.kind !== "appreciation");
  if (observation && !Number(state.observationReasonAskCounts?.[String(observation.topic).toLowerCase()] || 0)) {
    state.pendingObservation = { topic: observation.topic, stage: "reason", responseKind: observation.kind === "request" ? "request" : "feedback" };
  }
  if (!(facts.appreciations || []).length) state.awaitingAppreciationPersonName = null;
}

// Give an overall review room to finish before the first numeric question,
// and welcome additional feedback when a rating is already pending. This is
// only progression metadata: it never supplies facts or scores.
function pendingRatingChoiceFor(before, text, interpretation = null) {
  const pause = before.ratingFeedbackPause;
  if (!pause || pendingQuestionTypeFor(before) !== "rating_feedback") return "none";
  const normalize = (value) => String(value || "").toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  const source = normalize(text);
  // Exact option labels are unambiguous ONLY while this choice is pending.
  // No substring matching: a report, concern or request mentioning a rating
  // must still go through semantic interpretation and ordinary fact capture.
  const label = source.replace(/[.!?]+$/, "").trim();
  const labels = pause.ratingType === "nps"
    ? ["rating", "score", "nps", "nps rating", "recommendation rating", "recommendation score"]
    : ["rating", "score", "overall rating", "overall score", "csat", "csat rating"];
  if (labels.includes(label)) return "proceed";
  if (detectors.completionScopeFor(text, interpretation) === "rating") return "none";
  const evidence = normalize(interpretation?.ratingChoiceEvidence);
  return evidence && source.includes(evidence)
    && ["proceed", "continue_feedback"].includes(interpretation?.ratingChoice)
    ? interpretation.ratingChoice : "none";
}

function updateRatingFeedbackPause(state, before, facts = {}, text = "", interpretation = null, project = null) {
  if (state.sessionType === "quick_checkin" || state.closingGraceExpiresAt
    || [STATES.CLOSING_GRACE, STATES.COMPLETED, STATES.HANDED_OFF, STATES.OPTED_OUT].includes(before.state)) {
    state.ratingFeedbackPause = null;
    return;
  }
  const pending = pendingQuestionTypeFor(before);
  const previousPause = before.ratingFeedbackPause;
  const suppliedFacts = (facts.captured || []).length || (facts.observations || []).length || (facts.appreciations || []).length;
  const feedbackContinuation = suppliedFacts || ["feedback", "more_detail"].includes(interpretation?.intent);
  const firstOverallReview = !before.overallRatingAsked && !before.askedForOverallRating && feedbackContinuation
    && (state.projectEndReviewCaptured
      || ((state.generalFeedbackText || state.generalConcernText) && state.serviceScopeStatus !== "service_by_service")
      || (project && buildChecklist(state, project).overallRatingStillNeeded));
  const ratingType = previousPause?.ratingType
    || (["overall_rating", "nps"].includes(pending) ? pending : null)
    || (firstOverallReview ? "overall_rating" : null);
  if (!ratingType) return;
  const score = ratingType === "nps" ? state.npsScore : state.overallRating;
  if (score != null || state.clientRequestedClose || (ratingType === "nps" ? state.npsDeclined : state.overallRatingDeclined)) {
    if (score != null && project && state.sessionType !== "project_end" && previousPause?.overallReview) {
      const asked = before.askedForAnythingElse, answered = before.anythingElseAnswered;
      finishFeedbackQuestions(state, project);
      state.askedForAnythingElse = Boolean(asked);
      state.anythingElseAnswered = Boolean(answered);
    }
    state.ratingFeedbackPause = null;
    return;
  }
  const ratingChoice = pendingRatingChoiceFor(before, text, interpretation);
  if (ratingChoice === "proceed") {
    state.ratingFeedbackPause = null;
    if (project && previousPause?.overallReview && state.sessionType !== "project_end") finishFeedbackQuestions(state, project);
    return;
  }
  if (ratingChoice === "continue_feedback") {
    state.ratingFeedbackPause = { ...previousPause, choiceAsked: true };
    return;
  }
  const completion = detectors.completionScopeFor(text, interpretation);
  if (completion === "rating") {
    if (ratingType === "nps") state.npsDeclined = true;
    else state.overallRatingDeclined = true;
    state.ratingFeedbackPause = null;
    return;
  }
  const answeringRatingChoice = pending !== "rating_feedback" || messageMatchesRequiredAction(
    { type: "rating_feedback", ratingType, offerChoice: true }, before.lastQuestionAsked
  );
  const affirmativeCompletion = answeringRatingChoice
    && (interpretation?.intent === "affirmative" || detectors.isAffirmative(text));
  const verifiedSkip = interpretation?.controlVerification === "verified"
    && interpretation.serviceScope === SERVICE_SCOPE_DECISIONS.SKIP_REMAINING_SERVICES;
  const finished = verifiedSkip || ["feedback", "conversation"].includes(completion)
    || (!suppliedFacts && (!feedbackContinuation || factFreeControlReply(text, interpretation)) && (completion === "topic" || interpretation?.intent === "negative"
      || affirmativeCompletion || isMoveOnReply(text)
      || soundsLikeFarewell(text) || detectors.isNegativeSkip(text)));
  if (finished) {
    state.ratingFeedbackPause = null;
    if (project && (verifiedSkip || (previousPause?.overallReview && state.sessionType !== "project_end"))) finishFeedbackQuestions(state, project);
  } else if (feedbackContinuation) {
    state.ratingFeedbackPause = previousPause ? { ...previousPause } : { ratingType, choiceAsked: false, overallReview: Boolean(firstOverallReview) };
    // A failed control check must not fall into an acknowledgement-only dead
    // end. If no new facts were supplied, clarify the pending choice instead.
    if (interpretation?.controlVerification === "unverified" && !suppliedFacts) state.ratingFeedbackPause.choiceAsked = false;
    if (ratingType === "overall_rating" && !before.overallRatingAsked) state.overallRatingAsked = false;
  }
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

function baseFallbackForAction(action, conversationState, project, context = {}) {
  if (action.type === "project_end_review") return projectEndReviewQuestion(project);
  if (action.type === "service_scope") return SERVICE_SCOPE_QUESTION;
  if (action.type === "issue_reason") {
    return `I am sorry to hear that ${action.name} needs improvement. Our team will look into it. Could you share what specifically should improve?`;
  }
  if (action.type === "service_followup") {
    if (conversationState.awaitingAppreciationPersonName?.serviceKey === action.serviceKey) {
      return `Could you please share the ${conversationState.awaitingAppreciationPersonName.role}'s name so we can pass this appreciation to the right person? You can also add anything else; if you prefer not to name them, just reply no.`;
    }
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
    if (conversationState.pendingObservation?.acknowledged) {
      return "Before we move on, is there anything else you would like the Directors to know? If not, just reply no.";
    }
    if (conversationState.pendingObservation?.responseKind === "request") {
      const positiveLead = conversationState.pendingObservation?.positiveContext === "Social Media"
        ? "Glad to hear that social media is working well. "
        : "";
      return `${positiveLead}Thank you for raising this. We have recorded your request and will share it with the relevant team for action. Is there anything else you would like the Directors to know?`;
    }
    if (action.topic === "Billing") {
      return "I am sorry to hear about the billing concern. We have recorded it for review by the relevant team. Is there anything else you would like the Directors to know?";
    }
    return "Your feedback is recorded for review. Is there anything else you would like the Directors to know?";
  }
  if (action.type === "appreciation") {
    // Retained only for an older session that was already waiting on this
    // question. New sessions use one inclusive final management question.
    return "Is there any appreciation you would like us to record? If not, just reply no.";
  }
  if (action.type === "final_sweep") {
    return "Before we finish, is there anything else you would like the Directors to know—such as an issue, an area for improvement, or any appreciation you would like us to record? If not, just reply no.";
  }
  if (action.type === "rating_feedback") {
    if (!action.offerChoice) return "";
    return action.ratingType === "nps"
      ? "Would you like to add anything else, or shall we move to the recommendation rating?"
      : "Would you like to add anything else, or shall we move to the overall rating?";
  }
  if (action.type === "overall_rating") return overallRatingQuestion(conversationState, project);
  if (action.type === "nps") {
    return "Lastly, how likely are you to recommend SRV Media to someone in your network, out of 10?";
  }
  return "Thank you. Your feedback and overall rating are recorded. This chat will remain open for 10 minutes in case you want to correct or add anything.";
}

function latestConcernFacts(context = {}) {
  return [
    ...(context.captured || []).filter((item) => item.sentiment === "negative")
      .map((item) => ({ key: `service:${item.serviceKey}`, serviceKey: item.serviceKey, topic: (context.concerns || []).find((concern) => concern.serviceKey === item.serviceKey)?.title, detail: item.summary })),
    ...(context.observations || []).filter((item) => item.sentiment === "negative" && !["appreciation", "request"].includes(item.kind))
      .map((item) => ({ key: `observation:${item.topic}`, topic: item.topic, detail: item.detail })),
    ...(context.concerns || []).filter((item) => item.sentiment === "negative")
      .map((item) => ({ key: item.serviceKey ? `service:${item.serviceKey}` : `observation:${item.title}`, topic: item.title, serviceKey: item.serviceKey, detail: item.summary }))
  ].filter((item) => String(item.detail || "").trim());
}

function rememberAcknowledgedConcerns(conversationState, facts = {}) {
  const keys = latestConcernFacts(facts).map((item) => item.key);
  if (keys.length) conversationState.acknowledgedConcernTopics = [...new Set([
    ...(conversationState.acknowledgedConcernTopics || []), ...keys
  ])].slice(-40);
}

function concernAcknowledgement(context, conversationState, project = {}) {
  const facts = latestConcernFacts(context);
  if (!facts.length) return "";
  const acknowledged = conversationState.acknowledgedConcernTopics || [];
  const alreadyAcknowledged = facts.every((item) => acknowledged.includes(item.key));
  const topics = [...new Set(facts.map((item) => item.topic
    || (project.services || []).find((service) => service.serviceKey === item.serviceKey)?.name)
    .filter((topic) => topic && !internalSummaryLanguage(topic) && !/^(?:management|general|client) feedback$/i.test(topic)))].slice(0, 3);
  const subject = topics.length ? topics.join("; ") : "the issue you described";
  return alreadyAcknowledged
    ? `I have noted the additional detail about ${subject} for review.`
    : `I am sorry to hear about ${subject}. I have recorded your concerns for review.`;
}

function requestAcknowledgement(context = {}) {
  const requests = (context.observations || []).filter((item) => item.kind === "request" && item.detail);
  if (!requests.length) return "";
  const positiveLead = requests.some((item) => item.positiveContext === "Social Media")
    ? "Glad to hear that social media is working well. " : "";
  const topics = [...new Set(requests.map((item) => String(item.topic || "").trim())
    .filter((topic) => topic && !internalSummaryLanguage(topic)))].slice(0, 3);
  return `${positiveLead}I have recorded your request${topics.length ? ` regarding ${topics.join("; ")}` : ""} for review by the relevant team.`;
}

function internalSummaryLanguage(message) {
  return /\b(?:the client|the customer|client (?:says|states|reports|emphasizes|emphasises|expects))\b|\bi have (?:recorded|noted)(?: your (?:additional )?(?:feedback|request))?\s*:/i.test(String(message || ""));
}

function clientFacingAcknowledgement(context, project, action) {
  const hasRecordedFacts = Boolean((context.captured || []).length || (context.observations || []).length || (context.appreciations || []).length || (context.concerns || []).length);
  // The interpretation saw only this reply, while the writer also saw older
  // transcript context. Prefer its current-point wording when both are safe.
  for (const candidate of [context.extractedAcknowledgement, context.acknowledgement]) {
    const message = String(candidate || "").trim();
    if (!message || message.length > 600 || /[?？]/.test(message) || internalSummaryLanguage(message) || containsClaim(message, { allowFeedbackRecording: hasRecordedFacts })) continue;
    if (/\b(?:out of 10|on a scale|(?:have|has|already)\s+(?:notified|alerted|emailed)|(?:directors|management|team)\s+(?:have|has)\s+been\s+(?:notified|alerted|informed))\b/i.test(message)) continue;
    if (/\b(?:i|we|our team|the team)\s+(?:(?:have|has|already)\s+)*(?:fixed|resolved|implemented|completed)\b/i.test(message)) continue;
    if (!latestConcernFacts(context).length && /\b(?:sorry|apolog\w*|disappoint\w*|regret)\b/i.test(message)) continue;
    if (!responseIntroducesUnsupportedTopic(message, context.latestClientText, project, context, action)) return message;
  }
  return "";
}

function fallbackForAction(action, conversationState, project, context = {}) {
  const acknowledgement = appreciationAcknowledgement(context, project, conversationState);
  const naturalAcknowledgement = clientFacingAcknowledgement(context, project, action);
  if (naturalAcknowledgement && !["issue_reason", "service_followup", "observation_reason"].includes(action.type)) {
    const praise = acknowledgement && !responseAcknowledgesAppreciation(naturalAcknowledgement) ? acknowledgement : "";
    return [naturalAcknowledgement, praise, baseFallbackForAction(action, conversationState, project, context)].filter(Boolean).join(" ");
  }
  const processConcern = (context.observations || []).find((item) =>
    item.fallbackKind === "delivery_process"
    && item.sentiment === "negative"
  );
  if (processConcern && ["observation_reason", "observation_followup"].includes(action.type)) {
    const processName = processConcern.topic === "Creative Process"
      ? "the creative process"
      : "the delivery process";
    const appreciation = acknowledgement ? ` ${acknowledgement}` : "";
    const question = processConcern.needsFollowUp
      ? ` Could you please share a little more about what happened with ${processConcern.topic}?`
      : " Is there anything else you would like the Directors to know?";
    return `I am sorry that ${processName} involved avoidable back-and-forth and that agreed feedback was not implemented consistently. We have recorded this concern and will ask the relevant teams to strengthen internal alignment and communication so delivery is smoother.${appreciation}${question}`;
  }
  const generalConcern = (context.observations || []).find((item) =>
    item.fallbackKind === "general_concern"
    && item.sentiment === "negative"
  );
  if (generalConcern && ["observation_reason", "observation_followup"].includes(action.type)) {
    const appreciation = acknowledgement ? ` ${acknowledgement}` : "";
    const question = generalConcern.needsFollowUp
      ? ` Could you please share a little more about what happened with ${generalConcern.topic}?`
      : " Is there anything else you would like the Directors to know?";
    return `I am sorry that this part of your experience did not meet expectations. We have recorded the concerns you shared and will ask the relevant teams to review them carefully and take the necessary action.${appreciation}${question}`;
  }
  const next = acknowledgement
    && action.type === "service_followup"
    && !conversationState.awaitingAppreciationPersonName
    ? `Is there anything else you would like to add about ${action.name}? If that is all, just reply no.`
    : baseFallbackForAction(action, conversationState, project, context);
  const concern = !["issue_reason", "service_followup", "observation_reason"].includes(action.type)
    ? concernAcknowledgement(context, conversationState, project) : "";
  const request = requestAcknowledgement(context);
  const recorded = action.type === "rating_feedback" && !concern && !request && !acknowledgement
    ? "I have noted your additional feedback for review." : "";
  return [concern, request, acknowledgement, recorded, next].filter(Boolean).join(" ")
    || "Thank you. I have added that to your recorded feedback.";
}

function closingGraceMessage(poc, conversationState = {}, context = {}, project = {}) {
  const salutation = (poc && (poc.salutation || poc.name)) || "there";
  const rating = conversationState.overallRating;
  const ratingText = rating === null || rating === undefined
    ? "feedback"
    : `rating of ${rating} out of 10`;
  const hasNewFacts = [context.captured, context.observations, context.concerns, context.appreciations]
    .some((items) => items?.length);
  if (conversationState.reopenedDuringClosingGrace) {
    if (!hasNewFacts) {
      return "Thank you for confirming. Your feedback is recorded, and the original 10-minute window will close automatically.";
    }
    const appreciation = (context.appreciations || [])[0];
    const subject = String(appreciation?.subject || "").trim();
    const natural = clientFacingAcknowledgement(context, project, { type: "close" });
    const acknowledgement = appreciation
      ? /^client appreciation$/i.test(subject)
        ? "Thank you for sharing that appreciation."
        : `Thank you for appreciating ${/\b(?:team|department)$/i.test(subject) ? `the ${subject}` : subject}.`
      : "Thank you.";
    const recorded = appreciation && !natural
      ? "We will share your kind words with the relevant team, and I have added your appreciation to your recorded feedback."
      : "I have added that to your recorded feedback.";
    const addedConcern = concernAcknowledgement(context, conversationState, project);
    const addedRequest = requestAcknowledgement(context);
    const praise = natural && appreciation && !responseAcknowledgesAppreciation(natural) ? acknowledgement : "";
    return `${[natural || [addedConcern, addedRequest, acknowledgement].filter(Boolean).join(" "), praise].filter(Boolean).join(" ")} ${recorded} ${ratingText[0].toUpperCase()}${ratingText.slice(1)} remains recorded, and the original 10-minute window is still open if you want to add or correct anything else.`;
  }
  const closingLine = conversationState.sessionType === "project_end"
    ? "Thank you again for your honesty, time and trust. We appreciate the opportunity to have worked with you and wish you every success ahead."
    : "Thank you again for your honesty, time and trust. Please take care, and we look forward to connecting with you again next month.";
  const recorded = rating == null ? "Your feedback has" : `Your feedback and ${ratingText} have`;
  const natural = hasNewFacts ? clientFacingAcknowledgement(context, project, { type: "close" }) : "";
  const appreciation = appreciationAcknowledgement(context, project, conversationState);
  const acknowledgement = natural
    ? [natural, appreciation && !responseAcknowledgesAppreciation(natural) ? appreciation : ""].filter(Boolean).join(" ")
    : [concernAcknowledgement(context, conversationState, project), requestAcknowledgement(context), appreciation].filter(Boolean).join(" ");
  return `${acknowledgement ? `${acknowledgement}\n\n` : ""}Thank you, ${salutation}. ${recorded} been successfully recorded for confidential review by the Directors.\n\nThis feedback session will remain active for the next 10 minutes. During this time, you can add anything else you would like the Directors to know, revise your rating, share further feedback or appreciation, ask a question, or request a callback.\n\nAfter 10 minutes, this automated feedback session will close. You can, of course, contact SRV Media at any time if you need us.\n\n${closingLine}`;
}

function numericScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 10 ? score : null;
}

function hasMandatoryFinalSweepScores(session) {
  const state = session?.conversationState || {};
  const overallRating = numericScore(state.overallRating)
    ?? (session?.csatSource === "stated" ? numericScore(session.csatScore) : null);
  if (overallRating === null) return false;
  if (session?.sessionType !== "project_end") return true;
  const npsScore = numericScore(state.npsScore)
    ?? (session?.npsSource === "stated" ? numericScore(session.npsScore) : null);
  return npsScore !== null;
}

function finalSweepPromptMessage(session, messages = []) {
  const state = session?.conversationState || {};
  const lastQuestion = String(state.lastQuestionAsked || "").trim();
  return [...messages].reverse().find((message) => {
    if (message.side !== "srv") return false;
    const text = String(message.body || "").trim();
    if (!text) return false;
    if (lastQuestion && text === lastQuestion) return true;
    return (/\bbefore we finish\b[\s\S]{0,260}\bDirectors\b/i.test(text)
      && /\banything else\b/i.test(text))
      || /\b(?:team|department|person|appreciation)\b[\s\S]{0,180}\bappreciat\w*\b/i.test(text);
  }) || null;
}

/**
 * Decide whether the six-hour fallback may close this session. The database
 * claim prevents two schedulers from sending; this pure check also protects
 * against a client reply or normal completion arriving between scans.
 */
function inactiveFinalSweepEligibility(session, messages = [], nowValue = new Date()) {
  messages = conversationRelevantMessages(messages);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (Number.isNaN(now.getTime())) return { eligible: false, reason: "invalid_now" };
  if (!session || session.sessionType === "quick_checkin") {
    return { eligible: false, reason: "unsupported_session" };
  }

  const state = session.conversationState || {};
  if (
    state.sixHourAutoCompletionClaimedAt
    || state.sixHourAutoCompletionSentAt
    || state.sixHourAutoCompletionSkippedAt
    || state.closingGraceExpiresAt
    || [STATES.CLOSING_GRACE, STATES.COMPLETED, STATES.OPTED_OUT, STATES.HANDED_OFF].includes(state.state)
  ) {
    return { eligible: false, reason: "already_completed_or_claimed" };
  }
  const pendingOptionalQuestion = state.pendingQuestionType;
  const finalSweepPending = pendingOptionalQuestion === "final_sweep"
    && state.askedForAnythingElse === true
    && state.anythingElseAnswered !== true;
  const legacyAppreciationPending = pendingOptionalQuestion === "appreciation"
    && state.askedForAppreciation === true
    && state.appreciationAnswered !== true;
  if (!finalSweepPending && !legacyAppreciationPending) {
    return { eligible: false, reason: "final_sweep_not_pending" };
  }
  if (state.pendingGeneralIssue || state.pendingObservation || state.pendingServiceKey) {
    return { eligible: false, reason: "required_followup_pending" };
  }
  if (!hasMandatoryFinalSweepScores(session)) {
    return { eligible: false, reason: "mandatory_score_missing" };
  }

  const finalPrompt = finalSweepPromptMessage(session, messages);
  const finalPromptAt = Date.parse(finalPrompt?.createdAt || "");
  if (!Number.isFinite(finalPromptAt)) {
    return { eligible: false, reason: "final_sweep_prompt_not_found" };
  }

  const latestClientMessage = [...messages].reverse().find((message) => message.side === "client");
  const latestClientAt = Date.parse(latestClientMessage?.createdAt || session.lastClientResponseAt || "");
  if (!Number.isFinite(latestClientAt)) {
    return { eligible: false, reason: "client_message_not_found" };
  }
  // A newer reply must always be processed by the normal conversation flow.
  if (latestClientAt > finalPromptAt) {
    return { eligible: false, reason: "client_replied_after_final_sweep" };
  }

  const dueAt = finalPromptAt + INACTIVE_FINAL_SWEEP_MS;
  if (now.getTime() < dueAt) {
    return {
      eligible: false,
      reason: "not_due",
      dueAt: new Date(dueAt).toISOString(),
      finalPromptAt: new Date(finalPromptAt).toISOString(),
      latestClientAt: new Date(latestClientAt).toISOString()
    };
  }

  const serviceWindowClosesAt = latestClientAt + WHATSAPP_CUSTOMER_SERVICE_WINDOW_MS;
  if (now.getTime() >= serviceWindowClosesAt) {
    return {
      eligible: false,
      closeWithoutMessage: true,
      reason: "outside_whatsapp_service_window",
      dueAt: new Date(dueAt).toISOString(),
      finalPromptAt: new Date(finalPromptAt).toISOString(),
      latestClientAt: new Date(latestClientAt).toISOString(),
      serviceWindowClosesAt: new Date(serviceWindowClosesAt).toISOString()
    };
  }

  return {
    eligible: true,
    reason: "due",
    dueAt: new Date(dueAt).toISOString(),
    finalPromptAt: new Date(finalPromptAt).toISOString(),
    latestClientAt: new Date(latestClientAt).toISOString(),
    serviceWindowClosesAt: new Date(serviceWindowClosesAt).toISOString()
  };
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
  if (action.type === "observation_reason") {
    const topic = String(action.topic || "").toLowerCase();
    conversationState.observationReasonAskCounts = {
      ...(conversationState.observationReasonAskCounts || {}),
      [topic]: Number(conversationState.observationReasonAskCounts?.[topic] || 0) + 1
    };
  }
  if (action.type === "rating_feedback" && conversationState.ratingFeedbackPause && action.offerChoice) {
    conversationState.ratingFeedbackPause.choiceAsked = true;
  }
  conversationState.pendingQuestionType = action.type === "close" ? null : action.type;
  return markers;
}

function setStateForRequiredAction(conversationState, action, recordedQuestion) {
  if (action.type === "rating_feedback") {
    conversationState.state = action.ratingType === "nps" ? STATES.WAITING_FOR_NPS : STATES.WAITING_FOR_OVERALL_RATING;
    conversationState.pendingServiceKey = null;
  } else if (recordedQuestion.askedForProjectEndReview) {
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
  if (conversationState.state === STATES.WAITING_FOR_NPS) return "nps";
  if (conversationState.state === STATES.WAITING_FOR_SERVICE_FOLLOWUP) return "service_followup";
  if (conversationState.askedForAppreciation && !conversationState.appreciationAnswered) return "appreciation";
  if (conversationState.askedForAnythingElse && !conversationState.anythingElseAnswered) return "final_sweep";
  return null;
}

function applyTurnServiceScope(conversationState, project, text, interpretation, conducted = {}, stateBefore = {}) {
  // A response to the offered rating choice is survey control, not a new
  // whole-project review, even if extraction incorrectly labels its scope.
  const ratingChoice = stateBefore.pendingQuestionType === "rating_feedback"
    || Boolean(stateBefore.ratingFeedbackPause);
  const controlOnly = /^\s*(?:\d{1,2}(?:\.\d+)?(?:\s*\/\s*10)?|rating|score|overall rating|overall score|csat(?: rating)?|nps(?: rating)?)\s*[.!?]*\s*$/i.test(String(text || ""));
  if (controlOnly && (ratingChoice || ["overall_rating", "nps"].includes(pendingQuestionTypeFor(stateBefore)))) {
    return conversationState;
  }
  const valid = new Set(Object.values(SERVICE_SCOPE_DECISIONS));
  // Service scope is a fact about what the client chose. Only the dedicated
  // latest-reply interpretation may supply it; the response-writing model is
  // not an evidence source and must never change survey state.
  let decision = [interpretation?.serviceScope]
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

function acceptedOverallRating(conversationState, conducted, text = "") {
  // The client may interrupt the rating question with a new management point,
  // then give the score while we are closing that point. Once the overall
  // question has genuinely been asked, retain an explicit rating from the
  // latest client reply instead of asking for the same number again.
  const answeringNps = conversationState.state === STATES.WAITING_FOR_NPS
    || conversationState.ratingFeedbackPause?.ratingType === "nps"
    || pendingQuestionTypeFor(conversationState) === "nps";
  const invitedOverallRating = conversationState.pendingQuestionType === "rating_feedback"
    && conversationState.ratingFeedbackPause?.ratingType === "overall_rating";
  if ((!conversationState.overallRatingAsked && !invitedOverallRating) || answeringNps) return null;

  // The conductor sees the transcript and can occasionally repeat an older
  // number while handling a later non-rating reply. Only the latest client's
  // own words may update CSAT. This also keeps a project-end NPS answer wholly
  // separate from the earlier overall score.
  const source = String(text || "").trim();
  const read = detectors.detectRatingCorrection(source);
  const normalized = read && read.scale === 5 ? read.value * 2 : read?.value;
  const answeringOverall = conversationState.state === STATES.WAITING_FOR_OVERALL_RATING
    || pendingQuestionTypeFor(conversationState) === "overall_rating";
  const startsWithRating = /^\s*(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(source)
    && !/^\s*(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:day|days|week|weeks|month|months|meeting|meetings|lead|leads|report|reports)\b/i.test(source);
  const latestReplyIsRating = detectors.looksLikeRatingAnswer(source)
    || (answeringOverall && startsWithRating
      && numericScore(conducted?.overallRating) === normalized)
    || detectors.isRatingCorrectionReply(source);
  if (!read || !latestReplyIsRating) return null;
  if (normalized < 0 || normalized > 10 || (read.scale && ![5, 10].includes(read.scale))) return null;
  return normalized;
}

function latestExplicitOverallRating(messages, overallRatingAsked) {
  if (!overallRatingAsked) return null;
  const ratingQuestionIndex = messages.findIndex((message) => {
    if (message.side !== "srv") return false;
    const body = String(message.body || "");
    const state = message.metadata?.stateAfter || message.metadata?.state;
    return state === STATES.WAITING_FOR_OVERALL_RATING
      || /\boverall\b.{0,100}\b(?:out of 10|0 to 10)\b/i.test(body);
  });
  const candidates = ratingQuestionIndex >= 0 ? messages.slice(ratingQuestionIndex + 1) : messages.slice(-12);
  let latest = null;
  // Missing/partial history is not evidence that a bare number answered CSAT.
  // The state machine already knows the current question; reconciliation may
  // override it only from a real question in history or an explicit correction.
  let ratingContext = ratingQuestionIndex >= 0 ? "overall" : "unknown";
  for (const message of candidates) {
    const body = String(message.body || "").trim();
    if (message.side === "srv") {
      // Confirmations such as "updated your overall rating to 10" describe a
      // stored value; they do not ask the client which score their next reply
      // belongs to. Only an actual question (or an explicit waiting-state
      // marker on legacy messages) may change the context for a bare number.
      const state = message.metadata?.stateAfter || message.metadata?.state;
      const asksScoreQuestion = /\?\s*$/.test(body)
        || [STATES.WAITING_FOR_OVERALL_RATING, STATES.WAITING_FOR_NPS].includes(state);
      if (!asksScoreQuestion) continue;
      const asksNps = /\b(?:recommend|recommendation|nps|likely)\w*\b/i.test(body)
        && /(?:\b0\s*(?:to|-)\s*10\b|\bout of 10\b)/i.test(body);
      const asksOverall = /\boverall\b/i.test(body)
        && (/\b(?:rating|rate|score)\b/i.test(body)
          || /(?:\b0\s*(?:to|-)\s*10\b|\bout of 10\b)/i.test(body));
      if (asksNps) {
        ratingContext = "nps";
      } else if (asksOverall) {
        ratingContext = "overall";
      }
      continue;
    }
    if (message.side !== "client") continue;
    // Recommendation/NPS corrections form a separate score stream. Check
    // this before the generic word "rating": "change recommend rating to 9"
    // contains both, but must never be allowed to rewrite CSAT.
    const recommendationDirected = detectors.isRecommendationRatingReply(body)
      || /\b(?:recommend|recommendation|nps|likelihood)\w*\b/i.test(body);
    if (recommendationDirected) continue;

    const explicitlyOverall = /\boverall\b.{0,45}\b(?:rating|rate|score|csat|\d|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:rating|score|csat)\b.{0,45}\boverall\b/i.test(body);
    const read = detectors.detectRatingCorrection(body);
    if (!read) continue;
    if (/\b(?:day|days|week|weeks|month|months|campaign|campaigns|lead|leads|report|reports)\b/i.test(body)
      && !read.scale
      && !/\b(?:rating|raiting|score|csat|rate)\b/i.test(body)) continue;
    const direct = /^\s*(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*(?:\/|out of)\s*(?:5|10))?\s*[.!]*\s*$/i.test(body);
    const explicitCorrection = detectors.isRatingCorrectionReply(body);
    const explicitlyCsatCorrection = /\b(?:overall|csat|rating|raiting)\b/i.test(body);
    const explicit = explicitCorrection
      || /\b(?:out of|overall rating|rating|raiting|csat)\b/i.test(body);
    if (!direct && !explicit) continue;
    // A clearly worded CSAT/rating correction is authoritative even after the
    // NPS question. A bare number or a generic "take 5" inherits the NPS
    // question instead; neither may be pulled backward into overall CSAT.
    if (ratingContext !== "overall" && !explicitlyOverall && !explicitlyCsatCorrection) continue;
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
    || interpretation?.intent === "negative"
    || detectors.completionScopeFor(text, interpretation) !== "none";
  const capturedServiceKeys = (conducted.captured || [])
    .map((item) => item.serviceKey)
    .filter(Boolean);
  const movedToAnotherService = pendingType === "service_followup"
    && pendingServiceKey
    && capturedServiceKeys.some((key) => key !== pendingServiceKey)
    && !capturedServiceKeys.includes(pendingServiceKey);
  const volunteeredAppreciation = (conducted.appreciations || []).length > 0;
  return {
    answeredAppreciation: volunteeredAppreciation || (pendingType === "appreciation"
      ? explicitlyFinished
      : pendingType === "general_issue_detail"
        && stateBefore.resumeQuestionType === "appreciation"
        && explicitlyFinished),
    appreciationVolunteered: volunteeredAppreciation,
    // Substantive feedback answers the words of the final question, but after
    // acknowledging it we deliberately offer one inclusive "anything else?"
    // opportunity. Only an explicit done/no response closes that opportunity.
    // Otherwise every concern captured here can both answer and instantly
    // close the session, or reopen as several service-specific follow-ups.
    answeredAnythingElse: pendingType === "final_sweep" && explicitlyFinished,
    completedServiceFollowUpKeys: pendingType === "service_followup"
      && pendingServiceKey
      && (explicitlyFinished || movedToAnotherService
        || (conducted.captured || []).length > 0 || (conducted.observations || []).length > 0)
      ? [pendingServiceKey]
      : []
  };
}

function applyConversationInterruption(conversationState, stateBefore, interpretation, conducted, text) {
  const pendingType = pendingQuestionTypeFor(stateBefore);
  const explicitlyFinished = isMoveOnReply(text)
    || soundsLikeFarewell(text)
    || interpretation?.intent === "negative"
    || detectors.completionScopeFor(text, interpretation) !== "none";

  if (["observation_reason", "observation_followup"].includes(pendingType) && explicitlyFinished) {
    conversationState.pendingObservation = null;
  }

  if (pendingType === "general_issue_detail" && explicitlyFinished) {
    conversationState.pendingGeneralIssue = false;
  }

  const suppliedFeedback = (conducted.captured || []).length || (conducted.observations || []).length;
  if (pendingType === "general_issue_detail" && suppliedFeedback) {
    conversationState.pendingGeneralIssue = false;
  }
  if (["observation_reason", "observation_followup"].includes(pendingType) && suppliedFeedback) {
    // They answered "anything else?" by raising a new point. Follow their
    // lead instead of forcing an explicit no on the previous topic.
    conversationState.pendingObservation = null;
  }

  const actionableObservations = (conducted.observations || [])
    .filter((item) => item.kind !== "appreciation" && item.sentiment !== "positive");
  if (actionableObservations.length) {
    const latest = actionableObservations[actionableObservations.length - 1];
    conversationState.pendingGeneralIssue = false;
    const topicKey = String(latest.topic || "").toLowerCase();
    const reasonAlreadyAsked = Number(conversationState.observationReasonAskCounts?.[topicKey] || 0) >= 1;
    conversationState.pendingObservation = latest.needsFollowUp && !reasonAlreadyAsked ? {
      topic: latest.topic,
      stage: latest.needsFollowUp ? "reason" : "followup",
      acknowledged: false,
      responseKind: latest.kind === "request" ? "request" : "feedback",
      positiveContext: latest.positiveContext || null
    } : null;
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
  const covered = conversationState.sessionType === "project_end"
    || Number(service.serviceFollowUpAskCount || 0) >= 1 || service.serviceFollowUpAnswered;
  service.serviceFollowUpAnswered = Boolean(covered);
  service.status = covered ? "captured" : "needs_service_followup";
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
    return /\b(?:anything else|directors?|management|issue|area for improvement|appreciation)\b/i.test(text);
  }
  if (action.type === "rating_feedback") {
    if (!action.offerChoice) return !/[?？]/.test(text) && !/\b(?:out of 10|on a scale)\b/i.test(text);
    const invitesFeedback = /\b(?:anything (?:else|more|further)|add (?:anything|more)|share (?:anything|more)|further feedback|more feedback)\b/i.test(text);
    const offersTransition = /\b(?:rating|rate|score)\b/i.test(text)
      && /\b(?:or|before|then|otherwise|move|proceed|ready|continue)\b/i.test(text);
    const wrongScore = action.ratingType === "nps"
      ? /\boverall\s+(?:rating|score)\b/i.test(text)
      : /\b(?:nps|recommendation)\s+(?:rating|score)\b/i.test(text);
    return invitesFeedback && offersTransition && !wrongScore && !/\b(?:out of 10|on a scale)\b/i.test(text);
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
    if (!/\?\s*$/.test(text)) return false;
    return action.type === "observation_reason"
      ? /\b(?:what|which|how|share|explain|detail|tell)\b/i.test(text)
      : /\b(?:anything else|anything more|anything further|more to add|else you would like|add anything)\b/i.test(text);
  }
  if (action.type === "general_issue_detail") return /\b(?:tell me|tell us|what happened|please share|please explain)\b/i.test(text);
  if (action.type === "close") return !/\?\s*$/.test(text);
  return false;
}

function responseIntroducesUnsupportedTopic(message, text, project = {}, conducted = {}, requiredAction = {}) {
  const output = String(message || "");
  const source = String(text || "");
  const approvedTopics = new Set((conducted.observations || [])
    .map((item) => String(item.topic || "").toLowerCase())
    .filter(Boolean));
  const topicChecks = [
    {
      topic: "senior involvement",
      output: /\b(?:senior involvement|senior leadership|lack of senior|avp)\b/i,
      source: /\b(?:senior|leadership|leader|avp)\b/i
    },
    {
      topic: "billing",
      output: /\b(?:billing|invoice|tax invoice|ledger)\b/i,
      source: /\b(?:billing|invoice|tax invoice|ledger)\b/i
    },
    {
      topic: "review meeting",
      output: /\b(?:review meeting|weekly meeting|meeting cadence)\b/i,
      source: /\b(?:review meeting|weekly meeting|meeting cadence|meetings?)\b/i
    },
    {
      topic: "commercial process",
      output: /\b(?:commercial process|contract|payment)\b/i,
      source: /\b(?:commercial|contract|payment)\b/i
    },
    {
      topic: "creative process",
      output: /\b(?:creative process|design process|creatives?|designers?)\b/i,
      source: /\b(?:creative process|design process|creatives?|designers?|design)\b/i
    }
  ];
  if (topicChecks.some((check) => check.output.test(output)
    && !check.source.test(source)
    && !approvedTopics.has(check.topic))) return true;

  const approvedServices = new Set([
    ...(conducted.captured || []).map((item) => item.serviceKey),
    ...(conducted.appreciations || []).map((item) => item.serviceKey),
    ...detectors.detectServices(source, project),
    requiredAction.serviceKey
  ].filter(Boolean));
  return (project.services || []).some((service) => {
    if (approvedServices.has(service.serviceKey)) return false;
    const name = String(service.name || "").trim();
    return name.length >= 3 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(output);
  });
}

function normalizeLegacyServiceFollowups(conversationState) {
  // The rule parser still understands old per-service-rating states so older
  // stored conversations can be resumed safely. The current product does not
  // ask for those ratings: once a service answer is captured, it gives the
  // client one natural opportunity to add anything else about that service.
  let waitingForFollowUp = false;
  for (const service of Object.values(conversationState.mentionedServices || {})) {
    if (service.status !== "needs_rating") continue;
    const covered = service.serviceFollowUpAnswered || Number(service.serviceFollowUpAskCount || 0) >= 1
      || (conversationState.sessionType === "project_end" && conversationState.serviceScopeStatus !== "service_by_service");
    service.status = covered ? "captured" : "needs_service_followup";
    service.serviceFollowUpAnswered = Boolean(covered);
    if (!covered) waitingForFollowUp = true;
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
  // The request and its object must belong to the same prospective clause.
  // "never available for the review / never did what we want" is a complaint,
  // not consent to arrange a meeting. This is an outage fallback, not a veto
  // on semantic requests grounded by the interpretation pass.
  const object = /\b(?:meetings?|calls?|review|discussion|reports?|reporting|(?:spend|budget|cost)\s+updates?|dashboard|ledger|invoice|follow[ -]?up|senior\s+involvement|management\s+involvement)\b/;
  return source.split(/(?<=[.!?;])\s+|\n+|\bbut\b/).some((clause) => {
    const lead = /\b(?:i|we)\s+(?:would\s+(?:like|appreciate)|want|need)\b|\b(?:please|kindly)\s+(?:send|share|provide|give|prepare|circulate|update|schedule|arrange|organise|organize|review|ask|check)\b|\b(?:can|could)\s+(?:we|you|the\s+team|your\s+team)\b|\b(?:should|must)\s+(?!have\b)(?:be|share|send|provide|give|prepare|circulate|update|schedule|arrange|include)\b|\bneed\s+to\s+have\b/.exec(clause);
    if (!lead || /\b(?:what|whatever|that)\s*$/.test(clause.slice(0, lead.index))) return false;
    const requested = clause.slice(lead.index + lead[0].length);
    return object.test(requested) || (object.test(lead[0]) && /\b(?:please|kindly)\b/.test(lead[0]))
      || (object.test(clause.slice(0, lead.index)) && /^(?:should|must|need to)/.test(lead[0]));
  });
}

/**
 * Identify the object of an explicit request from the client's sentence. If a
 * sentence contains several operational nouns, the first requested object is
 * a safer fallback than a global keyword priority. Gemini may still supply a
 * more natural grounded label; this function only prevents a fabricated one.
 */
function explicitRequestTopic(text) {
  const source = String(text || "").toLowerCase();
  if (!isExplicitActionRequest(source)) return null;
  const candidates = [
    ["Billing", /\b(?:bill|billing|invoice|tax invoice|ledger)\b/],
    ["Review Meeting", /\b(?:meeting|meetings|call|calls|review|discussion)\b/],
    ["Spend Reporting", /\b(?:spend|budget|cost)\b[^.!?]{0,30}\b(?:reports?|reporting|updates?|dashboard)\b|\b(?:reports?|reporting|updates?|dashboard)\b[^.!?]{0,30}\b(?:spend|budget|cost)\b/],
    ["Reporting", /\b(?:reports?|reporting|dashboard)\b/],
    ["Senior Involvement", /\b(?:senior involvement|management involvement|leadership involvement)\b/],
    ["Commercial Process", /\b(?:contract|scope|commercial|payment|payments)\b/]
  ].map(([topic, pattern]) => {
    const match = pattern.exec(source);
    return match ? { topic, index: match.index } : null;
  }).filter(Boolean).sort((left, right) => left.index - right.index);
  return candidates[0]?.topic || "Management Feedback";
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
  const deterministicSeniorConcern = /\b(?:senior|leadership|leader|avp|director|management involvement|sarang)\b/.test(lowered)
    && /\b(?:absent|missing|unavailable|not (?:attend|attending|available|responding|picking)|doesn'?t (?:attend|respond|pick)|didn'?t (?:attend|respond|pick)|calls?|meetings?)\b/.test(lowered);
  if (!interpretedObservation && !explicitRequest && !deterministicBilling && !deterministicSeniorConcern) {
    return null;
  }
  let topic = "Management Feedback";
  const requestedTopic = explicitRequestTopic(source);
  if (requestedTopic) topic = requestedTopic;
  else if (/\b(?:bill|billing|invoice|tax invoice|cfo)\b/.test(lowered)) topic = "Billing";
  else if (/\b(?:reports?|reporting|dashboard|spend updates?|spend reports?|budget updates?|budget reports?)\b/.test(lowered)) {
    topic = /\b(?:spend|budget|cost)\b/.test(lowered) ? "Spend Reporting" : "Reporting";
  } else if (/\b(?:senior|leadership|leader|avp|director|management involvement)\b/.test(lowered)) {
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
      ? (interpretation?.sentiment === "negative" ? "negative" : "neutral")
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

/**
 * Preserve an actionable process concern when the language models are
 * unavailable. This is deliberately meaning-based and broad: it recognises
 * repetition, rework, missed changes and internal-alignment failures without
 * depending on one client's exact wording.
 */
function fallbackDeliveryObservation(text) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return null;
  const processFriction = /\b(?:back[- ]and[- ]forth|rework|reiterat\w*|repeat(?:ed|edly)?|multiple rounds?|not (?:consistently )?(?:applied|implemented|incorporated|carried out)|miss(?:ed|ing) changes?|inconsisten\w*|same (?:feedback|change|changes)|common (?:feedback|change|changes)|internal (?:alignment|communication)|coordination gap|communication gap|handoff gap)\b/i.test(source);
  if (!processFriction) return null;
  const creativeProcess = /\b(?:creative process|creatives?|design(?:s|ed|ing)?|designers?|design assets?|visual assets?|design process|artwork|landing pages?)\b/i.test(source);
  return {
    topic: creativeProcess ? "Creative Process" : "Delivery Process",
    detail: source.slice(0, 600),
    sentiment: "negative",
    severity: "watch",
    needsFollowUp: source.split(/\s+/).filter(Boolean).length < 14,
    kind: "feedback",
    fallbackKind: "delivery_process"
  };
}

function fallbackGeneralConcernObservation(
  text,
  interpretation = {},
  { allowLanguageOnly = false, modelAcknowledgedConcern = false } = {}
) {
  interpretation = interpretation || {};
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return null;
  const explicitlyNoConcern = /^(?:no|none|nothing|all good|everything(?: is|'s)? (?:good|fine)|no issues?|nothing to improve|that(?:'s| is) all)(?:[.!\s]*)$/i.test(source);
  if (explicitlyNoConcern) return null;

  const structured = [
    ...(interpretation.concerns || []).filter((item) => item?.sentiment === "negative" && !item.serviceKey),
    ...(interpretation.observations || []).filter((item) => item?.sentiment === "negative")
  ][0] || null;
  const negativeLanguage = /\b(?:concern\w*|issue\w*|problem\w*|disappoint\w*|frustrat\w*|unhappy|poor|weak|difficult\w*|delay\w*|late|slow|lack\w*|lacking|miss(?:ed|ing)|error\w*|wrong|failed?|failure|inconsisten\w*|avoidable|rework|below expectations?|could (?:be|have been) better|need(?:s|ed)? (?:more|better|stronger)|not (?:good|working|performing|implemented|applied|addressed|resolved|consistent|smooth))\b/i.test(source);
  // A model apology cannot turn clearly positive client language into a
  // concern. Structured facts and response wording are hypotheses; the
  // client's latest message remains the evidence.
  if (detectors.detectSentiment(source) === "positive" && !negativeLanguage) return null;
  const semanticConcern = interpretation.sentiment === "negative"
    || Boolean(structured)
    || modelAcknowledgedConcern;
  if (!semanticConcern && !(allowLanguageOnly && negativeLanguage)) return null;

  const topic = String(structured?.title || structured?.topic || "Management Feedback").trim()
    || "Management Feedback";
  const wordCount = source.split(/\s+/).filter(Boolean).length;
  return {
    topic,
    detail: source.slice(0, 600),
    sentiment: "negative",
    severity: structured?.severity || "watch",
    needsFollowUp: interpretation.explainsProblem === true || wordCount >= 14
      ? false
      : structured?.needsFollowUp !== false,
    kind: structured?.kind === "request" ? "request" : "feedback",
    fallbackKind: "general_concern"
  };
}

function responseAcknowledgesAppreciation(message) {
  const source = String(message || "");
  return /\b(?:thank(?:s| you)?(?: for)?|appreciat(?:e|ed|ing|ion)|kind words|special mention|glad to hear)\b/i.test(source)
    && /\b(?:share|pass|convey|team|person|people|them|him|her|support|work|words|mention|feedback)\b/i.test(source);
}

function factFreeControlReply(text, interpretation = null) {
  const source = String(text || "").trim();
  if (!source) return true;
  const ratingOnly = detectors.looksLikeRatingAnswer(source)
    && Boolean(detectors.detectRatingCorrection(source));
  // Gemini's `negative` intent is deliberately defined as declining further
  // detail / being done / asking to move on (not negative service sentiment).
  // Use that semantic read first; isMoveOnReply remains the deterministic
  // timeout fallback for short, common mobile answers.
  const hasGroundedStructuredFact = [
    ...(interpretation?.captured || []),
    ...(interpretation?.observations || []),
    ...(interpretation?.concerns || []),
    ...(interpretation?.appreciations || [])
  ].some((item) => {
    const evidence = String(item?.summary || item?.detail || item?.subject || "").trim();
    if (!evidence) return false;
    const overlap = contentOverlap(source, evidence);
    return overlap.shared >= 2 || overlap.ratio >= 0.5 || phraseAppearsInReply(source, evidence);
  });
  const substantiveMissingFact = /\b(?:no|without|missing|lack(?:ing)?|not receiving|not getting)\b[^.!?]{0,35}\b(?:reports?|updates?|responses?|results?|support|ownership|communication|information|data|meetings?)\b/i.test(source);
  const semanticMoveOn = interpretation?.intent === "negative"
    && !hasGroundedStructuredFact
    && !substantiveMissingFact
    && !isExplicitActionRequest(source);
  return ratingOnly || semanticMoveOn || isMoveOnReply(source);
}

function phraseAppearsInReply(text, phrase) {
  const source = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const needle = String(phrase || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return Boolean(source && needle && (` ${source} `).includes(` ${needle} `));
}

/**
 * Model JSON is a hypothesis, not evidence. A structured fact may influence
 * the session only when the latest client message supports it. This prevents
 * prompt examples or older transcript details from being copied into a new
 * turn while still allowing natural paraphrases and short service answers.
 */
function groundedObservationTopic(text, item = {}) {
  const source = String(text || "").trim();
  if (!source) return "Management Feedback";
  const candidate = String(item.topic || item.title || "").trim();
  const candidateLower = candidate.toLowerCase();
  const evidence = String(item.detail || item.summary || source).toLowerCase();
  const requestedTopic = explicitRequestTopic(evidence);
  if (requestedTopic) return requestedTopic;

  // A label does not have to repeat the client's exact wording. Preserve a
  // model label when its meaning is independently supported by that fact's
  // grounded detail. Crucially, inspect the individual fact detail here—not
  // the whole multi-topic message—so one campaign concern cannot relabel a
  // separate reporting concern.
  const semanticLabelSupported = (
    (/\b(?:campaign|outcome|result|traction|applicant|lead)\w*\b/.test(candidateLower)
      && /\b(?:campaign|outcome|result|traction|attention|applicant|lead)\w*\b/.test(evidence))
    || (/\b(?:report|data|profile|visibility|attribution|insight|information)\w*\b/.test(candidateLower)
      && /\b(?:report|data|profile|visibility|attribution|conversion|source|insight|information)\w*\b/.test(evidence))
    || (/\b(?:ownership|proactive|initiative|course correction)\w*\b/.test(candidateLower)
      && /\b(?:ownership|proactive|initiative|analyse|analyze|change course|course correction)\w*\b/.test(evidence))
    || (/\b(?:commercial|scope|contract|payment)\w*\b/.test(candidateLower)
      && /\b(?:commercial|scope|proposal|contract|payment)\w*\b/.test(evidence))
    || (/\b(?:leadership|director|review)\w*\b/.test(candidateLower)
      && /\b(?:leadership|leader|director|review)\w*\b/.test(evidence))
  );
  if (candidate && semanticLabelSupported) return candidate;

  if (/\b(?:bill|billing|invoice|tax invoice|cfo|ledger)\b/.test(evidence)) return "Billing";
  if (/\b(?:reports?|reporting|dashboard|spend updates?|spend reports?|budget updates?|budget reports?)\b/.test(evidence)) {
    return /\b(?:spend|budget|cost)\b/.test(evidence) ? "Spend Reporting" : "Reporting";
  }
  if (/\b(?:senior|leadership|leader|avp|director|sarang|management involvement)\b/.test(evidence)
    && /\b(?:absent|missing|unavailable|not (?:attend|attending|available|responding|picking)|doesn'?t (?:attend|respond|pick)|didn'?t (?:attend|respond|pick)|meetings?|calls?|would (?:like|appreciate)|request)\b/.test(evidence)) {
    return "Senior Involvement";
  }
  if (/\b(?:meeting|meetings|review call|review calls|weekly review|discussion|discussions)\b/.test(evidence)) {
    return "Review Meeting";
  }
  if (/\b(?:contract|scope|commercial|payment|payments)\b/.test(evidence)) return "Commercial Process";
  if (/\b(?:creative process|creatives?|design(?:s|ed|ing)?|designers?|artwork|landing pages?)\b/.test(evidence)) {
    return "Creative Process";
  }
  if (/\b(?:back[- ]and[- ]forth|rework|reiterat\w*|repeat(?:ed|edly)?|not (?:consistently )?(?:applied|implemented|incorporated)|internal (?:alignment|communication)|delivery process|coordination gap|handoff gap)\b/.test(evidence)) {
    return "Delivery Process";
  }

  const topicOverlap = contentOverlap(source, candidate);
  if (candidate && (
    phraseAppearsInReply(source, candidate)
    || topicOverlap.shared >= 2
    || (topicOverlap.shared >= 1 && topicOverlap.ratio >= 0.5)
  )) return candidate;
  return "Management Feedback";
}

function groundModelFact(kind, item, text, project = {}) {
  if (!item) return null;
  const source = String(text || "").trim();
  if (!source) return null;

  // Ground the evidence separately from its label. Combining topic + detail
  // allowed a fabricated label such as "Senior Involvement" to survive merely
  // because its otherwise-generic detail overlapped with "an issue in design".
  const evidenceText = kind === "captured"
    ? item.summary
    : kind === "appreciation"
      ? item.detail || item.subject
      : item.detail || item.summary;
  const overlap = contentOverlap(source, evidenceText);
  const sourceTokenCount = contentTokens(source).size;
  const detectedServiceKeys = detectors.detectServices(source, project);
  // A general request may have an operational owner, but that is not the same
  // as the client giving feedback about that owner's configured service. Do
  // not let a model-inferred service create a service interview unless the
  // latest message itself identifies that service.
  if (["captured", "concern"].includes(kind)
    && item.serviceKey
    && isExplicitActionRequest(source)
    && !detectedServiceKeys.includes(item.serviceKey)) return null;
  let grounded = overlap.shared >= 2 || overlap.ratio >= 0.5;
  if (!grounded && sourceTokenCount <= 4 && overlap.shared >= 1) grounded = true;

  if (kind === "captured" && item.serviceKey) {
    if (detectedServiceKeys.includes(item.serviceKey)) grounded = true;
    // A short answer such as "great" or "not up to mark" refers to the
    // service in the pending question even when it does not repeat its name.
    const sourceSentiment = detectors.detectSentiment(source);
    if (sourceTokenCount <= 6 && sourceSentiment !== "neutral"
      && sourceSentiment === item.sentiment) grounded = true;
  }

  if (kind === "appreciation" && phraseAppearsInReply(source, item.subject)) grounded = true;
  if (!grounded) return null;

  const result = { ...item };
  if (kind === "observation") result.topic = groundedObservationTopic(source, item);
  if (kind === "concern" && !item.serviceKey) result.title = groundedObservationTopic(source, item);
  return result;
}

function groundLatestReplyInterpretation(interpretation, text, project = {}) {
  if (!interpretation) return null;
  const captured = (interpretation.captured || [])
    .map((item) => groundModelFact("captured", item, text, project))
    .filter(Boolean);
  const observations = (interpretation.observations || [])
    .map((item) => groundModelFact("observation", item, text, project))
    .filter(Boolean);
  const concerns = (interpretation.concerns || [])
    .map((item) => groundModelFact("concern", item, text, project))
    .filter(Boolean);
  const appreciations = (interpretation.appreciations || [])
    .map((item) => groundModelFact("appreciation", item, text, project))
    .filter(Boolean);
  const serviceKeys = [...new Set([
    ...captured.map((item) => item.serviceKey),
    ...concerns.map((item) => item.serviceKey),
    ...detectors.detectServices(text, project)
  ].filter(Boolean))];
  const hasGroundedObservation = observations.length > 0
    || concerns.some((item) => !item.serviceKey);

  return {
    ...interpretation,
    deferRequested: detectors.clientRequestedDeferral(text, interpretation),
    serviceKeys,
    captured,
    observations,
    concerns,
    appreciations,
    isObservation: interpretation.isObservation === true && hasGroundedObservation
  };
}

function fallbackRoleAppreciations(text, project = {}) {
  const source = String(text || "").trim();
  const roleCue = /\b(?:pocs?|account managers?|project managers?|relationship managers?)\b/i;
  const praiseCue = /\b(?:approachable|responsive|supportive|helpful|patient|understanding|cooperative|available|smooth(?:ly)?|easy coordination|great support|excellent support)\b/i;
  if (!roleCue.test(source) || !praiseCue.test(source)) return [];

  const hasPositiveRolePraise = (part) => roleCue.test(part)
    && [...part.matchAll(new RegExp(praiseCue.source, "ig"))].some((match) => {
      const prefix = part.slice(0, match.index);
      // A lexical outage fallback must not praise an account manager for
      // being "never available" or "not responsive or helpful". Semantic
      // appreciations from the authoritative read are handled separately.
      return !/\b(?:not|never|hardly|rarely|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t)\b(?:\s+[a-z]+){0,3}\s*$/i.test(prefix);
    });
  const segment = source.split(/(?<=[.!?])\s+|\n+/).find(hasPositiveRolePraise);
  if (!segment) return [];
  const afterRole = segment.match(/\b(?:pocs?|account managers?|project managers?|relationship managers?)\b\s*[,;:-]?\s*([^.!?]{0,180})/i)?.[1] || "";
  const ignored = new Set([
    "The", "Our", "Your", "Their", "And", "But", "Or", "Initially", "Now", "Always",
    "Were", "Was", "Are", "Have", "Has", "Being", "Made", "Making", "Especially",
    "Approachable", "Responsive", "Supportive", "Helpful", "Patient", "Understanding",
    "Cooperative", "Coordination", "Smooth", "Easy", "Team", "POC", "POCs"
  ]);
  const names = [...afterRole.matchAll(/\b[A-Z][a-z][A-Za-z.'-]{1,30}\b/g)]
    .map((match) => match[0])
    .filter((name) => !ignored.has(name))
    .filter((name, index, values) => values.indexOf(name) === index)
    .slice(0, 3);
  const accountService = (project.services || []).find((service) =>
    /\baccount\b/i.test(`${service.serviceKey || ""} ${service.name || ""}`)
  );
  return [{
    subject: names.length ? names.join(names.length === 2 ? " and " : ", ") : "Project POC Team",
    detail: segment.trim().slice(0, 600),
    serviceKey: accountService?.serviceKey || null
  }];
}

/**
 * Gemini can return a perfectly usable client-facing reply while omitting a
 * concern or named appreciation from its structured arrays. The conversation
 * machine relies on those arrays to decide whether it may close, so supplement
 * (rather than replace) the model's interpretation with a few high-confidence
 * facts that we can establish from the client's own words.
 */
function enrichConductedWithDeterministicFacts(
  conducted,
  text,
  project = {},
  interpretation = {},
  { protectSubstantiveConcern = false, allowLanguageOnly = false } = {}
) {
  interpretation = interpretation || {};
  conducted.latestClientText = String(text || "");
  // Wording only, never a source of facts or scores.
  conducted.extractedAcknowledgement = interpretation.acknowledgement || "";
  conducted.concerns = (interpretation.concerns || []).map((item) => groundModelFact("concern", item, text, project)).filter(Boolean);
  // The conductor writes the reply; it is not an evidence source. Discard all
  // facts it generated from transcript context and rebuild exclusively from
  // the latest-reply interpretation plus deterministic facts found in the
  // latest client text. This deliberately removes the cross-model fact merge.
  conducted.captured = [];
  conducted.observations = [];
  conducted.appreciations = [];

  // A score or an explicit "nothing / move on" response contains no new
  // narrative facts. Neither model is allowed to attach an observation,
  // service complaint or appreciation to it from older transcript context.
  // This is what allowed an NPS answer of "10" to manufacture a Senior
  // Involvement concern.
  if (factFreeControlReply(text, interpretation)) {
    conducted.captured = [];
    conducted.observations = [];
    conducted.appreciations = [];
    conducted.concerns = [];
    conducted.extractedAcknowledgement = "";
    return conducted;
  }

  // The interpretation pass reads only the current question and latest client
  // reply. It is the sole model source for facts, and every fact is grounded
  // again before it can alter session state.
  for (const item of interpretation.captured || []) {
    const grounded = groundModelFact("captured", item, text, project);
    if (!grounded) continue;
    const existing = conducted.captured.find((candidate) => candidate.serviceKey === grounded.serviceKey);
    if (!existing) {
      conducted.captured.push(grounded);
      continue;
    }
    if (grounded.sentiment === "negative") existing.sentiment = "negative";
    if (!String(existing.summary || "").trim()) existing.summary = grounded.summary;
    if (grounded.needsFollowUp === true) existing.needsFollowUp = true;
    if (grounded.declined === true) existing.declined = true;
  }

  const mergeObservation = (candidate) => {
    if (!candidate || !String(candidate.detail || "").trim()) return;
    const existing = conducted.observations.find((item) => {
      const overlap = contentOverlap(item.detail, candidate.detail);
      return (item.topic === candidate.topic && overlap.shared >= 2)
        || overlap.shared >= 5
        || overlap.ratio >= 0.6;
    });
    if (!existing) {
      conducted.observations.push({ ...candidate });
      return;
    }
    if (candidate.sentiment === "negative") existing.sentiment = "negative";
    if (candidate.kind === "request") existing.kind = "request";
    if (candidate.needsFollowUp === false) existing.needsFollowUp = false;
    if (!String(existing.topic || "").trim()) existing.topic = candidate.topic;
  };

  for (const item of interpretation.observations || []) {
    const grounded = groundModelFact("observation", item, text, project);
    if (grounded) mergeObservation(grounded);
  }
  for (const concern of interpretation.concerns || []) {
    if (concern?.sentiment !== "negative") continue;
    const grounded = groundModelFact("concern", concern, text, project);
    if (!grounded) continue;
    if (grounded.serviceKey) {
      const existing = conducted.captured.find((item) => item.serviceKey === grounded.serviceKey);
      if (existing) {
        existing.sentiment = "negative";
        if (!String(existing.summary || "").trim()) existing.summary = grounded.summary;
        if (grounded.needsFollowUp === true) existing.needsFollowUp = true;
      } else {
        conducted.captured.push({
          serviceKey: grounded.serviceKey,
          sentiment: "negative",
          summary: grounded.summary,
          declined: false,
          needsFollowUp: grounded.needsFollowUp === true
        });
      }
    } else {
      mergeObservation({
        topic: grounded.title || "Management Feedback",
        detail: grounded.summary,
        sentiment: "negative",
        severity: grounded.severity || "watch",
        needsFollowUp: grounded.needsFollowUp === true,
        kind: "feedback"
      });
    }
  }

  for (const item of interpretation.appreciations || []) {
    const grounded = groundModelFact("appreciation", item, text, project);
    if (!grounded) continue;
    const existing = conducted.appreciations.find((candidate) => {
      const overlap = contentOverlap(candidate.detail, grounded.detail);
      return (candidate.subject === grounded.subject && overlap.shared >= 2)
        || overlap.shared >= 4
        || overlap.ratio >= 0.6;
    });
    if (!existing) conducted.appreciations.push(grounded);
  }

  const groundedInterpretation = {
    ...interpretation,
    observations: (interpretation.observations || [])
      .map((item) => groundModelFact("observation", item, text, project))
      .filter(Boolean),
    concerns: (interpretation.concerns || [])
      .map((item) => groundModelFact("concern", item, text, project))
      .filter(Boolean)
  };

  const deterministicObservation = observationFromInterpretation(groundedInterpretation, text)
    || fallbackDeliveryObservation(text)
    || (protectSubstantiveConcern
      ? fallbackGeneralConcernObservation(text, groundedInterpretation, {
          allowLanguageOnly,
          // Response wording is never evidence. A model apology cannot create
          // a concern that the client's latest reply did not contain.
          modelAcknowledgedConcern: false
        })
      : null);
  if (deterministicObservation) {
    const existing = conducted.observations.find((item) => {
      if (item.kind === "appreciation" || item.sentiment === "positive") return false;
      const overlap = contentOverlap(item.detail, deterministicObservation.detail);
      return item.fallbackKind === deterministicObservation.fallbackKind
        || (item.topic === deterministicObservation.topic && overlap.shared >= 2)
        || overlap.shared >= 5
        || overlap.ratio >= 0.55;
    });
    if (existing) {
      // Retain Gemini's richer wording while tagging the point so the safe
      // acknowledgement can address this concern specifically.
      existing.fallbackKind = deterministicObservation.fallbackKind;
      if (deterministicObservation.fallbackKind === "delivery_process") {
        existing.topic = deterministicObservation.topic;
      }
      existing.sentiment = "negative";
      existing.severity = existing.severity || deterministicObservation.severity;
      if (deterministicObservation.needsFollowUp === false) existing.needsFollowUp = false;
      if (!String(existing.detail || "").trim()) existing.detail = deterministicObservation.detail;
    } else {
      conducted.observations.push(deterministicObservation);
    }
  }

  for (const appreciation of fallbackRoleAppreciations(text, project)) {
    const existing = conducted.appreciations.find((item) => {
      const overlap = contentOverlap(item.detail, appreciation.detail);
      return overlap.shared >= 3 && overlap.ratio >= 0.45;
    });
    if (existing) {
      const existingSubject = String(existing.subject || "").trim();
      const fallbackSubject = String(appreciation.subject || "").trim();
      const existingIsGeneric = !existingSubject
        || /^(?:client appreciation|project poc team|poc team|account management team|team)$/i.test(existingSubject);
      const fallbackIsNamed = fallbackSubject && !/^project poc team$/i.test(fallbackSubject);
      if (existingIsGeneric && fallbackIsNamed) existing.subject = fallbackSubject;
      existing.serviceKey = existing.serviceKey || appreciation.serviceKey || null;
      if (!String(existing.detail || "").trim()) existing.detail = appreciation.detail;
    } else {
      conducted.appreciations.push(appreciation);
    }
  }
  return conducted;
}

function canonicalObservationTopic(observation, text = "") {
  const classify = (value) => {
    const source = String(value || "").toLowerCase();
    if (/\b(?:bill|billing|invoice|tax invoice|cfo)\b/.test(source)) return "Billing";
    if (/\b(?:reports?|reporting|dashboard|spend updates?|spend reports?|budget updates?|budget reports?)\b/.test(source)) {
      return /\b(?:spend|budget|cost)\b/.test(source) ? "Spend Reporting" : "Reporting";
    }
    if (/\b(?:senior|leadership|leader|avp|director|sarang|management involvement)\b/.test(source)) {
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
    /\b(?:senior|leadership|leader|avp|director|sarang|management involvement)\b/.test(source)
      && /\b(?:absent|missing|unavailable|not (?:attend|attending|available|responding|picking)|doesn'?t (?:attend|respond|pick)|didn'?t (?:attend|respond|pick)|meetings?|calls?|would (?:like|appreciate)|request)\b/.test(source)
      && "Senior Involvement"
  ].filter(Boolean);
  const unambiguousStrongTopic = new Set(strongTopics).size === 1 ? strongTopics[0] : null;
  const grounded = groundedObservationTopic(text, observation);
  const classified = explicitRequestTopic(observation?.detail)
    || classify(observation?.detail)
    || (grounded !== "Management Feedback" ? grounded : null)
    || unambiguousStrongTopic;
  if (classified) return classified;
  return "Management Feedback";
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
  let interpretedCaptures = Array.isArray(interpretation?.captured)
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
  interpretedCaptures = interpretedCaptures
    .map((item) => groundModelFact("captured", item, text, project))
    .filter(Boolean);

  let observations = Array.isArray(interpretation?.observations)
    ? interpretation.observations
      .map((item) => groundModelFact("observation", item, text, project))
      .filter(Boolean)
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
        || isExplicitActionRequest(observation.detail);
      if (!observationIsRequest) continue;
      observation.kind = "request";
      observation.needsFollowUp = false;
      observation.positiveContext = positiveSocialMediaContext(text);
      if (observation.sentiment === "positive") observation.sentiment = "neutral";
    }
  }

  const appreciations = Array.isArray(interpretation?.appreciations)
    ? interpretation.appreciations
      .map((item) => groundModelFact("appreciation", item, text, project))
      .filter(Boolean)
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
  ensureClientAppreciations(conducted, stateBefore, text, project);
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
    acceptedOverallRating(stateBefore, conducted, text),
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
//   POST /api/automation/complete-inactive-final-responses
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

function redirect(statusCode, location, headers = {}) {
  return {
    statusCode,
    headers: {
      location,
      "cache-control": "no-store",
      ...headers
    },
    body: ""
  };
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
const GOOGLE_OAUTH_STATE_COOKIE = "srv_csat_google_state";
const APP_SESSION_TTL_SECONDS = 12 * 60 * 60;
const GOOGLE_OAUTH_STATE_TTL_SECONDS = 10 * 60;

const APP_PERMISSION_KEYS = [
  "dashboard", "project_workspace", "directory", "project_performance", "manage_records",
  "manage_pocs", "manage_internal_pocs", "manage_catalogues", "messaging_controls", "bulk_sends",
  "manage_project_users", "add_projects", "edit_project_performance", "manage_project_services"
];

const ROLE_PERMISSION_DEFAULTS = {
  admin: Object.fromEntries(APP_PERMISSION_KEYS.map((key) => [key, true])),
  project_user: {
    dashboard: false,
    project_workspace: false,
    directory: false,
    project_performance: true,
    manage_records: false,
    manage_pocs: false,
    manage_internal_pocs: false,
    manage_catalogues: false,
    messaging_controls: false,
    bulk_sends: false,
    manage_project_users: false,
    add_projects: true,
    edit_project_performance: true,
    manage_project_services: false
  }
};

function normalizedPermissions(role, permissions = {}) {
  if (role === "super_admin") return Object.fromEntries(APP_PERMISSION_KEYS.map((key) => [key, true]));
  const defaults = ROLE_PERMISSION_DEFAULTS[role] || {};
  return Object.fromEntries(APP_PERMISSION_KEYS.map((key) => [key, permissions[key] === undefined ? Boolean(defaults[key]) : permissions[key] === true]));
}

function hasAppPermission(access, permission) {
  return Boolean(access && (access.role === "super_admin" || access.permissions?.[permission] === true));
}

function appLoginPassword() {
  const value = String(process.env.APP_LOGIN_PASSWORD || "");
  return value.length >= 8 ? value : null;
}

function appSessionSecret() {
  const separateSecret = String(process.env.APP_SESSION_SECRET || "");
  const commonSecret = String(process.env.SESSION_SECRET || "");
  if (separateSecret.length >= 16) return separateSecret;
  if (commonSecret.length >= 16) return commonSecret;
  return appLoginPassword();
}

function googleAllowedDomains() {
  return String(process.env.GOOGLE_ALLOWED_DOMAINS || process.env.GOOGLE_ALLOWED_DOMAIN || "")
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

function googleOAuthSettings(baseUrl) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const allowedDomains = googleAllowedDomains();
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || "").trim()
    || `${trimSlash(baseUrl)}/api/auth/google/callback`;
  const configured = Boolean(clientId && clientSecret && allowedDomains.length && appSessionSecret());
  return { configured, clientId, clientSecret, allowedDomains, redirectUri };
}

function appAuthenticationConfigured(baseUrl) {
  return Boolean(appLoginPassword() || googleOAuthSettings(baseUrl).configured);
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

function createAppSessionToken(now = Date.now(), user = null) {
  if (!appSessionSecret()) return null;
  const payload = Buffer.from(JSON.stringify({
    exp: now + (APP_SESSION_TTL_SECONDS * 1000),
    nonce: crypto.randomBytes(16).toString("base64url"),
    user: user ? {
      provider: user.provider || "google",
      sub: user.sub || null,
      email: user.email || null,
      name: user.name || null,
      hostedDomain: user.hostedDomain || null
    } : null
  })).toString("base64url");
  return `${payload}.${signSessionPayload(payload)}`;
}

function createGoogleOauthState(now = Date.now()) {
  if (!appSessionSecret()) return null;
  const payload = Buffer.from(JSON.stringify({
    exp: now + (GOOGLE_OAUTH_STATE_TTL_SECONDS * 1000),
    nonce: crypto.randomBytes(24).toString("base64url")
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

function readSignedPayload(token, now = Date.now()) {
  const [payload, signature, ...extra] = String(token || "").split(".");
  const expectedSignature = payload ? signSessionPayload(payload) : null;
  if (!payload || !signature || !expectedSignature || extra.length || !safeEqual(signature, expectedSignature)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(decoded.exp) && decoded.exp > now ? decoded : null;
  } catch {
    return null;
  }
}

function verifyAppSessionToken(token, now = Date.now()) {
  return Boolean(readSignedPayload(token, now));
}

function currentAppSession(headers) {
  return readSignedPayload(readCookie(headers, APP_SESSION_COOKIE));
}

function isAppAuthenticated(headers) {
  return verifyAppSessionToken(readCookie(headers, APP_SESSION_COOKIE));
}

function currentAppUser(headers) {
  return currentAppSession(headers)?.user || null;
}

async function resolveAppAccess(store, headers) {
  const user = currentAppUser(headers);
  if (!user) return null;
  if (user.provider === "password") {
    return { ...user, role: "super_admin", permissions: normalizedPermissions("super_admin"), active: true, bootstrap: true };
  }
  if (user.provider !== "google" || !user.email || typeof store.getAppUserByEmail !== "function") return null;
  const appUser = await store.getAppUserByEmail(user.email);
  if (!appUser || !appUser.active) return null;
  return {
    ...user,
    appUserId: appUser.id,
    name: appUser.name || user.name,
    role: appUser.role,
    permissions: normalizedPermissions(appUser.role, appUser.permissions),
    internalPocId: appUser.internalPocId || null,
    active: true
  };
}

function projectVisibleToAppAccess(project, appAccess) {
  if (appAccess?.role !== "project_user") return true;
  if (!appAccess.internalPocId) return false;
  return ["projectDirectorId", "amId", "tlId", "adId", "avpId"]
    .some((key) => project?.team?.[key] === appAccess.internalPocId);
}

function projectPerformanceInputWithTeam(project, team, updatedBy) {
  return {
    updatedBy,
    expectedVersion: project.version || 0,
    clientProfile: {
      clientGroup: project.clientGroup || "",
      clientCriticality: project.clientCriticality || ""
    },
    profile: {
      financialYear: project.financialYear || "",
      projectType: project.projectType || "",
      revenueCategory: project.revenueCategory || "",
      portfolioType: project.portfolioType || "",
      team,
      currency: project.currency || "INR",
      fxRateToInr: project.fxRateToInr,
      poAmountLocal: project.poAmountLocal,
      budgetAllocatedLocal: project.budgetAllocatedLocal,
      budgetSpentLocal: project.budgetSpentLocal,
      revenueGeneratedLocal: project.revenueGeneratedLocal,
      performanceStatus: project.performanceStatus || "",
      currentPhase: project.currentPhase || "",
      campaignStatus: project.campaignStatus || "",
      clientSentiment: project.clientSentiment || "",
      mandates: project.mandates || "",
      deliverablesStatus: project.deliverablesStatus || "",
      relationshipStrength: project.relationshipStrength || "",
      meetingCadence: project.meetingCadence || "",
      lastMeetingDate: project.lastMeetingDate || "",
      suggestionFrequency: project.suggestionFrequency || "",
      lastSuggestionDate: project.lastSuggestionDate || "",
      clientFeedback: project.clientFeedback || "",
      nextSteps: project.nextSteps || "",
      comments: project.comments || "",
      links: {
        mom: project.links?.mom || "",
        consolidatedSheet: project.links?.consolidatedSheet || "",
        projectDriveFolder: project.links?.projectDriveFolder || "",
        projectDataSheet: project.links?.projectDataSheet || ""
      }
    },
    kpis: project.kpis || []
  };
}

async function projectIdVisibleToAppAccess(store, projectId, appAccess) {
  if (appAccess?.role !== "project_user") return true;
  const performanceData = await store.getProjectPerformanceData();
  const project = performanceData.projects.find((item) => item.id === projectId);
  return Boolean(project && projectVisibleToAppAccess(project, appAccess));
}

function projectUserRouteAllowed(access, method, pathname) {
  if (method === "GET" && pathname === "/api/project-performance") return hasAppPermission(access, "project_performance");
  if (method === "GET" && /^\/api\/project-performance\/[^/]+\/zoho-password$/.test(pathname)) return hasAppPermission(access, "project_performance");
  if (method === "PUT" && /^\/api\/project-performance\/[^/]+$/.test(pathname)) return hasAppPermission(access, "edit_project_performance");
  if (method === "POST" && pathname === "/api/project-performance/projects") return hasAppPermission(access, "add_projects");
  if (method === "POST" && /^\/api\/project-performance\/projects\/[^/]+\/service-change-requests$/.test(pathname)) {
    return hasAppPermission(access, "project_performance");
  }
  return false;
}

function adminRoutePermission(method, pathname) {
  if (pathname === "/api/dashboard") return "dashboard";
  if (method === "PUT" && /^\/api\/projects\/[^/]+\/automation-settings$/.test(pathname)) return "messaging_controls";
  if (method === "POST" && pathname === "/api/project-performance/projects") return "add_projects";
  if (method === "POST" && /^\/api\/project-performance\/projects\/[^/]+\/service-change-requests$/.test(pathname)) return "project_performance";
  if (["POST", "DELETE"].includes(method) && /^\/api\/project-performance\/projects\/[^/]+\/services(?:\/[^/]+)?$/.test(pathname)) return "manage_project_services";
  if (method === "PUT" && /^\/api\/project-performance\/[^/]+$/.test(pathname)) return "edit_project_performance";
  if (pathname === "/api/project-performance" || /^\/api\/project-performance\//.test(pathname)) return "project_performance";
  if (pathname === "/api/projects" || /^\/api\/(?:projects|sessions|issues)\//.test(pathname)) return "project_workspace";
  if (pathname === "/api/admin/messaging") return "messaging_controls";
  if (/^\/api\/admin\/project-automation\//.test(pathname)) return "messaging_controls";
  if (/^\/api\/admin\/bulk-feedback\//.test(pathname)) return "bulk_sends";
  if (/^\/api\/admin\/app-users(?:\/|$)/.test(pathname)) return "manage_project_users";
  if (/^\/api\/admin\/(?:performance-standards|service-catalog)(?:\/|$)/.test(pathname)) return "manage_catalogues";
  if (/^\/api\/admin\/organization-standards(?:\/|$)/.test(pathname)) return "manage_internal_pocs";
  if (/^\/api\/admin\/(?:internal-pocs|departments|sub-departments)(?:\/|$)/.test(pathname)) return "manage_internal_pocs";
  if (/^\/api\/admin\/(?:poc-levels|poc-control)(?:\/|$)/.test(pathname) || /^\/api\/admin\/projects\/[^/]+\/pocs$/.test(pathname)) return "manage_pocs";
  if (pathname === "/api/admin/directory" || /^\/api\/admin\/clients\//.test(pathname)) {
    return method === "GET" ? "directory" : "manage_records";
  }
  if (/^\/api\/admin\//.test(pathname)) return "manage_records";
  return null;
}

function sessionCookie(token, baseUrl) {
  const secure = String(baseUrl || "").startsWith("https://") ? "; Secure" : "";
  return `${APP_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${APP_SESSION_TTL_SECONDS}`;
}

function expiredSessionCookie(baseUrl) {
  const secure = String(baseUrl || "").startsWith("https://") ? "; Secure" : "";
  return `${APP_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
}

function googleOauthStateCookie(token, baseUrl) {
  const secure = String(baseUrl || "").startsWith("https://") ? "; Secure" : "";
  return `${GOOGLE_OAUTH_STATE_COOKIE}=${encodeURIComponent(token)}; Path=/api/auth/google; HttpOnly; SameSite=Lax${secure}; Max-Age=${GOOGLE_OAUTH_STATE_TTL_SECONDS}`;
}

function expiredGoogleOauthStateCookie(baseUrl) {
  const secure = String(baseUrl || "").startsWith("https://") ? "; Secure" : "";
  return `${GOOGLE_OAUTH_STATE_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax${secure}; Max-Age=0`;
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
  return owner?.project_id === projectId || owner?.projectId === projectId
    ? { kind: "same_project", owner }
    : null;
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

const WHATSAPP_AUTOMATION_EVENTS = new Set([
  "feedback_started",
  "quick_checkin_started",
  "no_response",
  "feedback_session_closed",
  "manual_whatsapp_message"
]);

async function messagingStatus(store) {
  if (typeof store.getMessagingStatus !== "function") return { enabled: true, updatedAt: null, updatedBy: null };
  try {
    return await store.getMessagingStatus();
  } catch (statusError) {
    console.warn("[messaging] status unavailable; failing open:", statusError.message);
    return { enabled: true, updatedAt: null, updatedBy: null };
  }
}

async function whatsappMessagingEnabled(store) {
  return (await messagingStatus(store)).enabled !== false;
}

async function pausedMessagingResponse(store) {
  const status = await messagingStatus(store);
  return error(423, "WhatsApp messaging is paused", {
    updatedAt: status.updatedAt,
    updatedBy: status.updatedBy,
    emailAutomationUnaffected: true
  });
}

/**
 * WhatsApp Business greeting/away messages arrive through Meta as ordinary
 * inbound text.  They are not client feedback, but without this guard they can
 * advance a full-feedback questionnaire or complete a quick check-in.
 *
 * Keep this deliberately conservative: require either an explicit automated
 * message label, or two strong template signals. A real client saying only
 * "I am busy" must continue through the normal deferral flow.
 */
function automatedWhatsappReplyReason(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;

  if (/\b(?:automated|automatic|auto)\s+(?:reply|response|message)\b|\baway\s+message\b/.test(normalized)) {
    return "explicit_automated_reply";
  }

  const contactGreeting = /\b(?:thank you|thanks)\s+for\s+(?:contacting|reaching out(?: to us)?|your message|messaging us|getting in touch)\b/.test(normalized);
  const helpPrompt = /\b(?:please|pls|kindly)?\s*let us know\s+(?:how|what)\b.{0,45}\b(?:help|assist)\b|\bhow\s+(?:can|may)\s+we\s+(?:help|assist)\b/.test(normalized);
  const unavailable = /\b(?:i am|i'm|we are|we're)\s+(?:currently\s+|temporarily\s+)?(?:unavailable|away|out of (?:the )?office)\b/.test(normalized);
  const futureResponse = /\b(?:will|shall)\s+(?:respond|reply|get back(?: to you)?|contact you)\b.{0,45}\b(?:soon|shortly|as soon as possible|at the earliest)\b/.test(normalized);
  const hoursNotice = /\b(?:business|office|working)\s+hours?\b/.test(normalized)
    && /\b(?:respond|reply|get back|contact)\b/.test(normalized);

  if (contactGreeting && helpPrompt) return "business_greeting";
  if (contactGreeting && unavailable && futureResponse) return "away_reply";
  if (contactGreeting && hoursNotice) return "outside_business_hours";
  return null;
}

function conversationRelevantMessages(messages = []) {
  return messages.filter((message) => message?.metadata?.ignoredForConversation !== true);
}

async function recordAutomatedWhatsappReply(store, session, poc, body, text, reason) {
  const providerMessageId = body.providerMessageId || null;
  if (
    providerMessageId
    && typeof store.hasProviderMessage === "function"
    && await store.hasProviderMessage(providerMessageId)
  ) {
    return json(200, {
      duplicate: true,
      automatedReply: true,
      sendToWhatsapp: false,
      sessionId: session.id
    });
  }

  const inbound = {
    speaker: body.fromName || poc?.salutation || poc?.name || "Client",
    side: "client",
    body: text,
    providerMessageId,
    metadata: {
      source: "whatsapp",
      from: body.from || null,
      buttonPayload: body.buttonPayload || body.buttonId || null,
      automatedReply: true,
      automatedReplyReason: reason,
      ignoredForConversation: true
    }
  };
  const message = providerMessageId && typeof store.addInboundMessage === "function"
    ? await store.addInboundMessage(session.id, inbound)
    : await store.addMessage(session.id, inbound);

  return json(200, {
    duplicate: !message,
    automatedReply: true,
    automatedReplyReason: reason,
    ignored: true,
    sendToWhatsapp: false,
    sessionId: session.id,
    session,
    receivedMessage: message || null
  });
}

async function recordPausedInbound(store, session, poc, body, text, channel = "whatsapp") {
  const providerMessageId = body.providerMessageId || null;
  if (providerMessageId && typeof store.hasProviderMessage === "function" && await store.hasProviderMessage(providerMessageId)) {
    return json(200, { duplicate: true, sendToWhatsapp: false, sessionId: session.id, messagingPaused: true });
  }
  const inbound = {
    speaker: body.fromName || poc?.salutation || poc?.name || "Client",
    side: "client",
    body: text,
    providerMessageId,
    metadata: {
      source: channel,
      from: body.from || null,
      buttonPayload: body.buttonPayload || body.buttonId || null,
      receivedWhileMessagingPaused: true
    }
  };
  const message = providerMessageId && typeof store.addInboundMessage === "function"
    ? await store.addInboundMessage(session.id, inbound)
    : await store.addMessage(session.id, inbound);
  if (message) {
    const project = await store.getProjectById(session.projectId);
    await notifyAutomation(store, "handoff", {
      project,
      poc,
      session,
      clientText: text,
      reason: "whatsapp_messaging_paused",
      note: "WhatsApp auto-replies are paused. Email notifications remain active, so this inbound message needs human review."
    }, `handoff:messaging-paused:${message.id}`);
  }
  return json(200, {
    duplicate: !message,
    sendToWhatsapp: false,
    messagingPaused: true,
    sessionId: session.id,
    receivedMessage: message || null
  });
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
    return { eventType, status: "pending", delivered: false, dedupeKey };
  }
  if (dedupeKey) pendingAutomationKeys.add(dedupeKey);

  try {
    let claim = null;
    if (dedupeKey && typeof store.claimAutomationEvent === "function") {
      claim = await store.claimAutomationEvent(eventType, payload, dedupeKey);
      if (!claim) {
        const prior = typeof store.getAutomationEventByDedupeKey === "function"
          ? await store.getAutomationEventByDedupeKey(dedupeKey) : null;
        // A timed-out send may have delivered. Do not automatically resend it,
        // but equally do not report a failed/pending attempt as delivered.
        return { eventType, status: prior?.status === "sent" ? "duplicate" : prior?.status || "pending",
          delivered: prior?.status === "sent", dedupeKey, error: prior?.error || null };
      }
    }

    if (WHATSAPP_AUTOMATION_EVENTS.has(eventType) && !await whatsappMessagingEnabled(store)) {
      const event = {
        eventType,
        payload: { ...payload, blockedReason: "whatsapp_messaging_paused" },
        status: "paused",
        webhookUrlConfigured: false,
        sentAt: new Date().toISOString(),
        dedupeKey
      };
      if (claim && typeof store.completeAutomationEvent === "function") {
        await store.completeAutomationEvent(claim.id, event);
      } else if (typeof store.recordAutomationEvent === "function") {
        await store.recordAutomationEvent(event);
      }
      return event;
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

async function completeAutomationClaim(store, claim, event) {
  if (!claim || typeof store.completeAutomationEvent !== "function") return;
  try {
    await store.completeAutomationEvent(claim.id, event);
  } catch (error) {
    console.warn("[automation] could not complete six-hour audit event:", error.message);
  }
}

function claimedInactiveFinalSweepState(session, nowIso) {
  const state = { ...(session.conversationState || {}) };
  if (numericScore(state.overallRating) === null && session.csatSource === "stated") {
    state.overallRating = numericScore(session.csatScore);
  }
  if (
    session.sessionType === "project_end"
    && numericScore(state.npsScore) === null
    && session.npsSource === "stated"
  ) {
    state.npsScore = numericScore(session.npsScore);
  }
  return {
    ...state,
    sessionType: state.sessionType || session.sessionType,
    state: STATES.CLOSING_GRACE,
    pendingQuestionType: null,
    pendingServiceKey: null,
    askedForAnythingElse: true,
    anythingElseAnswered: true,
    askedForAppreciation: true,
    appreciationAnswered: true,
    sixHourAutoCompletionClaimedAt: nowIso,
    closingGraceExpiresAt: new Date(new Date(nowIso).getTime() + CLOSING_GRACE_MS).toISOString()
  };
}

async function notifyCycleSummaryAfterAutomaticCompletion(store, session, baseUrl) {
  if (!session?.id || typeof store.feedbackSessionSummary !== "function") return null;
  if (typeof store.queueFeedbackSummary === "function") await store.queueFeedbackSummary(session.id);
  const latestSession = await store.getSession(session.id);
  if (latestSession?.id === session.id) session = latestSession;
  const state = session.conversationState || {};
  if (state.summaryDeliveryStatus === "sent") return { status: "duplicate", delivered: true };
  if (state.state === STATES.CLOSING_GRACE && Date.parse(state.closingGraceExpiresAt || "") > Date.now()) return null;
  if (state.state === "quick_checkin_window" && Date.parse(state.quickCheckinWindowExpiresAt || "") > Date.now()) return null;
  const summary = await store.feedbackSessionSummary(session.id);
  if (!summary?.project || !summary.poc) return null;
  const quick = session.sessionType === "quick_checkin";
  const event = await notifyAutomation(store, "cycle_completed", {
    ...cycleCompletedPayload(summary, buildResumeUrl(baseUrl, summary.project, session)),
    summaryType: quick ? "quick_checkin_poc" : "feedback_poc",
    poc: summary.poc, messages: summary.messages || [],
    csatScore: summary.sessions[0]?.csatScore ?? null,
    npsScore: summary.sessions[0]?.npsScore ?? null,
    quickCheckinOutcome: state.quickCheckinOutcome || null,
    quickCheckinDetail: state.quickCheckinDetail || null
  }, quick ? `cycle_completed:quick_checkin:session:${session.id}` : `cycle_completed:feedback:session:${session.id}`);
  if (typeof store.markFeedbackSummaryDelivery === "function") await store.markFeedbackSummaryDelivery(session.id, event);
  return event;
}

async function finalizeFeedbackWindowsAndNotify(store, nowIso, baseUrl) {
  const closed = typeof store.finalizeExpiredInactiveFinalSweeps === "function"
    ? await store.finalizeExpiredInactiveFinalSweeps(nowIso) : [];
  const pending = typeof store.pendingFeedbackSummaries === "function"
    ? await store.pendingFeedbackSummaries(nowIso) : [];
  for (const session of pending) await notifyCycleSummaryAfterAutomaticCompletion(store, session, baseUrl);
  return closed;
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

async function notifyExpiredQuickCheckinSummaries(store, expiration, baseUrl) {
  const notifications = [];
  for (const session of expiration?.sessions || []) {
    const state = session.conversationState || {};
    if (state.closureReason !== "quick_checkin_window_elapsed") continue;
    if (typeof store.feedbackSessionSummary === "function") {
      notifications.push(await notifyCycleSummaryAfterAutomaticCompletion(store, session, baseUrl));
      continue;
    }
    if (typeof store.quickCheckinSessionSummary !== "function") continue;
    const summary = await store.quickCheckinSessionSummary(session.id);
    if (!summary?.project || !summary.poc) continue;
    const payload = {
      ...cycleCompletedPayload(
        summary,
        buildResumeUrl(baseUrl, summary.project, session)
      ),
      summaryType: "quick_checkin_poc",
      poc: summary.poc,
      messages: summary.messages || [],
      quickCheckinOutcome: state.quickCheckinOutcome || null,
      quickCheckinDetail: state.quickCheckinDetail || null
    };
    notifications.push(await notifyAutomation(
      store,
      "cycle_completed",
      payload,
      `cycle_completed:quick_checkin:session:${session.id}`
    ));
  }
  return notifications;
}

async function expireQuickCheckinsAndNotify(store, nowIso, baseUrl) {
  if (typeof store.expireDueQuickCheckins !== "function") {
    return { expired: 0, sessions: [], notifications: [] };
  }
  const expiration = await store.expireDueQuickCheckins(nowIso);
  const notifications = await notifyExpiredQuickCheckinSummaries(store, expiration, baseUrl);
  return { ...expiration, notifications };
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
  const messages = conversationRelevantMessages(await store.getMessagesForSession(session.id));
  const clientMessages = messages.filter((message) => message.side === "client");
  if (!clientMessages.length) {
    // A manual Stop must also remove any stale/interim score that predates the
    // real transcript. No client message means there is nothing for Gemini to
    // infer and the honest terminal result is explicitly unscored.
    if (closureReason !== "stopped_by_admin") return null;
    return {
      csatScore: null,
      csatSource: null,
      predictedCsat: null,
      predictedConfidence: null,
      predictedReasoning: null,
      predictedSignals: [],
      riskLevel: null,
      npsScore: null,
      npsSource: null,
      tone: null,
      toneReason: "No client feedback was provided.",
      toneSource: "fallback",
      services: [],
      observations: []
    };
  }

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
  messages = conversationRelevantMessages(messages);
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
    ? conversationRelevantMessages(await store.getMessagesForSession(session.id))
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
    const liveMessages = conversationRelevantMessages(await store.getMessagesForSession(session.id));
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
  const latestSrvMessage = [...previousMessages].reverse().find((message) => message.side === "srv");
  const manualContext = Boolean(latestSrvMessage?.metadata?.manualOutbound);
  if (manualContext) session = applyManualQuestionContext(session, latestSrvMessage);
  const stateBefore = JSON.parse(JSON.stringify(session.conversationState || {}));
  let turn = processWhatsAppReply({ session, project, poc, text, manualContext });
  const transcript = previousMessages.concat(clientMessage);

  // The rules did not understand this reply — "Mo", "Not", "I want to say more".
  // Ask Gemini what the client MEANT, then run the same turn again with that
  // interpretation. Gemini reads intent; the state machine still decides.
  let interpretation = null;
  // Every substantive narrative needs one latest-reply extraction pass. The
  // conductor may see transcript for conversational wording, but its facts are
  // ignored. Without this read, an apparently "unambiguous" long complaint had
  // no authoritative facts and the response model became the de-facto source.
  const needsNarrativeInterpretation = (turn.control?.allowAiRephrase === true
      || turn.control?.offScript === "out_of_scope")
    && !factFreeControlReply(text)
    && !turn.control?.optOut
    && !turn.control?.handoff;
  if (turn.needsInterpretation
    || needsNarrativeInterpretation
    || (manualContext && !turn.control?.optOut && !turn.control?.handoff)) {
    const lastQuestion = latestSrvMessage;
    const read = await interpretReply({
      project,
      question: lastQuestion ? lastQuestion.body : "",
      text,
      pendingRatingChoice: stateBefore.ratingFeedbackPause?.ratingType || null,
      verifySurveyControls: true
    });

    // If Gemini could not be reached, let the rules fall back to their keyword
    // matching — degraded, but better than refusing every inexact reply during
    // an outage.
    const unavailable = Boolean(read.error) && read.source === "fallback";

    // Keep the interpretation even when the INTENT is unclear. Gemini can read
    // "PPC is not working well" as PPC, negative, unexplained — all correct —
    // and still be unsure what kind of reply it is. Discarding the whole
    // response over one field threw away everything it understood.
    interpretation = read.source === "gemini"
      ? groundLatestReplyInterpretation(read, text, project)
      : null;

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
  let latestReplyFacts = interpretation;

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
      rating: acceptedOverallRating(stateBefore, deferredFacts, text)
    };
    replyProvider = "state_machine";
    replyError = null;
  } else if (control.allowAiRephrase) {
    // The model writes the turn from a checklist of what is still open. The
    // state machine supplied the fallback text and still owns the boundaries;
    // it no longer dictates the words or the order. A scripted bot answered
    // "I have not met Sarang in three months" with the next line of its script.
    normalizeLegacyServiceFollowups(turn.conversationState);
    settleClosingWindowFacts(turn.conversationState, stateBefore, interpretation || {});
    updateRatingFeedbackPause(turn.conversationState, stateBefore, interpretation || {}, text, interpretation, project);
    const conductorChecklist = buildChecklist(turn.conversationState, project);
    const preferredAction = requiredConversationAction(conductorChecklist, turn.conversationState);
    const conducted = await conductTurn({
      project,
      poc,
      checklist: conductorChecklist,
      preferredAction,
      messages: transcript
    });

    if (conducted.text && interpretation?.deferRequested === true) {
      // Deferral is a fact about the client's latest message. The dedicated
      // interpretation pass may supply it; the response-writing pass may not.
      // Rebuild from the pre-turn snapshot so no draft next-question markers
      // are persisted, then keep only grounded interpretation facts and pause.
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
          deferRequested: true
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
        rating: acceptedOverallRating(stateBefore, deferredFacts, text)
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
      // A successful Gemini call is not proof that every structured fact was
      // returned. Preserve clear process concerns and named POC praise before
      // the checklist decides whether this session is allowed to close.
      enrichConductedWithDeterministicFacts(
        conducted,
        text,
        project,
        interpretation,
        {
          protectSubstantiveConcern: true,
          // At the inclusive final-management question, substantial concern
          // wording must fail safe even if the semantic read under-classifies
          // it. During ordinary service/scope turns, keep Gemini's nuanced
          // positive or neutral interpretation instead of keyword-overriding it.
          allowLanguageOnly: pendingQuestionTypeFor(stateBefore) === "final_sweep"
        }
      );
      const explicitFeedbackCorrection = interpretation?.corrects === true
        && /(?:^\s*actually\b|\b(?:correction|i\s+(?:said|meant)|instead\s+of|rather\s+than|disregard|withdraw|take\s+back|my\s+(?:earlier|previous)\s+(?:feedback|answer|comment)|what\s+i\s+(?:said|mentioned))\b)/i.test(text);
      conducted.corrects = explicitFeedbackCorrection;
      ensureClientAppreciations(conducted, stateBefore, text, project);
      separateAppreciations(conducted);
      for (const observation of conducted.observations || []) {
        if (observation.kind === "appreciation") continue;
        observation.topic = canonicalObservationTopic(observation, text);
      }
      const explicitRequest = isExplicitActionRequest(text);
      if (explicitRequest) {
        for (const observation of conducted.observations || []) {
          if (observation.kind === "appreciation") continue;
          const observationIsRequest = observation.kind === "request"
            || isExplicitActionRequest(observation.detail);
          if (!observationIsRequest) continue;
          observation.kind = "request";
          observation.needsFollowUp = false;
          observation.positiveContext = positiveSocialMediaContext(text);
          if (observation.sentiment === "positive") observation.sentiment = "neutral";
        }
      }
      const interpretedObservation = observationFromInterpretation(interpretation, text);
      if (interpretedObservation) {
        const alreadyCaptured = (conducted.observations || []).some((observation) => {
          const overlap = contentOverlap(observation.detail, interpretedObservation.detail);
          return String(observation.topic || "").toLowerCase()
            === String(interpretedObservation.topic || "").toLowerCase()
            && (overlap.shared >= 2 || overlap.ratio >= 0.55);
        });
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
        acceptedOverallRating(stateBefore, conducted, text),
        conducted.corrects
      );
      openAppreciationFollowUp(turn.conversationState, stateBefore, conducted, text);
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
      settleActionableFinalSweepFacts(
        turn.conversationState, stateBefore, conducted, text, interpretation, project
      );
      if (!stateBefore.closingGraceExpiresAt && ["feedback", "conversation"].includes(detectors.completionScopeFor(text, interpretation))) {
        finishFeedbackQuestions(turn.conversationState, project, detectors.completionScopeFor(text, interpretation) === "conversation");
      }
      // First record only what THIS client reply answered. The checklist then
      // selects the next action; outgoing-question markers are accepted only
      // when they match that action.
      const answerMarkers = validatedAnswerMarkers(stateBefore, conducted, text, interpretation);
      const suppliedFinalSweepFeedback = pendingQuestionTypeFor(stateBefore) === "final_sweep"
        && Boolean(
          (conducted.captured || []).length
          || (conducted.observations || []).length
          || (conducted.appreciations || []).length
        );
      if (suppliedFinalSweepFeedback && answerMarkers.answeredAnythingElse !== true) {
        // Defence in depth: the preliminary rule pass must not be able to leave
        // a stale completion flag behind. Detailed feedback is acknowledged,
        // then the client gets one final inclusive opportunity to add more.
        turn.conversationState.askedForAnythingElse = true;
        turn.conversationState.anythingElseAnswered = false;
        turn.conversationState.pendingQuestionType = "final_sweep";
      }
      applyTurnProgress(turn.conversationState, project, answerMarkers, { recordAsked: false });
      normalizeLegacyServiceFollowups(turn.conversationState);
      const checklistAfterCapture = buildChecklist(turn.conversationState, project);
      const requiredAction = requiredConversationAction(checklistAfterCapture, turn.conversationState);
      const actualAction = conductedAction(conducted);
      // Do not discard a good Gemini reply merely because one JSON marker was
      // omitted or mis-set. Validate the client-facing words as well. The hard
      // checklist still blocks genuinely wrong transitions (for example,
      // asking about PPC instead of offering the requested continue/skip choice).
      const actionRejected = ["rating_feedback", "overall_rating", "nps"].includes(requiredAction.type)
        ? !messageMatchesRequiredAction(requiredAction, conducted.text)
        : !actionMatches(requiredAction, actualAction) && !messageMatchesRequiredAction(requiredAction, conducted.text);
      const requiredService = requiredAction.serviceKey
        ? turn.conversationState.mentionedServices?.[requiredAction.serviceKey]
        : null;
      const latestConcerns = latestConcernFacts(conducted);
      const needsConcernAcknowledgement = latestConcerns.length > 0
        || (["issue_reason", "service_followup"].includes(requiredAction.type) && requiredService?.sentiment === "negative");
      const hasConcernAcknowledgement = /\b(?:sorry|hear you|noted|recorded|concerns?|issues?|improv\w*|review|thank you for (?:raising|explaining|flagging))\b/i.test(conducted.text);
      const needsAppreciationAcknowledgement = Boolean(conducted.appreciations?.length)
        && !responseAcknowledgesAppreciation(conducted.text);
      const unsupportedResponseTopic = responseIntroducesUnsupportedTopic(
        conducted.text,
        text,
        project,
        conducted,
        requiredAction
      );
      const machineWordedAction = (needsConcernAcknowledgement && !hasConcernAcknowledgement)
        || internalSummaryLanguage(conducted.text)
        || needsAppreciationAcknowledgement
        || (requiredAction.type === "rating_feedback"
          && !/\b(?:thank|noted|recorded|added|appreciat\w*|sorry|hear you)\b/i.test(conducted.text))
        || unsupportedResponseTopic
        || /\b(?:(?:have|has|already)\s+(?:notified|alerted|emailed)|(?:directors|management|team)\s+(?:have|has)\s+been\s+(?:notified|alerted|informed))\b/i.test(conducted.text);

      if (actionRejected || machineWordedAction) {
        if (actionRejected) {
          console.warn(`[turn] rejected next action ${actualAction.type}; required ${requiredAction.type}`);
        }
        conducted.text = fallbackForAction(requiredAction, turn.conversationState, project, conducted);
        conducted.readyToClose = requiredAction.type === "close";
      }
      const recordedQuestion = recordRequiredQuestion(turn.conversationState, project, requiredAction);
      latestReplyFacts = conducted;

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
      const covered = isEverythingCovered(turn.conversationState, project)
        || (requiredAction.type === "close" && Boolean(stateBefore.closingGraceExpiresAt));

      // Only close when the message we are about to send is a CLOSING message.
      // Completing while still asking a question meant the client's answer
      // arrived at an already-closed session: the rating triggered the
      // post-completion guardrail, the closing message was never sent, and a
      // manager was emailed about the client's own score.
      const stillAsking = /\?\s*$/.test(conducted.text.trim());

      // Remember that we actually asked. A session may only close once the
      // client has been asked for a rating and answered — not because every
      // service happened to get a mention.
      if (requiredAction.type === "close" && covered && !stillAsking) {
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
        replyText = closingGraceMessage(poc, turn.conversationState, conducted, project);
      }

      // A farewell written while the checklist is unsatisfied is replaced with
      // the outstanding question. The model ended a conversation after one
      // service with "Have a great day ahead!" — the client reasonably read
      // that as the end, and the cycle closed with no rating and no score.
      const wantsToLeave = soundsLikeFarewell(conducted.text);
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
      const fallbackConducted = {
        text: "",
        captured: [],
        observations: [],
        appreciations: []
      };
      enrichConductedWithDeterministicFacts(
        fallbackConducted,
        text,
        project,
        interpretation,
        {
          protectSubstantiveConcern: true,
          allowLanguageOnly: pendingQuestionTypeFor(stateBefore) === "final_sweep"
        }
      );
      ensureClientAppreciations(fallbackConducted, stateBefore, text, project);
      separateAppreciations(fallbackConducted);
      for (const observation of fallbackConducted.observations || []) {
        if (observation.kind !== "appreciation") {
          observation.topic = canonicalObservationTopic(observation, text);
        }
      }

      // An observation must not mutate a nearby service merely because the
      // preliminary keyword pass saw "creative" or "meeting". Restore the
      // pre-turn service state, then apply only grounded deterministic facts.
      if ((fallbackConducted.observations || []).some((item) => item.kind !== "appreciation")) {
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
      openAppreciationFollowUp(turn.conversationState, stateBefore, fallbackConducted, text);
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
      settleActionableFinalSweepFacts(
        turn.conversationState,
        stateBefore,
        fallbackConducted,
        text,
        interpretation,
        project
      );
      if (!stateBefore.closingGraceExpiresAt && ["feedback", "conversation"].includes(detectors.completionScopeFor(text, interpretation))) {
        finishFeedbackQuestions(turn.conversationState, project, detectors.completionScopeFor(text, interpretation) === "conversation");
      }
      const answerMarkers = validatedAnswerMarkers(stateBefore, fallbackConducted, text, interpretation);
      const suppliedFinalSweepFeedback = pendingQuestionTypeFor(stateBefore) === "final_sweep"
        && Boolean(
          (fallbackConducted.captured || []).length
          || (fallbackConducted.observations || []).length
          || (fallbackConducted.appreciations || []).length
        );
      if (suppliedFinalSweepFeedback && answerMarkers.answeredAnythingElse !== true) {
        turn.conversationState.askedForAnythingElse = true;
        turn.conversationState.anythingElseAnswered = false;
        turn.conversationState.pendingQuestionType = "final_sweep";
      }
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
      latestReplyFacts = fallbackConducted;
      setStateForRequiredAction(turn.conversationState, requiredAction, recordedQuestion);
      if (requiredAction.type === "close") {
        turn.conversationState.state = STATES.CLOSING_GRACE;
        replyText = closingGraceMessage(poc, turn.conversationState, fallbackConducted, project);
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
    const liveMessages = conversationRelevantMessages(await store.getMessagesForSession(session.id));
    if (clientBurstContext(liveMessages, clientMessage).superseded) {
      return supersededTurnResponse(session, clientMessage);
    }
  }

  // processWhatsAppReply prepares a legacy next question before the checklist
  // conductor chooses the actual outgoing message. Persist the message we
  // really send, otherwise the repeat guard compares a future reply with an
  // internal draft the client never saw and can falsely trigger a handoff.
  turn.conversationState.lastQuestionAsked = replyText;
  rememberAcknowledgedConcerns(turn.conversationState, latestReplyFacts || {});

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
          messages: transcript,
          // Automatic replies share the bounded terminal-analysis window.
          // Keep the longer retry policy for explicit dashboard scoring only.
          callOptions: { maxAttempts: 1, timeoutMs: 6000 }
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
      const liveMessages = conversationRelevantMessages(await store.getMessagesForSession(session.id));
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

  const resumeUrl = buildResumeUrl(baseUrl, project, updatedSession);
  const pendingQuestions = turn.conversationState.offTopicQuestions || [];
  let postCompletionHandoffEvent = null;
  if (control.notify === "post_completion_message" && !control.forceManagerAlert) {
    try {
      // A Replit request has no waitUntil lifecycle hook. Await this critical
      // handoff so the audit row and n8n request exist before we tell the client
      // their message was passed to a person.
      postCompletionHandoffEvent = await notifyAutomation(store, control.notify, {
        project,
        poc,
        session: updatedSession,
        clientText: control.notifyText || text,
        guardrail: control.guardrail || null,
        state: turn.conversationState.state,
        pendingQuestions,
        resumeUrl
      }, `${control.notify}:message:${clientMessage.id}`);
    } catch (handoffError) {
      postCompletionHandoffEvent = {
        eventType: control.notify,
        status: "failed",
        error: handoffError.message
      };
    }
    if (!(postCompletionHandoffEvent?.status === "sent" || (postCompletionHandoffEvent?.status === "duplicate" && postCompletionHandoffEvent.delivered === true))) {
      const salutation = poc?.salutation || poc?.name || "there";
      replyText = `Thank you, ${salutation}. This feedback cycle is already closed, and I could not pass this new message to the team automatically. Please contact your SRV representative directly so it is not missed.`;
    }
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
          completionScope: detectors.completionScopeFor(text, interpretation),
          completionEvidence: interpretation.completionEvidence || null,
          controlVerification: interpretation.controlVerification || "not_requested",
          controlVerificationError: interpretation.controlVerificationError || null,
          proposedControl: interpretation.proposedControl || null,
          verifiedControl: interpretation.verifiedControl || null,
          ratingChoice: interpretation.ratingChoice || "none",
          ratingChoiceEvidence: interpretation.ratingChoiceEvidence || null,
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
      pendingQuestionType: turn.conversationState.pendingQuestionType || null,
      ratingFeedbackPause: turn.conversationState.ratingFeedbackPause || null,
      serviceScopeStatus: turn.conversationState.serviceScopeStatus || null,
      servicesAfter: Object.keys(turn.conversationState.mentionedServices || {}),
      // Recorded so the timeline shows WHY a turn was not understood, rather
      // than only that the bot apologised.
      interpretationFailed: turn.control && turn.control.notUnderstood ? true : undefined,
      aiRephraseAllowed: Boolean(control.allowAiRephrase),
      deferredCapture: control.deferredCapture || null
    }
  });

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
  let cycleSummaryQueued = false;

  // Queue one POC summary, but do not freeze it at the opening of the ten-minute
  // correction window. Other POCs do not have to finish first.
  if (
    terminalNotificationsAllowed
    && !control.forceManagerAlert
    && !control.notify
    && typeof store.feedbackSessionSummary === "function"
    && updatedSession.cycleId
  ) {
    try {
      await notifyCycleSummaryAfterAutomaticCompletion(store, updatedSession, baseUrl);
      cycleSummaryQueued = true;
    } catch (summaryError) {
      // The saved conversation and its reply must survive an email/audit outage.
      console.warn("[summary] could not queue POC summary:", summaryError.message);
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
  if (control.notify && control.notify !== "post_completion_message" && !control.forceManagerAlert) {
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
    postCompletionHandoffEvent,
    state: turn.conversationState.state,
    resumeUrl
  });
}

// ---------------------------------------------------------------------
// Cycle creation (one session per active POC)
// ---------------------------------------------------------------------

async function startCycle({ store, projectKey, cycleType, baseUrl, reason, clientPocIds, scheduleKey, automatic = false }) {
  if (!await whatsappMessagingEnabled(store)) throw new Error("WhatsApp messaging is paused");
  const result = await store.createCycle(projectKey, {
    cycleType,
    channel: "whatsapp",
    scheduleKey: scheduleKey || null,
    automatic,
    ...(Array.isArray(clientPocIds) ? { clientPocIds } : {})
  });
  const { cycle, sessions, project, pocs } = result;

  const dispatched = [];
  for (const session of sessions) {
    const poc = pocs.find((item) => item.id === session.clientPocId) || null;
    const resumeUrl = buildResumeUrl(baseUrl, project, session);
    const eventType = cycleType === "quick_checkin" ? "quick_checkin_started" : "feedback_started";
    await notifyAutomation(store, eventType, {
      project,
      poc,
      cycle,
      session,
      reason: reason || "manual_dashboard_request",
      reminderDueAt: session.reminderDueAt,
      scheduleKey: scheduleKey || null,
      resumeUrl
    }, `${eventType}:session:${session.id}`);
    dispatched.push({ session, poc, resumeUrl });
  }

  return { cycle, project, dispatched };
}

async function buildBulkSendPreview(store, cycleType, requestedProjectIds = null) {
  const projects = await store.listProjects();
  // `null` means no caller scope was supplied. An explicitly supplied empty
  // array means the active UI scope contains no projects and must return none,
  // never fall back to every project in the database.
  const requested = Array.isArray(requestedProjectIds)
    ? new Set(requestedProjectIds.map((id) => String(id)))
    : null;
  const reservedPhones = new Map();
  const rows = [];

  for (const projectSummary of projects) {
    if (requested && !requested.has(projectSummary.id)) continue;
    const reasons = [];
    if (projectSummary.activeStatus !== "active") reasons.push(`project is ${projectSummary.activeStatus}`);
    if (projectSummary.clientActiveStatus && projectSummary.clientActiveStatus !== "active") {
      reasons.push(`client is ${projectSummary.clientActiveStatus}`);
    }
    if (cycleType !== "project_end" && await projectEndFeedbackStarted(store, projectSummary)) {
      reasons.push("project-end feedback has already been sent; recurring feedback is closed");
    }
    if (await store.hasOpenCycle(projectSummary.id, cycleType)) reasons.push("this cycle type is already open");

    const allPocs = await store.pocsForProject(projectSummary.id, { activeOnly: false });
    const invalidPocs = allPocs.filter((poc) => !poc.active || !String(poc.contactWhatsapp || "").replace(/\D/g, ""));
    const eligiblePocs = [];
    const conflicts = [];
    const reachablePocs = reasons.length ? [] : allPocs.filter((item) => item.active && String(item.contactWhatsapp || "").replace(/\D/g, ""));
    for (const poc of reachablePocs) {
      const phone = String(poc.contactWhatsapp).replace(/\D/g, "");
      if (reservedPhones.has(phone)) {
        conflicts.push({ pocId: poc.id, pocName: poc.name, phone, reason: `same WhatsApp already selected for ${reservedPhones.get(phone)}` });
        continue;
      }
      const routing = await store.getWhatsappRoutingContext(phone);
      const activeSessions = routing.status === "ambiguous"
        ? routing.candidates.map((candidate) => candidate.session)
        : routing.status === "active" ? [routing.session] : [];
      // Bulk sends must never create two simultaneous conversations for one
      // WhatsApp number. Even another quick check-in is a conflict: without a
      // button payload, a free-text reply could not be routed to one project
      // unambiguously.
      const blocks = activeSessions.length > 0;
      if (blocks) {
        const blocking = activeSessions[0];
        const blockingProject = blocking?.projectId ? await store.getProjectById(blocking.projectId) : null;
        conflicts.push({ pocId: poc.id, pocName: poc.name, phone, reason: `active session${blockingProject ? ` on ${blockingProject.name}` : ""}` });
        continue;
      }
      reservedPhones.set(phone, projectSummary.name);
      eligiblePocs.push(poc);
    }
    if (!eligiblePocs.length && !reasons.length) reasons.push("no eligible active POC with WhatsApp");
    rows.push({
      projectId: projectSummary.id,
      projectKey: projectSummary.key,
      projectName: projectSummary.name,
      clientName: projectSummary.clientName,
      clusterName: projectSummary.clusterName,
      eligible: reasons.length === 0,
      eligiblePocs: eligiblePocs.map((poc) => ({ id: poc.id, name: poc.name, whatsapp: poc.contactWhatsapp })),
      invalidPocs: invalidPocs.map((poc) => ({ id: poc.id, name: poc.name, reason: poc.active ? "WhatsApp missing" : "inactive" })),
      conflicts,
      reasons
    });
  }
  return rows;
}

async function buildBulkAutomationPreview(store, input = {}) {
  const suppliedFeedback = typeof input.automaticFeedbackEnabled === "boolean";
  const suppliedQuickCheckin = typeof input.automaticQuickCheckinEnabled === "boolean";
  if (!suppliedFeedback && !suppliedQuickCheckin) {
    throw new Error("Choose at least one automatic sending setting to update");
  }

  const requestedIds = Array.isArray(input.projectIds)
    ? [...new Set(input.projectIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];
  if (!requestedIds.length) throw new Error("Select at least one project");

  const requested = new Set(requestedIds);
  const projects = (await store.listProjects()).filter((project) => requested.has(String(project.id)));
  const projectEndIds = typeof store.projectIdsWithCycleType === "function"
    ? await store.projectIdsWithCycleType("project_end")
    : [];
  // The production store returns a Set while lightweight test stores may
  // return an array. Normalize either shape before checking project-end locks.
  const projectEndSet = new Set(Array.from(projectEndIds || [], (id) => String(id)));
  const foundIds = new Set(projects.map((project) => String(project.id)));
  const rows = projects.map((project) => {
    const current = {
      automaticFeedbackEnabled: project.automaticFeedbackEnabled !== false,
      automaticQuickCheckinEnabled: project.automaticQuickCheckinEnabled !== false
    };
    const next = {
      automaticFeedbackEnabled: suppliedFeedback ? input.automaticFeedbackEnabled : current.automaticFeedbackEnabled,
      automaticQuickCheckinEnabled: suppliedQuickCheckin ? input.automaticQuickCheckinEnabled : current.automaticQuickCheckinEnabled
    };
    const reasons = [];
    const turningRecurringOn = (suppliedFeedback && input.automaticFeedbackEnabled && !current.automaticFeedbackEnabled)
      || (suppliedQuickCheckin && input.automaticQuickCheckinEnabled && !current.automaticQuickCheckinEnabled);
    if (turningRecurringOn && (project.endFeedbackRequestedAt || projectEndSet.has(String(project.id)))) {
      reasons.push("project-end feedback has already been sent; recurring feedback cannot be reactivated");
    }
    if (
      current.automaticFeedbackEnabled === next.automaticFeedbackEnabled
      && current.automaticQuickCheckinEnabled === next.automaticQuickCheckinEnabled
    ) reasons.push("already matches the selected settings");

    return {
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
      clientName: project.clientName || "",
      clusterName: project.clusterName || "",
      projectStatus: project.activeStatus || "",
      current,
      next,
      eligible: reasons.length === 0,
      reasons
    };
  });

  for (const missingId of requestedIds.filter((id) => !foundIds.has(String(id)))) {
    rows.push({
      projectId: missingId,
      projectKey: "",
      projectName: "Project not found",
      clientName: "",
      clusterName: "",
      projectStatus: "",
      current: null,
      next: null,
      eligible: false,
      reasons: ["project no longer exists"]
    });
  }
  return rows;
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
    const passwordConfigured = Boolean(appLoginPassword());
    const googleSettings = googleOAuthSettings(baseUrl);
    const configured = passwordConfigured || googleSettings.configured;
    const session = configured ? currentAppSession(request.headers) : null;
    let accessUser = session?.user || null;
    let accessAuthorized = false;
    if (session) {
      try {
        const authStore = createStore();
        const resolvedUser = await resolveAppAccess(authStore, request.headers);
        accessAuthorized = Boolean(resolvedUser);
        accessUser = resolvedUser || session.user;
      } catch {
        if (session.user?.provider === "password") {
          accessUser = { ...session.user, role: "super_admin", permissions: normalizedPermissions("super_admin"), active: true, bootstrap: true };
          accessAuthorized = true;
        }
      }
    }
    return withResponseHeaders(
      json(200, {
        configured,
        passwordConfigured,
        googleConfigured: googleSettings.configured,
        authenticated: Boolean(session),
        accessAuthorized,
        user: accessUser,
        sessionHours: APP_SESSION_TTL_SECONDS / 3600
      }),
      { "cache-control": "no-store" }
    );
  }

  if (method === "GET" && pathname === "/api/auth/google/start") {
    const settings = googleOAuthSettings(baseUrl);
    if (!settings.configured) {
      return error(
        503,
        "Google login is not configured",
        "Set SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_ALLOWED_DOMAINS in Replit Secrets."
      );
    }
    const state = createGoogleOauthState();
    const client = new OAuth2Client(settings.clientId, settings.clientSecret, settings.redirectUri);
    const authorizationUrl = client.generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      prompt: "select_account",
      state,
      hd: settings.allowedDomains.length === 1 ? settings.allowedDomains[0] : undefined
    });
    return redirect(302, authorizationUrl, {
      "set-cookie": googleOauthStateCookie(state, baseUrl)
    });
  }

  if (method === "GET" && pathname === "/api/auth/google/callback") {
    const settings = googleOAuthSettings(baseUrl);
    const errorRedirect = (reason) => redirect(303, `/?auth_error=${encodeURIComponent(reason)}`, {
      "set-cookie": expiredGoogleOauthStateCookie(baseUrl)
    });
    if (!settings.configured) return errorRedirect("google_not_configured");
    if (searchParams.get("error")) return errorRedirect("google_cancelled");

    const code = String(searchParams.get("code") || "");
    const state = String(searchParams.get("state") || "");
    const cookieState = readCookie(request.headers, GOOGLE_OAUTH_STATE_COOKIE);
    if (!code || !state || !cookieState || !safeEqual(state, cookieState) || !readSignedPayload(state)) {
      return errorRedirect("invalid_google_state");
    }

    try {
      const client = new OAuth2Client(settings.clientId, settings.clientSecret, settings.redirectUri);
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) return errorRedirect("google_identity_missing");
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: settings.clientId
      });
      const payload = ticket.getPayload() || {};
      const hostedDomain = String(payload.hd || "").toLowerCase();
      const email = String(payload.email || "").toLowerCase();
      if (!payload.sub || payload.email_verified !== true || !email) {
        return errorRedirect("google_identity_unverified");
      }
      if (!hostedDomain || !settings.allowedDomains.includes(hostedDomain)) {
        return errorRedirect("google_domain_not_allowed");
      }
      const user = {
        provider: "google",
        sub: payload.sub,
        email,
        name: String(payload.name || email).trim(),
        hostedDomain
      };
      const token = createAppSessionToken(Date.now(), user);
      return redirect(303, "/dashboard", {
        "set-cookie": [sessionCookie(token, baseUrl), expiredGoogleOauthStateCookie(baseUrl)]
      });
    } catch (googleError) {
      console.warn("[auth] Google login failed:", googleError.message);
      return errorRedirect("google_login_failed");
    }
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    const expected = appLoginPassword();
    if (!expected) {
      return error(503, "Password login is not enabled");
    }
    if (!safeEqual(body.password, expected)) return error(401, "Incorrect password");
    const user = { provider: "password", sub: null, email: null, name: null, hostedDomain: null, role: "super_admin", permissions: normalizedPermissions("super_admin"), active: true, bootstrap: true };
    const token = createAppSessionToken(Date.now(), user);
    return withResponseHeaders(
      json(200, { authenticated: true, user, sessionHours: APP_SESSION_TTL_SECONDS / 3600 }),
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
    if (!appAuthenticationConfigured(baseUrl)) {
      return error(503, "Application login is not configured", "Configure Google login or APP_LOGIN_PASSWORD in Replit Secrets, then restart the app.");
    }
    if (!isAppAuthenticated(request.headers)) return error(401, "Authentication required");
  }

  let store;
  try {
    store = createStore();
  } catch (storeError) {
    return error(500, "Data provider is not configured", storeError.message);
  }

  let appAccess = null;
  if (!isMachineApiPath(pathname)) {
    appAccess = await resolveAppAccess(store, request.headers);
    if (!appAccess) return error(403, "Application access has not been assigned", "Ask a Super Admin to add your Google email under Manage → Application Users.");
    if (appAccess.role === "project_user" && !projectUserRouteAllowed(appAccess, method, pathname)) {
      return error(403, "Your role can only access Project Performance");
    }
    if (appAccess.role === "admin") {
      const requiredPermission = adminRoutePermission(method, pathname);
      const dashboardForWorkspace = pathname === "/api/dashboard" && hasAppPermission(appAccess, "project_workspace");
      const directoryForManage = (pathname === "/api/admin/directory" || /^\/api\/admin\/clients\/[^/]+$/.test(pathname)) && [
        "manage_records", "manage_pocs", "manage_internal_pocs", "manage_catalogues", "messaging_controls", "bulk_sends", "manage_project_users"
      ].some((permission) => hasAppPermission(appAccess, permission));
      if (requiredPermission && !hasAppPermission(appAccess, requiredPermission) && !directoryForManage && !dashboardForWorkspace) {
        return error(403, "This feature is turned off for your Admin account");
      }
    }
  }

  // ---- Retired v1 routes: fail with direction, not a bare 404.
  if (pathname === "/api/clients" || /^\/api\/clients\//.test(pathname)) {
    return error(410, "The /api/clients routes were replaced in v2", "Use /api/projects and /api/projects/:projectKey/workspace");
  }

  if (method === "GET" && pathname === "/api/dashboard") {
    const [dashboard, messaging] = await Promise.all([store.getDashboard(), messagingStatus(store)]);
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
    const latestCycleByProjectType = new Map();
    for (const cycle of cycles) {
      const key = `${cycle.projectId}|${cycle.cycleType}`;
      const current = latestCycleByProjectType.get(key);
      if (!current || Date.parse(cycle.startedAt || "") > Date.parse(current.startedAt || "")) {
        latestCycleByProjectType.set(key, cycle);
      }
    }
    const projectEndProjectIds = new Set(
      cycles.filter((cycle) => cycle.cycleType === "project_end").map((cycle) => cycle.projectId)
    );
    const openCycles = (dashboard.openCycles || []).map((cycle) => {
      const owner = projectsById.get(cycle.projectId);
      return {
        ...cycle,
        projectKey: owner ? owner.key : null,
        projectName: owner ? owner.name : null,
        clientName: owner ? owner.clientName : null
      };
    });
    const nowMs = Date.now();
    const openCycleKeys = new Set(openCycles.map((cycle) => `${cycle.projectId}|${cycle.cycleType}`));
    const latestSkippedByProjectType = new Map();
    for (const event of dashboard.scheduleEvents || []) {
      const key = `${event.projectKey}|${event.cycleType}`;
      if (!latestSkippedByProjectType.has(key)) latestSkippedByProjectType.set(key, event);
    }
    const feedbackSchedule = [];
    for (const project of dashboard.projects || []) {
      const activePocCount = Number(dashboard.projectPocCounts?.[project.id]) || 0;
      const addScheduleRow = (cycleType, dueAt, baseStatus, statusReason = null, cycle = null) => {
        if (!dueAt && baseStatus !== "automatic_off") return;
        const open = openCycleKeys.has(`${project.id}|${cycleType}`);
        const skipped = latestSkippedByProjectType.get(`${project.key}|${cycleType}`) || null;
        const lastStarted = Date.parse(project.lastCycleStartedAt || "");
        const skipStillRelevant = skipped && (!Number.isFinite(lastStarted) || Date.parse(skipped.attemptedAt || "") > lastStarted);
        feedbackSchedule.push({
          id: `${project.id}-${cycleType}`,
          projectId: project.id,
          projectKey: project.key,
          projectName: project.name,
          clientName: project.clientName,
          clusterName: project.clusterName,
          cycleType,
          dueAt,
          activePocCount: Number(cycle?.pocTotal) || activePocCount,
          status: open ? "open" : skipStillRelevant ? "blocked" : baseStatus,
          blockedReason: skipStillRelevant ? skipped.reason : statusReason,
          attemptedAt: skipStillRelevant ? skipped.attemptedAt : null,
          cycleId: cycle?.id || null
        });
      };

      const latestProjectEnd = latestCycleByProjectType.get(`${project.id}|project_end`) || null;
      if (latestProjectEnd) {
        addScheduleRow(
          "project_end",
          latestProjectEnd.startedAt || latestProjectEnd.closedAt || project.endFeedbackRequestedAt,
          latestProjectEnd.status === "closed" ? "completed" : "requested",
          null,
          latestProjectEnd
        );
      } else if (project.activeStatus === "active" && project.endDate) {
        const due = new Date(project.endDate).getTime() <= nowMs;
        const status = project.endFeedbackRequestedAt
          ? "requested"
          : automaticProjectEndFeedbackEnabled()
            ? due ? "due" : "upcoming"
            : due ? "manual_required" : "upcoming_manual";
        addScheduleRow("project_end", project.endDate, status);
      }
      const ended = project.endDate && new Date(project.endDate).getTime() <= nowMs;
      const projectEndStarted = Boolean(project.endFeedbackRequestedAt)
        || projectEndProjectIds.has(project.id);
      if (project.activeStatus === "active" && !ended && !projectEndStarted) {
        if (project.automaticFeedbackEnabled === false) {
          addScheduleRow("pulse", project.nextCycleDueAt, "automatic_off", "Automatic sending off");
        } else if (project.nextCycleDueAt) {
          addScheduleRow(
            "pulse",
            project.nextCycleDueAt,
            new Date(project.nextCycleDueAt).getTime() <= nowMs ? "due" : "upcoming"
          );
        }
        const quickResumeAt = Date.parse(project.automaticQuickCheckinResumeAt || "");
        const quickDueAt = Number.isFinite(quickResumeAt) && quickResumeAt > nowMs
          ? project.automaticQuickCheckinResumeAt
          : nextQuickCheckinAt(new Date(nowMs));
        addScheduleRow(
          "quick_checkin",
          quickDueAt,
          project.automaticQuickCheckinEnabled === false ? "automatic_off" : "upcoming",
          project.automaticQuickCheckinEnabled === false ? "Automatic sending off" : null
        );
      }
    }
    feedbackSchedule.sort((left, right) => {
      const leftDue = Date.parse(left.dueAt || "");
      const rightDue = Date.parse(right.dueAt || "");
      if (!Number.isFinite(leftDue) && !Number.isFinite(rightDue)) return left.projectName.localeCompare(right.projectName);
      if (!Number.isFinite(leftDue)) return 1;
      if (!Number.isFinite(rightDue)) return -1;
      return leftDue - rightDue;
    });
    return json(200, { ...dashboard, openIssues, openCycles, cycles, feedbackSchedule, messaging });
  }

  if (method === "GET" && pathname === "/api/project-performance") {
    const performanceData = await store.getProjectPerformanceData();
    if (appAccess.role !== "project_user") return json(200, performanceData);
    const projects = performanceData.projects.filter((project) => projectVisibleToAppAccess(project, appAccess));
    const projectIds = new Set(projects.map((project) => project.id));
    const clientIds = new Set(projects.map((project) => project.clientId));
    return json(200, {
      ...performanceData,
      projects,
      clients: performanceData.clients.filter((client) => clientIds.has(client.id)),
      serviceChangeRequests: (performanceData.serviceChangeRequests || []).filter((request) => projectIds.has(request.projectId))
    });
  }

  if (method === "POST" && pathname === "/api/project-performance/projects") {
    const clientId = String(body.clientId || "").trim();
    const key = String(body.key || "").trim();
    const name = String(body.name || "").trim();
    if (!clientId || !key || !name || !body.startDate || !body.endDate) {
      return error(400, "Client, Project ID, name, start date and end date are required");
    }
    if (!/^[A-Za-z0-9-]+$/.test(key)) return error(400, "Project ID must contain letters, numbers and hyphens only");
    if (await store.projectKeyExists(key)) return error(409, "That project ID is already used", key);
    if (String(body.endDate) < String(body.startDate)) return error(400, "End date cannot be before the start date");
    const performanceData = await store.getProjectPerformanceData();
    const client = performanceData.clients.find((item) => item.id === clientId);
    if (!client) return error(404, "Client not found");
    const feedbackIntervalDays = Number(body.feedbackIntervalDays || 30);
    if (!Number.isInteger(feedbackIntervalDays) || feedbackIntervalDays < 1 || feedbackIntervalDays > 365) {
      return error(400, "Feedback interval must be a whole number from 1 to 365");
    }
    const project = await store.createProject({
      clientId,
      key,
      name,
      goal: String(body.goal || "").trim() || null,
      startDate: body.startDate,
      endDate: body.endDate,
      feedbackIntervalDays,
      activeStatus: "paused"
    });
    if (appAccess.role === "project_user" && appAccess.internalPocId) {
      const roleFields = {
        project_director: "projectDirectorId",
        am: "amId",
        tl: "tlId",
        ad: "adId",
        avp: "avpId"
      };
      const requestedRoles = Array.isArray(body.selfTeamRoles) ? body.selfTeamRoles : ["am"];
      const team = {};
      for (const role of requestedRoles) {
        if (roleFields[role]) team[roleFields[role]] = appAccess.internalPocId;
      }
      if (!Object.keys(team).length) team.amId = appAccess.internalPocId;
      await store.saveProjectPerformance(project.id, {
        updatedBy: appAccess.email || appAccess.name || "Project User",
        expectedVersion: 0,
        clientProfile: {},
        profile: { team },
        kpis: []
      });
    }
    await notifySetupRecordCreated(store, {
      kind: "project",
      client,
      project,
      actor: appAccess.email || appAccess.name || "Password Super Admin",
      source: "Project Performance",
      baseUrl
    });
    return json(201, {
      project,
      requiresSuperAdminSetup: true,
      message: "Project created as paused. A Super Admin must add standard services/POCs and activate it before CSAT messages can be scheduled."
    });
  }

  const performanceServiceDeleteMatch = pathname.match(/^\/api\/project-performance\/projects\/([^/]+)\/services\/([^/]+)$/);
  const performanceServiceAddMatch = pathname.match(/^\/api\/project-performance\/projects\/([^/]+)\/services$/);
  const performanceServiceRequestMatch = pathname.match(/^\/api\/project-performance\/projects\/([^/]+)\/service-change-requests$/);
  if (method === "POST" && performanceServiceRequestMatch) {
    if (appAccess.role === "super_admin") {
      return error(400, "Super Admins can change project services directly", "Use the Add or Remove service controls instead of creating an approval request.");
    }
    const projectId = decodeURIComponent(performanceServiceRequestMatch[1]);
    if (!await projectIdVisibleToAppAccess(store, projectId, appAccess)) return error(403, "This project is not assigned to you");
    const project = await store.getProjectById(projectId);
    if (!project) return error(404, "Project not found");
    const requestType = String(body.requestType || "").trim();
    if (!["add_existing", "remove_existing", "add_new"].includes(requestType)) {
      return error(400, "Choose whether to add, remove or request a new service");
    }
    const reason = String(body.reason || "").trim();
    if (reason.length < 5) return error(400, "Please explain why this service change is needed");
    if (reason.length > 1000) return error(400, "The service change reason must be 1,000 characters or fewer");

    const requestInput = {
      projectId,
      requestType,
      reason,
      requestedByAppUserId: appAccess.appUserId || null,
      requestedByEmail: appAccess.email || null,
      requestedByName: appAccess.name || appAccess.email || "Application user"
    };
    const currentServices = await store.servicesForProject(projectId);
    if (requestType === "add_existing") {
      const catalog = await store.getServiceCatalogItem(String(body.serviceCatalogId || "").trim());
      if (!catalog || !catalog.active) return error(400, "Select an active service from the standard catalogue");
      if (currentServices.some((item) => item.serviceCatalogId === catalog.id || item.serviceKey === catalog.serviceKey)) {
        return error(409, `${catalog.name} is already attached to this project`);
      }
      requestInput.serviceCatalogId = catalog.id;
    } else if (requestType === "remove_existing") {
      const service = currentServices.find((item) => item.id === String(body.projectServiceId || "").trim());
      if (!service) return error(404, "Service does not belong to this project");
      if (currentServices.length <= 1) return error(409, "A project must keep at least one service", "Request an additional service before requesting removal of the final service.");
      requestInput.projectServiceId = service.id;
    } else {
      const requestedServiceName = String(body.requestedServiceName || "").trim();
      if (requestedServiceName.length < 2 || requestedServiceName.length > 120) {
        return error(400, "Enter a service name between 2 and 120 characters");
      }
      const serviceKey = serviceIdentifier(requestedServiceName);
      if (await store.serviceCatalogConflict(requestedServiceName, serviceKey)) {
        return error(409, "That service already exists in the standard catalogue", "Select it from the existing service list instead.");
      }
      requestInput.requestedServiceName = requestedServiceName;
    }
    const duplicate = await store.findPendingServiceChangeRequest(requestInput);
    if (duplicate) return error(409, "This service change is already awaiting Super Admin review", duplicate.id);

    let serviceRequest;
    try {
      serviceRequest = await store.createServiceChangeRequest(requestInput);
    } catch (requestError) {
      if (requestError.code === "23505") return error(409, "This service change is already awaiting Super Admin review");
      throw requestError;
    }
    const notification = await notifyServiceChangeRequested(store, { request: serviceRequest, baseUrl });
    serviceRequest = await store.updateServiceChangeRequestNotification(serviceRequest.id, {
      status: notification.status,
      error: notification.error || null,
      notifiedAt: notification.status === "sent" ? notification.sentAt : null
    }) || serviceRequest;
    return json(201, {
      request: serviceRequest,
      notification: { status: notification.status, error: notification.error || null },
      message: notification.status === "sent"
        ? "Service change requested. Active Super Admins were notified by email. CSAT services have not changed."
        : "Service change requested. CSAT services have not changed; review the email notification status with a Super Admin."
    });
  }

  if (method === "POST" && performanceServiceAddMatch) {
    if (appAccess.role !== "super_admin") return error(403, "Only a Super Admin can directly add project services", "Submit a service change request for approval instead.");
    const projectId = decodeURIComponent(performanceServiceAddMatch[1]);
    if (!await projectIdVisibleToAppAccess(store, projectId, appAccess)) return error(403, "This project is not assigned to you");
    const project = await store.getProjectById(projectId);
    if (!project) return error(404, "Project not found");
    if (await store.hasOpenFeedbackCycle(projectId)) {
      return error(409, "A service cannot be added while a feedback cycle is open", "Close or complete the current cycle first so its service scope cannot change mid-conversation.");
    }
    const catalog = await store.getServiceCatalogItem(String(body.serviceCatalogId || "").trim());
    if (!catalog || !catalog.active) return error(400, "Select an active service from the standard catalogue");
    const current = await store.servicesForProject(projectId);
    if (current.some((item) => item.serviceCatalogId === catalog.id || item.serviceKey === catalog.serviceKey)) {
      return error(409, `${catalog.name} is already attached to this project`);
    }
    const service = await store.createProjectService({
      projectId,
      serviceCatalogId: catalog.id,
      serviceKey: catalog.serviceKey,
      name: catalog.name
    });
    return json(201, {
      service,
      message: `${catalog.name} was added to this project. The standard catalogue itself was not changed.`
    });
  }

  if (method === "DELETE" && performanceServiceDeleteMatch) {
    if (appAccess.role !== "super_admin") return error(403, "Only a Super Admin can directly remove project services", "Submit a service change request for approval instead.");
    const projectId = decodeURIComponent(performanceServiceDeleteMatch[1]);
    if (!await projectIdVisibleToAppAccess(store, projectId, appAccess)) return error(403, "This project is not assigned to you");
    const serviceId = decodeURIComponent(performanceServiceDeleteMatch[2]);
    const project = await store.getProjectById(projectId);
    if (!project) return error(404, "Project not found");
    const services = await store.servicesForProject(projectId);
    const service = services.find((item) => item.id === serviceId);
    if (!service) return error(404, "Service does not belong to this project");
    if (services.length <= 1) return error(409, "A project must keep at least one service");
    if (await store.hasOpenFeedbackCycle(projectId)) {
      return error(409, "This service cannot be removed while a feedback cycle is open", "Close or complete the current cycle first. Historical CSAT records will remain unchanged.");
    }
    await store.deleteProjectService(serviceId);
    return json(200, {
      removed: service,
      historicalFeedbackPreserved: true,
      message: "Service removed from future project feedback. Historical scores, issues and conversations were preserved."
    });
  }

  if (method === "GET" && pathname === "/api/admin/service-change-requests") {
    if (appAccess.role !== "super_admin") return error(403, "Only a Super Admin can review project service changes");
    if (!process.env.ADMIN_PIN) return error(503, "Editing is disabled", "ADMIN_PIN is not set on the server");
    if (!isAdminAuthorized(request.headers)) return error(403, "Incorrect PIN");
    return json(200, { requests: await store.listServiceChangeRequests() });
  }

  const serviceChangeReviewMatch = pathname.match(/^\/api\/admin\/service-change-requests\/([^/]+)$/);
  if (method === "PATCH" && serviceChangeReviewMatch) {
    if (appAccess.role !== "super_admin") return error(403, "Only a Super Admin can approve or reject project service changes");
    if (!process.env.ADMIN_PIN) return error(503, "Editing is disabled", "ADMIN_PIN is not set on the server");
    if (!isAdminAuthorized(request.headers)) return error(403, "Incorrect PIN");
    const requestId = decodeURIComponent(serviceChangeReviewMatch[1]);
    const serviceRequest = await store.getServiceChangeRequest(requestId);
    if (!serviceRequest) return error(404, "Service change request not found");
    if (serviceRequest.status !== "pending") return error(409, `This request was already ${serviceRequest.status}`);
    const decision = String(body.decision || "").trim().toLowerCase();
    if (!["approved", "rejected"].includes(decision)) return error(400, "Decision must be approved or rejected");
    const reviewNote = String(body.reviewNote || "").trim();
    if (decision === "rejected" && reviewNote.length < 3) return error(400, "Enter a short reason for rejecting this request");
    if (reviewNote.length > 1000) return error(400, "The review note must be 1,000 characters or fewer");

    let appliedService = null;
    let removedService = null;
    if (decision === "approved") {
      if (await store.hasOpenFeedbackCycle(serviceRequest.projectId)) {
        return error(409, "This service change cannot be approved while a feedback cycle is open", "Close or complete the current cycle so its service scope cannot change mid-conversation.");
      }
      const currentServices = await store.servicesForProject(serviceRequest.projectId);
      if (serviceRequest.requestType === "remove_existing") {
        removedService = currentServices.find((item) => item.id === serviceRequest.projectServiceId) || null;
        if (!removedService) return error(409, "The requested service is no longer assigned to this project");
        if (currentServices.length <= 1) return error(409, "A project must keep at least one service");
        await store.deleteProjectService(removedService.id);
      } else {
        let catalog;
        if (serviceRequest.requestType === "add_existing") {
          catalog = await store.getServiceCatalogItem(serviceRequest.serviceCatalogId);
          if (!catalog || !catalog.active) return error(409, "The requested standard service is no longer active");
        } else {
          const name = String(serviceRequest.requestedServiceName || "").trim();
          const serviceKey = serviceIdentifier(name);
          if (await store.serviceCatalogConflict(name, serviceKey)) {
            return error(409, "A service with this name or key now exists", "Reject this request and ask the requester to select the existing standard service.");
          }
          catalog = await store.createServiceCatalogItem({ name, serviceKey, active: true });
        }
        if (currentServices.some((item) => item.serviceCatalogId === catalog.id || item.serviceKey === catalog.serviceKey)) {
          return error(409, `${catalog.name} is already attached to this project`);
        }
        appliedService = await store.createProjectService({
          projectId: serviceRequest.projectId,
          serviceCatalogId: catalog.id,
          serviceKey: catalog.serviceKey,
          name: catalog.name
        });
      }
    }

    const reviewed = await store.reviewServiceChangeRequest(requestId, {
      status: decision,
      reviewedByAppUserId: appAccess.appUserId || null,
      reviewedByEmail: appAccess.email || "Password Super Admin",
      reviewNote: reviewNote || null,
      reviewedAt: new Date().toISOString()
    });
    if (!reviewed) return error(409, "This request was reviewed by someone else. Refresh the list.");
    if (typeof store.recordAutomationEvent === "function") {
      await store.recordAutomationEvent({
        eventType: `project_service_change_${decision}`,
        status: "recorded",
        payload: {
          requestId,
          projectId: reviewed.projectId,
          requestType: reviewed.requestType,
          serviceName: reviewed.serviceName,
          reviewedBy: reviewed.reviewedByEmail,
          reviewNote: reviewed.reviewNote
        },
        sentAt: reviewed.reviewedAt
      });
    }
    return json(200, {
      request: reviewed,
      service: appliedService,
      removedService,
      historicalFeedbackPreserved: true,
      message: decision === "approved"
        ? "Service change approved. It applies to future feedback cycles; historical feedback remains unchanged."
        : "Service change request rejected. CSAT services were not changed."
    });
  }

  const zohoPasswordMatch = pathname.match(/^\/api\/project-performance\/([^/]+)\/zoho-password$/);
  if (method === "GET" && zohoPasswordMatch) {
    const projectId = decodeURIComponent(zohoPasswordMatch[1]);
    if (!await projectIdVisibleToAppAccess(store, projectId, appAccess)) return error(403, "This project is not assigned to you");
    try {
      const response = json(200, { password: await store.getProjectZohoPassword(projectId) });
      response.headers["cache-control"] = "no-store";
      return response;
    } catch { return error(503, "Unable to reveal stored credential", "Check the credential encryption configuration"); }
  }
  const projectPerformanceMatch = pathname.match(/^\/api\/project-performance\/([^/]+)$/);
  if (method === "PUT" && projectPerformanceMatch) {
    const projectId = decodeURIComponent(projectPerformanceMatch[1]);
    if (!await projectIdVisibleToAppAccess(store, projectId, appAccess)) return error(403, "This project is not assigned to you");
    const signedInUser = currentAppUser(request.headers);
    const updatedBy = String(signedInUser?.email || signedInUser?.name || body.updatedBy || "").trim();
    if (updatedBy.length < 2 || updatedBy.length > 120) {
      return error(400, "Enter the name of the person making this update");
    }
    const profile = body.profile || {};
    const financialYear = String(profile.financialYear || "").trim();
    if (financialYear) {
      const match = financialYear.match(/^(\d{4})-(\d{4})$/);
      if (!match || Number(match[2]) !== Number(match[1]) + 1) {
        return error(400, "Financial year must use the format 2026-2027");
      }
    }
    const data = await store.getProjectPerformanceData();
    const existingPerformanceProject = data.projects.find((item) => item.id === projectId) || null;
    const referenceChecks = {
      clientCriticality: [body.clientProfile?.clientCriticality, "client_criticality", existingPerformanceProject?.clientCriticality],
      clientGroup: [body.clientProfile?.clientGroup, "client_group", existingPerformanceProject?.clientGroup],
      projectType: [profile.projectType, "project_type", existingPerformanceProject?.projectType],
      revenueCategory: [profile.revenueCategory, "revenue_category", existingPerformanceProject?.revenueCategory],
      portfolioType: [profile.portfolioType, "portfolio_type", existingPerformanceProject?.portfolioType],
      currency: [profile.currency || "INR", "currency", existingPerformanceProject?.currency || "INR"],
      performanceStatus: [profile.performanceStatus, "performance_status", existingPerformanceProject?.performanceStatus],
      currentPhase: [profile.currentPhase, "current_phase", existingPerformanceProject?.currentPhase],
      campaignStatus: [profile.campaignStatus, "campaign_status", existingPerformanceProject?.campaignStatus],
      clientSentiment: [profile.clientSentiment, "client_sentiment", existingPerformanceProject?.clientSentiment],
      relationshipStrength: [profile.relationshipStrength, "relationship_strength", existingPerformanceProject?.relationshipStrength],
      meetingCadence: [profile.meetingCadence, "meeting_cadence", existingPerformanceProject?.meetingCadence],
      suggestionFrequency: [profile.suggestionFrequency, "suggestion_frequency", existingPerformanceProject?.suggestionFrequency]
    };
    for (const [field, [value, category, existingValue]] of Object.entries(referenceChecks)) {
      if (!value) continue;
      const allowed = new Set((data.referenceValues?.[category] || []).filter((item) => item.active !== false).map((item) => item.value));
      if (!allowed.has(value) && value !== existingValue) return error(400, `${field} must be selected from its active standard list`);
    }
    const internalPocIds = new Set((data.internalPocs || []).map((item) => item.id));
    for (const [role, value] of Object.entries(profile.team || {})) {
      if (value && !internalPocIds.has(value)) return error(400, `${role} must be selected from Internal POCs`);
    }
    const numericFields = [
      "fxRateToInr", "poAmountLocal", "budgetAllocatedLocal", "budgetSpentLocal", "revenueGeneratedLocal"
    ];
    for (const field of numericFields) {
      const value = profile[field];
      if (value !== "" && value !== null && value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
        return error(400, `${field} must be a valid non-negative number`);
      }
    }
    if (profile.fxRateToInr !== "" && profile.fxRateToInr !== null && profile.fxRateToInr !== undefined
      && Number(profile.fxRateToInr) <= 0) {
      return error(400, "FX rate must be greater than zero");
    }
    if (profile.zohoPassword !== undefined && (typeof profile.zohoPassword !== "string" || profile.zohoPassword.length > 2000)) return error(400, "Zoho password must be text of 2,000 characters or fewer");
    const links = { ...(profile.links || {}), zohoDashboard: profile.zohoDashboardLink };
    for (const [name, value] of Object.entries(links)) {
      if (!value) continue;
      try {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
      } catch {
        return error(400, `${name} must be a valid http or https URL`);
      }
    }
    if (!Array.isArray(body.kpis) || body.kpis.length > 100) {
      return error(400, "KPIs must be a list containing no more than 100 rows");
    }
    const allowedKpiNames = new Set((data.referenceValues?.kpi_name || []).filter((item) => item.active !== false).map((item) => item.value));
    const existingKpiNames = new Set((existingPerformanceProject?.kpis || []).map((item) => item.kpiName));
    let primaryKpiCount = 0;
    for (const [index, kpi] of body.kpis.entries()) {
      const kpiName = String(kpi.kpiName || "").trim();
      if (!kpiName) return error(400, `KPI ${index + 1} needs a name`);
      if (kpi.comment !== undefined && (typeof kpi.comment !== "string" || kpi.comment.length > 2000)) return error(400, `KPI ${index + 1} comment must be text of 2,000 characters or fewer`);
      if (!allowedKpiNames.has(kpiName) && !existingKpiNames.has(kpiName)) return error(400, `KPI ${index + 1} name must be selected from the active standard KPI list`);
      if (!["number", "percent", "currency", "ratio"].includes(kpi.unit || "number")) {
        return error(400, `KPI ${index + 1} unit is invalid`);
      }
      if (!["higher_better", "lower_better"].includes(kpi.direction || "higher_better")) {
        return error(400, `KPI ${index + 1} direction is invalid`);
      }
      if (kpi.isPrimary) primaryKpiCount += 1;
      for (const field of ["target", "actual", "previousYearActual"]) {
        const value = kpi[field];
        if (value !== "" && value !== null && value !== undefined && !Number.isFinite(Number(value))) {
          return error(400, `KPI ${index + 1} ${field} must be a valid number`);
        }
      }
    }
    if (primaryKpiCount > 1) return error(400, "Only one KPI can be marked Primary");
    try {
      return json(200, await store.saveProjectPerformance(projectId, { ...body, updatedBy }));
    } catch (saveError) {
      if (saveError.code === "PERFORMANCE_VERSION_CONFLICT") return error(409, saveError.message);
      if (saveError.message === "Project not found") return error(404, saveError.message);
      return error(400, "Could not save project performance", saveError.message);
    }
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

  const automationSettingsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/automation-settings$/);
  if (method === "PUT" && automationSettingsMatch) {
    const projectKey = decodeURIComponent(automationSettingsMatch[1]);
    const project = await store.getProject(projectKey);
    if (!project) return error(404, "Project not found");

    const suppliedFeedback = Object.prototype.hasOwnProperty.call(body, "automaticFeedbackEnabled");
    const suppliedQuickCheckin = Object.prototype.hasOwnProperty.call(body, "automaticQuickCheckinEnabled");
    if (!suppliedFeedback && !suppliedQuickCheckin) {
      return error(400, "Choose at least one automatic sending setting to update");
    }
    if (suppliedFeedback && typeof body.automaticFeedbackEnabled !== "boolean") {
      return error(400, "automaticFeedbackEnabled must be true or false");
    }
    if (suppliedQuickCheckin && typeof body.automaticQuickCheckinEnabled !== "boolean") {
      return error(400, "automaticQuickCheckinEnabled must be true or false");
    }
    const turningRecurringOn = (suppliedFeedback && body.automaticFeedbackEnabled)
      || (suppliedQuickCheckin && body.automaticQuickCheckinEnabled);
    if (turningRecurringOn && await projectEndFeedbackStarted(store, project)) {
      return error(
        409,
        "Recurring feedback is closed for this project",
        "Project-end feedback has already been sent, so automatic scheduled feedback and quick check-ins cannot be reactivated."
      );
    }

    const input = {};
    if (suppliedFeedback) input.automaticFeedbackEnabled = body.automaticFeedbackEnabled;
    if (suppliedQuickCheckin) input.automaticQuickCheckinEnabled = body.automaticQuickCheckinEnabled;
    const saved = await store.updateProjectAutomationSettings(project.id, input);
    if (!saved) return error(404, "Project not found");

    if (typeof store.recordAutomationEvent === "function") {
      await store.recordAutomationEvent({
        eventType: "project_automatic_sending_changed",
        status: "recorded",
        webhookUrlConfigured: false,
        sentAt: new Date().toISOString(),
        payload: {
          projectId: project.id,
          projectKey: project.key,
          projectName: project.name,
          previous: {
            automaticFeedbackEnabled: project.automaticFeedbackEnabled !== false,
            automaticQuickCheckinEnabled: project.automaticQuickCheckinEnabled !== false,
            automaticQuickCheckinResumeAt: project.automaticQuickCheckinResumeAt || null,
            nextCycleDueAt: project.nextCycleDueAt || null
          },
          next: {
            automaticFeedbackEnabled: saved.automaticFeedbackEnabled !== false,
            automaticQuickCheckinEnabled: saved.automaticQuickCheckinEnabled !== false,
            automaticQuickCheckinResumeAt: saved.automaticQuickCheckinResumeAt || null,
            nextCycleDueAt: saved.nextCycleDueAt || null
          },
          changedBy: appAccess?.email || appAccess?.name || "Password Super Admin"
        }
      });
    }
    return json(200, {
      project: saved,
      message: "Automatic sending settings updated. Existing cycles, sessions and POC weights were not changed."
    });
  }

  const requestFeedbackMatch = pathname.match(/^\/api\/projects\/([^/]+)\/request-feedback$/);
  if (method === "POST" && requestFeedbackMatch) {
    if (!await whatsappMessagingEnabled(store)) return pausedMessagingResponse(store);
    const projectKey = decodeURIComponent(requestFeedbackMatch[1]);
    const allowedCycleTypes = new Set(["pulse", "project_end", "quick_checkin"]);
    const cycleType = allowedCycleTypes.has(body.cycleType) ? body.cycleType : "pulse";

    const project = await store.getProject(projectKey);
    if (!project) return error(404, "Project not found");
    if (cycleType !== "project_end" && await projectEndFeedbackStarted(store, project)) {
      return error(
        409,
        "Recurring feedback is closed for this project",
        "Project-end feedback has already been sent, so monthly feedback and quick check-ins cannot be started."
      );
    }

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
    if (!await whatsappMessagingEnabled(store)) return pausedMessagingResponse(store);
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

    const detectedManualQuestionType = manualQuestionType({
      body: text,
      metadata: { manualOutbound: true }
    }, session.sessionType);
    const message = await store.addMessage(session.id, {
      speaker: "SRV Media MD Office",
      side: "srv",
      body: text,
      metadata: {
        source: "dashboard_manual_whatsapp",
        manualOutbound: true,
        manualQuestionType: detectedManualQuestionType,
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
    if (!poc || poc.removedAt) return error(409, "This POC has been removed from the project");
    if (session.sessionType === "quick_checkin") {
      return handleQuickCheckinTurn({ store, session, project, poc, body, text, baseUrl, channel: "web" });
    }
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
    if (session.sessionType === "quick_checkin") {
      return error(409, "Quick check-ins are not scored", "They record All good or the client's written feedback without changing CSAT or NPS.");
    }

    const messages = typeof store.getMessagesForSession === "function"
      ? conversationRelevantMessages(await store.getMessagesForSession(sessionId))
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
      const details = predicted.error === "gemini_timeout"
        ? "Gemini timed out after two attempts. No score was saved and the session or cycle status was not changed. You can safely click Retry scoring."
        : (predicted.error || "the model was unavailable");
      return error(503, "Could not score this conversation", details);
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
      sessionRemainsOpen: !["completed", "opted_out"].includes(updated.status),
      sessionStatusUnchanged: true
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
    if (session.sessionType === "quick_checkin") {
      return json(200, {
        session, project, poc,
        stopScore: { attempted: false, scored: false, reason: "Quick check-ins do not create satisfaction scores." }
      });
    }
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
    // Report this POC independently. Failure to email must not undo the stop.
    try {
      await notifyCycleSummaryAfterAutomaticCompletion(store, session, baseUrl);
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
    if (!await whatsappMessagingEnabled(store)) return pausedMessagingResponse(store);
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

    const poc = await store.getClientPocById(existing.clientPocId);
    if (!poc || poc.removedAt) return error(409, "This POC has been removed from the project");

    const finalRatingReminder = shouldUseFinalRatingReminder(existing);
    const session = await store.markNoResponse(sessionId, {
      askForOverallRating: finalRatingReminder
    });
    const project = await store.getProjectById(session.projectId);
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

    const buttonSessionId = quickCheckinSessionId(body);
    const routing = typeof store.getWhatsappRoutingContext === "function"
      ? await store.getWhatsappRoutingContext(body.from)
      : null;

    let poc = null;
    let session = null;
    if (buttonSessionId) {
      session = await store.getSession(buttonSessionId);
      const phonePocs = typeof store.getPocsByWhatsapp === "function"
        ? await store.getPocsByWhatsapp(body.from)
        : [];
      poc = phonePocs.find((item) => item.id === session?.clientPocId) || null;
      if (!session || session.sessionType !== "quick_checkin" || !poc) {
        return error(400, "This quick check-in button does not match the sender or an active quick check-in");
      }
    } else if (routing?.status === "ambiguous") {
      const detailCandidates = (routing.candidates || []).filter((candidate) =>
        candidate.session?.sessionType === "quick_checkin"
        && candidate.session?.conversationState?.state === "quick_checkin_detail"
      );
      if (detailCandidates.length) {
        detailCandidates.sort((left, right) =>
          new Date(right.session.lastClientResponseAt || right.session.startedAt || 0).getTime()
          - new Date(left.session.lastClientResponseAt || left.session.startedAt || 0).getTime()
        );
        ({ poc, session } = detailCandidates[0]);
      } else {
        return error(409, "This WhatsApp number has more than one active feedback session", "Use the button for the relevant project. If feedback details were requested, reply immediately after choosing Share feedback.");
      }
    } else {
      poc = routing ? routing.poc : await store.getPocByWhatsapp(body.from);
      // Prefer the open session; fall back to the most recent one so that a
      // post-completion message still reaches G3 instead of 404-ing into silence.
      const active = routing ? routing.session : await store.getActiveSessionForPoc(poc?.id);
      session = active || (routing ? null : await store.getLatestSessionForPoc(poc?.id));
    }
    if (!poc) return error(404, `No active client POC found for WhatsApp number ${body.from}`);
    if (!session) return error(404, `No feedback session found for POC ${poc.name}`);

    const project = await store.getProjectById(session.projectId);
    const automatedReplyReason = automatedWhatsappReplyReason(text);
    if (automatedReplyReason) {
      return recordAutomatedWhatsappReply(store, session, poc, body, text, automatedReplyReason);
    }
    if (!await whatsappMessagingEnabled(store)) {
      return recordPausedInbound(store, session, poc, body, text);
    }
    if (session.sessionType === "quick_checkin") {
      return handleQuickCheckinTurn({
        store, session, project, poc, body, text, baseUrl, channel: "whatsapp",
        waitUntil: request.waitUntil
      });
    }
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
    if (!poc || poc.removedAt) return error(409, "This POC has been removed from the project");
    const automatedReplyReason = automatedWhatsappReplyReason(text);
    if (automatedReplyReason) {
      return recordAutomatedWhatsappReply(store, session, poc, body, text, automatedReplyReason);
    }
    if (!await whatsappMessagingEnabled(store)) {
      return recordPausedInbound(store, session, poc, body, text);
    }
    if (session.sessionType === "quick_checkin") {
      return handleQuickCheckinTurn({
        store, session, project, poc, body, text, baseUrl, channel: "whatsapp",
        waitUntil: request.waitUntil
      });
    }
    return handleTurn({
      store, session, project, poc, body, text, baseUrl, channel: "whatsapp",
      waitUntil: request.waitUntil
    });
  }

  // ---- Automation / scheduler
  if (method === "POST" && pathname === "/api/automation/complete-inactive-final-responses") {
    if (!isAutomationAuthorized(request.headers)) return error(401, "Unauthorized automation request");
    const now = body.now ? new Date(body.now) : new Date();
    if (Number.isNaN(now.getTime())) return error(400, "Invalid automation time");
    const nowIso = now.toISOString();
    const closed = await finalizeFeedbackWindowsAndNotify(store, nowIso, baseUrl);
    if (!await whatsappMessagingEnabled(store)) {
      return json(200, { paused: true, closed, sent: [], closedWithoutMessage: [], duplicates: [], failed: [], ignored: 0 });
    }
    if (
      typeof store.getInactiveFinalSweepCandidates !== "function"
      || typeof store.claimAutomationEvent !== "function"
      || typeof store.markInactiveFinalSweepClaimed !== "function"
      || typeof store.completeInactiveFinalSweep !== "function"
    ) {
      return error(503, "Six-hour completion is not supported by the configured data provider");
    }

    const candidates = await store.getInactiveFinalSweepCandidates(nowIso);
    const sent = [];
    const closedWithoutMessage = [];
    const duplicates = [];
    const failed = [];
    let ignored = 0;

    for (const initialSession of candidates) {
      const initialMessages = typeof store.getMessagesForSession === "function"
        ? conversationRelevantMessages(await store.getMessagesForSession(initialSession.id))
        : [];
      let assessment = inactiveFinalSweepEligibility(initialSession, initialMessages, now);
      if (!assessment.eligible && !assessment.closeWithoutMessage) {
        ignored += 1;
        continue;
      }

      const [initialProject, initialPoc] = await Promise.all([
        store.getProjectById(initialSession.projectId),
        store.getClientPocById(initialSession.clientPocId)
      ]);
      const dedupeKey = `six_hour_completion:${initialSession.id}`;
      const auditPayload = {
        sessionId: initialSession.id,
        cycleId: initialSession.cycleId,
        projectId: initialSession.projectId,
        clientPocId: initialSession.clientPocId,
        reason: assessment.reason,
        dueAt: assessment.dueAt || null
      };
      const claim = await store.claimAutomationEvent(
        "six_hour_final_response_completion",
        auditPayload,
        dedupeKey
      );
      if (!claim) {
        duplicates.push({ sessionId: initialSession.id, dedupeKey });
        continue;
      }

      // Re-read after the unique claim. A client may have answered or the
      // normal flow may have completed while this scheduler was selecting rows.
      const session = await store.getSession(initialSession.id);
      const messages = typeof store.getMessagesForSession === "function"
        ? conversationRelevantMessages(await store.getMessagesForSession(initialSession.id))
        : [];
      assessment = inactiveFinalSweepEligibility(session, messages, now);
      if (!assessment.eligible && !assessment.closeWithoutMessage) {
        await completeAutomationClaim(store, claim, {
          eventType: "six_hour_final_response_completion",
          payload: { ...auditPayload, reason: assessment.reason },
          status: "skipped",
          webhookUrlConfigured: false,
          sentAt: nowIso
        });
        ignored += 1;
        continue;
      }

      const project = session.projectId === initialProject?.id
        ? initialProject
        : await store.getProjectById(session.projectId);
      const poc = session.clientPocId === initialPoc?.id
        ? initialPoc
        : await store.getClientPocById(session.clientPocId);

      // If the free-text service window has expired (or delivery details are
      // no longer available), close the completed feedback without trying an
      // impermissible or impossible WhatsApp send.
      if (
        assessment.closeWithoutMessage
        || !project
        || !poc
        || poc.active === false
        || !poc.contactWhatsapp
      ) {
        const reason = assessment.closeWithoutMessage
          ? assessment.reason
          : !poc?.contactWhatsapp
            ? "client_whatsapp_missing"
            : poc?.active === false
              ? "client_poc_inactive"
              : "project_or_poc_missing";
        const skippedState = claimedInactiveFinalSweepState(session, nowIso);
        delete skippedState.closingGraceExpiresAt;
        skippedState.state = STATES.COMPLETED;
        skippedState.sixHourAutoCompletionSkippedAt = nowIso;
        skippedState.sixHourAutoCompletionSkipReason = reason;
        skippedState.closureReason = "final_sweep_inactive_six_hours_no_message";
        const completed = await store.completeInactiveFinalSweep(session.id, skippedState, nowIso);
        await completeAutomationClaim(store, claim, {
          eventType: "six_hour_final_response_completion",
          payload: { ...auditPayload, reason },
          status: "skipped",
          webhookUrlConfigured: Boolean(process.env.N8N_MANUAL_MESSAGE_WEBHOOK),
          sentAt: nowIso
        });
        closedWithoutMessage.push({ session: completed, reason });
        await notifyCycleSummaryAfterAutomaticCompletion(store, completed, baseUrl);
        continue;
      }

      const previousState = { ...(session.conversationState || {}) };
      const claimedState = claimedInactiveFinalSweepState(session, nowIso);
      await store.markInactiveFinalSweepClaimed(session.id, claimedState);
      const text = closingGraceMessage(poc, claimedState);
      const requestId = `six-hour-completion-${session.id}`;
      const deliveryPayload = {
        sessionId: session.id,
        cycleId: session.cycleId,
        project,
        poc,
        to: poc.contactWhatsapp,
        text,
        requestId,
        reason: "final_sweep_inactive_six_hours"
      };
      const delivery = await emitAutomation("manual_whatsapp_message", deliveryPayload);
      await completeAutomationClaim(store, claim, {
        ...delivery,
        eventType: "six_hour_final_response_completion",
        payload: deliveryPayload,
        dedupeKey
      });

      if (delivery.status === "sent") {
        const sentAt = delivery.sentAt || nowIso;
        const completedState = {
          ...claimedState,
          sixHourAutoCompletionSentAt: sentAt,
          completionMessageSentAt: claimedState.completionMessageSentAt || sentAt,
          sixHourAutoCompletionDeliveryStatus: "sent"
        };
        const completed = await store.completeInactiveFinalSweep(
          session.id,
          completedState,
          sentAt
        );
        const message = await store.addMessage(session.id, {
          speaker: "SRV Media MD Office",
          side: "srv",
          body: text,
          metadata: {
            source: "six_hour_final_response_completion",
            state: STATES.CLOSING_GRACE,
            requestId,
            deliveryStatus: "accepted",
            deliveryStatusCode: delivery.statusCode || 200
          }
        });
        sent.push({ session: completed, message, correctionWindowEndsAt: completedState.closingGraceExpiresAt });
        await notifyCycleSummaryAfterAutomaticCompletion(store, completed, baseUrl);
        continue;
      }

      const deliveryUncertain = delivery.status === "failed" && !delivery.statusCode && Boolean(delivery.error);
      if (deliveryUncertain) {
        // A timeout may occur after Meta accepted the message. Treat it as an
        // uncertain one-time dispatch and never retry automatically: avoiding
        // a duplicate client message is more important than guessing.
        const uncertainState = {
          ...claimedState,
          sixHourAutoCompletionDeliveryUncertainAt: nowIso,
          sixHourAutoCompletionDeliveryStatus: "uncertain",
          sixHourAutoCompletionDeliveryError: delivery.error || null
        };
        const completed = await store.completeInactiveFinalSweep(session.id, uncertainState, nowIso);
        failed.push({ session: completed, delivery, retrySuppressed: true });
        await notifyCycleSummaryAfterAutomaticCompletion(store, completed, baseUrl);
      } else {
        const failedState = {
          ...previousState,
          sixHourAutoCompletionClaimedAt: nowIso,
          sixHourAutoCompletionFailedAt: nowIso,
          sixHourAutoCompletionDeliveryStatus: delivery.status,
          sixHourAutoCompletionDeliveryError: delivery.error || null,
          sixHourAutoCompletionDeliveryStatusCode: delivery.statusCode || null
        };
        if (typeof store.markInactiveFinalSweepDeliveryFailure === "function") {
          await store.markInactiveFinalSweepDeliveryFailure(
            session.id,
            failedState,
            session.reminderDueAt
          );
        }
        failed.push({ sessionId: session.id, delivery, retrySuppressed: true });
      }
    }

    return json(200, {
      now: nowIso,
      inactivityHours: INACTIVE_FINAL_SWEEP_MS / (60 * 60 * 1000),
      sent,
      closedWithoutMessage,
      closedExpiredCorrectionWindows: closed,
      duplicates,
      failed,
      ignored
    });
  }

  if (method === "GET" && pathname === "/api/automation/due-feedback") {
    if (!isAutomationAuthorized(request.headers)) return error(401, "Unauthorized automation request");
    const targets = await store.getDueFeedbackTargets(searchParams.get("now") || undefined);
    return json(200, { targets: automaticFeedbackTargets(targets) });
  }

  if (method === "POST" && pathname === "/api/automation/create-due-sessions") {
    if (!isAutomationAuthorized(request.headers)) return error(401, "Unauthorized automation request");
    if (!await whatsappMessagingEnabled(store)) return json(200, { paused: true, cycles: [], skipped: [] });
    const targets = automaticFeedbackTargets(await store.getDueFeedbackTargets(body.now));
    const cycles = [];
    const skipped = [];

    for (const target of targets) {
      try {
        cycles.push(await startCycle({
          store,
          projectKey: target.projectKey,
          cycleType: target.cycleType,
          baseUrl,
          reason: "scheduled",
          automatic: true
        }));
      } catch (cycleError) {
        // A project with no reachable POC must not abort the whole run.
        const skippedTarget = { projectKey: target.projectKey, cycleType: target.cycleType, reason: cycleError.message };
        skipped.push(skippedTarget);
        if (typeof store.recordAutomationEvent === "function") {
          try {
            await store.recordAutomationEvent({
              eventType: "cycle_start_skipped",
              status: "skipped",
              payload: skippedTarget,
              error: cycleError.message
            });
          } catch (auditError) {
            console.error("[automation] could not save skipped cycle audit:", auditError.message);
          }
        }
      }
    }

    return json(201, { cycles, skipped });
  }


  if (method === "POST" && pathname === "/api/automation/create-due-quick-checkins") {
    if (!isAutomationAuthorized(request.headers)) return error(401, "Unauthorized automation request");
    const nowIso = body.now || new Date().toISOString();
    if (!Number.isFinite(Date.parse(nowIso))) return error(400, "Invalid automation time");
    const expired = await expireQuickCheckinsAndNotify(store, nowIso, baseUrl);
    if (!await whatsappMessagingEnabled(store)) {
      return json(200, { paused: true, scheduleKey: null, cycles: [], skipped: [], expired: expired.expired });
    }
    const due = await store.getDueQuickCheckinTargets(body.now);
    const cycles = [];
    const skipped = [];

    for (const target of due.targets) {
      try {
        cycles.push(await startCycle({
          store,
          projectKey: target.projectKey,
          cycleType: "quick_checkin",
          scheduleKey: due.scheduleKey,
          baseUrl,
          reason: "scheduled_11th_or_21st",
          automatic: true
        }));
      } catch (cycleError) {
        const skippedTarget = { projectKey: target.projectKey, cycleType: "quick_checkin", reason: cycleError.message };
        skipped.push(skippedTarget);
        if (typeof store.recordAutomationEvent === "function") {
          try {
            await store.recordAutomationEvent({
              eventType: "quick_checkin_start_skipped",
              status: "skipped",
              payload: skippedTarget,
              error: cycleError.message
            });
          } catch (auditError) {
            console.error("[automation] could not save skipped quick check-in audit:", auditError.message);
          }
        }
      }
    }

    return json(201, { scheduleKey: due.scheduleKey, cycles, skipped, expired: expired.expired });
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
    const nowIso = body.now || new Date().toISOString();
    if (!Number.isFinite(Date.parse(nowIso))) return error(400, "Invalid automation time");
    await finalizeFeedbackWindowsAndNotify(store, nowIso, baseUrl);
    const expiredQuickCheckins = await expireQuickCheckinsAndNotify(store, nowIso, baseUrl);
    if (!await whatsappMessagingEnabled(store)) {
      return json(200, { paused: true, reminders: [], closed: [], deferredClosures: [], failed: [] });
    }
    const targets = await store.getDueReminderTargets(body.now);
    const reminders = [];
    const closed = [];
    const closureReviewTasks = [];
    const deferredClosures = [];

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
      // Finish each POC's analysis before taking their final summary snapshot.
      await Promise.all(closureReviewTasks.map((task) => task()));
      for (const entry of closed) {
        const latest = await store.getSession(entry.session.id) || entry.session;
        await notifyCycleSummaryAfterAutomaticCompletion(store, latest, baseUrl);
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
      expiredQuickCheckins: expiredQuickCheckins.expired,
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
    return json(200, {
      pinRequired: Boolean(process.env.ADMIN_PIN),
      authorized: isAdminAuthorized(request.headers),
      messaging: await messagingStatus(store)
    });
  }

  if (method === "GET" && pathname === "/api/admin/directory") {
    const directory = await store.getDirectory();
    const userManagementOnly = appAccess.role === "admin"
      && hasAppPermission(appAccess, "manage_project_users")
      && !["directory", "manage_records", "manage_pocs", "manage_internal_pocs", "manage_catalogues", "bulk_sends"]
        .some((permission) => hasAppPermission(appAccess, permission));
    if (userManagementOnly) {
      return json(200, {
        clusters: [], clients: [], projects: [], clientPocs: [], projectServices: [], pocLevels: [], departments: [], subDepartments: [], serviceCatalog: [],
        internalPocs: (directory.internalPocs || []).map((person) => ({
          id: person.id,
          name: person.name,
          email: person.email || "",
          active: person.active !== false
        }))
      });
    }
    return json(200, directory);
  }

  if (method === "GET" && pathname === "/api/admin/project-teams") {
    const performanceData = await store.getProjectPerformanceData();
    return json(200, {
      projects: performanceData.projects.map((project) => ({
        id: project.id,
        key: project.key,
        name: project.name,
        clientId: project.clientId,
        clientName: project.clientName,
        clusterName: project.clusterName,
        version: project.version || 0,
        team: project.team || {}
      }))
    });
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

  if (method === "PUT" && pathname === "/api/admin/project-teams") {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length || rows.length > 500) return error(400, "Select between 1 and 500 changed projects");
    const performanceData = await store.getProjectPerformanceData();
    const projectsById = new Map(performanceData.projects.map((project) => [project.id, project]));
    const validInternalPocIds = new Set((performanceData.internalPocs || []).map((person) => person.id));
    const teamFields = ["projectDirectorId", "amId", "tlId", "adId", "avpId"];
    const updatedBy = appAccess.email || appAccess.name || "Admin";
    const saved = [];
    for (const row of rows) {
      const project = projectsById.get(String(row.projectId || ""));
      if (!project) return error(404, "One of the selected projects was not found");
      const team = {};
      for (const field of teamFields) {
        const value = String(row.team?.[field] || "").trim();
        if (value && !validInternalPocIds.has(value)) return error(400, `${field} must be selected from Internal POCs`);
        team[field] = value || null;
      }
      try {
        const result = await store.saveProjectPerformance(
          project.id,
          projectPerformanceInputWithTeam(project, team, updatedBy)
        );
        saved.push({ projectId: project.id, version: result.version });
        project.version = result.version;
        project.team = team;
      } catch (saveError) {
        if (saveError.code === "PERFORMANCE_VERSION_CONFLICT") return error(409, saveError.message);
        return error(400, `Could not update the project team for ${project.name}`, saveError.message);
      }
    }
    return json(200, {
      saved,
      message: `${saved.length} project team${saved.length === 1 ? "" : "s"} updated and added to audit history.`
    });
  }

  if (method === "GET" && pathname === "/api/admin/app-users") {
    const users = await store.listAppUsers();
    return json(200, {
      users: (appAccess.role === "super_admin" ? users : users.filter((user) => user.role === "project_user"))
        .map((user) => ({ ...user, permissions: normalizedPermissions(user.role, user.permissions) })),
      roles: appAccess.role === "super_admin" ? ["super_admin", "admin", "project_user"] : ["project_user"]
    });
  }

  if (method === "POST" && pathname === "/api/admin/app-users") {
    const email = String(body.email || "").trim().toLowerCase();
    const role = String(body.role || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(400, "Enter a valid Google Workspace email");
    if (!["super_admin", "admin", "project_user"].includes(role)) return error(400, "Role must be Super Admin, Admin or Project User");
    if (appAccess.role !== "super_admin" && role !== "project_user") {
      return error(403, "Admins can only add Project Users");
    }
    let internalPocId = role === "project_user" ? String(body.internalPocId || "").trim() : null;
    const createLinkedInternalPoc = role === "project_user" && !internalPocId && body.createInternalPoc === true;
    if (role === "project_user" && !internalPocId && !createLinkedInternalPoc) {
      return error(400, "Select an existing Internal POC or choose Create new Internal POC");
    }
    if (internalPocId && !await store.internalPocById(internalPocId)) return error(400, "Selected Internal POC was not found");
    if (internalPocId && (await store.listAppUsers()).some((user) => user.internalPocId === internalPocId)) {
      return error(409, "That Internal POC is already linked to an Application User");
    }
    const allowedDomains = googleAllowedDomains();
    const domain = email.split("@")[1];
    if (allowedDomains.length && !allowedDomains.includes(domain)) return error(400, "Email must use an approved Google Workspace domain");
    if (await store.getAppUserByEmail(email)) return error(409, "That application user already exists");
    let createdInternalPoc = null;
    try {
      if (createLinkedInternalPoc) {
        const name = String(body.name || "").trim();
        if (name.length < 2) return error(400, "Enter the Project User's name");
        const existingInternalPoc = typeof store.internalPocByEmail === "function"
          ? await store.internalPocByEmail(email)
          : null;
        if (existingInternalPoc) {
          internalPocId = existingInternalPoc.id;
        } else {
          createdInternalPoc = await store.createInternalPoc({ name, email, active: true });
          internalPocId = createdInternalPoc.id;
        }
        if ((await store.listAppUsers()).some((user) => user.internalPocId === internalPocId)) {
          return error(409, "That Internal POC is already linked to an Application User");
        }
      }
      const user = await store.createAppUser({
        email,
        name: body.name,
        role,
        permissions: normalizedPermissions(role, body.permissions),
        internalPocId,
        active: body.active !== false,
        actor: appAccess.email || "Password Super Admin"
      });
      return json(201, { user, internalPoc: createdInternalPoc });
    } catch (createError) {
      if (createdInternalPoc?.id && typeof store.deleteInternalPoc === "function") {
        try { await store.deleteInternalPoc(createdInternalPoc.id); } catch { /* preserve original error */ }
      }
      return error(400, "Could not add application user", createError.message);
    }
  }

  const appUserMatch = pathname.match(/^\/api\/admin\/app-users\/([^/]+)$/);
  if (method === "PATCH" && appUserMatch) {
    const appUserId = decodeURIComponent(appUserMatch[1]);
    const users = await store.listAppUsers();
    const existing = users.find((item) => item.id === appUserId);
    if (!existing) return error(404, "Application user not found");
    if (appAccess.role !== "super_admin" && existing.role !== "project_user") {
      return error(403, "Admins cannot change Super Admin or Admin accounts");
    }
    const role = body.role === undefined ? existing.role : String(body.role || "");
    const active = body.active === undefined ? existing.active : Boolean(body.active);
    if (!["super_admin", "admin", "project_user"].includes(role)) return error(400, "Role must be Super Admin, Admin or Project User");
    if (appAccess.role !== "super_admin" && role !== "project_user") {
      return error(403, "Admins can only manage Project Users");
    }
    const internalPocId = role === "project_user"
      ? String(body.internalPocId === undefined ? existing.internalPocId || "" : body.internalPocId || "").trim()
      : null;
    if (role === "project_user" && !internalPocId) return error(400, "Select the Internal POC this Project User represents");
    if (internalPocId && !await store.internalPocById(internalPocId)) return error(400, "Selected Internal POC was not found");
    if (internalPocId && users.some((user) => user.id !== appUserId && user.internalPocId === internalPocId)) {
      return error(409, "That Internal POC is already linked to another Application User");
    }
    const removesActiveSuperAdmin = existing.role === "super_admin" && existing.active && (role !== "super_admin" || !active);
    if (removesActiveSuperAdmin && await store.activeSuperAdminCount() <= 1) {
      return error(409, "Keep at least one active Super Admin");
    }
    const user = await store.updateAppUser(appUserId, {
      name: body.name,
      role,
      permissions: normalizedPermissions(role, body.permissions === undefined ? existing.permissions : body.permissions),
      internalPocId,
      active,
      actor: appAccess.email || "Password Super Admin"
    });
    return json(200, { user });
  }

  if (method === "DELETE" && appUserMatch) {
    const appUserId = decodeURIComponent(appUserMatch[1]);
    const users = await store.listAppUsers();
    const existing = users.find((item) => item.id === appUserId);
    if (!existing) return error(404, "Application user not found");
    if (appAccess.appUserId === appUserId) {
      return error(409, "You cannot delete your own Application User account");
    }
    if (existing.role === "super_admin") {
      return error(409, "Super Admin accounts cannot be deleted", "Keep the account for access continuity, or deactivate it after another active Super Admin exists.");
    }
    if (appAccess.role !== "super_admin" && existing.role !== "project_user") {
      return error(403, "Admins cannot delete Super Admin or Admin accounts");
    }
    const result = await store.deleteAppUserIfNoHistory(appUserId);
    if (!result) return error(404, "Application user not found");
    if (result.action === "blocked") {
      return error(409, "This Application User has Project Performance history and cannot be deleted", "Deactivate the account instead so its saved update and audit attribution is retained.");
    }
    return json(200, result);
  }

  const PERFORMANCE_STANDARD_CATEGORIES = new Set([
    "client_group", "client_criticality", "project_type", "revenue_category", "portfolio_type", "currency",
    "performance_status", "current_phase", "campaign_status", "client_sentiment", "relationship_strength",
    "meeting_cadence", "suggestion_frequency", "kpi_name"
  ]);

  if (method === "GET" && pathname === "/api/admin/performance-standards") {
    return json(200, { values: await store.listPerformanceReferenceValues({ includeInactive: true }) });
  }

  if (method === "POST" && pathname === "/api/admin/performance-standards") {
    const category = String(body.category || "").trim();
    const value = String(body.value || "").trim();
    if (!PERFORMANCE_STANDARD_CATEGORIES.has(category)) return error(400, "Unknown Project Performance standard category");
    if (!value) return error(400, "Standard value is required");
    try {
      return json(201, { value: await store.createPerformanceReferenceValue({ category, value, sortOrder: body.sortOrder, active: body.active }) });
    } catch (createError) {
      return error(409, "That standard value already exists", createError.message);
    }
  }

  const performanceStandardMatch = pathname.match(/^\/api\/admin\/performance-standards\/([^/]+)$/);
  if (method === "PATCH" && performanceStandardMatch) {
    const value = String(body.value || "").trim();
    if (!value) return error(400, "Standard value is required");
    try {
      const saved = await store.updatePerformanceReferenceValue(decodeURIComponent(performanceStandardMatch[1]), {
        value,
        sortOrder: body.sortOrder,
        active: body.active
      });
      if (!saved) return error(404, "Standard value not found");
      return json(200, { value: saved });
    } catch (updateError) {
      return error(409, "Could not update that standard value", updateError.message);
    }
  }

  if (method === "DELETE" && performanceStandardMatch) {
    const result = await store.deletePerformanceReferenceValue(decodeURIComponent(performanceStandardMatch[1]));
    if (!result) return error(404, "Standard value not found");
    return json(200, result);
  }

  if (method === "PATCH" && pathname === "/api/admin/messaging") {
    if (typeof body.enabled !== "boolean") return error(400, "enabled must be true or false");
    const messaging = await store.setMessagingStatus(body.enabled, "Manage admin");
    if (typeof store.recordAutomationEvent === "function") {
      await store.recordAutomationEvent({
        eventType: body.enabled ? "whatsapp_messaging_resumed" : "whatsapp_messaging_paused",
        status: "recorded",
        payload: { ...messaging, emailAutomationUnaffected: true },
        sentAt: messaging.updatedAt
      });
    }
    return json(200, { messaging });
  }

  if (method === "POST" && pathname === "/api/admin/project-automation/preview") {
    try {
      const projects = await buildBulkAutomationPreview(store, body);
      return json(200, {
        projects,
        eligibleProjects: projects.filter((project) => project.eligible).length,
        blockedProjects: projects.filter((project) => !project.eligible).length
      });
    } catch (previewError) {
      return error(400, previewError.message);
    }
  }

  if (method === "PUT" && pathname === "/api/admin/project-automation/bulk") {
    let preview;
    try {
      preview = await buildBulkAutomationPreview(store, body);
    } catch (previewError) {
      return error(400, previewError.message);
    }

    const updated = [];
    const skipped = preview.filter((project) => !project.eligible);
    for (const project of preview.filter((item) => item.eligible)) {
      try {
        const input = {};
        if (typeof body.automaticFeedbackEnabled === "boolean") {
          input.automaticFeedbackEnabled = body.automaticFeedbackEnabled;
        }
        if (typeof body.automaticQuickCheckinEnabled === "boolean") {
          input.automaticQuickCheckinEnabled = body.automaticQuickCheckinEnabled;
        }
        const saved = await store.updateProjectAutomationSettings(project.projectId, input);
        if (!saved) {
          skipped.push({ ...project, eligible: false, reasons: ["project no longer exists"] });
          continue;
        }
        updated.push({
          ...project,
          automaticFeedbackEnabled: saved.automaticFeedbackEnabled !== false,
          automaticQuickCheckinEnabled: saved.automaticQuickCheckinEnabled !== false,
          automaticQuickCheckinResumeAt: saved.automaticQuickCheckinResumeAt || null,
          nextCycleDueAt: saved.nextCycleDueAt || null
        });
      } catch (updateError) {
        skipped.push({ ...project, eligible: false, reasons: [updateError.message] });
      }
    }

    if (updated.length && typeof store.recordAutomationEvent === "function") {
      await store.recordAutomationEvent({
        eventType: "project_automatic_sending_bulk_changed",
        status: skipped.length ? "partial" : "recorded",
        webhookUrlConfigured: false,
        sentAt: new Date().toISOString(),
        payload: {
          projectIds: updated.map((project) => project.projectId),
          projectCount: updated.length,
          automaticFeedbackEnabled: typeof body.automaticFeedbackEnabled === "boolean"
            ? body.automaticFeedbackEnabled
            : "unchanged",
          automaticQuickCheckinEnabled: typeof body.automaticQuickCheckinEnabled === "boolean"
            ? body.automaticQuickCheckinEnabled
            : "unchanged",
          existingCyclesSessionsAndPocWeightsChanged: false,
          changedBy: appAccess?.email || appAccess?.name || "Password Super Admin"
        }
      });
    }

    return json(200, {
      updated,
      skipped,
      updatedProjects: updated.length,
      skippedProjects: skipped.length,
      message: "Automatic sending settings updated. Existing cycles, sessions and POC weights were not changed."
    });
  }

  if (method === "POST" && pathname === "/api/admin/bulk-feedback/preview") {
    const cycleType = body.cycleType === "quick_checkin" ? "quick_checkin" : "pulse";
    const projectIds = Array.isArray(body.projectIds) ? body.projectIds : null;
    const projects = await buildBulkSendPreview(store, cycleType, projectIds);
    return json(200, {
      cycleType,
      messaging: await messagingStatus(store),
      projects,
      eligibleProjects: projects.filter((project) => project.eligible).length,
      eligiblePocs: projects.reduce((sum, project) => sum + project.eligiblePocs.length, 0)
    });
  }

  if (method === "POST" && pathname === "/api/admin/bulk-feedback/send") {
    if (!await whatsappMessagingEnabled(store)) return pausedMessagingResponse(store);
    const cycleType = body.cycleType === "quick_checkin" ? "quick_checkin" : "pulse";
    const projectIds = Array.isArray(body.projectIds)
      ? [...new Set(body.projectIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : [];
    if (!projectIds.length) return error(400, "Select at least one project from the preview");
    const preview = await buildBulkSendPreview(store, cycleType, projectIds);
    const sent = [];
    const skipped = preview.filter((project) => !project.eligible);
    for (const row of preview.filter((project) => project.eligible)) {
      try {
        sent.push(await startCycle({
          store,
          projectKey: row.projectKey,
          cycleType,
          baseUrl,
          reason: "manage_bulk_send",
          clientPocIds: row.eligiblePocs.map((poc) => poc.id)
        }));
      } catch (sendError) {
        skipped.push({ ...row, eligible: false, reasons: [sendError.message] });
      }
    }
    return json(201, {
      cycleType,
      sent,
      skipped,
      projectsStarted: sent.length,
      messagesQueued: sent.reduce((sum, item) => sum + item.dispatched.length, 0)
    });
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

  if (method === "DELETE" && internalPocUpdateMatch) {
    const internalPocId = decodeURIComponent(internalPocUpdateMatch[1]);
    const result = await store.deleteInternalPoc(internalPocId);
    if (!result.internalPocsDeleted) return error(404, "Internal POC not found");
    return json(200, result);
  }

  const departmentDeleteMatch = pathname.match(/^\/api\/admin\/departments\/([^/]+)$/);
  if (method === "DELETE" && departmentDeleteMatch) {
    const result = await store.deleteDepartment(decodeURIComponent(departmentDeleteMatch[1]));
    if (!result.departmentsDeleted) return error(404, "Department not found");
    return json(200, result);
  }

  const subDepartmentDeleteMatch = pathname.match(/^\/api\/admin\/sub-departments\/([^/]+)$/);
  if (method === "DELETE" && subDepartmentDeleteMatch) {
    const result = await store.deleteSubDepartment(decodeURIComponent(subDepartmentDeleteMatch[1]));
    if (!result.subDepartmentsDeleted) return error(404, "Sub-department not found");
    return json(200, result);
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

  if (method === "POST" && pathname === "/api/admin/service-catalog") {
    const name = String(body.name || "").trim();
    if (!name) return error(400, "Service name is required");
    const serviceKey = serviceIdentifier(name);
    if (await store.serviceCatalogConflict(name, serviceKey)) {
      return error(409, "That service already exists in the catalogue", name);
    }
    return json(201, {
      service: await store.createServiceCatalogItem({ name, serviceKey, active: body.active !== false })
    });
  }

  if (method === "POST" && pathname === "/api/admin/service-catalog/bulk") {
    const requested = Array.isArray(body.services) ? body.services : [];
    if (!requested.length) return error(400, "Add at least one service");
    if (requested.length > 100) return error(400, "Add no more than 100 services at once");
    const prepared = [];
    const seenNames = new Set();
    const seenKeys = new Set();
    for (let index = 0; index < requested.length; index += 1) {
      const name = String(requested[index]?.name || "").trim();
      if (!name) return error(400, `Service ${index + 1}: name is required`);
      const serviceKey = serviceIdentifier(name);
      if (seenNames.has(name.toLowerCase()) || seenKeys.has(serviceKey)) {
        return error(400, `Service ${index + 1}: duplicates another service in this list`, name);
      }
      if (await store.serviceCatalogConflict(name, serviceKey)) {
        return error(409, `Service ${index + 1}: already exists in the catalogue`, name);
      }
      seenNames.add(name.toLowerCase());
      seenKeys.add(serviceKey);
      prepared.push({ name, serviceKey, active: true });
    }
    const services = [];
    for (const item of prepared) services.push(await store.createServiceCatalogItem(item));
    return json(201, { services });
  }

  const serviceCatalogMatch = pathname.match(/^\/api\/admin\/service-catalog\/([^/]+)$/);
  if (method === "PATCH" && serviceCatalogMatch) {
    const serviceCatalogId = decodeURIComponent(serviceCatalogMatch[1]);
    const current = await store.getServiceCatalogItem(serviceCatalogId);
    if (!current) return error(404, "Catalogue service not found");
    const name = body.name === undefined ? current.name : String(body.name || "").trim();
    if (!name) return error(400, "Service name is required");
    if (await store.serviceCatalogConflict(name, current.serviceKey, serviceCatalogId)) {
      return error(409, "That service name is already used", name);
    }
    const service = await store.updateServiceCatalogItem(serviceCatalogId, {
      name,
      active: body.active === undefined ? current.active : body.active
    });
    return json(200, { service });
  }

  if (method === "DELETE" && serviceCatalogMatch) {
    const result = await store.deleteOrArchiveServiceCatalogItem(decodeURIComponent(serviceCatalogMatch[1]));
    if (result.action === "deleted" && !result.deleted) return error(404, "Catalogue service not found");
    return json(200, result);
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

  if (method === "POST" && pathname === "/api/admin/organization-standards/bulk") {
    const clusterNames = [...new Set((Array.isArray(body.clusters) ? body.clusters : []).map((item) => String(item || "").trim()).filter(Boolean))];
    const departmentNames = [...new Set((Array.isArray(body.departments) ? body.departments : []).map((item) => String(item || "").trim()).filter(Boolean))];
    const subDepartmentRows = (Array.isArray(body.subDepartments) ? body.subDepartments : [])
      .map((item) => ({ departmentId: String(item?.departmentId || "").trim(), name: String(item?.name || "").trim() }))
      .filter((item) => item.name || item.departmentId);
    if (!clusterNames.length && !departmentNames.length && !subDepartmentRows.length) {
      return error(400, "Add at least one Cluster, Department or Sub-department");
    }
    if (clusterNames.length + departmentNames.length + subDepartmentRows.length > 150) {
      return error(400, "Add no more than 150 organization standards in one save");
    }
    const directory = await store.getDirectory();
    const clusterKeys = new Set((directory.clusters || []).map((item) => item.name.trim().toLowerCase()));
    const departmentKeys = new Set((directory.departments || []).map((item) => item.name.trim().toLowerCase()));
    const departmentIds = new Set((directory.departments || []).map((item) => item.id));
    const subKeys = new Set((directory.subDepartments || []).map((item) => `${item.departmentId}|${item.name.trim().toLowerCase()}`));
    const created = { clusters: [], departments: [], subDepartments: [] };
    for (const name of clusterNames) {
      const key = name.toLowerCase();
      if (clusterKeys.has(key)) continue;
      created.clusters.push(await store.createCluster({ name }));
      clusterKeys.add(key);
    }
    for (const name of departmentNames) {
      const key = name.toLowerCase();
      if (departmentKeys.has(key)) continue;
      created.departments.push(await store.createDepartment({ name }));
      departmentKeys.add(key);
    }
    for (let index = 0; index < subDepartmentRows.length; index += 1) {
      const row = subDepartmentRows[index];
      if (!row.departmentId || !departmentIds.has(row.departmentId)) return error(400, `Sub-department ${index + 1}: select an existing Department`);
      if (!row.name) return error(400, `Sub-department ${index + 1}: name is required`);
      const key = `${row.departmentId}|${row.name.toLowerCase()}`;
      if (subKeys.has(key)) continue;
      created.subDepartments.push(await store.createSubDepartment(row));
      subKeys.add(key);
    }
    return json(201, { created });
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
    const client = await store.createClient({ ...body, name, key });
    await notifySetupRecordCreated(store, {
      kind: "client",
      client,
      actor: appAccess.email || appAccess.name || "Password Super Admin",
      source: "Manage",
      baseUrl
    });
    return json(201, { client });
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

  if (method === "GET" && pathname === "/api/admin/import-workbook-template") {
    const directory = await store.getDirectory();
    const workbook = await buildCsatImportWorkbook(directory);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return json(200, {
      filename: `SRV_CSAT_Client_Project_Import_${new Date().toISOString().slice(0, 10)}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: buffer.toString("base64")
    });
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
    if (!services.length) return error(400, "Add at least one service before saving the project");
    if (pocs.length > 50 || services.length > 50) return error(400, "A project setup can contain at most 50 POCs and 50 services");

    const levels = typeof store.pocLevels === "function" ? await store.pocLevels() : null;
    const seenPhones = new Set();
    const preparedPocs = [];
    let activePocWeightTotal = 0;
    for (let index = 0; index < pocs.length; index += 1) {
      const row = pocs[index] || {};
      const active = row.active !== false;
      const number = String(row.contactWhatsapp || "").replace(/\D/g, "");
      const weightPercentage = active ? Number(row.weightPercentage) : 0;
      if (!String(row.name || "").trim()) return error(400, `POC ${index + 1}: name is required`);
      if (!validOptionalIsoDate(row.birthDate)) return error(400, `POC ${index + 1}: birthday must be YYYY-MM-DD`);
      if (number && (number.length < 10 || number.length > 15)) return error(400, `POC ${index + 1}: WhatsApp number must be 10-15 digits including country code`);
      if (number && seenPhones.has(number)) return error(400, `POC ${index + 1}: WhatsApp number appears twice on this project`);
      if (active && (!String(row.levelId || "").trim() || (levels && !levels.has(row.levelId)))) {
        return error(400, `POC ${index + 1}: select Normal or Important`);
      }
      if (active && (!Number.isFinite(weightPercentage) || weightPercentage <= 0 || weightPercentage > 100)) {
        return error(400, `POC ${index + 1}: influence must be more than 0% and no more than 100%`);
      }
      if (number) {
        seenPhones.add(number);
      }
      if (active) activePocWeightTotal += weightPercentage;
      preparedPocs.push({ ...row, name: String(row.name).trim(), contactWhatsapp: number, weightPercentage, active });
    }
    if (preparedPocs.some((poc) => poc.active) && Math.abs(activePocWeightTotal - 100) > 0.01) {
      return error(400, `Active POC influence must total exactly 100%; the current total is ${Math.round(activePocWeightTotal * 100) / 100}%`);
    }

    const seenServiceKeys = new Set();
    const preparedServices = [];
    for (let index = 0; index < services.length; index += 1) {
      const row = services[index] || {};
      const catalog = typeof store.getServiceCatalogItem === "function"
        ? await store.getServiceCatalogItem(String(row.serviceCatalogId || "").trim())
        : null;
      if (typeof store.getServiceCatalogItem === "function" && (!catalog || !catalog.active)) {
        return error(400, `Service ${index + 1}: select an active service from the catalogue`);
      }
      const name = catalog ? catalog.name : String(row.name || "").trim();
      if (!name) return error(400, `Service ${index + 1}: name is required`);
      const serviceKey = catalog ? catalog.serviceKey : serviceIdentifier(name);
      if (seenServiceKeys.has(serviceKey)) return error(400, `Service ${index + 1}: ${name} duplicates another service`);
      seenServiceKeys.add(serviceKey);
      preparedServices.push({ ...row, name, serviceKey, serviceCatalogId: catalog?.id || null });
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
    const directory = await store.getDirectory();
    const client = (directory.clients || []).find((item) => item.id === project.clientId) || { id: project.clientId, name: "Unknown client" };
    await notifySetupRecordCreated(store, {
      kind: "project",
      client,
      project,
      actor: appAccess.email || appAccess.name || "Password Super Admin",
      source: "Manage complete project setup",
      baseUrl
    });
    return json(201, { project, pocs: createdPocs, services: createdServices });
  }

  const projectPocsMatch = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/pocs$/);
  if (method === "PUT" && projectPocsMatch) {
    const projectId = decodeURIComponent(projectPocsMatch[1]);
    const requested = Array.isArray(body.pocs) ? body.pocs : [];
    const removedIds = [...new Set((Array.isArray(body.removedIds) ? body.removedIds : []).map(String))];
    if (requested.length > 50) return error(400, "A project can contain at most 50 POCs in one save");
    if (removedIds.length > 50) return error(400, "Remove no more than 50 project POCs in one save");

    const directory = await store.getDirectory();
    const project = (directory.projects || []).find((item) => item.id === projectId);
    if (!project) return error(404, "Project not found");
    const current = await store.pocsForProject(projectId, { activeOnly: false });
    const currentById = new Map(current.map((poc) => [poc.id, poc]));
    const invalidRemoval = removedIds.find((id) => !currentById.has(id));
    if (invalidRemoval) return error(400, "A removed POC does not belong to this project", invalidRemoval);
    const removedSet = new Set(removedIds);
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
      if (id && removedSet.has(id)) return error(400, `POC ${index + 1}: a record cannot be saved and removed together`);
      if (id && seenIds.has(id)) return error(400, `POC ${index + 1}: record appears more than once`);
      if (!String(row.name || "").trim()) return error(400, `POC ${index + 1}: name is required`);
      if (!validOptionalIsoDate(row.birthDate)) return error(400, `POC ${index + 1}: birthday must be YYYY-MM-DD`);
      if (phone && (phone.length < 10 || phone.length > 15)) {
        return error(400, `POC ${index + 1}: WhatsApp number must be 10-15 digits including country code`);
      }
      if (phone && seenPhones.has(phone)) return error(400, `POC ${index + 1}: WhatsApp number appears twice on this project`);
      if (active && (!String(row.levelId || "").trim() || (levels && !levels.has(row.levelId)))) {
        return error(400, `POC ${index + 1}: select a Normal or Important tag`);
      }
      if (active && (!Number.isFinite(weightPercentage) || weightPercentage <= 0 || weightPercentage > 100)) {
        return error(400, `POC ${index + 1}: influence must be more than 0% and no more than 100%`);
      }
      if (phone) {
        const conflict = await pocWhatsappConflict(store, phone, projectId, id || null);
        if (conflict?.kind === "same_project" && !removedSet.has(conflict.owner?.id)) {
          return error(409, `POC ${index + 1}: WhatsApp number is already configured on this project`, conflict.owner?.name);
        }
        seenPhones.add(phone);
      }
      if (id) seenIds.add(id);
      if (active) activeWeightTotal += weightPercentage;
      prepared.push({ ...row, id, projectId, name: String(row.name).trim(), contactWhatsapp: phone, active, weightPercentage });
    }

    if (prepared.some((row) => row.active) && Math.abs(activeWeightTotal - 100) > 0.01) {
      return error(400, `Active POC influence must total exactly 100%; the current total is ${Math.round(activeWeightTotal * 100) / 100}%`);
    }
    return json(200, await store.saveProjectPocBatch(projectId, prepared, removedIds));
  }

  if (method === "PUT" && pathname === "/api/admin/pocs/bulk-control") {
    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (!updates.length) return error(400, "Select at least one POC assignment to update");
    if (updates.length > 1000) return error(400, "Update no more than 1000 POC assignments at once");

    const seen = new Set();
    const prepared = [];
    const currentByProject = new Map();
    const levels = typeof store.pocLevels === "function" ? await store.pocLevels() : null;
    for (const item of updates) {
      const id = String(item?.id || "").trim();
      if (!id || seen.has(id)) return error(400, "Every POC update needs a unique ID");
      seen.add(id);
      const current = await store.getClientPocById(id);
      if (!current) return error(404, "Client POC not found", id);
      if (current.removedAt) return error(409, "This POC has been removed from the project", id);
      const active = item.active !== false;
      const weightPercentage = active ? Number(item.weightPercentage) : 0;
      if (active && (!Number.isFinite(weightPercentage) || weightPercentage <= 0 || weightPercentage > 100)) {
        return error(400, `${current.name}: active influence must be more than 0% and no more than 100%`);
      }
      const levelId = String(item.levelId || current.levelId || "").trim();
      const salutation = String(item.salutation ?? current.salutation ?? current.name ?? "").trim();
      if (active && (!levelId || (levels && !levels.has(levelId)))) {
        return error(400, `${current.name}: select a Normal or Important tag before activation`);
      }
      prepared.push({ current, active, weightPercentage, levelId, salutation });
      if (!currentByProject.has(current.projectId)) {
        currentByProject.set(current.projectId, await store.pocsForProject(current.projectId, { activeOnly: false }));
      }
    }

    const updateById = new Map(prepared.map((item) => [item.current.id, item]));
    for (const [projectId, projectPocs] of currentByProject) {
      const finalRows = projectPocs.map((poc) => {
        const change = updateById.get(poc.id);
        return change ? { ...poc, active: change.active, weightPercentage: change.weightPercentage } : poc;
      });
      const activeRows = finalRows.filter((poc) => poc.active);
      const total = Math.round(activeRows.reduce((sum, poc) => sum + (Number(poc.weightPercentage) || 0), 0) * 100) / 100;
      if (activeRows.length && Math.abs(total - 100) > 0.01) {
        const project = await store.getProjectById(projectId);
        return error(400, `${project?.name || "Project"}: active POC influence must total exactly 100%`, { total });
      }
    }

    const pocs = [];
    for (const item of prepared) {
      pocs.push(await store.updateClientPoc(item.current.id, {
        salutation: item.salutation || null,
        active: item.active,
        weightPercentage: item.weightPercentage,
        levelId: item.levelId || null
      }));
    }
    return json(200, { pocs, updated: pocs.length });
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
      const existing = row.id ? currentById.get(row.id) : null;
      const requestedCatalogId = row.serviceCatalogId || existing?.serviceCatalogId || "";
      const catalog = typeof store.getServiceCatalogItem === "function"
        ? await store.getServiceCatalogItem(String(requestedCatalogId).trim())
        : null;
      if (typeof store.getServiceCatalogItem === "function" && (!catalog || !catalog.active)) {
        return error(400, `Service ${index + 1}: select an active service from the catalogue`);
      }
      const name = catalog ? catalog.name : String(row.name || "").trim();
      if (!name) return error(400, `Service ${index + 1}: name is required`);
      if (row.id && !currentById.has(row.id)) return error(400, `Service ${index + 1} does not belong to this project`);
      if (row.id && seenIds.has(row.id)) return error(400, `Service ${index + 1} was included twice`);
      const serviceKey = catalog ? catalog.serviceKey : row.id ? currentById.get(row.id).serviceKey : serviceIdentifier(name);
      if (seenKeys.has(serviceKey)) return error(400, `Service ${index + 1}: ${name} duplicates another service`);
      if (row.id) seenIds.add(row.id);
      seenKeys.add(serviceKey);
      prepared.push({ ...row, name, serviceKey, serviceCatalogId: catalog?.id || null, projectId });
    }

    const currentScope = [...new Set(current.map((service) => service.serviceKey))].sort();
    const requestedScope = [...new Set(prepared.map((service) => service.serviceKey))].sort();
    const serviceScopeChanged = currentScope.length !== requestedScope.length
      || currentScope.some((serviceKey, index) => serviceKey !== requestedScope[index]);
    if (serviceScopeChanged && typeof store.hasOpenFeedbackCycle === "function" && await store.hasOpenFeedbackCycle(projectId)) {
      return error(
        409,
        "Project services cannot be added or removed while a feedback cycle is open",
        "Close or complete the current cycle first so its service scope cannot change mid-conversation. Owners and KPI notes may still be updated without changing the service list."
      );
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
          internalPocId: service.internalPocId,
          serviceCatalogId: service.serviceCatalogId
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
    const directory = await store.getDirectory();
    const client = (directory.clients || []).find((item) => item.id === clientId) || { id: clientId, name: "Unknown client" };
    for (const input of prepared) {
      const project = await store.createProject(input);
      projects.push(project);
      await notifySetupRecordCreated(store, {
        kind: "project",
        client,
        project,
        actor: appAccess.email || appAccess.name || "Password Super Admin",
        source: "Manage bulk project upload",
        baseUrl
      });
    }
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
    const directory = await store.getDirectory();
    const client = (directory.clients || []).find((item) => item.id === project.clientId) || { id: project.clientId, name: "Unknown client" };
    await notifySetupRecordCreated(store, {
      kind: "project",
      client,
      project,
      actor: appAccess.email || appAccess.name || "Password Super Admin",
      source: "Manage",
      baseUrl
    });
    return json(201, { project });
  }

  if (method === "PUT" && pathname === "/api/admin/projects/bulk-status") {
    const projectIds = [...new Set((Array.isArray(body.projectIds) ? body.projectIds : []).map((value) => String(value || "").trim()).filter(Boolean))];
    const activeStatus = String(body.activeStatus || "").trim().toLowerCase();
    if (!projectIds.length || projectIds.length > 500) return error(400, "Select between 1 and 500 projects");
    if (!["active", "paused", "closed"].includes(activeStatus)) return error(400, "Project status must be active, paused or closed");
    const directory = await store.getDirectory();
    const projectsById = new Map((directory.projects || []).map((project) => [project.id, project]));
    const missingIds = projectIds.filter((projectId) => !projectsById.has(projectId));
    if (missingIds.length) return error(404, "One or more selected projects were not found");
    const changedProjects = projectIds
      .map((projectId) => projectsById.get(projectId))
      .filter((project) => project.activeStatus !== activeStatus);
    const updated = [];
    for (const project of changedProjects) {
      const saved = await store.updateProject(project.id, { activeStatus });
      if (!saved) return error(404, `Project not found: ${project.name}`);
      if (activeStatus === "active" && typeof store.ensureProjectSchedule === "function") {
        await store.ensureProjectSchedule(project.id);
      }
      updated.push(saved);
    }
    return json(200, {
      projects: updated,
      updated: updated.length,
      unchanged: projectIds.length - updated.length,
      activeStatus,
      message: `${updated.length} project${updated.length === 1 ? "" : "s"} changed to ${activeStatus}${projectIds.length - updated.length ? `; ${projectIds.length - updated.length} already had that status` : ""}.`
    });
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
    }
    return json(201, { poc: await store.createClientPoc(body) });
  }

  const pocUpdateMatch = pathname.match(/^\/api\/admin\/pocs\/([^/]+)$/);
  if (method === "PATCH" && pocUpdateMatch) {
    const pocId = decodeURIComponent(pocUpdateMatch[1]);
    const currentPoc = await store.getClientPocById(pocId);
    if (!currentPoc) return error(404, "POC not found");
    if (currentPoc.removedAt) return error(409, "This POC has been removed from the project");
    if (body.projectId !== undefined && body.projectId !== currentPoc.projectId) {
      return error(400, "A POC cannot be moved to another project. Copy it into that project's POC list instead.");
    }
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
    const detail = await store.getClientDetail(clientId, { includeRemoved: true });
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
    internalSummaryLanguage,
    clientFacingAcknowledgement,
    fallbackForAction,
    closingGraceMessage,
    rememberAcknowledgedConcerns,
    recordRequiredQuestion,
    setStateForRequiredAction,
    acceptedOverallRating,
    applyTurnServiceScope,
    validatedAnswerMarkers,
    scopeCapturedToPendingQuestion,
    groundMultiServiceCaptures,
    resetFreshCapturedServices,
    reconcilePendingServiceArtifacts,
    settleActionableFinalSweepFacts,
    suppressDuplicateIssues,
    mergeObservations,
    separateAppreciations,
    ensureClientAppreciations,
    openAppreciationFollowUp,
    suppressBroadOverallServiceGuess,
    applyPendingIssueInterpretation,
    normalizeLegacyServiceFollowups,
    applyConversationInterruption,
    observationFromInterpretation,
    fallbackDeliveryObservation,
    fallbackGeneralConcernObservation,
    fallbackRoleAppreciations,
    groundedObservationTopic,
    groundModelFact,
    groundLatestReplyInterpretation,
    responseIntroducesUnsupportedTopic,
    fallbackQuickCheckinConcerns,
    enrichConductedWithDeterministicFacts,
    enrichQuickCheckinInterpretation,
    canonicalObservationTopic,
    applyDeferredInterpretation,
    isExplicitActionRequest,
    explicitRequestTopic,
    latestExplicitOverallRating,
    clientBurstContext,
    manualQuestionType,
    applyManualQuestionContext,
    hasMandatoryFinalSweepScores,
    finalSweepPromptMessage,
    inactiveFinalSweepEligibility,
    claimedInactiveFinalSweepState
  }
};

function quickCheckinButton(body) {
  const payload = String(body.buttonPayload || body.buttonId || "").trim();
  if (payload.startsWith("QC_ALL_GOOD:")) return "all_good";
  if (payload.startsWith("QC_SHARE_FEEDBACK:")) return "share_feedback";
  return null;
}

function quickCheckinSessionId(body) {
  const payload = String(body.buttonPayload || body.buttonId || "").trim();
  const match = payload.match(/^QC_(?:ALL_GOOD|SHARE_FEEDBACK):(.+)$/);
  return match ? match[1] : null;
}

function normalizedQuickCheckinReply(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

function quickCheckinCoveredReply(text) {
  const normalized = normalizedQuickCheckinReply(text);
  return /^(?:everything|it|that|this)\s+(?:is|was|has been)?\s*(?:already\s+)?(?:covered|sorted|handled)(?:\s+for now)?$/i.test(normalized)
    || /^(?:all|everything)\s+(?:covered|sorted|handled)(?:\s+for now)?$/i.test(normalized)
    || /^(?:nothing|no)\s+(?:else|more|further)(?:\s+(?:to add|from (?:me|my side)|at the moment|for now))?$/i.test(normalized)
    || /^(?:that's|that is)\s+(?:all|it)(?:\s+(?:from (?:me|my side)|for now))?$/i.test(normalized)
    || /^(?:done|covered|sorted)(?:\s+for now)?$/i.test(normalized);
}

function quickCheckinMeetingReferenceWithoutDetail(text) {
  const normalized = normalizedQuickCheckinReply(text);
  const subjectFirst = /^(?:(?:the\s+)?same|it|this|that)\s+(?:(?:was|has been|is)\s+)?(?:already\s+)?(?:discussed|covered|mentioned|raised|shared|taken up)\s+(?:(?:in|during|on)\s+)?(?:the\s+)?(?:today's\s+)?(?:meeting|call|discussion)(?:\s+today)?$/i;
  const actionFirst = /^(?:we\s+)?(?:have\s+)?(?:already\s+)?(?:discussed|covered|mentioned|raised|shared|taken up|spoke about|talked about)\s+(?:(?:the\s+)?same|it|this|that)?\s*(?:(?:in|during|on)\s+)?(?:the\s+)?(?:today's\s+)?(?:meeting|call|discussion)(?:\s+today)?$/i;
  return subjectFirst.test(normalized) || actionFirst.test(normalized);
}

function quickCheckinAcknowledgementReply(text) {
  const normalized = normalizedQuickCheckinReply(text);
  return /^(?:ok|okay|okey|sure|alright|all right|noted|understood|got it|yes|yep|yeah|thanks|thank you|👍(?:🏻|🏼|🏽|🏾|🏿)?)$/i.test(normalized);
}

function quickCheckinDetailDecision(text, interpretation) {
  if (quickCheckinCoveredReply(text)) return "covered";
  if (quickCheckinMeetingReferenceWithoutDetail(text)) return "meeting_reference";
  if (quickCheckinAcknowledgementReply(text)) return "acknowledgement";

  if (interpretation && detectors.clientRequestedDeferral(text, interpretation)) return "defer";
  const hasStructuredNegativeFeedback = (
    (Array.isArray(interpretation?.concerns) && interpretation.concerns.length > 0)
    || (Array.isArray(interpretation?.captured)
      && interpretation.captured.some((item) => item.sentiment === "negative" && item.summary))
    || (Array.isArray(interpretation?.observations)
      && interpretation.observations.some((item) => item.sentiment === "negative" && item.detail))
  );
  const hasSubstantiveNegativeFeedback = hasStructuredNegativeFeedback
    || (interpretation?.sentiment === "negative" && interpretation?.explainsProblem === true);
  if (hasSubstantiveNegativeFeedback) return "feedback";
  if (["feedback", "conversation"].includes(detectors.completionScopeFor(text, interpretation))) return "covered";
  // Negative intent alone is not a refusal: it may be a complaint whose
  // structured details were omitted. Only verified completion can close it.
  if (interpretation?.intent === "negative") return "needs_detail";
  if (interpretation?.intent === "affirmative") return "acknowledgement";
  if (interpretation?.intent === "off_topic" || interpretation?.intent === "rating") return "off_topic";
  if (["more_detail", "unclear"].includes(interpretation?.intent)) return "needs_detail";

  if (interpretation?.intent === "feedback") {
    const captured = Array.isArray(interpretation.captured) ? interpretation.captured : [];
    const hasCompleteServicePoint = captured.some((item) => (
      String(item.summary || "").trim()
      && (item.needsFollowUp !== true || interpretation.explainsProblem === true || item.sentiment === "positive")
    ));
    const hasMeaningfulFeedback = hasCompleteServicePoint
      || (Array.isArray(interpretation.observations) && interpretation.observations.length > 0)
      || (Array.isArray(interpretation.concerns) && interpretation.concerns.length > 0)
      || (Array.isArray(interpretation.appreciations) && interpretation.appreciations.length > 0)
      || interpretation.explainsProblem === true
      || interpretation.serviceScope === "overall_feedback";
    return hasMeaningfulFeedback ? "feedback" : "needs_detail";
  }

  // A model timeout, rejected payload or unavailable key must never turn an
  // uncertain message into completed feedback. Keep waiting instead.
  return "uncertain";
}

function quickCheckinConcernPoints(interpretation, { includeSummary = true } = {}) {
  const points = [];
  const add = (title, summary) => {
    const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
    const cleanSummary = String(summary || "").replace(/\s+/g, " ").trim();
    if (!cleanSummary) return;
    const point = cleanTitle && !cleanSummary.toLowerCase().startsWith(cleanTitle.toLowerCase())
      ? `${cleanTitle}: ${cleanSummary}`
      : cleanSummary;
    const normalized = point.toLowerCase();
    if (points.some((existing) => existing.toLowerCase() === normalized)) return;
    points.push(point.slice(0, 180).replace(/[.,:;\s]+$/g, ""));
  };

  for (const concern of interpretation?.concerns || []) {
    if (concern?.sentiment === "negative") {
      add(null, includeSummary ? `${concern.title}: ${concern.summary}` : concern.title);
    }
  }
  if (!points.length) {
    for (const item of interpretation?.captured || []) {
      if (item?.sentiment === "negative") add(null, item.summary);
    }
    for (const item of interpretation?.observations || []) {
      if (item?.sentiment === "negative" && item.kind !== "request") add(item.topic, item.detail);
    }
  }
  return points.slice(0, 3);
}

function fallbackQuickCheckinConcerns(text) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return [];
  const segments = source
    .split(/(?<=[.!?])\s+|\s*;\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const concerns = [];
  const add = (title, matches, severity = "watch") => {
    const summary = segments.filter(matches).join(" ") || (matches(source) ? source : "");
    if (!summary) return;
    concerns.push({
      title,
      summary: summary.slice(0, 600),
      sentiment: "negative",
      severity,
      serviceKey: null,
      needsFollowUp: false
    });
  };

  const processObservation = fallbackDeliveryObservation(source);
  if (processObservation) {
    add(
      processObservation.topic === "Creative Process"
        ? "Inconsistent implementation of agreed creative feedback"
        : "Repeated rework and delivery-process gaps",
      (part) => /\b(?:back[- ]and[- ]forth|rework|reiterat\w*|repeat(?:ed|edly)?|not (?:consistently )?(?:applied|implemented|incorporated)|miss(?:ed|ing) changes?|inconsisten\w*|same (?:feedback|change|changes)|common (?:feedback|change|changes)|internal (?:alignment|communication))\b/i.test(part)
    );
  }
  add(
    "Campaign outcomes below expectations",
    (part) => /\b(?:campaign|outcomes?|results?|traction|attention|applicants?|leads?)\b/i.test(part)
      && /\b(?:disappoint\w*|poor|weak|low|below|lacking|not (?:attracting|working|performing|enough)|could be achieved without|no (?:traction|results?))\b/i.test(part),
    "high"
  );
  add(
    "Reporting visibility is insufficient",
    (part) => /\b(?:data|report\w*|information|profile|visibility|insight\w*)\b/i.test(part)
      && /\b(?:no|not|missing|lack\w*|without|unclear|incomplete|insufficient|doesn'?t|does not|fails? to)\b/i.test(part)
  );
  add(
    "More proactive ownership is needed",
    (part) => /\b(?:ownership|proactiv\w*|initiative|interest|course correction|change course|analyse|analyze)\b/i.test(part)
      && /\b(?:need|needs|needed|expect\w*|lack\w*|lacking|more|not|insufficient)\b/i.test(part)
  );
  add(
    "Delays or slow turnaround",
    (part) => /\b(?:delay\w*|late|slow|turnaround|deadline|overdue|pending)\b/i.test(part)
      && /\b(?:delay\w*|late|slow|miss\w*|overdue|too long|not on time|still pending)\b/i.test(part)
  );
  add(
    "Communication or coordination gaps",
    (part) => /\b(?:communication|coordination|updates?|responses?|follow[- ]?up|alignment)\b/i.test(part)
      && /\b(?:poor|weak|lack\w*|missing|delay\w*|slow|gap|not|inconsisten\w*)\b/i.test(part)
  );

  return concerns.filter((item, index, values) => values.findIndex((candidate) => {
    const candidateCategory = quickCheckinConcernCategory(candidate);
    const itemCategory = quickCheckinConcernCategory(item);
    if (new Set([candidateCategory, itemCategory]).size === 2
      && [candidateCategory, itemCategory].includes("process")
      && [candidateCategory, itemCategory].includes("communication")) {
      const related = contentOverlap(candidate.summary, item.summary);
      if (related.shared >= 4 || related.ratio >= 0.55) return true;
    }
    if (candidateCategory && itemCategory) return candidateCategory === itemCategory;
    const overlap = contentOverlap(
      `${candidate.title} ${candidate.summary}`,
      `${item.title} ${item.summary}`
    );
    return overlap.shared >= 4 && overlap.ratio >= 0.72;
  }) === index).slice(0, 6);
}

function quickCheckinConcernCategory(item) {
  const title = String(item?.title || "").toLowerCase();
  if (/\b(?:report\w*|data|profile|visibility|information|insight\w*)\b/.test(title)) return "reporting";
  if (/\b(?:campaign|applicants?|leads?|traction|outcomes?|results?)\b/.test(title)) return "campaign_outcomes";
  if (/\b(?:ownership|proactiv\w*|initiative|course correction|change course)\b/.test(title)) return "ownership";
  if (/\b(?:delay\w*|late|slow|turnaround|deadline|overdue|pending)\b/.test(title)) return "delay";
  if (/\b(?:communication|coordination|updates?|responses?|follow[- ]?up|alignment)\b/.test(title)) return "communication";
  if (/\b(?:rework|implementation|creative process|delivery process)\b/.test(title)) return "process";

  const source = `${title} ${item?.summary || ""}`.toLowerCase();
  if (/\b(?:report\w*|data|profile|visibility|information|insight\w*)\b/.test(source)) return "reporting";
  if (/\b(?:campaign|applicants?|leads?|traction|attention|outcomes?|results?)\b/.test(source)
    && /\b(?:below|poor|weak|low|disappoint|not|outcomes?|results?|traction|attention|applicants?|leads?)\b/.test(source)) {
    return "campaign_outcomes";
  }
  if (/\b(?:ownership|proactiv\w*|initiative|interest|course correction|change course|analyse|analyze)\b/.test(source)) return "ownership";
  if (/\b(?:delay\w*|late|slow|turnaround|deadline|overdue|pending)\b/.test(source)) return "delay";
  if (/\b(?:communication|coordination|updates?|responses?|follow[- ]?up|alignment)\b/.test(source)) return "communication";
  if (/\b(?:rework|reiterat\w*|repeat\w*|inconsisten\w*|implemented|applied|creative process|delivery process)\b/.test(source)) return "process";
  return null;
}

function enrichQuickCheckinInterpretation(text, project, interpretation = {}) {
  interpretation = groundLatestReplyInterpretation(interpretation || {}, text, project) || {};
  interpretation.latestClientText = String(text || "");
  // Quick Check-in has no conductor pass, but model labels still need the same
  // latest-message evidence rule. In particular, normalize an unsupported
  // observation title instead of letting an old prompt/transcript topic become
  // a management issue.
  const modelUnavailable = interpretation.source === "fallback"
    || Boolean(interpretation.error)
    || !interpretation.intent;
  // Supplement successful model output too. A successful request can still
  // omit one of several concerns from its structured arrays, which previously
  // produced a generic acknowledgement and incomplete issue records.
  const deterministicConcerns = fallbackQuickCheckinConcerns(text);
  const processObservation = fallbackDeliveryObservation(text);
  const concerns = [...(interpretation.concerns || [])];
  for (const concern of deterministicConcerns) {
    const duplicate = concerns.some((existing) => {
      const existingCategory = quickCheckinConcernCategory(existing);
      const concernCategory = quickCheckinConcernCategory(concern);
      if (existingCategory && concernCategory) return existingCategory === concernCategory;
      const overlap = contentOverlap(
        `${existing.title || ""} ${existing.summary || ""}`,
        `${concern.title} ${concern.summary}`
      );
      return overlap.shared >= 4 && overlap.ratio >= 0.55;
    });
    if (!duplicate) concerns.push(concern);
  }
  const observations = [...(interpretation.observations || [])];
  if (processObservation) {
    const duplicate = observations.some((existing) => {
      const overlap = contentOverlap(existing.detail, processObservation.detail);
      return existing.fallbackKind === processObservation.fallbackKind
        || overlap.shared >= 5
        || overlap.ratio >= 0.55;
    });
    if (!duplicate) observations.push(processObservation);
  }
  const alreadyHasNegativeFact = concerns.some((item) => item.sentiment === "negative")
    || observations.some((item) => item.sentiment === "negative")
    || (interpretation.captured || []).some((item) => item.sentiment === "negative");
  // If Gemini understood an explained negative experience but omitted its
  // optional concern arrays, preserve the client's actual words as a general
  // management concern. This is a topic-independent last line of defence for
  // quick check-ins; it prevents a generic success acknowledgement and an
  // empty issue record without guessing which service owns the concern.
  if (!alreadyHasNegativeFact
    && interpretation.sentiment === "negative"
    && interpretation.explainsProblem === true) {
    concerns.push({
      title: "Concern requiring management review",
      summary: String(text || "").replace(/\s+/g, " ").trim().slice(0, 600),
      sentiment: "negative",
      severity: "watch",
      serviceKey: null,
      needsFollowUp: false
    });
  }
  const roleAppreciations = fallbackRoleAppreciations(text, project);
  const appreciations = [...(interpretation.appreciations || [])];
  for (const item of roleAppreciations) {
    const duplicateIndex = appreciations.findIndex((existing) => {
      if (item.serviceKey && existing.serviceKey === item.serviceKey) return true;
      const overlap = contentOverlap(existing.detail, item.detail);
      return overlap.shared >= 3 && overlap.ratio >= 0.55;
    });
    if (duplicateIndex < 0) appreciations.push(item);
    else if (/\band\b|,/.test(item.subject)) appreciations[duplicateIndex] = item;
  }
  if (!deterministicConcerns.length
    && !processObservation
    && !appreciations.length
    && concerns.length === (interpretation.concerns || []).length) return interpretation;

  return {
    ...interpretation,
    intent: (deterministicConcerns.length || processObservation)
      ? "feedback"
      : modelUnavailable && appreciations.length
      ? "feedback"
      : interpretation.intent,
    sentiment: deterministicConcerns.length
      ? "negative"
      : interpretation.sentiment || (appreciations.length ? "positive" : null),
    explainsProblem: interpretation.explainsProblem === true || deterministicConcerns.length > 0,
    isObservation: interpretation.isObservation === true
      || Boolean(processObservation && !(interpretation.captured || []).length),
    observations,
    concerns,
    appreciations,
    source: modelUnavailable && (deterministicConcerns.length || appreciations.length)
      ? "deterministic_fallback"
      : interpretation.source
  };
}

function quickCheckinFeedbackAcknowledgement(poc, interpretation, windowText, project = {}, additional = false) {
  const name = poc.salutation || poc.name;
  const concernPoints = quickCheckinConcernPoints(interpretation, { includeSummary: false });
  const appreciation = appreciationAcknowledgement({
    appreciations: interpretation?.appreciations || []
  }, project, {});
  const appreciationText = appreciation ? ` ${appreciation}` : "";
  const natural = clientFacingAcknowledgement(interpretation || {}, project, { type: "close" });
  if (natural) {
    return `${natural}${appreciation && !responseAcknowledgesAppreciation(natural) ? appreciationText : ""} Your feedback has been recorded for confidential management review. ${windowText}`;
  }
  const request = requestAcknowledgement(interpretation || {});
  if (!concernPoints.length) {
    return `Thank you, ${name}.${request ? ` ${request}` : ""}${appreciationText} Your feedback has been recorded for confidential management review. ${windowText}`;
  }
  const numbered = concernPoints.map((point, index) => `${index + 1}) ${point}`).join(" ");
  return `${additional ? `Thank you for the additional detail, ${name}.` : `Thank you for bringing these concerns to our attention, ${name}.`} I have specifically noted: ${numbered}.${request ? ` ${request}` : ""}${appreciationText} Your feedback has been recorded for confidential management review. ${windowText}`;
}

async function handleQuickCheckinTurn({ store, session, project, poc, body, text, baseUrl, channel, waitUntil }) {
  const providerMessageId = body.providerMessageId || null;
  if (providerMessageId && await store.hasProviderMessage(providerMessageId)) {
    return json(200, { duplicate: true, sendToWhatsapp: false, sessionId: session.id });
  }

  const inbound = {
    speaker: body.fromName || poc.salutation || poc.name || "Client",
    side: "client",
    body: text,
    providerMessageId,
    metadata: {
      source: channel === "whatsapp" ? "whatsapp" : "web_test",
      from: body.from || null,
      buttonPayload: body.buttonPayload || body.buttonId || null
    }
  };
  const clientMessage = providerMessageId && typeof store.addInboundMessage === "function"
    ? await store.addInboundMessage(session.id, inbound)
    : await store.addMessage(session.id, inbound);
  if (!clientMessage) return json(200, { duplicate: true, sendToWhatsapp: false, sessionId: session.id });

  const button = quickCheckinButton(body);
  const state = session.conversationState || {};
  const normalized = String(text || "").trim().toLowerCase();
  const allGood = button === "all_good"
    || /^(?:all good|everything(?: is|'s)? (?:good|fine)|going well|no issues?|no problem|fine|good)$/i.test(normalized);
  const shareChoice = button === "share_feedback"
    || /^(?:share feedback|needs? improvement|have an issue|issue|something to share)$/i.test(normalized);
  let result;
  let replyText;
  let alertText = null;
  let recordedInterpretation = null;
  let postCompletionHandoff = false;
  let postCompletionHandoffEvent = null;

  const interpretDetail = async () => enrichQuickCheckinInterpretation(text, project, await interpretReply({
      project,
      question: `What needs improvement, what is going well, or what should management know about ${project.name}?`,
      text,
      longForm: true,
      verifySurveyControls: true
    }));
  const recordDetail = async (inputInterpretation) => {
    let interpretation = inputInterpretation;
    if (!interpretation.sentiment) {
      const negative = /\b(issue|problem|improv\w*|delay\w*|late|slow|poor|bad|concern|not (?:good|working|happy)|unhappy|miss\w*)\b/i.test(text);
      const positive = /\b(good|great|fine|excellent|happy|appreciat\w*|well done|satisfied)\b/i.test(text);
      interpretation = { ...interpretation, sentiment: negative ? "negative" : positive ? "positive" : "neutral" };
    }
    recordedInterpretation = interpretation;
    const recorded = await store.applyQuickCheckinResponse(session.id, {
      outcome: "feedback_shared",
      detail: text,
      interpretation
    });
    if (recorded.sentiment !== "positive") {
      const concernPoints = quickCheckinConcernPoints(interpretation);
      alertText = concernPoints.length
        ? concernPoints.map((point, index) => `${index + 1}. ${point}`).join("\n")
        : text;
    }
    return recorded;
  };

  const responseDeadline = Date.parse(
    state.state === "quick_checkin_window"
      ? state.quickCheckinWindowExpiresAt || ""
      : session.reminderDueAt || ""
  );
  const responseDeadlineExpired = Number.isFinite(responseDeadline) && responseDeadline <= Date.now();

  if (session.status === "completed" || state.state === "completed" || responseDeadlineExpired) {
    if (responseDeadlineExpired && session.status !== "completed" && state.state !== "completed") {
      await expireQuickCheckinsAndNotify(store, new Date().toISOString(), baseUrl);
    }
    result = { session: await store.getSession(session.id) || session };
    const closedAcknowledgement = /^(?:ok|okay|thanks|thank you|all good|fine|good|no problem|no|nothing else|that(?:'s| is) all|👍(?:🏻|🏼|🏽|🏾|🏿)?)$/i.test(normalized);
    postCompletionHandoff = !closedAcknowledgement;
    replyText = postCompletionHandoff
      ? "This automated quick check-in has closed, so I cannot add this message to it. I have passed your message to the SRV team, and someone will respond directly."
      : "Thank you. This quick check-in has closed, and your earlier response remains safely recorded for management review.";
  } else if (state.state === "quick_checkin_window") {
    if (allGood) {
      result = { session };
      replyText = state.quickCheckinOutcome === "all_good"
        ? "Glad to hear that. Your All good response is already recorded, and the original 10-minute window remains open if you would like to add or correct anything else."
        : "Thank you for the update. Your earlier feedback remains recorded, and the original 10-minute window remains open if you would like to add or correct anything else.";
    } else if (shareChoice) {
      result = { session };
      replyText = "Please share what needs improvement, any issue you are facing, or anything you would like management to be aware of. The original 10-minute window remains open.";
    } else if (/^(?:ok|okay|thanks|thank you|no|nothing else|that(?:'s| is) all)$/i.test(normalized)) {
      result = { session };
      replyText = "Thank you. Your response is recorded, and the original 10-minute window remains open if you would like to add or correct anything else.";
    } else {
      const interpretation = await interpretDetail();
      const decision = quickCheckinDetailDecision(text, interpretation);
      result = decision === "feedback" ? await recordDetail(interpretation) : { session };
      const windowText = "The original 10-minute window remains open if you would like to add or correct anything else.";
      replyText = decision === "feedback"
        ? quickCheckinFeedbackAcknowledgement(poc, recordedInterpretation, windowText, project, state.quickCheckinOutcome === "feedback_shared")
        : ["covered", "acknowledgement", "defer"].includes(decision)
          ? `Thank you. Your earlier feedback remains recorded. ${windowText}`
          : `If there is anything you would like the Directors to specifically note or follow up on, please feel free to share it here. ${windowText}`;
    }
  } else if (allGood) {
    result = await store.applyQuickCheckinResponse(session.id, { outcome: "all_good" });
    replyText = `Glad to hear that, ${poc.salutation || poc.name}. Thank you for confirming that everything is going well. Your response has been recorded for confidential management review. This quick check-in will remain open for the next 10 minutes, during which you can add anything else or correct your response.`;
  } else if (shareChoice) {
    result = await store.applyQuickCheckinResponse(session.id, { outcome: "needs_improvement" });
    replyText = `Thank you, ${poc.salutation || poc.name}. Please share what needs improvement, any issue you are facing, or anything you would like management to be aware of. After you share it, the quick check-in will remain open for 10 minutes in case you want to add or correct anything.`;
  } else if (state.state === "quick_checkin_choice" && /^(?:yes|no|ok|okay)$/i.test(normalized)) {
    result = { session };
    replyText = "Please choose All good if everything is going well, or Share feedback if anything needs improvement or should be brought to management's attention.";
  } else if (state.state === "quick_checkin_choice") {
    const interpretation = await interpretDetail();
    const decision = quickCheckinDetailDecision(text, interpretation);
    if (decision === "feedback") {
      result = await recordDetail(interpretation);
      replyText = quickCheckinFeedbackAcknowledgement(
        poc,
        interpretation,
        "This quick check-in will remain open for the next 10 minutes, during which you can add anything else or correct your response.",
        project
      );
    } else if (decision === "defer") {
      result = { session };
      replyText = `No problem, ${poc.salutation || poc.name}. Please respond whenever convenient by choosing All good or Share feedback.`;
    } else {
      result = { session };
      replyText = "Please choose All good if everything is going well, or Share feedback if anything needs improvement or should be brought to management's attention.";
    }
  } else if (state.state === "quick_checkin_detail") {
    let decision = quickCheckinDetailDecision(text, null);
    let interpretation = null;
    if (!["covered", "meeting_reference", "acknowledgement"].includes(decision)) {
      interpretation = await interpretDetail();
      decision = quickCheckinDetailDecision(text, interpretation);
    }

    if (decision === "covered") {
      result = await store.applyQuickCheckinResponse(session.id, { outcome: "feedback_shared" });
      replyText = `Thank you, ${poc.salutation || poc.name}. We understand there is nothing further you would like the Directors to note at the moment. Your response has been recorded for confidential management review. This quick check-in will remain open for the next 10 minutes, during which you can add anything else or correct your response.`;
    } else if (decision === "meeting_reference") {
      result = { session };
      replyText = `Thank you for letting us know, ${poc.salutation || poc.name}. If there is anything you would like the Directors to specifically note or follow up on, please feel free to share it here. If everything is covered, just let us know.`;
    } else if (decision === "acknowledgement") {
      result = { session };
      replyText = `Thank you, ${poc.salutation || poc.name}. Please share the feedback whenever convenient.`;
    } else if (decision === "defer") {
      result = { session };
      replyText = `No problem, ${poc.salutation || poc.name}. Please share it here whenever convenient.`;
    } else if (decision === "feedback") {
      result = await recordDetail(interpretation);
      replyText = quickCheckinFeedbackAcknowledgement(
        poc,
        interpretation,
        "This quick check-in will remain open for the next 10 minutes, during which you can add anything else or correct your response.",
        project
      );
    } else if (decision === "off_topic") {
      result = { session };
      replyText = "To continue this quick check-in, please share what needs improvement, any issue you are facing, or anything you would like management to be aware of.";
    } else if (decision === "needs_detail") {
      result = { session };
      replyText = `Thank you, ${poc.salutation || poc.name}. Could you please add a little more detail about what needs improvement or what you would like management to follow up on?`;
    } else {
      result = { session };
      replyText = "I want to make sure your feedback is recorded accurately. Please share what needs improvement, any issue you are facing, or anything you would like management to be aware of.";
    }
  } else {
    result = { session };
    replyText = "Please choose All good if everything is going well, or Share feedback if anything needs improvement or should be brought to management's attention.";
  }

  if (alertText) {
      const concernCount = recordedInterpretation?.concerns?.length || 0;
      const issues = Array.isArray(result.issues) ? result.issues : (result.issue ? [result.issue] : []);
      const riskLevel = issues.some((item) => item.severity === "high") ? "High" : (issues[0]?.severity || "Watch");
      notifyAutomationAsync(store, "manager_alert", {
        project,
        poc,
        session: result.session,
        clientText: text,
        analysis: {
          requiresManagerAlert: true,
          managerEmail: concernCount > 1 ? null : result.service?.managerEmail || null,
          ownerEmail: concernCount > 1 ? null : result.service?.ownerEmail || null,
          ownerName: concernCount > 1 ? "Management" : result.service?.ownerName || "Management",
          primaryServiceName: concernCount > 1 ? `${concernCount} quick check-in concerns` : result.service?.name || "Quick check-in",
          riskLevel,
          csatScore: null,
          rootCause: alertText,
          concerns: recordedInterpretation?.concerns || [],
          issueCount: issues.length
        },
        resumeUrl: buildResumeUrl(baseUrl, project, result.session)
      }, `manager_alert:quick_checkin:${clientMessage.id}`, waitUntil);
  }

  if (postCompletionHandoff) {
    try {
      // This event cannot be fire-and-forget on Replit. The request may finish
      // before an untracked promise reserves its audit row or reaches n8n,
      // leaving the client with a false "passed to the team" confirmation.
      postCompletionHandoffEvent = await notifyAutomation(store, "post_completion_message", {
        project,
        poc,
        session: result.session,
        clientText: text,
        guardrail: "quick_checkin_post_completion",
        state: result.session.conversationState?.state || "completed",
        resumeUrl: buildResumeUrl(baseUrl, project, result.session)
      }, `post_completion_message:quick_checkin:${clientMessage.id}`);
    } catch (handoffError) {
      console.warn("[automation] quick-check-in post-completion handoff failed:", handoffError.message);
      postCompletionHandoffEvent = { status: "failed", error: handoffError.message };
    }

    const handoffAccepted = postCompletionHandoffEvent?.status === "sent"
      || (postCompletionHandoffEvent?.status === "duplicate" && postCompletionHandoffEvent.delivered === true);
    replyText = handoffAccepted
      ? "This automated quick check-in has closed, so I cannot add this message to it. I have passed your message to the SRV team, and someone will respond directly."
      : "This automated quick check-in has closed, and I could not pass this new message to the team automatically. Please contact your SRV representative directly so it is not missed.";
  }

  const assistantMessage = await store.addMessage(session.id, {
    speaker: "SRV Media Directors' Office",
    side: "srv",
    body: replyText,
    metadata: {
      source: "quick_checkin",
      outcome: result.session.conversationState?.quickCheckinOutcome || null,
      postCompletionHandoff,
      postCompletionHandoffStatus: postCompletionHandoffEvent?.status || null
    }
  });
  return json(201, {
    session: result.session,
    project,
    poc,
    receivedMessage: clientMessage,
    nextMessage: assistantMessage,
    whatsappReplyText: replyText,
    sendToWhatsapp: true,
    guardrail: postCompletionHandoff ? "quick_checkin_post_completion" : null,
    handoffStatus: postCompletionHandoffEvent?.status || null,
    state: result.session.conversationState?.state || null
  });
}

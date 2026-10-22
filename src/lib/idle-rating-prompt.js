const { isDeepStrictEqual } = require("node:util");
const IDLE_RATING_MS = 60 * 60 * 1000;
const SERVICE_WINDOW_MS = 24 * IDLE_RATING_MS;

// Only newly armed overall reviews participate. Deployment must not start
// chasing historical sessions, or infer feedback from a greeting/acknowledgement.
function ownsPendingRatingReminder(session) {
  const state = session?.conversationState || {};
  return state.overallRating == null && !state.overallRatingDeclined
    && (Boolean(state.idleRatingPromptAttemptedAt)
      || (state.idleRatingPromptEligible === true && state.ratingFeedbackPause?.overallReview === true
        && state.ratingFeedbackPause?.ratingType === "overall_rating"));
}

function idleRatingEligibility(session, messages = [], now = Date.now()) {
  const state = session?.conversationState || {};
  const deny = (reason) => ({ eligible: false, reason });
  if (!Number.isFinite(now)) return deny("invalid_time");
  if (!["pulse", "project_end"].includes(session?.sessionType)) return deny("unsupported_session");
  if (!["started", "partial", "needs_attention", "no_response"].includes(session.status)
    || session.completionStatus === "completed" || session.completedAt
    || state.closingGraceExpiresAt || state.optedOut || state.clientRequestedClose || state.deferredAt
    || state.reminderExhausted || state.wrongPerson
    || ["completed", "closing_grace", "opted_out", "handed_off", "deferred", "stopped"].includes(state.state)) return deny("inactive_or_paused");
  if (state.idleRatingPromptAttemptedAt || state.overallRatingAsked || state.askedForOverallRating
    || state.overallRating != null || state.overallRatingDeclined
    || ["overall_rating", "nps"].includes(state.pendingQuestionType)
    || (state.pendingQuestionType !== "rating_feedback" && ["waiting_for_overall_rating", "waiting_for_nps"].includes(state.state))
    || (session.csatSource === "stated" && session.csatScore != null)) return deny("rating_already_handled");
  if (!ownsPendingRatingReminder(session)) return deny("no_overall_feedback_wait");
  if (state.pendingQuestionType !== "rating_feedback" || state.pendingGeneralIssue
    || state.pendingObservation || state.pendingServiceKey) return deny("other_question_pending");

  const relevant = messages.filter((message) => message.side === "client" || message.side === "srv");
  const client = [...relevant].reverse().find((message) => message.side === "client");
  const latest = relevant.at(-1);
  const clientAt = Date.parse(client?.createdAt || "");
  const replyAt = Date.parse(latest?.createdAt || "");
  // Wait for processing of the most recent client message to finish; the
  // transcript also protects against a manual question not yet in session state.
  if (!Number.isFinite(clientAt) || latest?.side !== "srv" || !Number.isFinite(replyAt)
    || replyAt < clientAt) return deny("client_reply_processing");
  if (latest.metadata?.manualOutbound || latest.metadata?.pendingQuestionType !== "rating_feedback") return deny("different_latest_question");
  if (relevant.some((message) => message.side === "srv" && (
    message.metadata?.pendingQuestionType === "overall_rating"
    || message.metadata?.manualQuestionType === "overall_rating"
    || message.metadata?.source === "one_hour_rating_prompt"
  ))) return deny("rating_question_in_transcript");
  const processedAt = Date.parse(session.lastClientResponseAt || "");
  const activityAt = Math.max(clientAt, Number.isFinite(processedAt) ? processedAt : clientAt);
  if (now < activityAt + IDLE_RATING_MS) return deny("not_due");
  if (now >= clientAt + SERVICE_WINDOW_MS) return deny("outside_service_window");
  return { eligible: true, reason: "due", dueAt: new Date(activityAt + IDLE_RATING_MS).toISOString(), clientMessageId: client.id };
}

// Dependencies are explicit so regression tests never contact a live provider.
async function sendIdleRatingPrompts({ store, nowIso, messagingEnabled, send, question, prepareState }) {
  const result = { sent: [], skipped: [], failed: [] };
  if (typeof store.getIdleRatingCandidates !== "function") return { ...result, supported: false };
  if (!await messagingEnabled()) return { ...result, paused: true };
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) throw new Error("Invalid automation time");
  const candidates = await store.getIdleRatingCandidates(nowIso);
  for (const candidate of candidates) {
    // Keep one bad record/provider failure from starving the remaining POCs.
    try {
      const session = await store.getSession(candidate.id);
      const messages = await store.getMessagesForSession(candidate.id);
      const assessment = idleRatingEligibility(session, messages, now);
      if (!assessment.eligible) { result.skipped.push({ sessionId: candidate.id, reason: assessment.reason }); continue; }
      const [project, poc] = await Promise.all([
        store.getProjectById(session.projectId), store.getClientPocById(session.clientPocId)
      ]);
      if (!project || !poc || poc.active === false || poc.removedAt || !poc.contactWhatsapp) {
        result.skipped.push({ sessionId: session.id, reason: "recipient_unavailable" }); continue;
      }
      const text = question(session.sessionType);
      const prepared = prepareState(session, project, text, nowIso);
      // Atomic state comparison: a reply, manual edit or another scheduler
      // invalidates this reservation rather than losing its changes.
      const claimed = await store.reserveIdleRatingPrompt(session, prepared, nowIso);
      if (!claimed) { result.skipped.push({ sessionId: session.id, reason: "session_changed" }); continue; }
      const live = await store.getSession(session.id);
      const liveMessages = await store.getMessagesForSession(session.id);
      const newestClient = [...liveMessages].reverse().find((message) => message.side === "client");
      const unchanged = isDeepStrictEqual(live?.conversationState, prepared);
      if (!unchanged || newestClient?.id !== assessment.clientMessageId || !await messagingEnabled()) {
        await store.releaseIdleRatingPrompt(session, prepared);
        result.skipped.push({ sessionId: session.id, reason: "changed_before_dispatch" }); continue;
      }
      const dedupeKey = `one_hour_rating_prompt:${session.id}`;
      const payload = { sessionId: session.id, cycleId: session.cycleId, project, poc,
        to: poc.contactWhatsapp, text, requestId: dedupeKey, reason: "overall_feedback_idle_one_hour" };
      const event = await store.claimAutomationEvent("one_hour_rating_prompt", payload, dedupeKey);
      if (!event) { result.skipped.push({ sessionId: session.id, reason: "already_attempted" }); continue; }
      const finalSession = await store.getSession(session.id);
      const finalMessages = await store.getMessagesForSession(session.id);
      if (!isDeepStrictEqual(finalSession?.conversationState, prepared)
        || finalMessages.at(-1)?.id !== liveMessages.at(-1)?.id
        || Date.parse(finalSession?.lastClientResponseAt || "") > now - IDLE_RATING_MS
        || !await messagingEnabled()) {
        await store.completeAutomationEvent(event.id, { status: "skipped", payload: { ...payload, reason: "changed_at_dispatch" } });
        await store.releaseIdleRatingPrompt(session, prepared, true);
        result.skipped.push({ sessionId: session.id, reason: "changed_at_dispatch" });
        continue;
      }
      // At most one dispatch attempt. A timeout may mean WhatsApp accepted it;
      // retries must never send another question or overwrite newer feedback.
      let delivery;
      try { delivery = await send(payload); }
      catch (error) { delivery = { status: "failed", error: error.message }; }
      await store.completeAutomationEvent(event.id, { ...delivery, payload });
      if (delivery.status === "sent") {
        await store.addMessage(session.id, { speaker: "SRV Media MD Office", side: "srv", body: text,
          metadata: { source: "one_hour_rating_prompt", pendingQuestionType: "overall_rating",
            requestId: dedupeKey, deliveryStatus: "accepted" } });
        result.sent.push({ sessionId: session.id, dueAt: assessment.dueAt });
      } else {
        // Preserve an attempt marker, but do not claim that an undelivered
        // question was asked. Compare-and-set cannot roll back a newer reply.
        await store.releaseIdleRatingPrompt(session, prepared, true);
        result.failed.push({ sessionId: session.id, status: delivery.status, error: delivery.error || null, retrySuppressed: true });
      }
    } catch (error) {
      result.failed.push({ sessionId: candidate.id, error: error.message });
    }
  }
  return result;
}

module.exports = { IDLE_RATING_MS, ownsPendingRatingReminder, idleRatingEligibility, sendIdleRatingPrompts };

// Latest-message-only interpretation checks. This never reads conversation
// history, changes a score, or accepts facts from the response writer.
function exactEvidence(value, source) {
  const quote = typeof value === "string" ? value.trim() : "";
  return quote.length >= 8 && String(source).includes(quote) ? quote : null;
}

function applyReplyFidelityReview(read, review, source, safeWording) {
  if (!review || !["srv_request", "feedback", "unrelated", "uncertain"].includes(review.scope)) return read;
  const result = { ...read, fidelityReview: "reviewed" };
  // Only exact current-message request evidence can repair a contradictory
  // off-topic classification. Never import paraphrased facts or old concerns.
  const requests = ["srv_request", "feedback"].includes(review.scope)
    ? [...new Set((Array.isArray(review.requestEvidence) ? review.requestEvidence : [])
      .map((value) => exactEvidence(value, source)).filter(Boolean))].slice(0, 6) : [];
  if (requests.length && ["off_topic", "unclear", "feedback"].includes(read.intent)) {
    result.intent = "feedback";
    result.observations = [...(read.observations || [])];
    for (const detail of requests) {
      if (!result.observations.some((item) => item.kind === "request" && item.detail === detail)) {
        result.observations.push({ topic: "Client Request", detail, kind: "request",
          sentiment: "neutral", severity: "info", needsFollowUp: false, sourceEvidence: detail });
      }
    }
    result.requestScopeReviewed = true;
  }
  const ack = typeof review.acknowledgement === "string" ? review.acknowledgement.trim() : "";
  const coverage = Array.isArray(review.coverage) ? review.coverage : [];
  const validCoverage = coverage.length > 0 && coverage.every((point) =>
    exactEvidence(point?.evidence, source) && exactEvidence(point?.responseExcerpt, ack));
  if (ack && ack.length <= 900 && !/[?？]/.test(ack) && validCoverage
    && review.preservesUncertainty === true && safeWording(ack)) {
    result.acknowledgement = ack;
    result.acknowledgementReviewed = true;
  }
  return result;
}

module.exports = { exactEvidence, applyReplyFidelityReview };

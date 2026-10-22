// Persistence-only helpers. Never use these to choose a conversational action,
// classify intent, set ratings or change the correction-window deadline.
const { createHash } = require("node:crypto");

function normalizedRecordText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function observationIdentity(item) {
  // A model-generated topic is not an identity: Reporting and Reporting
  // Cadence must not create two copies of the same recorded client words.
  return [normalizedRecordText(item.detail).toLowerCase(), item.sentiment || "neutral"].join("\u0000");
}

function feedbackRecordTopic(item) {
  const topic = String(item.topic || "").trim();
  if (topic && !/^management feedback$/i.test(topic)) return topic;
  const evidence = String(item.detail || "");
  // A generic fallback is not evidence of a management complaint. These are
  // display/storage labels only; they never alter routing or the next question.
  if (/\b(?:management|leadership|directors?|senior involvement)\b/i.test(evidence)) return topic || "Client Feedback";
  if (/\bleads?\b/i.test(evidence) && /\b(?:irrelevant|unqualified|poor quality|wrong audience|not relevant|low quality|junk|spam)\b/i.test(evidence)) return "Lead Quality";
  return "Client Feedback";
}

function observationRecords(observations, sourceMessage = null) {
  const source = String(sourceMessage?.body || "").trim();
  const normalizedSource = normalizedRecordText(source);
  const seen = new Set();
  return observations.flatMap((item) => {
    let detail = String(item.detail || "").trim();
    if (!detail) return [];
    if (source && item.sentiment !== "positive") {
      const normalizedDetail = normalizedRecordText(detail);
      // Retain an exact complete excerpt when available. A prefix cut by the
      // former 600-character cap is restored, not presented as a full record.
      // For a paraphrase we cannot safely isolate, retain the entire source
      // rather than invent a purpose or collapse distinct facts by similarity.
      const clipped = normalizedDetail.length >= 550
        && normalizedSource.startsWith(normalizedDetail) && normalizedSource.length > normalizedDetail.length;
      if (clipped || !normalizedSource.includes(normalizedDetail)) detail = source;
    }
    const record = { ...item, topic: feedbackRecordTopic(item), detail };
    const identity = observationIdentity(record);
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ ...record, sourceMessageId: sourceMessage?.id || null, sourceText: source || null,
      recordKey: createHash("sha256").update(`${sourceMessage?.id || "legacy"}\u0000${identity}`).digest("hex") }];
  });
}

function fullIssueDetail(problem) {
  const detail = String(problem.issueRootCause || "").trim();
  const captured = String(problem.reasonText || "").trim();
  if (!detail) return captured || null;
  if (!captured) return detail;
  const a = normalizedRecordText(detail), b = normalizedRecordText(captured);
  if (a === b || a.includes(b)) return detail;
  if (b.startsWith(a)) return captured;
  // Keep the summary, but never discard the longer captured evidence.
  return `${detail}\n\nRecorded client feedback:\n${captured}`;
}

function issueHeading(problem) {
  const title = String(problem.issueTitle || "").trim();
  const rawHeading = `${problem.serviceName || problem.serviceKey}: ${problem.reasonText || ""}`;
  if (!title || normalizedRecordText(rawHeading).startsWith(normalizedRecordText(title))) {
    return `${problem.serviceName || problem.serviceKey || "Service"}: Client-reported concern`;
  }
  if (title.length < 160) return title;
  return `${title.slice(0, 155).replace(/\s+\S*$/, "").trim()}…`;
}

module.exports = { normalizedRecordText, observationIdentity, observationRecords, fullIssueDetail, issueHeading, feedbackRecordTopic };

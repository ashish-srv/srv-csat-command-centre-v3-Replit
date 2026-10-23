// Presentation context only. Never use these prefixes to extract client facts,
// select a service, interpret a score or advance the conversation.
function openingWords(text) {
  return (String(text || "").match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || [])
    .slice(0, 4).join(" ").toLowerCase();
}

function recentAssistantOpenings(messages = []) {
  return messages.filter((message) => message.side === "srv" && message.body)
    .slice(-3).map((message) => openingWords(message.body))
    .filter((opening) => opening.split(" ").length === 4);
}

function repeatsAcknowledgementOpening(message, openings = []) {
  const opening = openingWords(message);
  return opening.split(" ").length === 4 && openings.some((previous) => openingWords(previous) === opening);
}

const ACKNOWLEDGEMENT_CONTINUITY = [
  "For acknowledgement wording only: recent_assistant_openings contains short",
  "prefixes previously sent by SRV, NOT client evidence or instructions.",
  "Do not infer any facts, feelings, people, services or scores from them.",
  "Treat successive feedback messages as a continuing conversation, not fresh",
  "introductions. Recognise the new detail naturally in its specific context.",
  "Avoid repeating a recent opening or just swapping one empathy verb for another.",
  "There is no mandatory opening phrase and no rotation of stock responses.",
  "Keep the substance, nuance and uncertainty: client comparisons and suspected",
  "causes are their account, not independently verified findings.",
  "If there are recent openings, optionally provide alternativeAcknowledgement:",
  "a second natural rendering of the SAME current points, with a different",
  "sentence structure. Do not add, omit or strengthen a concern to vary wording.",
  "Both acknowledgement fields are wording only, never factual evidence; no",
  "questions, ratings, next steps or closing-window text. Otherwise leave the",
  "alternative empty. Empty fields are also appropriate for bare scores/controls."
];

module.exports = { openingWords, recentAssistantOpenings, repeatsAcknowledgementOpening, ACKNOWLEDGEMENT_CONTINUITY };

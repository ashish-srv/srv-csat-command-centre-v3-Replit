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
  "Return ONE faithful acknowledgement, not alternative versions. Substance",
  "takes priority over variety: never omit a point to avoid repeating an opening.",
  "For multi-point feedback, connect the material concerns, their stated impact",
  "or comparison, and any distinct requests or praise. Do not replace this with",
  "a thank-you and a list of topic labels. Use enough concise sentences for the",
  "content; a short message needs less detail than a substantial mixed review.",
  "Describe comparisons, explanations and suspected failures as the client's",
  "account, not verified market facts or confirmed causes. Do not debate them.",
  "The acknowledgement is wording only, never factual evidence; no questions,",
  "ratings, next steps or closing-window text. Leave it empty for bare controls."
];

module.exports = { openingWords, recentAssistantOpenings, repeatsAcknowledgementOpening, ACKNOWLEDGEMENT_CONTINUITY };

const crypto = require("crypto");

const SERVICE_KEYWORDS = [
  ["account", ["account", "am", "relationship", "coordination", "closure", "escalation"]],
  ["copy", ["copy", "content", "strategy", "messaging", "creative strategy", "programme nuance", "nuance"]],
  ["design", ["design", "creative", "visual", "banner", "post"]],
  ["website", ["website", "landing", "page", "seo", "ranking", "organic"]],
  ["ppc", ["ppc", "media", "campaign", "lead", "cpl", "ads", "performance"]],
  ["video", ["video", "reel", "testimonial", "shoot"]]
];

const NEGATIVE_WORDS = [
  "bad",
  "poor",
  "concern",
  "angry",
  "not happy",
  "unhappy",
  "slow",
  "delay",
  "generic",
  "missing",
  "weak",
  "issue",
  "problem",
  "escalation",
  "urgent",
  "risk"
];

const POSITIVE_WORDS = [
  "good",
  "great",
  "happy",
  "satisfied",
  "smooth",
  "transparent",
  "responsive",
  "stable",
  "clear",
  "helpful",
  "excellent"
];

const NEGATED_POSITIVE_PHRASES = [
  "not good",
  "not happy",
  "not satisfied",
  "not responsive",
  "not clear",
  "not helpful",
  "not okay",
  "not ok"
];

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function getService(client, serviceKey) {
  return (client.services || []).find((service) => service.serviceKey === serviceKey);
}

function detectServices(text, client) {
  const lower = text.toLowerCase();
  const matches = [];
  for (const [serviceKey, keywords] of SERVICE_KEYWORDS) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      const service = getService(client, serviceKey);
      matches.push({
        serviceKey,
        serviceName: service?.name || serviceKey,
        ownerName: service?.ownerName || "Service Owner",
        managerEmail: service?.managerEmail || client.managerEmail
      });
    }
  }
  return matches.length ? matches : [{
    serviceKey: "general",
    serviceName: "Overall Relationship",
    ownerName: "Account Lead",
    managerEmail: client.managerEmail
  }];
}

function detectSentiment(text) {
  const lower = text.toLowerCase();
  const negativeCount = NEGATIVE_WORDS.filter((word) => lower.includes(word)).length;
  const positiveCount = POSITIVE_WORDS.filter((word) => {
    if (!lower.includes(word)) return false;
    return !NEGATED_POSITIVE_PHRASES.some((phrase) => (
      phrase.includes(word) && lower.includes(phrase)
    ));
  }).length;
  if (negativeCount > positiveCount) return "negative";
  if (positiveCount > negativeCount) return "positive";
  return "neutral";
}

function detectSatisfaction(text) {
  const explicit = text.match(/\b([1-5])\s*(?:\/\s*5|out of 5|rating|score)?\b/i);
  if (!explicit) return null;
  return Number(explicit[1]);
}

function scoreFromText(text, sentiment, currentClientScore) {
  const satisfaction = detectSatisfaction(text);
  if (satisfaction) return Number((satisfaction * 2).toFixed(1));
  if (sentiment === "negative") return Math.max(3.5, Number((currentClientScore - 1.4).toFixed(1)));
  if (sentiment === "positive") return Math.min(9.2, Number((currentClientScore + 0.7).toFixed(1)));
  return Number(currentClientScore.toFixed(1));
}

function statusFromScore(score) {
  if (score < 6.5) return "weak";
  if (score < 7.5) return "watch";
  return "strong";
}

function riskFromScore(score, sentiment) {
  if (score < 6.5 || sentiment === "negative") return "High";
  if (score < 7.5) return "Watch";
  return "Low";
}

function npsFromScore(score) {
  if (score >= 8.5) return 22;
  if (score >= 7.5) return 12;
  if (score >= 6.5) return 4;
  return -8;
}

function summarize(text, services, sentiment) {
  const serviceNames = services.map((service) => service.serviceName).join(", ");
  if (sentiment === "negative") {
    return `Client raised a negative signal around ${serviceNames}. Exact capture: "${text}"`;
  }
  if (sentiment === "positive") {
    return `Client gave a positive signal around ${serviceNames}. Exact capture: "${text}"`;
  }
  return `Client gave a neutral signal around ${serviceNames}. Exact capture: "${text}"`;
}

function analyzeFeedback(text, client) {
  const sentiment = detectSentiment(text);
  const services = detectServices(text, client);
  const primaryService = services[0];
  const satisfaction = detectSatisfaction(text);
  const score = scoreFromText(text, sentiment, Number(client.csatScore || 7));
  const riskLevel = riskFromScore(score, sentiment);
  const status = statusFromScore(score);
  const requiresManagerAlert = riskLevel === "High" || score < 6.5;
  const isComplete = Boolean(satisfaction);

  return {
    id: id("analysis"),
    text,
    sentiment,
    satisfaction,
    isComplete,
    completionStatus: isComplete ? "completed" : "partial",
    services,
    primaryServiceKey: primaryService.serviceKey,
    primaryServiceName: primaryService.serviceName,
    ownerName: primaryService.ownerName,
    managerEmail: primaryService.managerEmail || client.managerEmail,
    csatScore: score,
    healthScore: Math.round(score * 10),
    npsScore: npsFromScore(score),
    riskLevel,
    status,
    rootCause: summarize(text, services, sentiment),
    positiveSignal: sentiment === "positive" ? primaryService.serviceName : client.positiveSignal,
    focusSignal: sentiment === "negative" ? primaryService.serviceName : client.focusSignal,
    escalationSignal: requiresManagerAlert
      ? `Instant alert to ${primaryService.ownerName}`
      : `Track ${primaryService.serviceName} in next review`,
    requiresManagerAlert,
    requiresCompletionReminder: !isComplete,
    dueInHours: !isComplete ? 24 : riskLevel === "High" ? 24 : 48,
    createdAt: new Date().toISOString()
  };
}

function buildAssistantReply(analysis, client) {
  const completionAsk = "To complete the pulse, please reply with your overall satisfaction from 1 to 5.";

  if (analysis.requiresManagerAlert) {
    return analysis.isComplete
      ? `Thank you. I have captured this as a ${analysis.riskLevel.toLowerCase()} risk signal for ${analysis.primaryServiceName}. I am routing it to ${analysis.ownerName} and triggering an immediate manager alert.`
      : `Thank you. I have captured this as a ${analysis.riskLevel.toLowerCase()} risk signal for ${analysis.primaryServiceName}. I am routing it to ${analysis.ownerName} and triggering an immediate manager alert. ${completionAsk}`;
  }
  if (analysis.sentiment === "positive") {
    return analysis.isComplete
      ? `Thank you. I have captured ${analysis.primaryServiceName} as a positive signal and your overall satisfaction for ${client.name}.`
      : `Thank you. I have captured ${analysis.primaryServiceName} as a positive signal for ${client.name}. Is there any area where SRV should improve first? ${completionAsk}`;
  }
  return analysis.isComplete
    ? `Thank you. I have captured this under ${analysis.primaryServiceName} with the overall score. I will keep it visible in the service matrix and route the next action to ${analysis.ownerName}.`
    : `Thank you. I have captured this under ${analysis.primaryServiceName}. I will keep it visible in the service matrix and route the next action to ${analysis.ownerName}. ${completionAsk}`;
}

module.exports = {
  analyzeFeedback,
  buildAssistantReply,
  statusFromScore,
  id
};

export function formatDate(value) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** Scores are nullable in v2 — a session with no rating shows a dash, never 0.0. */
export function formatScore(score) {
  if (score === null || score === undefined || score === "") return "--";
  return `${Number(score).toFixed(1)}/10`;
}

/** How sure the model was. Below 70 it never alerts anyone. */
export function formatConfidence(confidence) {
  if (confidence === null || confidence === undefined) return null;
  const value = Math.round(Number(confidence));
  if (value >= 85) return `${value}% confident`;
  if (value >= 70) return `${value}% confident`;
  return `${value}% confident — treat as a rough read`;
}

export function confidenceClass(confidence) {
  if (confidence === null || confidence === undefined) return "neutral";
  return Number(confidence) >= 70 ? "strong" : "watch";
}

/** Share of respondents scoring 7 or above — the benchmarkable figure. */
export function formatCsatPercent(percent) {
  if (percent === null || percent === undefined || percent === "") return "--";
  return `${Math.round(Number(percent))}%`;
}

const TONES = {
  appreciative: { label: "Appreciative", tone: "strong", hint: "Active praise" },
  neutral: { label: "Neutral", tone: "neutral", hint: "Factual, no emotional signal" },
  disappointed: { label: "Concerns raised", tone: "watch", hint: "Some parts need improvement; this does not override the stated CSAT rating" },
  frustrated: { label: "Frustrated", tone: "weak", hint: "Repeated effort or chasing" },
  disengaged: { label: "Disengaged", tone: "weak", hint: "Withdrawn — a churn signal" }
};

/** Whole days between raising an issue and closing it. */
export function formatResolutionTime(createdAt, closedAt) {
  if (!createdAt || !closedAt) return "--";
  const ms = new Date(closedAt).getTime() - new Date(createdAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return "--";
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days} ${days === 1 ? "day" : "days"}`;
  const hours = Math.round(ms / 3600000);
  if (hours >= 1) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return "under an hour";
}

export function formatCycleStatus(cycle) {
  if (!cycle) return "Not started";
  return cycle.status === "closed" ? "Closed" : "Open";
}

export function formatTone(tone) {
  return TONES[tone] || null;
}

/**
 * An individual answer to the NPS question, on the 0-10 scale they were asked.
 */
export function formatNpsAnswer(score) {
  if (score === null || score === undefined || score === "") return "--";
  return `${Number(score)}/10`;
}

/**
 * A Net Promoter Score: promoters minus detractors, -100 to +100. Signed on
 * purpose — "+20" and "20/10" mean very different things, and showing an NPS
 * on a 0-10 scale is how it gets misread as a rating.
 */
export function formatNps(score) {
  if (score === null || score === undefined || score === "") return "--";
  const value = Math.round(Number(score));
  return value > 0 ? `+${value}` : `${value}`;
}

/** NPS from one or two people is not a trend. Say how many answered. */
export function formatNpsBasis(responses) {
  if (!responses) return "no responses yet";
  if (responses === 1) return "1 response — too few to read as a trend";
  if (responses < 5) return `${responses} responses — treat as indicative`;
  return `${responses} responses`;
}

export function npsClass(score) {
  if (score === null || score === undefined || score === "") return "neutral";
  const value = Number(score);
  if (value < 0) return "weak";
  if (value < 30) return "watch";
  return "strong";
}

/**
 * UI label only. The stored values stay "pulse" and "project_end" — n8n, the
 * database and every API field are untouched. "Pulse feedback" meant nothing
 * to management; the interval comes from the project, so a 30-day project
 * reads "30-Day Feedback" and a 45-day one reads "45-Day Feedback".
 */
export function formatCycleType(value, intervalDays) {
  if (value === "quick_checkin") return "Quick Check-in";
  if (value === "project_end") return "Project-End Feedback";
  return intervalDays ? `${intervalDays}-Day Feedback` : "Monthly Feedback";
}

export function formatCompletion(value) {
  const labels = {
    not_started: "Not started",
    partial: "Partial",
    completed: "Completed"
  };
  return labels[value] || value || "Unknown";
}

export function formatSessionStatus(value) {
  const labels = {
    started: "Awaiting reply",
    partial: "Partial",
    completed: "Completed",
    needs_attention: "Needs attention",
    no_response: "No response",
    opted_out: "Opted out"
  };
  return labels[value] || value || "Unknown";
}

export function formatSessionOutcome(session) {
  if (!session) return "Unknown";
  if (session.sessionType === "quick_checkin") {
    const outcome = session.conversationState?.quickCheckinOutcome;
    const windowExpiry = Date.parse(session.conversationState?.quickCheckinWindowExpiresAt || "");
    const inWindowState = session.conversationState?.state === "quick_checkin_window";
    const windowOpen = inWindowState && (!Number.isFinite(windowExpiry) || windowExpiry > Date.now());
    const windowElapsed = inWindowState && Number.isFinite(windowExpiry) && windowExpiry <= Date.now();
    const labels = {
      awaiting_response: "Awaiting response",
      needs_improvement: "Awaiting details",
      all_good: "All good",
      feedback_shared: "Feedback shared",
      no_response: "No response - closed",
      awaiting_details_expired: "Details not received - closed"
    };
    if (labels[outcome]) {
      if (windowOpen) return `${labels[outcome]} - 10-minute window open`;
      if (windowElapsed) return `${labels[outcome]} - window closed`;
      return labels[outcome];
    }
  }
  if (session.conversationState && session.conversationState.stoppedByAdmin) {
    return "Stopped for this cycle";
  }
  const exhausted = Boolean(
    session.reminderExhausted
    || (session.conversationState && session.conversationState.reminderExhausted)
  );
  if (exhausted) {
    return session.completionStatus === "partial" ? "Partial feedback — closed" : "No response — closed";
  }
  return formatSessionStatus(session.status);
}

export function formatEventType(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** "2 of 3 POCs · 67% weight" — the line that explains a partial cycle. */
export function formatCycleCoverage(cycle) {
  if (!cycle) return "No coverage yet";
  const responded = cycle.pocResponded || 0;
  const total = cycle.pocTotal || 0;
  const weight = cycle.weightResponded === null || cycle.weightResponded === undefined
    ? null
    : Math.round(Number(cycle.weightResponded) * 100);
  const base = `${responded} of ${total} ${total === 1 ? "POC" : "POCs"}`;
  return weight === null ? base : `${base} · ${weight}% weight`;
}

/** Level only — the weight number lives in the card footer so names fit. */
export function formatPocLevel(poc) {
  if (!poc) return "";
  return poc.levelName || "Not set";
}

export function formatWeight(poc) {
  if (!poc) return "";
  return `${poc.levelName || "Not set"} · ${Number(poc.weightPercentage) || 0}% influence`;
}

export function pocWeightShare(poc, projectPocs = [], options = {}) {
  const includeInactive = Boolean(options.includeInactive);
  if (!poc || (!includeInactive && poc.active === false)) return 0;
  const eligiblePocs = projectPocs.filter((item) =>
    item.projectId === poc.projectId && (includeInactive || item.active !== false)
  );
  if (!eligiblePocs.length) return 0;
  const configuredTotal = eligiblePocs.reduce(
    (sum, item) => sum + Math.max(0, Number(item.weightPercentage) || 0),
    0
  );
  if (!configuredTotal) return 100 / eligiblePocs.length;
  return (Math.max(0, Number(poc.weightPercentage) || 0) / configuredTotal) * 100;
}

export function formatPocWeightShare(poc, projectPocs = [], options = {}) {
  if (!poc || (!options.includeInactive && poc.active === false)) return "0% — inactive";
  const share = pocWeightShare(poc, projectPocs, options);
  const rounded = Math.round(share * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

const GUARDRAIL_LABELS = {
  G1_duplicate_inbound: "Duplicate message ignored",
  G2_opt_out: "Client opted out",
  G3_post_completion: "Message after cycle closed",
  G4_wrong_person: "Wrong number",
  G5_probe_cap: "Handed to a person",
  G6_out_of_scope: "Question routed to the team",
  G7_escalation: "Escalation",
  G8_invalid_rating: "Rating scale clarified",
  G9_bare_number: "Number ignored (no rating asked)",
  G10_unparseable: "Message not understood",
  G11_no_signal: "No feedback in message"
};

export function formatGuardrail(code) {
  return GUARDRAIL_LABELS[code] || formatEventType(code);
}

export function riskClass(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("off track") || normalized.includes("at risk") || normalized.includes("critical")
    || normalized.includes("concerned") || normalized.includes("escalated") || normalized.includes("high")
    || normalized.includes("weak") || normalized.includes("failed") || normalized.includes("escalation")) return "weak";
  if (normalized.includes("watch") || normalized.includes("partial") || normalized.includes("pending") || normalized.includes("attention")) return "watch";
  if (normalized.includes("on track") || normalized.includes("positive") || normalized.includes("closed")
    || normalized.includes("completed") || normalized.includes("low") || normalized.includes("sent")) return "strong";
  return "neutral";
}

/** Thresholds match the state machine: below 5 high risk, below 7 watch. */
export function scoreClass(score) {
  if (score === null || score === undefined || score === "") return "neutral";
  const value = Number(score);
  if (value < 5) return "weak";
  if (value < 7) return "watch";
  return "strong";
}

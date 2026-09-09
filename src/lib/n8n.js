// Event -> env var holding the n8n webhook URL.
// Anything a human must see but that has no dedicated webhook falls back to
// N8N_HUMAN_HANDOFF_WEBHOOK, so a guardrail can never fire into a void.
const EVENT_TO_ENV = {
  feedback_started: "N8N_FEEDBACK_STARTED_WEBHOOK",
  feedback_received: "N8N_FEEDBACK_RECEIVED_WEBHOOK",
  manager_alert: "N8N_MANAGER_ALERT_WEBHOOK",
  no_response: "N8N_NO_RESPONSE_WEBHOOK",
  feedback_session_closed: "N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK",
  cycle_completed: "N8N_CYCLE_COMPLETED_WEBHOOK",
  manual_whatsapp_message: "N8N_MANUAL_MESSAGE_WEBHOOK",

  // Guardrail / human-in-the-loop events (v2)
  post_completion_message: "N8N_HUMAN_HANDOFF_WEBHOOK",
  client_question: "N8N_HUMAN_HANDOFF_WEBHOOK",
  escalation: "N8N_HUMAN_HANDOFF_WEBHOOK",
  handoff: "N8N_HUMAN_HANDOFF_WEBHOOK",
  wrong_person: "N8N_HUMAN_HANDOFF_WEBHOOK",
  opt_out: "N8N_HUMAN_HANDOFF_WEBHOOK"
};

const HUMAN_EVENTS = new Set([
  "post_completion_message",
  "client_question",
  "escalation",
  "handoff",
  "wrong_person",
  "opt_out"
]);

function webhookFor(eventType) {
  const envName = EVENT_TO_ENV[eventType];
  const direct = envName ? process.env[envName] : null;
  if (direct) return direct;
  if (HUMAN_EVENTS.has(eventType)) return process.env.N8N_HUMAN_HANDOFF_WEBHOOK || null;
  return null;
}

async function emitAutomation(eventType, payload) {
  const webhookUrl = webhookFor(eventType);
  const event = {
    eventType,
    payload,
    status: webhookUrl ? "pending" : "skipped",
    webhookUrlConfigured: Boolean(webhookUrl)
  };

  if (!webhookUrl) return event;

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csat-webhook-secret": process.env.N8N_WEBHOOK_SECRET || ""
      },
      body: JSON.stringify({ eventType, ...payload })
    });
    event.status = response.ok ? "sent" : "failed";
    event.statusCode = response.status;
    event.sentAt = new Date().toISOString();
  } catch (error) {
    event.status = "failed";
    event.error = error.message;
  }

  return event;
}

module.exports = { emitAutomation, EVENT_TO_ENV, HUMAN_EVENTS };

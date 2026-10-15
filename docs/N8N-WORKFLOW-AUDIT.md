# n8n CSAT workflow audit — 30 August 2026

This review covers the nine exact workflow exports supplied with the current app. The older duplicate files in Downloads were not used.

## Must fix before relying on scheduled automation

1. **Workflows 8 and 9 use the wrong credential.** `Create Due Sessions` and `Process Due Reminders` currently use the `Meta WhatsApp Token` header credential when they call the CSAT app. Change both nodes to the same `CSAT Webhook Secret` credential used by `Call CSAT Engine`. The app expects `x-csat-webhook-secret`, not the Meta bearer token.
2. **One app environment variable cannot invoke both start workflows.** The app has one `N8N_FEEDBACK_STARTED_WEBHOOK`. It can point to workflow 2 (WhatsApp template) or workflow 6 (email link), but not both. If both channels are required, merge the email branch into workflow 2 or make one start workflow call the other.
3. **Cycle summary drops client questions.** The app sends `clientQuestions`, but workflow 10's `Build Summary` code never adds them to the email. Add a `CLIENT QUESTIONS / FOLLOW-UP NEEDED` section. Without it, a question can be included in the event but invisible to the recipient.
4. **No external send has a retry/error route.** The HTTP and SMTP nodes have no `retryOnFail`, `maxTries`, `waitBetweenTries`, or error workflow. This is especially dangerous in workflow 1: the app can save the inbound message, then the Meta send can fail. A later Meta retry is correctly detected as a duplicate, so the reply will not be regenerated. Configure retries on `Call CSAT Engine`, every Meta send, and every SMTP send; route exhausted failures to a monitored error workflow.

## Security and reliability hardening

- Workflow 1's GET verification path returns `hub.challenge` without checking `hub.verify_token`. Validate it against a dedicated n8n secret before returning the challenge.
- Workflow 1 does not validate Meta's request signature. Verify `x-hub-signature-256` against the Meta app secret before processing the POST body.
- Keep the webhook response fast. Longer app/Meta work should be retried or queued rather than leaving Meta waiting on an SMTP or API chain.
- The app adapter now registers notification promises with Netlify `context.waitUntil()`, allowing the HTTP reply to return without abandoning manager, handoff, or cycle-summary delivery work.
- Configure an n8n error workflow and execution retention for every active CSAT workflow. Alert on repeated 401, 429, and 5xx responses.

## Workflow-by-workflow result

| # | Workflow | Contract result | Required action |
|---|---|---|---|
| 1 | WhatsApp Inbound Message Router | App URL and request/response field names match. Provider message ID reaches the app's idempotency guard. | Add Meta token/signature verification and retries/error handling. |
| 2 | Feedback Started — WhatsApp | `project`, `poc`, `session.sessionType`, and services match the app payload. | Resolve the workflow 2/6 fan-out. Client-facing wording must remain “Monthly feedback”; `pulse` is only the app's internal cycle key. |
| 3 | Human Handoff | Event, guardrail, POC, client text, state, and resume URL match. | Add SMTP retry/error handling. Remove the unused old tunnel URL from Config. |
| 4 | Bad Feedback Manager Alert | `analysis.requiresManagerAlert`, manager/owner routing, score, and resume URL match. | Add SMTP retry/error handling. Remove the unused old tunnel URL from Config. |
| 5 | No/Partial Response Reminder | `reminderKind` and `conversationState.missingFields` match. The rating wording correctly uses 0–10. | Add Meta send retry/error handling. |
| 6 | Feedback Started — Email Link | Email, session type, interval, project name, and resume URL match. | Merge/fan out with workflow 2 if both email and WhatsApp are intended. |
| 8 | Create Due Pulse/Project-End Cycles | URL and 12-hour schedule are correct. The app now initializes a first pulse date for newly created/imported active projects. | Replace Meta credential with CSAT webhook credential; add retry/error handling. |
| 9 | Process Due Reminders | URL and hourly schedule are correct. | Replace Meta credential with CSAT webhook credential; add retry/error handling. |
| 10 | Cycle and Quick Check-in Summary | Issues, appreciations, observations, questions, recipients, CSAT, and resume URL match. It also accepts one per-POC quick-check-in completion payload. | Import v5, retain the SMTP credential and Directors' Office address, deactivate the older Workflow 10, then activate v5. |

## Recommended node retry policy

For CSAT app and Meta HTTP nodes, start with three attempts and a short increasing delay. Retry transient network failures, 429, and 5xx responses; do not endlessly retry validation or authentication failures. SMTP sends should also retry transient failures and then enter a monitored error workflow with the project/session identifier.

## Environment mapping

- `N8N_FEEDBACK_STARTED_WEBHOOK` → one combined start/fan-out workflow
- `N8N_MANAGER_ALERT_WEBHOOK` → workflow 4
- `N8N_NO_RESPONSE_WEBHOOK` → workflow 5
- `N8N_CYCLE_COMPLETED_WEBHOOK` → workflow 10
- `N8N_HUMAN_HANDOFF_WEBHOOK` → workflow 3
- `N8N_WEBHOOK_SECRET` → the value stored by n8n's `CSAT Webhook Secret` header credential

The live app URL is already correct in workflows 1, 2, 5, 6, 8, and 9. The old tunnel URLs in workflows 3, 4, and 10 are currently unused by their nodes, so they are confusing rather than the direct cause of a failure.

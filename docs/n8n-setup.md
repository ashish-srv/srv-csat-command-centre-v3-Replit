# n8n Cloud Setup

## Workflows To Import

Import these JSON files:

- `feedback-started-send-client-link.json`
- `feedback-started-send-whatsapp-template.json`
- `no-or-partial-response-reminder.json`
- `no-or-partial-response-whatsapp-reminder.json`
- `bad-feedback-manager-alert.json`
- `scheduled-45-day-and-project-end-session-creator.json`
- `scheduled-reminder-processor.json`
- `whatsapp-inbound-message-router.json`

## App Environment Variables

In the CSAT app:

```text
PUBLIC_APP_URL=https://your-hosted-csat-app.com
N8N_WEBHOOK_SECRET=shared-secret
N8N_FEEDBACK_STARTED_WEBHOOK=https://your-n8n-cloud/webhook/csat-feedback-started
N8N_MANAGER_ALERT_WEBHOOK=https://your-n8n-cloud/webhook/csat-manager-alert
N8N_NO_RESPONSE_WEBHOOK=https://your-n8n-cloud/webhook/csat-no-response
N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK=https://your-n8n-cloud/webhook/csat-feedback-session-closed
N8N_MANUAL_MESSAGE_WEBHOOK=https://your-n8n-cloud/webhook/csat-manual-whatsapp-message
```

## n8n Environment Variables

In n8n Cloud:

```text
CSAT_APP_URL=https://your-hosted-csat-app.com
CSAT_WEBHOOK_SECRET=shared-secret
WHATSAPP_SEND_MESSAGE_URL=https://your-provider-send-message-endpoint
WHATSAPP_SEND_TEMPLATE_URL=https://your-provider-send-template-endpoint
WHATSAPP_ACCESS_TOKEN=provider-token
```

Template names inside the sample workflows are placeholders. Replace them with the exact approved template names from your WhatsApp provider.

## Required Email Credentials

Update the Email Send nodes to use your SMTP/Gmail/Outlook credential.

Replace placeholder email addresses:

- `csat@srvmedia.example`
- `csat-alerts@srvmedia.example`

## Workflow Behavior

`scheduled-45-day-and-project-end-session-creator`

- Runs every 12 hours.
- Calls the app to create due sessions.
- The app triggers the feedback-started webhook for each created session.

`feedback-started-send-client-link`

- Sends the first feedback link to the client.
- Uses project-end wording for `sessionType = project_end`.

`feedback-started-send-whatsapp-template`

- Sends the first approved WhatsApp template to the client.
- Uses `srv_45_day_pulse` for normal cycles.
- Uses `srv_project_end_feedback` for project-end feedback.
- Passes `session_id` so replies can continue the same session.
- After the client replies, the app can send dynamic AI/state-machine replies inside the WhatsApp service window.

`scheduled-reminder-processor`

- Runs every hour.
- Finds due incomplete sessions.
- The app triggers the no-response webhook.

`no-or-partial-response-reminder`

- If no response: asks client to start feedback.
- If partial response: asks client to continue the same session and complete only the missing overall score.

`no-or-partial-response-whatsapp-reminder`

- Sends approved WhatsApp reminder templates.
- Uses `srv_feedback_reminder` for no response.
- Uses `srv_complete_feedback_reminder` for partial response.
- On reminder three, uses `srv_final_rating_reminder` when a partial respondent
  has not yet supplied an overall rating.

`partial-feedback-session-closing`

- Runs only for partial respondents after all three reminders and the final
  24-hour grace period have expired.
- Sends `srv_feedback_session_closed` and waits for Meta to accept the message
  before the application closes the session.
- It is never used by the dashboard's **Stop Feedback** action.

`bad-feedback-manager-alert`

- Sends an instant manager email when `requiresManagerAlert = true`.
- Uses the service owner and manager email returned by the CSAT app.

`whatsapp-inbound-message-router`

- Receives incoming WhatsApp replies from your provider.
- Normalizes the payload to include `sessionId`, `from`, `fromName`, `messageId`, and `text`.
- Calls `/api/whatsapp/sessions/:sessionId/reply`.
- Sends `whatsappReplyText` back to the same WhatsApp number.

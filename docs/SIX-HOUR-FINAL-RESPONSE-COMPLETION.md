# Six-hour final-response completion

This automation applies only when a full feedback session has reached the final
optional Directors question and the client does not answer it for six hours.

It does **not** change the normal flow. When the client answers the final
question, the existing thank-you message and 10-minute correction window start
immediately.

## Eligibility

- Monthly feedback must have a stated overall rating.
- Project-end feedback must have both a stated overall rating and a stated NPS.
- The final Directors question must be the pending question.
- An already-open session waiting on the older optional appreciation question
  is treated the same way for backward compatibility.
- No client message may have arrived after that question.
- The session must not already be closing, closed, handed off or opted out.

## Installation

1. Deploy the matching application code to Replit.
2. Import `15 - CSAT v1 - Complete Inactive Final Responses.json` into n8n.
3. In its Config node, replace `https://YOUR-REPLIT-APP.replit.app` with the
   published application URL, without a trailing slash.
4. On the HTTP Request node, select the existing `CSAT Webhook Secret`
   credential. Its header must be `x-csat-webhook-secret`, with the same value
   as the Replit `N8N_WEBHOOK_SECRET` deployment secret.
5. Confirm workflow 11 (Manual WhatsApp Message) is active and that Replit's
   `N8N_MANUAL_MESSAGE_WEBHOOK` points to its production webhook URL.
6. Run workflow 15 manually once. A successful empty scan returns HTTP 200 with
   empty `sent` and `failed` arrays.
7. Activate workflow 15. It runs every five minutes in `Asia/Kolkata`.

No new Meta template or Replit secret is required.

## Duplicate protection and recovery

Each session uses the unique key `six_hour_completion:<session-id>`. Repeated
workflow runs, retries and application restarts cannot dispatch that session a
second time. The endpoint also re-reads the session after claiming it so a
concurrent normal client reply wins safely.

The same scan changes an expired automatic correction window from
`closing_grace` to `completed`. A client message received after the timestamp is
still treated as post-completion even if the next five-minute scan has not run.

If more than 24 hours have elapsed since the client's latest message, the app
does not attempt a free-text WhatsApp send. It closes the fully scored session
without a message and records the reason in the conversation state and
automation audit.

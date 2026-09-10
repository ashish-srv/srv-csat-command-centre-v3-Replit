SRV CSAT n8n import package — 31 August 2026
====================================================

This package uses MONTHLY feedback wording. The app's internal cycle key can
still be "pulse"; that is only a technical key and does not change client text.

IMPORT ORDER
------------
1. Deactivate the old CSAT workflows first.
2. Import files 01 through 12 individually in n8n.
3. In workflow 01, replace both placeholders before activation:
   - Meta POST Security Config -> META_APP_SECRET
   - Meta GET Security Config  -> META_VERIFY_TOKEN
   These are local Set nodes, not HTTP requests. The GET branch runs only for
   Meta's webhook handshake; the POST branch verifies x-hub-signature-256
   locally before the workflow acknowledges the webhook.
4. Confirm these existing n8n credentials are selected on imported nodes:
   - CSAT Webhook Secret: Header name x-csat-webhook-secret and the same value
     as Netlify N8N_WEBHOOK_SECRET.
   - Meta WhatsApp Token: Authorization header for Meta Graph API.
   - SMTP (Ashish): email credential.
5. In workflows 01-05 and 08-12, open Workflow Settings and choose workflow 07
   as the Error workflow. Workflow 06 is optional and should remain inactive.
6. Activate workflows 01-05 and 08-12. Workflow 07 does not need normal trigger
   activation; it is selected as the Error workflow.

NETLIFY ENVIRONMENT VARIABLES
-----------------------------
N8N_FEEDBACK_STARTED_WEBHOOK = <n8n base>/webhook/csat-feedback-started
N8N_MANAGER_ALERT_WEBHOOK    = <n8n base>/webhook/csat-manager-alert
N8N_NO_RESPONSE_WEBHOOK      = <n8n base>/webhook/csat-whatsapp-reminder
N8N_CYCLE_COMPLETED_WEBHOOK  = <n8n base>/webhook/csat-cycle-completed
N8N_HUMAN_HANDOFF_WEBHOOK    = <n8n base>/webhook/csat-human-handoff
N8N_MANUAL_MESSAGE_WEBHOOK   = <n8n base>/webhook/csat-manual-whatsapp-message
N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK = <n8n base>/webhook/csat-feedback-session-closed
N8N_WEBHOOK_SECRET           = same secret used by the CSAT Webhook Secret credential

WHATSAPP / META
---------------
Callback URL: <n8n base>/webhook/csat-whatsapp-inbound
Verify token: use the same value in Meta Developers and workflow 01.

The approved Meta template name srv_30_day_pulse is intentionally retained.
Meta rejects unapproved template names. Check the visible text of that approved
template in WhatsApp Manager and make sure it says "monthly feedback". If you
create and approve a new template name, update Send WhatsApp Template afterward.

WHAT WAS FIXED
--------------
- Correct CSAT credential in scheduler workflows 08 and 09.
- Header authentication on all app-to-n8n webhooks.
- Meta verify-token and x-hub-signature-256 checks in workflow 01.
- Fast webhook acknowledgement before slower Gemini/Meta work in workflow 01.
- Three-attempt retries on CSAT, Meta, and SMTP nodes.
- The main feedback-started workflow sends WhatsApp only. Workflow 06 remains
  an optional email-only fallback and should stay inactive unless required.
- Monthly wording preserved in client emails and cycle summaries.
- Client questions included in workflow 10 summary.
- Workflow 07 sends an email when a CSAT workflow exhausts retries.
- Old tunnel URLs removed from the package.
- Workflow 11 sends dashboard-written free-text replies through the existing
  Meta WhatsApp credential and returns only after Meta accepts the message.
- Workflow 05 uses `srv_final_rating_reminder` for the third reminder when a
  partial respondent has not provided an overall rating.
- Workflow 05 uses `srv_complete_project_end_feedback_reminder` for partial
  project-end feedback, while monthly partial feedback continues to use
  `srv_complete_feedback_reminder`. Create and approve the project-end Meta
  template before activating this route; use {{1}} for the POC name and {{2}}
  for the missing-feedback list, and say "complete your project-end feedback"
  instead of "complete this month's check-in".
- Workflow 12 sends `srv_feedback_session_closed` and waits for Meta to accept
  it before the application closes an exhausted partial session.

WORKFLOW 06
-----------
Workflow 06 is an optional email-only fallback. Do not point
N8N_FEEDBACK_STARTED_WEBHOOK to it when workflow 02 is active, because workflow
02 already sends the monthly feedback request on WhatsApp.

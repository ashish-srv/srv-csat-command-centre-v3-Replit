# Cluster Email Workflow Update — 24 October 2026

These three inactive import files were built from the current exports supplied
by the user. The supplied files in Downloads are unchanged. No live workflow,
production database, Replit secret or SMTP service was changed during preparation.

| Replace workflow | Import file | New behavior |
| --- | --- | --- |
| 3 | `03 - CSAT v6 - Super Admin Human Handoff.json` | Explicit human handoff / unhandled post-closure message, to active Super Admins only |
| 4 | `04 - CSAT v6 - Concern Emails Disabled.json` | Compatibility webhook, no mail sender; routine concerns belong in the completed POC summary |
| 10 | `10 - CSAT v6 - Cluster POC Feedback Summary.json` | One POC's complete monthly, project-end or quick check-in summary to active Super Admins plus opted-in cluster Admins |

## Required setup

1. Keep a copy of the existing workflows. Import these files **inactive** and
   review them. Do not run old and new copies on the same webhook path.
2. On each Webhook node, select the **CSAT Webhook Secret** Header Auth credential.
   Its header name must be `x-csat-webhook-secret`; its value must exactly match
   `N8N_WEBHOOK_SECRET` in Replit **production**. The supplied current exports had
   no authentication; the updated files deliberately require it. The credential
   reference is included, not the secret. If it does not resolve in your instance,
   select/create the matching credential; do not change authentication to None.
3. On workflow 3 and 10 email nodes, confirm the preserved SMTP credential.
   Their sender addresses are preserved: workflow 3 uses `directoroffice@srvmedia.com`,
   workflow 10 uses `internalcommunications@srvmedia.com`. No sender changes or
   extra recipient settings are needed.
4. Coordinate activation with the new application release during a quiet period.
   Do not switch while clients are actively responding or summaries are being
   dispatched. Pause automatic scheduler runs for the short cutover if necessary,
   then restore them. These files reject old application payloads instead of
   sending to an old fixed address. Conversely, the old email workflows must not
   remain active with the new recipient policy.
5. Apply migration **022** with `npm run db:migrate` against the intended production
   database, deploy the pending application changes, and assign Admin clusters
   and email switches in Manage → Application Users as Super Admin. Verify your
   own Super Admin account is active and has the correct email. No active Super
   Admin email means no dispatch. Existing Admins default to no cluster access.
6. Deactivate the old workflow 3, 4 and 10 copies; activate/publish their v6
   replacements once the matching application is ready. Confirm the production
   webhook URLs below. Restore workflow 15 and any other paused schedulers.

| Replit production secret | Unchanged webhook path |
| --- | --- |
| `N8N_HUMAN_HANDOFF_WEBHOOK` | `/webhook/csat-human-handoff` |
| `N8N_MANAGER_ALERT_WEBHOOK` | `/webhook/csat-manager-alert` |
| `N8N_CYCLE_COMPLETED_WEBHOOK` | `/webhook/csat-cycle-completed` |

The n8n base URL must remain your actual instance URL. Use production webhook
URLs, not `/webhook-test/` URLs. No new email-recipient secret is needed.

## What was removed / retained

- Removed Config recipient fallbacks and manager/service-owner routing. An owner
  receives a summary only if they independently qualify as an opted-in cluster
  Admin or active Super Admin. Project Users do not receive CSAT summaries.
- Ordinary complaints, suggestions, questions, office-visit requests and
  recoverable Gemini timeouts do not invoke immediate email. Workflow 3 also
  rejects those event types if an old caller sends them directly.
- Workflow 10 uses the application's exact recipients and escaped Verdana HTML
  plus plain text. It includes the POC's final feedback and original transcript,
  additions/corrections, and separate CSAT/NPS values. No interpretation/debug
  labels are added to transcripts.
- The application retains the original 10-minute deadline and durable send-once
  claim. Workflow 10 checks for a single POC/session and rejects an unexpired
  deadline. It does not start a new timer, wait for other POCs, or backfill old mail.
- There is no automatic SMTP retry. A timeout can occur after delivery; blindly
  retrying the workflow can send a duplicate. Check the execution/provider first.
- The reply is sent only after the SMTP node returns and all expected recipients
  appear in its accepted list, with no rejection. SMTP acceptance is **not** proof
  of inbox delivery. Partial rejection returns `sent:false`; do not resend to
  everyone automatically, since some recipients may already have received mail.
- These workflows do not change the bot's conversation prompts, service questions,
  ratings, completion behavior or WhatsApp templates.

## Controlled verification after activation

Use a test project/POC and intended test recipients before normal operation:

1. Record a concern, request and appreciation during the same conversation:
   no workflow 3 or 4 email should be sent for those ordinary messages.
2. Finish the POC feedback, add/correct something within ten minutes, and let
   the original window close. Workflow 15 must remain active to process closure
   and queued summaries. Expect one workflow 10 email including the corrections.
3. Verify all active Super Admins and only opted-in Admins for that project's
   cluster are recipients. Verify muted Admins, other-cluster Admins and Project
   Users are excluded. Repeat for monthly, project-end and quick check-in.
4. A real explicit human-handoff event should run workflow 3 to Super Admins only,
   including the triggering message and conversation context.
5. Check the SMTP node output and actual mailboxes. Do not retry old executions
   to test: their payloads have stale recipient lists and may duplicate mail.

Local validation: `npm run test:n8n-email` plus conversation-lifecycle and
cluster-access regression suites. These execute the exported Code-node logic and
check graph wiring with simulated payloads/results; they do not replace a live
n8n import/SMTP check. If workflow 6 is active or your workflow 12 includes an
email node, provide those exports for review too. Preserve workflow 12's WhatsApp
closing action and workflow 15's scheduler.

References checked for node compatibility:
[Webhook authentication and response modes](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/),
[n8n Email Send implementation: both formats and SMTP result](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/nodes/EmailSend/v2/send.operation.ts).

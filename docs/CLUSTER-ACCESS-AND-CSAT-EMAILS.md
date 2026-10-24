# Cluster Access and CSAT Emails

## Application Users

Manage → Application Users supports assigning one or more clusters while adding or bulk-editing users. Each Admin/cluster has a separate **Send CSAT Summary Emails** switch. Save all user changes to apply the assignments.

- Super Admins retain all-cluster access and are mandatory CSAT summary and human-handoff recipients.
- Admins can access projects, CSAT, Project Performance, downloads and operational actions only in their assigned clusters. No assigned clusters means no project access. Server checks cover direct links and bulk actions, not only filters.
- Email switches do not alter access. Project Users never receive CSAT emails through these assignments; their existing project-team assignments still determine Project Performance access.
- Shared organization standards, standard service definitions and the global messaging switch remain Super-Admin-only: changing them would affect other clusters. Cluster Admins can manage their project records and delivery settings when their feature permissions allow it.
- Admins may manage Project Users only when the user's linked Internal POC, all assigned clusters and all project-team assignments are within their scope. Cross-cluster users need a Super Admin. External Google identity approval is Super-Admin-only.

## External Google Accounts

Add the person's exact Google email, link their Internal POC, assign Project User, enable **Approve This Exact External Google Email**, and assign their project team roles. Do not add gmail.com to GOOGLE_ALLOWED_DOMAINS. Approval is checked at sign-in and on every API request, so revocation or deactivation applies to existing sessions too. The Google OAuth application's audience must permit external accounts; an Internal-only Google OAuth application cannot admit Gmail users.

## Email Policy

For monthly, project-end and quick check-in feedback, send one complete summary per POC after that session's fixed 10-minute window closes. Include additions and corrections and the original transcript. Other POCs need not finish first. Existing summary queue and deduplication keys are retained.

Recipients are active Super Admins plus active Admins assigned to the project's current cluster with email enabled. Deduplicate addresses. Do not add service owners, reporting managers, Project Users or workflow fallback recipients. A missing active Super Admin email blocks dispatch and records the failure instead of silently routing elsewhere.

Ordinary complaints, suggestions, questions and requests are recorded during the conversation without individual email dispatch. A genuine explicit human handoff goes to Super Admins only, with the triggering message and conversation context. Recoverable Gemini failures are not an email reason. Post-closure messages that the bot cannot handle continue through the human-handoff route.

The `feedback_session_closed` event is intentionally NOT suppressed: it is also used by the partial-response WhatsApp closing-template workflow. Remove any extra email node from that workflow if present; preserve its WhatsApp sender.

## n8n Contract — Update Before Deployment

The user's current exports of workflows **3, 4 and 10** were supplied and reviewed on 24 October. The updated inactive **v6** files are in `n8n/workflows`; use [Cluster Email Import Steps](../n8n/workflows/README-CLUSTER-EMAIL-IMPORT.md) for coordinated rollout. Workflow 4 now has no email sender. Workflows 3 and 10 require authenticated application payloads and use the exact application template/recipients. No live workflow has been changed. Also inspect any separate completion/concern mail workflow; workflow **12 (Partial Feedback Session Closing)** only needs an email adjustment if the deployed version contains an email sender. Workflow 15's scheduler should remain active for closing windows and processing queued summaries.

For summary/handoff events the application supplies:

- `emailPolicyVersion: 1`, `recipientPolicy: "cluster_admins_v1"`
- `recipients`: exact deduplicated allowed recipients; `mandatoryRecipients`: active Super Admins
- `email.to`, `email.subject`, `email.html`, `email.text`
- Original `project`, `poc`, `sessions`/`session`, `messages` and summary facts

The workflows must use these recipients without appending old configured addresses, service owners or managers. Use the supplied escaped Verdana HTML/plaintext. Return success only after the mail-send node succeeds. SMTP acceptance does not prove inbox delivery; provider logs remain authoritative for delivery troubleshooting. Workflow retries must not blindly resend after ambiguous timeouts.

## Deployment Order

1. Review/test locally and update the current n8n exports together with the application. No live workflows were changed automatically.
2. Run `npm run db:migrate` against the intended database before deploying this application version. Migration 022 adds only cluster assignments and the explicit external-login flag; it does not remove data or alter POC weights, services or past feedback.
3. Sign in as Super Admin, assign Admin clusters and email switches, then save. Existing Admins intentionally default to no cluster access until assigned.
4. Verify one permitted/denied Admin project and an assigned Project User. Verify summary recipients and one real handoff using a controlled test POC before normal sending.

## Reports and UI

Application-generated emails use the shared SRV-inspired red, charcoal, white
and soft rose/grey theme in Verdana. Both HTML and plain text end with
`Best Regards,` followed by `Ashish Kate`. This applies to feedback summaries,
human handoffs and direct SMTP client/project setup and service-approval alerts.
The v6 n8n workflows forward these app-generated bodies unchanged, so no new
credential or v6 workflow re-import is needed for presentation-only updates.
Separate legacy/optional workflows that compose their own mail bodies (such as
6 or 7) are outside this app template; obtain their current deployed exports
before replacing those independently managed templates. Historic emails and
conversation transcripts are not rewritten.

Dashboard → Consolidated Feedback and Chat Export supports cluster/client/project/type/date selection and HTML, Excel or print-to-PDF. Data is grouped by project, POC and session. Transcripts contain original message text, not interpretation/debug labels. Quick check-ins do not invent ratings. CSAT and NPS remain separate. Exports never include stored Zoho credentials.

The sidebar distinguishes total open issues from the overdue subset; issue due dates are currently set at creation to 24 hours for high severity and 48 hours otherwise. Project service selectors exclude existing/draft duplicates. Explicit Add/Copy actions reveal newly inserted editor rows without changing scroll on typing or save.

# WhatsApp Broadcasts

The Broadcasts tab creates text-only announcement campaigns from approved Meta
templates. Recipients are grouped by client, project and POC. One normalised
WhatsApp number receives one announcement within a campaign, with all selected
client/project associations recorded in the preview and history.

## Deployment

1. Deploy the code and run `npm run db:migrate` against the production database.
   Migration `026-whatsapp-broadcasts.sql` adds campaigns, recipient delivery
   records, replies, messaging preferences and the per-cycle skipped-POC list.
2. Update the existing n8n Workflow 1 using
   `01 - CSAT v6 - WhatsApp Inbound Router (Broadcast Priority).json`. Keep its
   existing app URL and credentials. Replace the existing listener and activate
   that workflow. Its original CSAT nodes and request body are retained. The
   additional status branch records sent/delivered/read/failed notifications.
3. Import `16 - CSAT v1 - WhatsApp Broadcast Sender.json`. In Config, enter the
   published application URL and copy the WhatsApp Graph send URL from the
   existing working template sender. Select the existing CSAT Webhook Secret
   and Meta WhatsApp Token credentials. Both new workflow exports start inactive.
4. Add Workflow 16's production webhook URL to the Replit **Production Secret**
   `N8N_BROADCAST_WEBHOOK`. Reuse the existing `N8N_WEBHOOK_SECRET`. Activate
   Workflow 16, which also checks the pending queue every minute.
5. Super Admin registers an already-approved template under Broadcasts →
   Approved Announcement Templates. Enter its exact Meta name, language code and
   approved body. This version supports text-only body templates with numbered
   parameters and no header, attachment or button components. Meta approval is
   completed in WhatsApp Manager before registration in this application.

### Delivery-receipt fix (17 November 2026)

For an existing installation, deploy the application and run `npm run db:migrate`.
New migration `027-broadcast-delivery-and-history.sql` adds failure codes/times,
retry links and history-removal markers. It does not modify CSAT tables, ratings,
sessions or conversation state. Existing migration files are unchanged.

Update **both** the shared Visitor 03 router and CSAT Workflow 1, then publish the
updated versions. Keep the Meta callback pointing to the shared Visitor router.
The configured import files in `outputs` preserve the supplied URLs, credential
references, signature verification, visitor approval and OTP-cancellation paths:

- `SRV Visitor 03 - Shared Router - Delivery Receipts Fixed.json`
- `1. CSAT v6 - WhatsApp Inbound Message Router (Birthday and Broadcast Isolation).json`

Replace the existing workflows rather than enabling additional listeners with
the same webhook paths. Workflow 16 needs no change for this fix. No new secrets
are required; cleanup uses the existing `ADMIN_PIN` Manage password.

The shared router forwards status-only batches separately from client messages.
CSAT Workflow 1 saves receipts before returning HTTP success. Ordinary text still
uses the existing CSAT nodes and request body. Failed receipt writes propagate
back to the shared router so Meta can retry. Duplicate and out-of-order receipts
cannot regress Read/Delivered to Sent/Failed.

Old dropped receipts are not automatically recovered. The optional, manual-only
`One-time - Restore Known Broadcast Delivery Receipts.json` file in `outputs`
contains the six status events supplied for the 17 November 17:51 IST test. Run
it once after deploying/migrating, then Refresh Status. It only posts receipts to
the app; it contains no WhatsApp send node. It cannot reconstruct missing events
that were never supplied.

The reusable `scripts/upgrade-broadcast-workflows.js` accepts `visitor|csat`, an
input JSON path and an output JSON path. It fails on an unexpected splitter
version. Configured exports and backups stay in ignored `outputs`, not Git.

### Retries and removal

- History counts Delivered (including Read), Read, Awaiting Confirmation and
  Failed separately. A provider acceptance is not a delivery confirmation.
- A confirmed Failed recipient has a manual **Retry Failed Recipient** button.
  Meta error `131049` enforces at least 24 hours from its failure timestamp.
  Retrying later does not guarantee delivery. No automatic resends are added.
- A retry creates a separate announcement attempt for that one recipient, using
  the original approved template/text/parameters. The database permits one retry
  child per failed attempt. A later failure can be retried from that new attempt.
  Current cluster access, template availability, opt-out, valid contact and active
  feedback are checked again. If a delayed success arrives before dispatch, the
  pending retry is skipped. Accepted, Sent, Unknown, Delivered and Read records
  cannot be retried through this action.
- Super Admin can **Remove from App** under Approved Templates. This removes the
  template registration, not the Meta template or historical announcement snapshots.
- Super Admin can **Delete History** with recipient/message counts shown first,
  explicit DELETE confirmation and the Manage password. Existing announcement and
  message content is erased. Minimal routing/provider IDs, timestamps, opt-outs
  and delivery metadata remain so late replies cannot spill into CSAT. New replies
  to removed history reappear in Broadcast Replies. Clients' WhatsApp chats are
  unaffected. Pending sends/replies must finish before cleanup.

## Access and sending

Super Admin has access. Existing/new Admin and Project User accounts receive no
broadcast grants by default. In Manage → Application Users, grant the Admin
**View WhatsApp Broadcasts**, **Create and send WhatsApp broadcasts** and/or
**Reply to WhatsApp broadcast conversations** as required. Admin recipient and
history access follows assigned clusters. A shared-number conversation spanning
multiple clusters is visible only to Super Admin or an Admin assigned to every
linked cluster, because its messages cannot be separated safely by cluster.
Project Users cannot access broadcasts.

Select matching POCs, preview the personalised message and the skipped reasons,
confirm recipient messaging permission and send. Filters have search, multiple
selection, Clear and OK. Only selected POCs within the displayed filters are
submitted. A shared number's name/client/project template values combine its
eligible selected associations in the preview. The exact personalised text and
template field values are saved with each recipient, so history and queued sends
retain the confirmed message even if contact details change afterwards.

The queue checks contact status and active feedback again before each send.
Paused messaging, missing/invalid numbers, opt-outs and active feedback produce
visible reasons. A number with active feedback on another project is also skipped.
Only the explicit Send action creates a new campaign. Repeated requests use the
same request ID and cannot create a second campaign. Background workers claim
jobs under database locks and authorise each external send once.

The history distinguishes Queued, Sending, Accepted by WhatsApp, Sent,
Delivered, Read, Failed, Confirmation Missing and Skipped. Actual delivery/read
states come from Meta webhooks. A missing external confirmation is retained for
review. The worker does not automatically resend an uncertain or accepted send.
The reply inbox defaults to all campaigns, with latest replies first, status/date
filters, search, pagination and a per-recipient chat window. Free-text manual
replies require the recipient's open 24-hour WhatsApp service window.

An explicit STOP, UNSUBSCRIBE or OPT OUT reply records a messaging opt-out.
Future proactive announcements and feedback sends honour that preference.
Authorised senders can record renewed permission with a note in the conversation.

## Reply priority

- A broadcast newer than the recipient's previous feedback sessions owns its
  incoming replies. They are stored in Broadcast Replies for manual response.
  Tapping a button from an older, closed Quick Check-in does not revive that
  feedback or trigger its closed-session response after a newer announcement.
- When a newer WhatsApp feedback session starts, its start time takes priority
  over the earlier broadcast. All subsequent replies go through the existing
  feedback handler, including replies quoting the earlier announcement.
- After that feedback closes, its existing post-completion handling continues.
  The old broadcast composer explains that the newer feedback owns replies.
- A later new broadcast establishes a new announcement context. Exact broadcast
  reply references identify its campaign when announcements own the conversation.
- Duplicate provider messages retain their original destination. Provider
  timestamps prevent delayed deliveries being attached to a newer interaction.
- Birthday routing retains its own message references and latest-wish behaviour.
  The announcement guard defers unquoted replies to a newer birthday wish and
  preserves exact birthday references and already-recorded birthday deliveries.

## Old quick check-in buttons after a newer survey starts

An old, closed quick check-in button may still be visible in WhatsApp. When the
sender taps it and has exactly one verified newer active quick check-in, 30-day
or project-end session, the app resumes its first or pending question, naming
the project and feedback type. It preserves
the original tap in the transcript, does not treat it as feedback/a rating, and
does not reopen the old quick check-in or issue a handoff for the tap. An existing
follow-up does not consume another opportunity merely because it was repeated.

Broadcast and birthday isolation run before this routing check. Visitor approval
and OTP controls retain their shared-router destinations. Current quick check-in
buttons keep their own handler. Without a newer active survey, closed-session
handling continues. If multiple projects are active, the verified original
button's project can identify exactly one newer session in that project. The
selection is saved separately from ordinary survey resumption so the next
plain-text answer stays with that project; a later feedback invitation invalidates
that selection. Ambiguous sessions in the same project are never chosen silently. Provider
IDs deduplicate taps, and delayed webhooks from before the newer survey started
stay with their original session. A running 10-minute window keeps its original
deadline and recorded scores.

Both old buttons act only as resumption controls. An old All good tap cannot
record a positive outcome in a newer quick check-in. The latter enters its
detail prompt without adding an issue or resetting a running window.

An unverifiable/deleted original button or unresolved project ambiguity is saved
as a pending `feedback_routing_review` entry in the existing automation audit
table. The client receives a short review acknowledgement (unless WhatsApp is
paused); no survey, rating or issue is modified and no per-message email is sent.
The dashboard and attention rail show **Feedback routing needs review**, with
the message, reason, associated project links and a **Mark reviewed** action.
Super Admins see all entries. Admins require access to every associated project;
unknown/unassigned entries are Super Admin-only, and Project Users cannot access
the queue. Provider IDs deduplicate retries, including after a review is resolved.
This queue does not guess a destination or automatically replay a reviewed message.

This fix needs application deployment only: no database migration, new secret or
n8n workflow change. `test:quick` covers the routing boundaries; `test:api` covers
the first/pending questions, follow-ups, CSAT/NPS, next real reply, duplicate taps,
sender checks, correction windows and normal quick check-in buttons. The routing
review tests cover concurrent stops, unchanged scores/deadlines, the review UI,
pagination and cluster privacy. No live WhatsApp or email is sent by these tests.

## Eligible feedback recipients

Automatic, Project Workspace and Manage bulk sends use the same per-POC
eligibility check for Quick Check-in, 30-Day and Project-End. Eligible active
POCs receive sessions. Missing/invalid numbers, inactive/removed POCs, duplicate
numbers, opt-outs and already-active conversations are recorded with reasons.
An empty eligible list creates no cycle. Automatic failures retain named POC
reasons in the scheduler audit. Successful cycles retain `skipped_pocs` for
Project Workspace display, and only included sessions count toward completion.
The configured POC weights are preserved in the existing session snapshots.

## Verification

Run `npm run test:broadcasts`, `npm run check`, `npm test` and `npm run build`.
The broadcast tests use fixture recipients, provider responses and browser events.
They cover routing priority, duplicate deliveries, shared numbers, cluster/role
permissions, filter behaviour, preview, queueing and the three feedback types.
The existing conversation regression suites exercise the feedback handlers.

`scripts/broadcast-delivery-smoke.js` covers shared-router receipt batches,
visitor/OTP controls, retry cooldown, permissions and cleanup. For disposable
PostgreSQL integration verification, install `@electric-sql/pglite` outside the
application dependencies and pass its directory to
`node scripts/broadcast-database-smoke.js <package-directory>`. This test never
uses `DATABASE_URL`; it applies migrations 026/027 to an in-memory database and
tests early receipts, retry uniqueness, history removal and late reply routing.

## Page layout and changing access

Application page tabs wrap within the available width as permissions change.
Disabling the current page opens an allowed page. If every page is disabled,
the account sees a clear access message and Sign out. Visible signed-in pages
refresh permissions every 30 seconds and on return to the browser tab.
Unchanged access preserves the current page state and drafts.

Recipient tables, preview lists, history, delivery/reply tables, template text
and chat transcripts have bounded scroll areas. Their heights adapt to the
viewport. History and the all-campaign inbox also use pagination.

## Broadcast report downloads

Broadcast History and Broadcast Replies & Delivery each offer **PDF**, **HTML**
and **Excel**. PDF opens the browser's Print / Save as PDF window, matching the
existing CSAT report downloads. HTML keeps each recipient's original conversation
in its own scroll area; printing expands all messages. Excel has Summary,
Announcements, Recipients and Conversations sheets with frozen/filterable headers.

History downloads cover all accessible announcement history across every page.
Replies & Delivery downloads apply the selected broadcast, delivery/reply status,
search and latest-reply date range to every matching recipient, across all pages.
The date range uses the latest client reply date in IST; clear dates to include
POCs who have not replied. Exported conversations contain all saved messages for
the matching recipients, not just messages inside the date range.

Reports include original announcement text, recipients and linked clients/projects,
delivery/read status, failed/skipped reasons, Meta error codes, retry timing and
client replies. Provider message IDs, automation secrets and deleted chat content
are excluded. Cluster/role access matches the Broadcasts tab, including requiring
every linked cluster for a shared-number conversation. Oversized exports ask for
narrower filters rather than silently dropping rows. Exports are read-only.

These changes require **no new migration, secret or n8n workflow update**. The
existing broadcast migrations must already be applied. Broadcast date fields now
have their own responsive sizing, with visible date-reset and Reset filters controls.

`scripts/broadcast-export-smoke.js` tests filtered export access, report counts,
raw transcript text, HTML escaping, IST boundaries and Excel reopening.
`scripts/broadcast-export-browser-smoke.js` checks actual desktop/mobile geometry,
clear/reset, file downloads and the PDF popup using fixture data. It accepts the
same `CSAT_BROWSER_TEST_MODULE` and `CSAT_BROWSER_TEST_EXECUTABLE` options as the
existing browser tests. Run `node scripts/broadcast-export-smoke.js --fixtures`
first to generate its local report samples under ignored `outputs`.

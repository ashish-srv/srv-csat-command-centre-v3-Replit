# Birthday Centre

This module uses independent PostgreSQL tables. It never creates CSAT projects,
alters POC influence or changes feedback state. A separate transport-level
inbound check isolates birthday replies before the unchanged CSAT conversation
engine. Birthday-only organisations are entered directly.

## Deployment

1. Deploy the code with migrations `024-birthday-centre.sql` and
   `025-birthday-reply-isolation.sql`.
   Run `npm run db:migrate` against the intended database before opening the tab.
   This adds birthday contacts, yearly occasions, history, a send queue and
   separate reply-routing/review records. It does not change CSAT tables.
2. Both contact wish channels and scheduled birthday automation default OFF.
   Existing users are not automatically granted Birthday Centre access.
3. In Manage → Application Users, Super Admin can grant Admin permissions:
   View Birthday Centre, Manage Contacts/Gifts/Approvals, Send Reminders,
   and Delete Birthday History. Project Users cannot access the tab or API.
   Admin access is limited to assigned clusters; unassigned contacts require
   Super Admin. Internal POC email responsibility does not grant CSAT access.
4. Under Birthday Centre → Settings, configure desk and additional notification
   email recipients and the standard gift list. Keep Special Gift and No Gift.
   The existing SMTP_* application secrets send birthday emails. Existing
   SESSION_SECRET (or APP_SESSION_SECRET) must be stable and at least 16 characters
   for signed action links. N8N_WEBHOOK_SECRET must be a real shared secret of
   at least 16 characters for birthday automation; no new secret name is required.
5. Import **Birthday A v2 - Gift Reminders and Email Wishes.json** in n8n.
   Set Config.CSAT_APP_URL to the published application origin, without a trailing
   slash, and reuse the application's N8N_WEBHOOK_SECRET. It runs every 15 minutes;
   the application applies 8 AM IST wishes and 9 AM IST internal follow-up rules.
6. Disable the old Google-Sheet birthday A/B/C workflows before enabling the
   replacement schedules. Leave CSAT sending, summary and handoff workflows
   unchanged; only its inbound router receives the metadata update in step 9.
   New email actions open the app's signed confirmation pages directly.
   The supplied B v2 redirect is optional and is not required by these emails.
   Old rowId links are not migrated to new contact/year records.
7. Import **Birthday C v2 - Guarded WhatsApp Wishes.json** only when needed.
   Set its app URL/shared secret, copy the Graph send URL from the existing CSAT
   sender and select its existing WhatsApp Bearer Header Auth credential.
   This uses the same WhatsApp number. The configured Meta-approved birthday
   template must have one body parameter for the person's salutation/name.
   Configure its name and language in Birthday Settings. Keep this workflow
   inactive and contact switches OFF until the birthday template is approved.
8. Activate A and enable scheduled automation in the application after a
   controlled test. Enabling scheduling does not enable either client wish
   channel. Use explicit per-contact or filtered bulk switches.
9. Before enabling birthday WhatsApp, replace the live Workflow 1 with
   **01 - CSAT v5 - WhatsApp Inbound Router (Birthday Reply Isolation).json**.
   It was built from the supplied live export, preserves its webhook path and
   CSAT/Meta credential references, and only forwards extra reply-context and
   provider timestamp metadata. Import it into the existing workflow, not as a
   second active listener on the same webhook path. Re-select the existing
   CSAT Webhook Secret / Meta WhatsApp Token credentials if n8n asks. The export
   is inactive for safe import; activate only after the application is deployed.

## Contacts and Excel

### Internal gift owners and compact sections

Birthday Centre → Internal Gift POCs lists only people assigned to at least one
non-removed birthday contact and lets users
with Internal POC management permission add a name, email, optional phone and
multiple assigned clusters using the Manage password. It writes only the existing
Internal POC directory, not Application Users; no login role or CSAT access is
granted. External email domains are supported for these recipients. Assign them
to birthday contacts in Add / Edit Contact (or the existing Excel template).
The list shows their assigned birthday contacts. Unassigned people remain
available in the contact editor's Responsible Internal POCs dropdown. Creating
an Internal POC does not automatically assign them or put them on this list.
All assigned active owners with valid email addresses receive the existing gift
decision/reminder emails and can use their signed email links without logging in.

Birthday sections can be expanded/minimised without clearing their form values.
Top section links open their target before scrolling. Tables, owner lists,
settings, import previews, replies and history have bounded scroll areas. After a
successful Settings save, the section stays open and shows its confirmation;
users can minimise it manually. A failure keeps the form and error visible. This UI follow-up
requires no additional migration, credentials or workflow changes beyond the
Birthday Centre deployment already described above.

Contact email and WhatsApp wish preferences have labelled green ON / rose OFF
indicators in the table, contact editor and opened contact details. Preferences
and send results are shown separately, so last year's/earlier delivery result
cannot hide the current switch. Bulk actions show the selected contacts' ON/OFF
counts and use explicit Turn ON / Turn OFF labels.

### Fixed stakeholder notices and client greetings

Under Birthday Automation & Email Settings, Super Admin can save **Birthday
Stakeholder Emails**, one address per line (commas/semicolons are also accepted).
These are fixed recipients for birthday-day notices from 9 AM IST, independent
of the client's Email/WhatsApp Wish switches or gift eligibility. Scheduled
Birthday Automation must be enabled. Recipients need no application account.
Each contact/year/recipient notice is deduplicated across scheduler runs and
includes the contact/client, birthday, gift progress and responsible Internal
POCs. This stakeholder list does not receive gift-decision/escalation messages
unless its addresses are separately configured for those responsibilities.
Desk, existing additional notifications and Super Admin recipients continue to
receive the birthday notices; duplicate addresses are combined.

Client birthday email wishes use the approved cream, coral, mint and blush card,
warm wording, cake/flower emojis and a small self-hosted animated GIF. The
greeting addresses the contact's full name, rather than salutation.
The SRV MEDIA heading and signature both use the logo's red (#DD1F26). Emails end
with **Best Regards, SRV Media**, in HTML and plain text. Mail readers that block
images still display the full greeting. Older pending wish jobs use the current
greeting at send time; already accepted wishes are never resent by this update.
The GIF is versioned in public/images/ and copied by the normal Vite build;
no external image service is required. Internal operational and CSAT emails
retain their existing presentation and Ashish Kate signature.

These additions use the existing birthday settings JSON and workflows; no new
database migration, secret or n8n workflow change is required.

Download the template from Birthday Centre. Fill Birthday Contacts only.
Birthdays accept MM-DD, YYYY-MM-DD or an Excel date. Birth year is optional.
Use | between multiple existing active Internal POC email addresses.
The reference tab is for lookup; it does not need filling. Up to 500 rows can
be previewed and imported in one transaction. Invalid/duplicate rows block saving.
Export filtered contacts to obtain stable IDs for updates. Imports preserve the
existing contact's wish switches and do not import annual gift/wish history.
New contacts always have Email Wishes OFF and WhatsApp Wishes OFF.
February 29 is observed on February 28 in non-leap years without changing the DOB.

## Gifts and reminders

- One contact/year has one shared gift decision. Stage: Awaiting Decision →
  Gift Selected → Arranged → Delivered. Escalated is a separate attention flag.
- Day -10: ask every responsible Internal POC. From day -7, ask daily until a
  decision is recorded; overdue unanswered requests continue until resolved.
- Day -3 (or a later catch-up before the birthday): additionally escalate to
  the desk, responsible owners and active Super Admins. Day -1: flag pending
  arrangement/delivery. On the birthday ask the desk about a selected gift's
  delivery. No Gift is an explicit choice and stops gift logistics reminders.
- The first confirmed selection wins under a database row lock. Opening an email
  link performs no decision write. Links are signed, recipient-bound and expire.
  Audit identifies the link recipient; forwarded links do not prove the clicker's
  personal identity. Other owners see the existing selection and its attribution.
- A later selection becomes a change request to active Super Admins. Authorised
  cluster Admins or Super Admin may approve/reject it in the tab. Approved gift
  changes reset arrangement/delivery progress and notify owners and desk.
- Not Delivered requires a reason; person, timestamp and reason are retained.
  Default gift eligibility applies to new yearly records. Existing yearly
  eligibility can be changed explicitly in Gift & History.
- Manual reminder buttons work independently of client wish channel switches.
  Internal emails use the existing Verdana SRV presentation and Ashish Kate
  signature. Client birthday wishes use the SRV Media signature described above.

## WhatsApp guard and send results

Immediately before handing a birthday wish to the sender, check open feedback
cycles across linked CSAT contacts and matching phone/email identities, including
other projects. Active feedback produces Skipped — Active Feedback Cycle and an
email to desk/configured notification recipients and Super Admins. It does not
send the birthday wish later when feedback closes. Global WhatsApp pause is
also respected. Sending or skipping a birthday wish does not advance a CSAT session.

The birthday sender cannot distinguish a new cycle opened after the guarded
claim from one opened before it without changing the CSAT workflow. There is a
short interval between the guard and provider send; contact switches start OFF.
The separate inbound guard uses saved outgoing birthday message IDs and the
original recipient identity, not words such as "thanks". Explicitly quoted
birthday replies go to Birthday Replies & Manual Review even if a newer survey
exists. Other replies in an active CSAT session keep their existing handling.
When there is no active session and the latest recorded outgoing message was a
birthday wish, an unthreaded reply is saved for manual review, without sending
an automatic response, calling Gemini, changing scores, creating issues or
triggering a handoff email. Replies to other messages and survey buttons are
not intercepted when their IDs identify another thread. If the birthday sender
has not confirmed its outgoing ID yet, a quoted but unverified reply with no
active survey is also retained for review rather than answered from old CSAT.
A subsequent CSAT invitation/outgoing message restores normal
unthreaded routing. Delayed deliveries use their provider timestamp when given.
Only application-recorded outgoing messages can be compared; unrelated sends
made outside these workflows are not assumed to have been recorded.

The scoped review inbox is searchable, paginated and bounded. Birthday managers
can mark a reply reviewed; this records the reviewer/time but does not send a
message. Project Users cannot access it. Provider IDs deduplicate retries even
after a new survey begins or birthday wish history is cleared. Wish/Complete
History cleanup removes reply text and reviewer details while retaining minimal
transport identity/deduplication markers. Test the updated Workflow 1 and C with
a controlled contact before enabling client wish switches.

The dashboard distinguishes queued, sender-accepted, skipped, failed, unknown
and history-cleared results. SMTP/Graph acceptance does not prove inbox/handset
delivery. Unknown outcomes are not blindly retried. Provider delivery callbacks
are not added to the existing CSAT webhook by this change.

## Cleanup

Follow-up, Wish, Gift and Complete Birthday History have separate cleanup actions.
Explicit table selections and birthday year determine scope; hidden filtered-out
selections are not included. Review shows names/year and requires DELETE plus a
fresh Manage password (ADMIN_PIN). Sending records must finish before cleanup.
Gift cleanup removes that year's operational gift data and stops further
gift follow-ups for that year. Client wish settings remain independent.
Cleanup cannot restart reminders or resends.

Contact removal stops future birthday flows and keeps historical records and
CSAT data. Removed contacts can be filtered, inspected, cleaned up or restored
inactive with both wish channels OFF. Minimal opaque send reservations survive
history cleanup to prevent the same contact/year/channel being sent again.

## Verification

Run `npm run test:birthday`, `npm run check`, `npm test` and `npm run build`.
Automated birthday tests use isolated fixtures and never send production mail,
WhatsApp, call Gemini, activate workflows or connect to the production database.

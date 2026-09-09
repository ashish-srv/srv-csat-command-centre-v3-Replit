# Architecture

## Recommended Hosted Stack

- App: Node.js backend serving the current HTML/CSS/JS UI
- Database: Supabase Postgres
- Automation: n8n Cloud
- AI analysis: can remain in app for MVP, or move to n8n/OpenAI workflow later

## Data Ownership

Supabase is the source of truth:

- clients
- active status
- project start/end dates
- 45-day feedback due date
- sessions
- messages
- conversation state
- service-level feedback
- service scores
- issues
- issue close/reopen history
- manager alert status
- automation audit events

n8n is the automation layer:

- scheduled 45-day session creation
- project-end feedback request
- no-response reminders
- partial-response completion reminders
- instant manager alerts for bad feedback
- inbound WhatsApp routing

## Session Rules

- A new 45-day cycle creates a `session_type = cycle` session.
- Project completion creates a `session_type = project_end` session.
- Partial feedback sets `completion_status = partial`.
- Reminder links always include `session=<id>`.
- A client who opens a reminder resumes the same chat and does not restart.
- A 0-10 overall score marks the session `completion_status = completed` only
  after the service, appreciation, and final-sweep checklist is covered.
- The first reminder is due 24 hours after the initial request. A maximum of
  three reminders is allowed, with a fresh 24-hour response window after each.
- Manual and scheduled reminders increment the same `reminder_count`; a manual
  reminder moves the next scheduled action to 24 hours after that manual send.
- When the 24-hour window after reminder three expires, the session closes as
  partial feedback or no response. A fourth reminder is never sent.
- WhatsApp replies are processed through a state machine, not a free-form chatbot.
- The state machine extracts service sentiment, reasons, ratings, and missing fields.

## Internal App Screens

- Company Dashboard: daily queue for due feedback, partial replies, reminder due items, open issues, service health, recent sessions, and n8n events.
- Client Workspace: one-client view with project dates, active services, WhatsApp timeline, feedback sessions, service-wise capture, issue actions, and automation trail.

The client does not use these screens. The client interacts on WhatsApp.

## Issue Rules

- Bad feedback creates an open issue assigned to the service owner.
- Closing an issue stores a resolution note and `closed_at`.
- Reopening an issue stores a reopen reason and `reopened_at`.
- Every close/reopen action also writes an `issue_events` history row.

## Feedback Cadence

Each active client has:

- `active_status`
- `project_start_date`
- `project_end_date`
- `feedback_interval_days`
- `next_feedback_due_at`
- `last_feedback_requested_at`
- `end_feedback_requested_at`

Default cadence is every 45 days.

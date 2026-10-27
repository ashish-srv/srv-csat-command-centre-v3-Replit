# Unfinished Feedback Reminders

## 27 October 2026 correction

Negative feedback can set a session's status to `needs_attention` before the client supplies CSAT or NPS. The scheduled reminder query previously selected only `started`, `no_response` and `partial`, leaving these unfinished sessions out of both reminder delivery and closure after three reminders. The query now includes `needs_attention`, with the existing terminal-session, removed-POC, quick-check-in and one-time rating-prompt exclusions preserved. PostgreSQL inherits the same query from SupabaseStore.

This is a reminder-selection correction only. It does not change conversation interpretation, acknowledgement wording, scores, POC weights, the one-hour prompt, or the six-hour final-question rule. No migration, secret or workflow change is needed for this correction.

Existing overdue rows with this status and a due timestamp become eligible at the next Workflow 9 run after deployment. They resume their remaining reminders; missed reminders are not sent in a burst. Each reminder schedules the next action 24 hours later. After reminder three and its final 24-hour grace period, the existing closure process records partial feedback or no response. Partial closure also requires the configured closing-template sender to accept the notice; a failed/missing closing webhook appears under `deferredClosures` in Workflow 9's API output.

## Distinguish the timers

- Automatic 30-day feedback OFF prevents new automatic interval cycles. It does not pause reminders for a project-end cycle already sent.
- The one-hour rating prompt is for eligible overall feedback where no rating question has yet been asked. It is not an hourly repeat of an unanswered rating question.
- Six-hour completion applies to an unanswered optional final question once mandatory scores have been handled. It does not complete a session still waiting for the required rating.
- The ten-minute addition/correction period begins after the completion response, not after the first feedback or rating question.
- Normal unfinished-feedback reminders use a maximum of three reminders, 24 hours apart. Manual reminders share the same counter.

## Production verification

Run the read-only queries in `diagnostics/feedback-reminder-audit.sql` against the database used by the published application. Change the POC name fragment in both queries if checking another contact. No updates or client messages are performed by these queries.

Check the session ID, cycle start date, status, next reminder time, conversation state and audit events together. A successful Workflow 9 execution can return zero targets, and a reminder counter alone is not proof of WhatsApp delivery. Inspect the matching `no_response` automation event and Workflow 5's sender output; webhook acceptance is not handset delivery. Workflow 9 may also return success while an individual webhook call fails, so inspect its output and the event audit, not only the execution's green status.

Regression coverage in `scripts/api-smoke.js` reproduces an unfinished negative project-end/monthly review with one reminder, automatic interval sending OFF and a missing rating. It verifies selection, remaining reminders without a catch-up burst, the final grace period, preserved feedback/empty ratings and closure without a fourth reminder. Separate cases retain exclusions for completed, opted-out, handed-off, removed and quick-check-in records.

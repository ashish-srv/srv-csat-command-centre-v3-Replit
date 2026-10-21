# Feedback Conversation Regression Coverage

## Scope

These changes retain the latest-reply interpretation as the only model source
for conversational facts. The response-writing pass cannot contribute facts
from older transcript messages. The broader cross-model merge stays removed.

Approved changes are limited to progression, completion, postponement and
acknowledgements. Existing CSAT/NPS separation, current-message grounding,
automatic-reply detection, ten-minute windows and handoff delivery checks remain
covered. No schema migration or n8n workflow change is required for this update.

## Historical Conversation Families

| Shared conversation or failure | Regression coverage |
| --- | --- |
| Vinay: revise rating, typos, repeated corrections | Separate score streams, latest correction wins, no stale score restoration |
| Vinay: landing-page/video appreciation; unnamed account manager | Appreciation is acknowledged; ask once for a person's name, not for every praised team |
| Sukhwinder: overall agency praise | Acknowledge the broad review, proceed to CSAT; no missed-department question |
| Shravya/Aashish: CSAT 9, NPS 10, long mixed feedback | Preserve both scores, actual process concerns and named POC praise; do not reopen every mentioned service |
| Aashish: bare NPS answer imports Senior Involvement | Reject narrative facts not grounded in the current reply; response writer is not an evidence source |
| Aashish: spend report during ratings or closing window | Save the reporting request, do not turn it into a rating correction or meeting request; offer a feedback-to-rating choice if a score is still pending |
| Aashish: five improvement points plus YOY praise | Retain distinct points and praise; preserve original closing deadline and CSAT/NPS |
| Aashish: pasted question/transcript | Do not accept a copied survey question as feedback or mine a pasted conversation for a new score |
| Arun: detailed campaign/staffing complaints and repeated additions | Acknowledge and retain additional facts without repeating a service interview; continue to unanswered ratings |
| Arun: account managers "were busy" | Past/third-party availability is not the client's request to postpone |
| Arun: feedback is sufficient | Finish feedback questions, preserve concerns, do not assume an unanswered rating was declined |
| Yuvraj: CSAT 5, NPS 0, "Don't hire interns" | Preserve a real zero; acknowledge the staffing concern rather than repeating the final question unchanged |
| Swati: Share feedback, Okay, meeting reference | Do not start the ten-minute window from acknowledgement or a reference lacking actual feedback |
| Smitu: campaign traction, applicant profiles and ownership | Replay the supplied long message through the API; preserve multiple concerns and a consolidated alert |
| University admissions greetings and Sriparna's away reply | No survey progress, invented feedback or closing window; later real replies remain usable |
| All good / Share feedback buttons | Button payload and typed-response handling; window stays available for corrections |
| Messages after any closed feedback flow | Substantive follow-up routes to handoff; missing/failed delivery is not described as successful |
| Other wording and custom services | Semantic completion, score refusal, topic changes, billing/access/reporting requests and Influencer Marketing |
| 21 October monthly partnership review and closing-window additions | Room to finish before CSAT; neutral meeting/access requests, specific form/design concerns, unrelated team praise; no old service interview or deadline extension |

## Overall Review and Feedback Added During a Rating Question

A useful whole-project review receives an acknowledgement and one opportunity
to finish sharing before the first numeric CSAT question. An explicit completion
or volunteered score can proceed directly. The same pause applies when more
feedback interrupts an already-requested rating. Acknowledge it and offer once:

> Would you like to add anything else, or shall we move to the overall rating?

Use recommendation rating only when the pending question is project-end NPS.
More details, including short emotional continuations without a new structured
service fact, are acknowledged without another question after every message.
Natural completion resumes the numeric question; feedback supplied instead of
that number starts another feedback opportunity. A volunteered valid score can
still be accepted. An explicit refusal to give a score is distinct from saying
there is no more feedback and leaves the score empty.

A bare acknowledgement is contextual: it can accept an immediately preceding
feedback-to-rating choice, but does not declare feedback finished after a
note-only acknowledgement. Explicit completion still resumes the missing score.

The response-writing call supplies a separate optional client-facing
acknowledgement. Safe wording can be retained when its proposed next question
needs correction; it cannot contribute facts. Internal third-person notes and
verbatim complaint lists are not copied into fallback replies. Natural
feedback-to-rating invitations are accepted without requiring an exact sentence.
Retrospective complaints are not turned into prospective requests merely by
combining words such as "review" and "we want" from separate clauses.

The pause is per-session JSON state, not a new evidence source. It does not
change extraction, allow response-writing facts to enter the state, apply to
quick check-ins, or extend an existing ten-minute closing window.

Additional replays cover bounded clarification, quantities inside NPS feedback,
conflicting reply-writing output, response-writer timeouts and negative role
descriptions that must not become appreciation. Related complaints are retained
unless their wording is genuinely near-identical.

## Contextual Additions and Closing Windows (21 October)

Broad monthly relationship feedback gets the same opportunity to finish sharing
before CSAT; a client who volunteers the score need not repeat it. Monthly
feedback never asks NPS. A prospective request is not evidence of a failure or
of overall disappointment. Mixed messages retain both concerns and appreciation.

The latest-reply extraction may supply optional client-facing acknowledgement
wording. This is preferred over transcript-informed wording when available,
validated for unsupported topics and notification/action claims, and never
used as evidence for services, concerns or scores. No extra model call or
cross-model fact merge is introduced. Question-shaped requests also receive a
semantic interpretation before the older off-topic shortcut can intercept them.

Within an existing ten-minute window, acknowledge the actual new points rather
than reopening historical service interviews. Generic team praise does not
require another service question. A genuinely unclear new concern or unnamed
person may receive one clarification; the original deadline still applies even
while waiting for that answer. Model timeouts retain grounded current facts and
use a topic-aware fallback, without assuming that email or action has occurred.

The one-hour reminder for overall feedback with an unanswered CSAT remains
deferred. This update does not enable it or change existing n8n workflows.

## Rollback Discipline

Preserve the pre-change worktree and Git history before updating conversational
behaviour. A checkpoint is a recovery point, not evidence that a production
version was known-good. If a regression is reported, capture the exact deployed
revision and transcript, reproduce it, and compare with the confirmed working
revision. Revert the responsible conversation change or fix the reproduced
defect without resetting unrelated UI work or deleting feedback data. These
changes do not migrate or rewrite historical scores, messages or cycles.

## Test Entry Points

- `npm run test:feedback-history`: sequential historical and paraphrase replays.
- `npm run test:api`: real handler pipeline with controlled model responses,
  including successful extraction, conflicting reply wording and timeouts.
- `npm run test:state`: state transitions, ratings, limits and window handling.
- `npm run test:sweep`: state/reply combinations.
- `npm run test:gemini`: normalized extraction and prompt contract checks.
- `npm run test:workspace-navigation`: activity links, same-project conversation
  changes, stale filters, asynchronous loading and conversation scrolling;
  Needs Attention section links, collapsed icons and high-risk project selection.
- `npm test`: all above plus quick-check-in persistence, imports and store tests.

Assertions focus on saved facts, question counts, required actions, score
ownership and deadlines, not an exact approved reply string. The fixture inputs
include supplied messages and representative variations; not every historical
chat bubble is replayed verbatim.

## Verification Limits

Tests use controlled Gemini responses and mocked delivery/storage. They do not
send WhatsApp messages or email, use a live model, or modify production data.
They verify application routing and persistence behaviour, not every possible
future model interpretation. Production delivery still depends on deployed
code, credentials and active workflows.

## Pending Work — Not Implemented

- One-hour rating reminder: consider sending one gentle reminder for the missing
  overall CSAT after an hour of client inactivity, only when meaningful overall
  feedback is already recorded. Do not apply to unanswered openings, greetings,
  automated replies, acknowledgement-only replies, quick check-ins, an explicit
  postponement or refusal, or human-managed conversations. New client feedback
  resets the inactivity clock. Do not close the session, fill a score or start
  the ten-minute closing window. Keep the existing post-rating six-hour policy
  separate. The user requested this remain on the pending-work list until they
  ask to implement it; no scheduled Codex notification was requested.

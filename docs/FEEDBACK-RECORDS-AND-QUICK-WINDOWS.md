# Feedback records, exports and quick-check-in expiry — 22 October 2026

## Scope

The initial records/export/expiry patch left conversation wording and progression unchanged. Subsequent, separately approved narrow corrections address the Pooja Kamat transcript and the one-time missing-rating prompt described below. None restores the broader model-fact merge.

## Subsequent request/acknowledgement correction

- A grounded structured request is no longer accompanied by a second whole-message fallback observation. The latter could turn a neutral visit request into an unexplained Management Feedback complaint or overwrite its sentiment.
- Requests and complaints retain separate records even when their wording overlaps. Only an unexplained negative feedback point can open the complaint-clarification path; a request does not need an explanation of what went wrong. Existing legacy request clarifications use neutral wording.
- Current-message requests during the closing window are acknowledged without restarting a service interview, changing CSAT/NPS, or extending the original deadline. Actual unclear concerns remain eligible for one bounded clarification.
- General praise is not addressed as if its topic were a team. An acknowledgement of a positive outcome does not need a second, redundant appreciation sentence. Four prompt lines clarify requests and the distinction between a client's impression and a verified cause.
- Offer the add-more-or-rating choice once when entering a feedback pause. Subsequent feedback is saved and acknowledged without repeating that invitation after every point. Explicit completion resumes the missing rating. A one-time idle prompt provides a way forward if meaningful overall feedback was received and the client then becomes silent. Bare courtesy replies are not consent to a rating.
- The original state-machine module, numeric rating ownership, NPS eligibility, and ten-minute clock are unchanged. There is no new schema or workflow change for this conversational correction; migration 021 below belongs to the earlier records patch.

The additional five-file pre-correction snapshot is in ../local-backups/before-request-acknowledgement-fix-22-oct. It preserves the prior records/export work as well as the unchanged conversational baseline. The full Pooja replay covers praise, explained concerns, transition, CSAT 8, NPS 9, completion, the visit request and its timing clarification. Variations cover indirect requests, overlapping mixed concerns/requests, and quick-check-in additions. These are controlled extraction/writer fixtures, not proof that every live model output will be identical.

## One-time idle rating prompt

- Applies to monthly (`pulse`) and project-end sessions only, after a newly processed meaningful overall review. No historical-session backfill and no trigger from only a greeting/start/acknowledgement.
- Wait at least one hour since the latest client activity, including replies still being processed. Each new reply resets that wait. The existing Workflow 15 five-minute tick invokes the check, so delivery is normally within the next five minutes after the hour, not at an exact second. Workflow 9's hourly reminder endpoint also invokes it as a fallback.
- Ask only the missing overall rating, never NPS or a quick-check-in rating. Skip if that rating was already asked (including manually) or answered, if declined, postponed, handed off, stopped, opted out, completed, within the ten-minute closing window, outside the free-text service window, or another clarification is pending. Global messaging pause and inactive/removed POCs remain respected.
- The claim uses compare-and-set session state plus a persistent unique automation-event key. Concurrent ticks cannot dispatch twice. New client activity is checked again immediately before dispatch. A message already handed to the external sender cannot be recalled if a reply arrives during delivery.
- There is at most one automatic dispatch attempt per session. HTTP failures and uncertain timeouts are recorded in `automation_events` as `one_hour_rating_prompt`, with no automatic retry; inspect those failures before deciding on manual follow-up. A successful webhook confirms acceptance by the existing sender, not handset delivery.
- Generic 24-hour reminders do not chase this pending overall-rating wait or duplicate the one-time attempt. After the client supplies the rating, the normal flow resumes (including project-end NPS). Scores, weights, reminder counts, and the ten-minute closing deadline are not modified by this prompt. No new completion email is emitted.
- Keep Workflow 15 active and the existing Workflow 11 manual-message sender configured via `N8N_MANUAL_MESSAGE_WEBHOOK`. No new workflow, secret, migration or always-running in-app timer is needed for this feature. With neither scheduler running, no timed prompt will run.

Pre-feature snapshot: `../local-backups/before-one-time-idle-rating-22-oct`. `npm run test:idle-rating` covers timing, exclusions, idempotency, concurrent replies, delivery failure and resumption after a score. All delivery tests are mocked, with no live client sends.

## Corrections

- Whole-transcript satisfaction scoring no longer inserts a new paraphrase of earlier observations on each closing-window turn, explicit score request or terminal retry. Current-turn feedback is still recorded.
- New observations retain the source message ID and complete source text. Exact duplicate replays are ignored. Distinct exact points and later additions are retained; topic-name similarity alone does not collapse records.
- A clipped observation prefix can be restored from its source. When an excerpt cannot be safely isolated, the complete original client message is retained instead of inventing extra meaning.
- A short issue title no longer hides a longer root-cause explanation in the workspace or its report. New raw-text fallback titles become concise headings; captured issue evidence remains in the detail.
- The generic Management Feedback fallback is not evidence of a management complaint. Unsupported catch-all labels display as Client Feedback; explicit irrelevant/unqualified-lead complaints display as Lead Quality. This storage/display correction does not change conversational routing or invent a service assignment.
- Each POC has a separate HTML conversation section and Excel worksheet, with individual cycles/sessions separated inside it. HTML uses client/SRV chat bubbles. Neither transcript includes interpretation, fallback, or intent metadata. Long Excel messages continue on additional rows without losing text. Existing cycle/date/POC filters still determine the exported sessions.
- Expired quick-check-in response windows stop reserving the WhatsApp number even if the expiry scheduler is delayed. Dashboard/workspace refresh, manual-send checks and bulk-preview checks persist stale completed windows and recompute their parent cycles. Missing/invalid deadlines and live windows remain protected.
- Completed quick-check-ins queue the existing per-POC summary mechanism. Concurrent expiry uses a compare-and-set update; it must not overwrite another worker's state. No POC weights or scores are changed by expiry. An independently active conversation, other POCs still awaiting replies, or the existing project-end restriction can still block a send legitimately.

## Deployment

Run `npm run db:migrate` against the same database used by the published application **before** publishing this code. Migration `021-feedback-record-provenance.sql` adds nullable provenance fields and an idempotency index; it does not delete or rewrite existing feedback.

No new secrets or n8n workflow edits are required for this patch. Keep the already configured summary/reminder automation active for delivery of queued summaries. The send-availability fix does not depend on a timely scheduler tick.

Historical duplicate observations are not automatically deleted. Existing short records cannot be reconstructed safely without consulting their original transcript; no historical text is invented by this update. Existing longer issue explanations become visible immediately. Existing stale quick windows self-heal when the dashboard/workspace is refreshed or send eligibility is checked.

## Rollback / verification

The pre-change source is commit `363d9eb`; a separate 139-file local snapshot exists in `../local-backups/before-feedback-record-repair-22-oct-363d9eb` (relative to the application repository). Do not remove the additive columns when reverting code, because new provenance/history may already use them.

Run `npm run check`, `npm test`, and `npm run build`. `test:feedback-records` covers provenance, replay idempotency, full-text preservation, export grouping/escaping, expiry boundaries, stale reminder timestamps, and concurrent-update guards. API closing-window replays also assert that scoring-only paraphrases never enter the observation ledger while ratings/deadlines and responses remain unchanged. Tests use local fixtures, not live client messaging.

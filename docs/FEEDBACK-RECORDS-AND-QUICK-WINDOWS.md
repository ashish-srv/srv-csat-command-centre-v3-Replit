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

## Acknowledgement wording follow-up — 23 October 2026

- Preserve natural, specific replies such as "We hear your feedback..." rather than rejecting them solely for lacking a canned thank-you/recording phrase. Existing topic, claim, and next-question checks still apply.
- Recognising a positive outcome counts as acknowledging it; do not append a second abstract-topic thank-you. Apply this consistently to monthly, project-end and quick-check-in replies, including closing-window additions.
- Extraction and reply-writing prompts request concise, specific recognition of the difficulty and impact, preserve the client's uncertainty, and avoid mandatory repeated thanks/apologies. Wording remains separate from factual extraction; the broad writer-fact merge remains disabled.
- No question progression, rating ownership, one-hour prompt eligibility or ten-minute deadline changes. No new schema, secrets, or workflow edits for this follow-up.
- Backup: `../local-backups/before-acknowledgement-wording-23-oct-0bfaa5f`, plus the unchanged baseline commit `0bfaa5f`. Historical and API replays cover the repeated positive-outcome sentence, the fuller delivery/SPOC acknowledgement, mixed praise/concerns, varied outcome topics, and quick-check-in windows. These use controlled model responses, not live Gemini/WhatsApp sends.

## Contextual acknowledgement repair — 23 October 2026

- Removed the suggested stock opening from the extraction prompt. Both existing model calls now receive the same continuity guidance: treat successive feedback as a continuing conversation, avoid repeated introductory phrasing, and retain the client's uncertainty.
- Style context contains only the first four words of the last three SRV replies. It is explicitly not client evidence. Quick check-ins fetch this small context from their existing session messages; no new schema or stored state field is required.
- This supersedes the previous optional-alternative selection. Request one faithful acknowledgement; never swap an accepted reply merely to vary its opening. A detailed acknowledgement may repeat an opening when necessary. No new model call, retry, stock-phrase rotation, or broader fact merge is introduced.
- When a writer's next question is wrong, retain its safe exact acknowledgement prefix. A question-free draft can also be retained. Existing claim, question and unsupported-topic checks still apply. The interpreter's acknowledgement remains available when the writer fails or provides no usable acknowledgement. A wording-only preference can select a fuller safe candidate only when it retains all matched current-detail words and adds detail; these words never become extracted facts or scores.
- Prompts require recognition of material concerns, impact/comparisons, requests and praise, preserving the client's uncertainty rather than confirming suspected causes or market claims. The previous 400-character writer limit could reject a substantial response: the writer now has a 1,200-character ceiling with a separate 900-character acknowledgement ceiling. These are ceilings, not targets. Overlong acknowledgements are rejected rather than sliced mid-sentence.
- Monthly clients can continue a useful point without repeatedly being interrupted with an unanswered service question. This turn-taking marker does not mark that service answered or manufacture overall feedback. A scoped observation alone does not arm the one-hour overall-rating prompt; the existing overall-review invitation is preserved. Explicit completion, postponement and refusal are respected, and genuinely missing essential detail can still receive a bounded clarification. Project-end review progression, rating ownership and the ten-minute response clock are preserved.
- Backup: `../local-backups/before-contextual-acknowledgement-repair-13dbb10`; the earlier `../local-backups/before-acknowledgement-continuity-23-oct-9af5d26` snapshot remains available. API replays cover the 23 October Ashish and earlier Alka/Deepak campaign messages across all three flows, including scoped observations, accepted/rejected writer actions and a simulated writer outage. Additional checks cover accessibility, translations, billing, delivery, reporting, mixed praise/concerns, existing broad-praise progression, safe fallback selection, long acknowledgements, score/deadline isolation, and the one-time reminder boundaries.
- All extraction/writer responses and outbound delivery in these tests are controlled fixtures, not live Gemini/WhatsApp sends. They verify application behaviour across varied model outputs, not that a live model will interpret every possible message perfectly. This repair needs no database migration, dependency, secret or n8n workflow change; migration 021 below belongs to the earlier records patch.

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

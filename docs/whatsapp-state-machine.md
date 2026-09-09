# WhatsApp Session State Machine (v2)

WhatsApp is only the channel. The CSAT backend decides what to ask next.

v2 runs per **project** and per **client POC**: one cycle creates one session per
active POC, and every reply is interpreted against that POC's own session.

```
processWhatsAppReply({ session, project, poc, text })
  -> { conversationState, analysis, nextMessage, control }
```

`control` tells the API layer what to do beyond storing the turn:

| field | meaning |
|---|---|
| `allowAiRephrase` | whether Gemini may reword the reply (false for every guardrail line) |
| `sendReply` | whether to send anything to WhatsApp |
| `stopReminders` | clear `reminder_due_at` — the session is terminal |
| `notify` | fire a human-facing n8n event (`escalation`, `post_completion_message`, …) |
| `skipAnalysisWrite` | do not touch scores (a closed session must stay closed) |
| `forceManagerAlert` | alert regardless of score |

## States

`waiting_for_open_feedback`, `waiting_for_issue_reason`,
`waiting_for_service_rating`, `waiting_for_service_feedback`,
`waiting_for_more_services`, `waiting_for_overall_rating`, `waiting_for_nps`,
`completed`, `opted_out`, `handed_off`

## Core rule

Use extraction to understand the client reply, then use deterministic rules to
decide the next question. **The AI layer may only rephrase a question the state
machine already chose — it may never claim something was captured.**

## Guardrails

| Code | Trigger | Behaviour |
|---|---|---|
| `G1_duplicate_inbound` | same `provider_message_id` seen before | ignored (API layer), no reply, no second issue |
| `G2_opt_out` | "stop", "unsubscribe", "don't message me" | closes session, stops reminders, notifies |
| `G3_post_completion` | any message after `completed` / `handed_off` / `opted_out` | honest "this cycle is closed" reply, raw text routed to a human, **scores untouched** |
| `G4_wrong_person` | "who is this", "wrong number" | hands off, stops reminders |
| `G5_probe_cap` | 2 detail asks per service, 25 turns per session | stops probing / hands off to a person |
| `G6_out_of_scope` | client asks us a question, or raises billing/scope | defers to a human, then resumes the pending question |
| `G7_escalation` | contract/legal/refund language, abuse | immediate manager alert, hands off |
| `G8_invalid_rating` | number outside the asked scale | states the scale once, then takes the nearest value (`8/10` → `4/5`) |
| `G9_bare_number` | a number when no rating was asked | ignored, never scored |
| `G10_unparseable` | gibberish | re-asks once, then hands off |
| `G11_no_signal` | greeting or empty pleasantry | no service, no score, no issue |

## Scoring (v2)

- No rating captured → `csatScore` is **null**, not a fallback number. Null
  sessions are excluded from the weighted cycle roll-up.
- Overall rating × 2 is the base; if there is no overall rating, the mean of
  the service ratings × 2 is used.
- Each complaint raised but never rated subtracts 0.5 (max 1.5, floor 1.0).
- Risk: any rating ≤ 2 or score < 6.5 → High; score < 7.5 or any unrated
  negative → Watch; otherwise Low. A negative with a reason and no score is High.
- A manager alert needs High risk **and** a concrete reason — or an escalation.

## Issue creation

An issue is created only for a service with **negative sentiment AND a reason**.
Greetings, praise, and moods never create issues.

## Reminders

If the session is not terminal, reminders continue and the reminder kind depends
on `missingFields`. Opted-out and handed-off sessions are skipped by
`process-due-reminders`. A new session is never started for partial feedback —
the same `sessionId` always continues.

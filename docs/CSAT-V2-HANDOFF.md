# SRV Media CSAT Command Centre — v2 Handoff

**Read this first.** It is written for a Claude session with no prior context. It
explains what the product is, why v2 exists, what has been built and verified,
what has not, and what to do next. Last updated: 30 July 2026.

---

## 1. What this product is

SRV Media Pvt. Ltd. is a digital marketing agency in India serving mostly
education-sector clients. The CSAT Command Centre collects **client satisfaction
feedback over WhatsApp** as a conversation (not a form), scores it, routes
problems to the internal owner responsible, and shows the whole picture on an
internal dashboard.

Two kinds of feedback cycle:

- **Pulse** — recurring during a project (interval is per-project, historically 45 days)
- **Project-end** — fires after the project end date, and additionally asks NPS (0–10)

The owner of this project is **Ashish Kate**, Associate Data Scientist at SRV
Media, on the Data Science / Automation team.

### Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite, plain CSS (`src/styles.css`, CSS custom properties, no framework) |
| Backend | Netlify Functions (single function router) + a local Node dev server |
| Database | Supabase Postgres, accessed over PostgREST with the service role key |
| Automation | n8n (self-hosted at n8n.srv.media) |
| Messaging | WhatsApp Business API (Meta), single SRV business number across all clients |
| AI | Gemini, used **only** to reword a question the state machine already chose |

Deployment note: the Netlify site is not linked to the repo (to save build
credits) — the `dist` folder is drag-dropped manually.

---

## 2. Why v2 exists — the v1 problems

v1 modelled the world as **one client = one contact = one session**. Five things
broke, and v2 was designed around fixing exactly these:

1. **No project or multi-POC model.** One client can have several projects, and a
   project can have several client contacts (POCs) whose opinions do not carry
   equal weight. v1 could not represent this at all.
2. **Fake scores.** Every session produced a CSAT number, even one where the
   client said nothing — v1 fell back to the client's previous score. A silent
   client looked identical to a satisfied one.
3. **Issues created from noise.** "Hello" could create an issue for a service
   owner, because any message with vaguely negative wording produced a service row.
4. **The AI layer lied.** After a session completed, the state machine captured
   nothing — but Gemini, seeing the client's message mention account management,
   improvised *"I have noted the issue with account management, and SRV will work
   on resolving it."* The complaint was discarded while the bot promised action.
   **This is the single most important bug v2 fixes.**
5. **Conversation loops.** Vague replies ("not sure", "apart from this nothing")
   reset a service back to "needs feedback", so the bot asked the same question
   forever.

---

## 3. v2 data model

The Supabase schema (`schema-v2.sql` + `seed-v2.sql`, ~16 tables) was written and
verified against real Postgres in an earlier session, and Ashish has run it.
The tables the app reads or writes:

```
clusters ──< clients ──< projects ──< client_pocs      (the client-side contacts)
                              │
                              ├──< project_services     (services sold on this project,
                              │                          each with an internal owner)
                              ├──< feedback_cycles ──< feedback_sessions ──< messages
                              │                                │
                              │                                └──< service_feedback
                              └──< issues ──< issue_events

internal_pocs        (SRV staff; self-referencing reporting_manager_id)
poc_levels           (lookup: Normal and Important group percentages; total 100)
automation_events    (audit log of every webhook fired)
```

### Key modelling decisions

- **One cycle creates one session per active POC.** Each POC has their own
  conversation, own state, own score.
- **`poc_levels` is a 2-row lookup, not a percentage column on `client_pocs`.**
  Manage sets the total allocation for the Normal group; Important automatically
  receives the remainder to 100%. Every POC continues to point at one group.
  Changing the policy does not recalculate stored, completed cycle scores; future
  and open cycles use the new values.
- **Service ownership chain**: `project_services.internal_poc_id` → the owner →
  `internal_pocs.reporting_manager_id` → the manager who receives alerts.
- **`messages.provider_message_id`** stores Meta's `wamid`, used for de-duplication.

### Weighted aggregation ("Option B")

A cycle's score is the **weighted average across the POCs who actually replied**.
The configured percentage is first allocated to a group, then divided equally
among the POCs in that group. A coverage figure keeps a partial cycle readable:

```
effectiveWeight = group percentage / number of POCs in that group
csat            = Σ(session.csat × effectiveWeight) / Σ(effectiveWeight of responders)
weightResponded = Σ(effectiveWeight of responders)
riskLevel       = worst risk among responders (High > Watch > Low)
```

Worked example — policy Normal 40%, Important 60%, with two Normal POCs and one
Important POC: the Normal POCs receive 20% each and the Important POC receives
60%. If only the Important POC replies with 8, cycle CSAT = 8.0 at **60% weight,
1 of 3 POCs**. If a project has only one group, that group receives 100%, divided
equally among its POCs. Sessions with a null score are excluded from the average.

This lives in `aggregateCycle()` in `src/lib/supabase-store.js` and is unit-tested.

---

## 4. Conversation engine (`src/lib/whatsapp-state-machine.js`)

```
processWhatsAppReply({ session, project, poc, text })
  → { conversationState, analysis, nextMessage, control }
```

**Core rule:** extraction understands the client's reply; deterministic rules
decide the next question. Gemini may only *reword* the chosen question. It may
never decide what was captured.

### States

`waiting_for_open_feedback` · `waiting_for_issue_reason` ·
`waiting_for_service_rating` · `waiting_for_service_feedback` ·
`waiting_for_more_services` · `waiting_for_overall_rating` · `waiting_for_nps` ·
`completed` · `opted_out` · `handed_off`

Normal flow: open feedback → per-service reason → per-service 1–5 rating
(positive services get rated too) → any other service? → overall 1–5 →
(project-end only) NPS 0–10 → completed.

### The 11 guardrails

Every non-standard turn is tagged with a code that appears in message metadata
and in the dashboard timeline.

| Code | Trigger | Behaviour |
|---|---|---|
| `G1_duplicate_inbound` | same `provider_message_id` seen before | ignored in the API layer; no reply, no duplicate issue |
| `G2_opt_out` | "stop", "unsubscribe", "don't message me" | closes session, clears reminders, notifies a human |
| `G3_post_completion` | any message after `completed` / `handed_off` / `opted_out` | honest "this cycle is closed" reply, raw text routed to a human, **scores untouched** — this is the fix for v1 problem #4 |
| `G4_wrong_person` | "who is this", "wrong number" | hands off, stops reminders |
| `G5_probe_cap` | 2 detail asks per service; 25 turns per session | stops probing / hands the conversation to a person |
| `G6_out_of_scope` | client asks *us* a question, or raises billing/scope | says it has been passed on, then resumes the pending question |
| `G7_escalation` | contract/legal/refund language, abuse | immediate manager alert, hands off |
| `G8_invalid_rating` | number outside the asked scale | states the scale once, then takes the nearest ("8/10" → 4/5) |
| `G9_bare_number` | a number when no rating was asked | ignored — v1 could score a phone number |
| `G10_unparseable` | gibberish | re-asks once, then hands off |
| `G11_no_signal` | greeting or pleasantry | no service, no score, no issue — the "Hello" fix |

`control` tells the API layer what to do beyond storing the turn:
`allowAiRephrase` (false for every guardrail line), `sendReply`, `stopReminders`,
`notify` (human event name), `notifyText`, `skipAnalysisWrite`, `forceManagerAlert`,
`handoff`, `optOut`.

### Scoring (conversation-aware)

- **No rating captured → `csatScore` is `null`**, never a fallback number. Null
  sessions are excluded from the cycle roll-up. The UI renders `--`, not `0.0`.
- Base = overall rating × 2; if no overall rating, mean of service ratings × 2.
- Each complaint raised but never rated subtracts 0.5 (max 1.5, floor 1.0).
- Risk: rating ≤ 2 or score < 6.5 → **High**; score < 7.5, an unrated negative,
  or a general negative → **Watch**; otherwise **Low**. A negative *with a reason*
  and no score is High.
- **A manager alert needs High risk AND a concrete reason** — or an escalation.
  Moods and greetings never alert.

### Issue creation

An issue is created only for a service with **negative sentiment AND a non-empty
reason** (`maybeCreateIssue` in the store). Severity `high` (SLA 24h) if rating ≤ 2,
otherwise `watch` (48h). Duplicate protection is per `(session_id, service_key)`.

---

## 5. API surface (`src/server/api-handler.js`)

```
GET  /api/health
GET  /api/dashboard
GET  /api/projects
GET  /api/projects/:projectKey
GET  /api/projects/:projectKey/workspace
GET  /api/projects/:projectKey/issues
POST /api/projects/:projectKey/request-feedback     { cycleType: pulse | project_end }
GET  /api/cycles/:cycleId/sessions
GET  /api/sessions/:sessionId
POST /api/sessions/:sessionId/messages              { text }        (web test chat)
POST /api/sessions/:sessionId/reminder | /no-response
POST /api/whatsapp/inbound                          { from, text, providerMessageId }
POST /api/whatsapp/sessions/:sessionId/reply        { text }
GET  /api/automation/due-feedback
POST /api/automation/create-due-sessions
GET  /api/automation/due-reminders
POST /api/automation/process-due-reminders
GET  /api/issues/:issueId
POST /api/issues/:issueId/(close|reopen|progress)   { note, actorName }
```

- All `/api/clients*` routes are **gone** and return **410** with a pointer to
  `/api/projects` — a clean break, not a silent 404.
- Automation routes require header `x-csat-webhook-secret` when
  `N8N_WEBHOOK_SECRET` is set to a real value.
- `/api/whatsapp/inbound` resolves phone → POC → open session, falling back to
  the most recent session so a post-completion message reaches G3 rather than 404-ing.
- `request-feedback` returns 409 if an open cycle of that type already exists.
- `create-due-sessions` collects per-project failures in `skipped[]` instead of
  aborting the whole scheduled run.
- Reminders are refused (409) on completed/opted-out sessions, and
  `process-due-reminders` skips opted-out and handed-off conversations.

### n8n events (`src/lib/n8n.js`)

| Event | Env var |
|---|---|
| `feedback_started` (one per POC) | `N8N_FEEDBACK_STARTED_WEBHOOK` |
| `feedback_received` | `N8N_FEEDBACK_RECEIVED_WEBHOOK` |
| `manager_alert` | `N8N_MANAGER_ALERT_WEBHOOK` |
| `no_response` | `N8N_NO_RESPONSE_WEBHOOK` |
| `cycle_completed` | `N8N_CYCLE_COMPLETED_WEBHOOK` |
| `post_completion_message`, `client_question`, `escalation`, `handoff`, `wrong_person`, `opt_out` | `N8N_HUMAN_HANDOFF_WEBHOOK` (shared fallback, so a guardrail can never fire into a void) |

### Environment variables

```
DATA_PROVIDER=supabase          # anything else now throws a clear error
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
PUBLIC_APP_URL=
N8N_WEBHOOK_SECRET=
N8N_*_WEBHOOK=                  # see table above
GEMINI_API_KEY=                 # optional; without it, replies are state-machine text
GEMINI_MODEL=                   # default gemini-3.5-flash
PORT=8787                       # local dev only
```

---

## 6. Repo map (v2)

```
src/
  App.jsx                    cluster → client → project sidebar tree, search filter, logo slot
  format.js                  formatScore/formatCycleCoverage/formatGuardrail etc.
  styles.css                 v1 design system + v2 additions at the bottom
  api.js                     apiGet/apiPost
  components/
    Dashboard.jsx            project table + cluster/risk/status/search filters, open cycles, open issues
    ProjectWorkspace.jsx     POC cards with weights, cycles with coverage, conversation, services, issues
    Ui.jsx                   Button, Panel, MetricCard, StatusPill, ScoreMeter, BrandLogo, EmptyState…
  lib/
    supabase-store.js        ~1,000 lines, 40+ methods, aggregateCycle()
    whatsapp-state-machine.js  states, 11 guardrails, scoring
    gemini.js                rephrasing layer with anti-fabrication rules
    n8n.js                   webhook emitter
    store.js                 factory; supabase-only
    analysis.js              id(), statusFromScore() and legacy helpers
    env.js                   .env loader
  server/api-handler.js      the whole API router
netlify/functions/api.mjs    Netlify adapter (modern API + waitUntil)
server.local.js              local dev server (Vite middleware + API)
scripts/
  state-machine-smoke.js     20 conversation scenarios
  api-smoke.js               14 route/guardrail scenarios against a stub store
docs/whatsapp-state-machine.md
n8n/workflows/*.json         8 exported workflows (still v1-shaped — see pending work)
supabase/schema.sql, seed.sql (v1 files; schema-v2.sql/seed-v2.sql were delivered separately)
```

**Deleted in v2** (dead code that would mislead): `src/lib/local-store.js`,
`src/components/ClientWorkspace.jsx`, `scripts/alert-idempotency-smoke.js`,
`src/data/seed.json`.

Routing changed from `/client?client=KEY` to `/project?project=KEY&session=ID`.
`/client` still resolves as an alias so old links do not break.

---

## 7. Status

### Done and verified

- ✅ `schema-v2.sql` + `seed-v2.sql` — ran clean against real Postgres, ~16 tables. Ashish has run these on the new Supabase project.
- ✅ `supabase-store.js` v2 — full rewrite; weighted aggregation unit-tested.
- ✅ `whatsapp-state-machine.js` v2 — 11 guardrails, scoring redesign. **20/20 scenarios pass** (`npm run test:state`).
- ✅ `api-handler.js` v2 — project/POC/cycle routes. **14/14 scenarios pass** (`npm run test:api`).
- ✅ `gemini.js` — hard anti-fabrication rules; the API layer only allows rephrasing on ordinary questions.
- ✅ `n8n.js` — human-handoff event types.
- ✅ UI — `App.jsx`, `Dashboard.jsx`, `ProjectWorkspace.jsx`, `Ui.jsx`, `format.js`, CSS. `npm run build` succeeds (≈175 KB JS / 18.5 KB CSS gzipped to 55 KB / 4.2 KB).
- ✅ `npm run check` (syntax) clean.

### Not done yet

1. **The n8n workflows have not been rewritten for v2.** All 8 JSON exports still
   speak the v1 shape: they call `/api/clients/...`, read `payload.client`, and
   assume one recipient per cycle. **They will break against v2.** This is the
   largest remaining task. What changes: `feedback_started` now fires once per POC
   (loop over recipients), payloads carry `project` + `poc` instead of `client`,
   and there are six new human-handoff events that need a destination.
2. **Nothing has been tested against real Supabase or real WhatsApp yet.** All
   testing so far is unit/stub-level.
3. **`docs/architecture.md`, `docs/n8n-setup.md`, `README.md`** still describe v1.
4. **`test-chat.js`** works against v2 (the endpoint is unchanged) but its output
   labels are v1-flavoured.
5. **Bundled manager email in n8n** — a long-standing rework that predates v2.
6. **Permanent Meta System User token** and **WhatsApp template approvals** are
   still outstanding operational items. Testing has used `hello_world`.
7. **`public/srv-logo.svg` does not exist.** `BrandLogo` falls back to an "SRV"
   monogram until the real asset is added; no code change needed.

### Known limitations worth naming

- Service detection is keyword/synonym-based, not model-based. A client using
  unusual vocabulary may not map to a service; the machine then treats it as
  general feedback rather than guessing.
- `getDashboard()` returns open issues as raw snake_case Supabase rows; the API
  handler normalises them and joins project names before the UI sees them.
- Reminder cadence is a fixed 24h re-arm in the store.

---

## 8. How to run and test

```bash
npm install
npm run check        # syntax check every backend file
npm test             # 20 state-machine scenarios + 14 API scenarios
npm run dev          # local server at http://127.0.0.1:8787 (needs .env)
npm run build        # produces dist/ for manual Netlify upload
node test-chat.js <sessionId>   # terminal chat against a real session
```

**The first real-WhatsApp test to run** is the one that failed in v1: complete a
full cycle, then send "Account management has issue" afterwards. Correct v2
behaviour is an honest *"this feedback cycle is already closed… I have passed your
message to the SRV team"* plus a `post_completion_message` event — **not** the old
false promise that the issue was noted.

---

## 9. How the owner prefers to work

Worth knowing before proposing anything:

- **Discuss the approach and get confirmation before writing code.** He has
  pushed back when changes were made that he did not ask for.
- When code is delivered, he wants **complete, ready-to-use files**, not diffs.
- For n8n he works **step by step**: node name, operation, exact field, value,
  and type — one change at a time, tested before moving on.
- Local dev is on Windows using **Command Prompt (not PowerShell)**.
- Netlify deploys are **manual drag-and-drop of `dist/`** (repo unlinked to save
  build credits).

---

## 10. Suggested next step

Rewrite the n8n workflows for v2, starting with the two that carry the whole
flow: **`whatsapp-inbound-message-router`** (forward `{from, text,
providerMessageId}` to `/api/whatsapp/inbound`, and respect
`sendToWhatsapp: false` on a duplicate) and
**`feedback-started-send-whatsapp-template`** (now a loop over one event per POC).
Then add a single handler for `N8N_HUMAN_HANDOFF_WEBHOOK` so the six guardrail
events reach a real inbox — until that exists, escalations and post-completion
complaints are recorded but nobody is notified.

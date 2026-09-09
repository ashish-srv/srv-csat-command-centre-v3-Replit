-- Adds fields used by the current analysis code but absent from the recovered
-- v2 baseline, plus the non-service observations table.

begin;

alter table public.feedback_sessions
  add column if not exists nps_source text,
  add column if not exists predicted_csat numeric(4, 1),
  add column if not exists predicted_confidence numeric(5, 4),
  add column if not exists predicted_reasoning text,
  add column if not exists predicted_signals jsonb not null default '[]'::jsonb,
  add column if not exists csat_source text,
  add column if not exists tone text,
  add column if not exists tone_reason text,
  add column if not exists tone_source text;

alter table public.service_feedback
  add column if not exists predicted_rating numeric(4, 1),
  add column if not exists predicted_confidence numeric(5, 4),
  add column if not exists predicted_reasoning text,
  add column if not exists rating_source text;

create table if not exists public.observations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  session_id uuid not null references public.feedback_sessions(id) on delete cascade,
  client_poc_id uuid references public.client_pocs(id) on delete set null,
  topic text not null,
  detail text,
  sentiment text not null default 'neutral',
  severity text not null default 'watch',
  created_at timestamptz not null default now()
);

create index if not exists observations_project_idx on public.observations(project_id);
create index if not exists observations_session_idx on public.observations(session_id);

-- Fresh databases need these tags before project POCs can be created. Their
-- weights are retained for compatibility; direct POC percentages drive CSAT.
insert into public.poc_levels (name, weight)
values ('Normal', 40), ('Important', 60)
on conflict (name) do nothing;

commit;

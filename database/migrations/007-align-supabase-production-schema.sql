-- Align columns discovered by the guarded production-data preflight. These
-- fields already exist in the current Supabase database and must be preserved
-- even where the Replit application does not currently display them directly.

begin;

alter table public.projects
  add column if not exists csat_percent numeric,
  add column if not exists csat_responses integer;

alter table public.feedback_cycles
  add column if not exists tone text,
  add column if not exists nps_source text,
  add column if not exists csat_percent numeric,
  add column if not exists csat_responses integer;

-- Gemini confidence is stored as an integer percentage (0-100) in production.
alter table public.feedback_sessions
  alter column predicted_confidence type integer
  using round(predicted_confidence)::integer;

-- Service ratings can be decimal values; confidence remains a 0-100 integer.
alter table public.service_feedback
  alter column rating type numeric
  using rating::numeric,
  alter column predicted_confidence type integer
  using round(predicted_confidence)::integer;

alter table public.observations
  add column if not exists status text,
  add column if not exists notified_at timestamptz,
  add column if not exists updated_at timestamptz;

drop trigger if exists observations_set_updated_at on public.observations;
create trigger observations_set_updated_at
before update on public.observations
for each row execute function public.set_updated_at();

commit;

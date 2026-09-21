-- Lightweight project check-ins sent on the 11th and 21st. They intentionally
-- share the cycle/session transcript model but never participate in CSAT/NPS.

begin;

alter table public.feedback_cycles
  add column if not exists schedule_key text;

create unique index if not exists quick_checkin_schedule_unique
  on public.feedback_cycles (project_id, cycle_type, schedule_key)
  where cycle_type = 'quick_checkin' and schedule_key is not null;

create index if not exists quick_checkin_expiry_idx
  on public.feedback_sessions (reminder_due_at)
  where status in ('started', 'partial');


commit;

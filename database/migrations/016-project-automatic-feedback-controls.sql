begin;

alter table public.projects
  add column if not exists automatic_feedback_enabled boolean not null default true,
  add column if not exists automatic_quick_checkin_enabled boolean not null default true,
  add column if not exists automatic_quick_checkin_resume_at timestamptz;

commit;

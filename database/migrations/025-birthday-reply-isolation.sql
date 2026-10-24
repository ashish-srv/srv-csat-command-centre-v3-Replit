begin;

-- Routing metadata is independent of survey messages and survives history cleanup
-- to avoid attaching a delayed birthday reply to a completed CSAT session.
create table if not exists public.birthday_whatsapp_routes (
  job_id uuid primary key references public.birthday_jobs(id),
  contact_id uuid not null references public.birthday_contacts(id),
  birthday_year integer not null,
  phone_hash text not null,
  provider_message_id text unique,
  dispatched_at timestamptz not null default now(),
  status text not null default 'prepared' check (status in ('prepared','accepted','unknown','failed'))
);
create index if not exists birthday_routes_phone on public.birthday_whatsapp_routes(phone_hash, dispatched_at desc);

create table if not exists public.birthday_replies (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.birthday_whatsapp_routes(job_id),
  contact_id uuid not null references public.birthday_contacts(id),
  birthday_year integer not null,
  provider_message_id text not null unique,
  reply_to_message_id text,
  body text not null,
  from_name text not null default '',
  classification text not null check (classification in ('birthday','manual_review')),
  provider_sent_at timestamptz,
  status text not null default 'awaiting_review' check (status in ('awaiting_review','reviewed','history_cleared')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text
);
create index if not exists birthday_replies_inbox on public.birthday_replies(birthday_year, status, created_at desc);
commit;

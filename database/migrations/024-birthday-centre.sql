begin;

-- Birthday-only contacts do not require, create or delete CSAT projects/POCs.
create table if not exists public.birthday_contacts (
  id uuid primary key default gen_random_uuid(),
  identity_key text not null unique,
  cluster_id uuid references public.clusters(id) on delete set null,
  data jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.birthday_occasions (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.birthday_contacts(id),
  birthday_year integer not null check (birthday_year between 1900 and 2200),
  data jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id, birthday_year)
);
create table if not exists public.birthday_events (
  id uuid primary key default gen_random_uuid(),
  occasion_id uuid references public.birthday_occasions(id) on delete cascade,
  category text not null check (category in ('followup','wish','gift','cleanup')),
  action text not null,
  actor text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists public.birthday_jobs (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.birthday_contacts(id),
  birthday_year integer not null,
  dedupe_key text not null unique,
  channel text not null check (channel in ('email','whatsapp')),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  result jsonb not null default '{}'::jsonb,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists birthday_contacts_cluster on public.birthday_contacts(cluster_id);
create unique index if not exists birthday_contacts_phone_unique on public.birthday_contacts((data->>'whatsapp')) where coalesce(data->>'whatsapp','')<>'';
create unique index if not exists birthday_contacts_email_person_unique on public.birthday_contacts(lower(data->>'email'),lower(data->>'name'),(data->>'birthday')) where coalesce(data->>'email','')<>'';
create index if not exists birthday_events_occasion on public.birthday_events(occasion_id, created_at desc);
create index if not exists birthday_jobs_pending on public.birthday_jobs(status, created_at);

-- No automatic channel activation. Scheduling is enabled explicitly in the UI.
insert into public.app_settings(setting_key, setting_value)
values ('birthday_centre', '{"enabled":false,"deskEmails":[],"notificationEmails":[],"giftOptions":["Cake + Plant","Cake","Plant","Bouquet","Special Gift","No Gift"],"whatsappTemplate":"","whatsappLanguage":"en"}'::jsonb)
on conflict (setting_key) do nothing;
commit;

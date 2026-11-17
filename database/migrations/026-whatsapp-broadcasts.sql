begin;

create table if not exists public.whatsapp_broadcast_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  language text not null default 'en',
  body text not null,
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique(name, language)
);
create table if not exists public.whatsapp_broadcasts (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  request_hash text not null,
  title text not null,
  template jsonb not null,
  parameters jsonb not null default '[]',
  created_by text not null,
  consent_confirmed boolean not null,
  created_at timestamptz not null default now()
);
create table if not exists public.whatsapp_broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references public.whatsapp_broadcasts(id),
  phone text,
  associations jsonb not null,
  message_body text not null default '',
  parameter_values jsonb not null default '[]',
  status text not null default 'queued' check (status in ('queued','sending','accepted','sent','delivered','read','failed','unknown','skipped')),
  reason text not null default '',
  provider_message_id text unique,
  claimed_at timestamptz,
  dispatch_at timestamptz,
  sent_at timestamptz,
  latest_reply_at timestamptz,
  last_staff_reply_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(broadcast_id, phone)
);
create table if not exists public.whatsapp_broadcast_messages (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.whatsapp_broadcast_recipients(id),
  side text not null check (side in ('client','srv')),
  body text not null,
  request_id text unique,
  provider_message_id text unique,
  reply_to_message_id text,
  status text not null,
  error text not null default '',
  claimed_at timestamptz,
  dispatch_at timestamptz,
  provider_at timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_broadcast_queue on public.whatsapp_broadcast_recipients(status, updated_at);
create index if not exists whatsapp_broadcast_phone on public.whatsapp_broadcast_recipients(phone, sent_at desc);
create index if not exists whatsapp_broadcast_replies on public.whatsapp_broadcast_messages(recipient_id, created_at);
create index if not exists whatsapp_broadcast_reply_queue on public.whatsapp_broadcast_messages(status) where side='srv';
create table if not exists public.whatsapp_broadcast_delivery_events (
  provider_message_id text primary key,
  status text not null,
  rank integer not null,
  reason text not null default '',
  received_at timestamptz not null default now()
);
create table if not exists public.whatsapp_messaging_preferences (
  phone text primary key,
  opted_out boolean not null,
  note text not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
alter table public.feedback_cycles add column if not exists skipped_pocs jsonb not null default '[]';

commit;

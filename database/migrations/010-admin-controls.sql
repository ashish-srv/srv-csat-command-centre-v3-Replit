-- Persistent application controls and stable aliases for editable project IDs.
create table if not exists public.app_settings (
  setting_key text primary key,
  setting_value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (setting_key, setting_value)
values ('whatsapp_messaging', '{"enabled": true}'::jsonb)
on conflict (setting_key) do nothing;

create table if not exists public.project_key_aliases (
  alias text primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists project_key_aliases_project_idx
  on public.project_key_aliases(project_id);

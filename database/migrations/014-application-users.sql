create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  role text not null check (role in ('super_admin', 'admin', 'project_user')),
  permissions jsonb not null default '{}'::jsonb,
  internal_poc_id uuid references public.internal_pocs(id) on delete set null,
  active boolean not null default true,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists app_users_email_unique
  on public.app_users (lower(email));
create index if not exists app_users_role_active_idx
  on public.app_users (role, active);

drop trigger if exists set_app_users_updated_at on public.app_users;
create trigger set_app_users_updated_at
before update on public.app_users
for each row execute function public.set_updated_at();

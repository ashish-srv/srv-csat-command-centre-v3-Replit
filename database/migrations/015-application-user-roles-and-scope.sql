alter table public.app_users
  add column if not exists permissions jsonb not null default '{}'::jsonb;

alter table public.app_users
  add column if not exists internal_poc_id uuid references public.internal_pocs(id) on delete set null;

alter table public.app_users
  drop constraint if exists app_users_role_check;

alter table public.app_users
  add constraint app_users_role_check
  check (role in ('super_admin', 'admin', 'project_user'));

create index if not exists app_users_internal_poc_idx
  on public.app_users (internal_poc_id)
  where internal_poc_id is not null;

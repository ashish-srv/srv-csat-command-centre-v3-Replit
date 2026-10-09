begin;

create table if not exists public.project_service_change_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  request_type text not null check (request_type in ('add_existing', 'remove_existing', 'add_new')),
  service_catalog_id uuid references public.service_catalog(id) on delete set null,
  project_service_id uuid references public.project_services(id) on delete set null,
  requested_service_name text,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by_app_user_id uuid references public.app_users(id) on delete set null,
  requested_by_email text,
  requested_by_name text,
  reviewed_by_app_user_id uuid references public.app_users(id) on delete set null,
  reviewed_by_email text,
  review_note text,
  reviewed_at timestamptz,
  notification_status text not null default 'pending',
  notification_error text,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_service_change_request_target check (
    (request_type = 'add_existing' and service_catalog_id is not null and project_service_id is null and requested_service_name is null)
    or (request_type = 'remove_existing' and project_service_id is not null and service_catalog_id is null and requested_service_name is null)
    or (request_type = 'add_new' and service_catalog_id is null and project_service_id is null and nullif(trim(requested_service_name), '') is not null)
  )
);

create index if not exists project_service_change_requests_project_idx
  on public.project_service_change_requests(project_id, created_at desc);
create index if not exists project_service_change_requests_status_idx
  on public.project_service_change_requests(status, created_at desc);

create unique index if not exists project_service_change_requests_pending_catalog_unique
  on public.project_service_change_requests(project_id, request_type, service_catalog_id)
  where status = 'pending' and service_catalog_id is not null;
create unique index if not exists project_service_change_requests_pending_project_service_unique
  on public.project_service_change_requests(project_id, request_type, project_service_id)
  where status = 'pending' and project_service_id is not null;
create unique index if not exists project_service_change_requests_pending_name_unique
  on public.project_service_change_requests(project_id, request_type, lower(requested_service_name))
  where status = 'pending' and requested_service_name is not null;

drop trigger if exists set_project_service_change_requests_updated_at on public.project_service_change_requests;
create trigger set_project_service_change_requests_updated_at
before update on public.project_service_change_requests
for each row execute function public.set_updated_at();

commit;

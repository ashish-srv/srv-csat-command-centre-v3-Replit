-- A single controlled list prevents spelling variants from creating separate
-- services while preserving the project-specific owner, KPIs and score.
create table if not exists public.service_catalog (
  id uuid primary key default gen_random_uuid(),
  service_key text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists service_catalog_name_unique
  on public.service_catalog (lower(name));

alter table public.project_services
  add column if not exists service_catalog_id uuid
    references public.service_catalog(id) on delete set null;

insert into public.service_catalog (service_key, name, active)
select distinct on (service_key)
  service_key,
  name,
  true
from public.project_services
where nullif(trim(service_key), '') is not null
  and nullif(trim(name), '') is not null
order by service_key, created_at asc
on conflict do nothing;

update public.project_services ps
set service_catalog_id = catalog.id
from public.service_catalog catalog
where ps.service_catalog_id is null
  and catalog.service_key = ps.service_key;

create index if not exists project_services_catalog_idx
  on public.project_services(service_catalog_id);


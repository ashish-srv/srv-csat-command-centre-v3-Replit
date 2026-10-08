begin;

-- Criticality belongs to the client profile, so every project for the same
-- client reads and updates one shared value. Legacy columns are retained only
-- to avoid destructive loss of data already written by older deployments.
alter table public.client_performance_profiles
  add column if not exists client_criticality text;

-- If Project Criticality was already used, carry the most urgent saved value
-- to the shared client profile before retiring that field from the UI.
with ranked_client_criticality as (
  select distinct on (projects.client_id)
    projects.client_id,
    profiles.project_criticality
  from public.projects projects
  join public.project_performance_profiles profiles
    on profiles.project_id = projects.id
  where nullif(trim(profiles.project_criticality), '') is not null
  order by projects.client_id,
    case lower(profiles.project_criticality)
      when 'critical' then 1
      when 'high' then 2
      when 'medium' then 3
      when 'low' then 4
      else 5
    end,
    profiles.updated_at desc
)
update public.client_performance_profiles clients
set client_criticality = ranked.project_criticality
from ranked_client_criticality ranked
where clients.client_id = ranked.client_id
  and nullif(trim(clients.client_criticality), '') is null;

insert into public.performance_reference_values (category, value, sort_order, active)
select 'client_criticality', value, sort_order, active
from public.performance_reference_values
where category = 'project_criticality'
on conflict do nothing;

insert into public.performance_reference_values (category, value, sort_order)
values
  ('client_criticality', 'Critical', 10),
  ('client_criticality', 'High', 20),
  ('client_criticality', 'Medium', 30),
  ('client_criticality', 'Low', 40)
on conflict do nothing;

delete from public.performance_reference_values
where category in ('client_category', 'project_criticality');

commit;

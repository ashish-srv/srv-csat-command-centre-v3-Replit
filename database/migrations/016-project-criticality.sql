begin;

alter table public.project_performance_profiles
  add column if not exists project_criticality text;

insert into public.performance_reference_values (category, value, sort_order)
values
  ('project_criticality', 'Critical', 10),
  ('project_criticality', 'High', 20),
  ('project_criticality', 'Medium', 30),
  ('project_criticality', 'Low', 40)
on conflict do nothing;

commit;

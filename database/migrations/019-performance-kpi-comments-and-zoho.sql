begin;
alter table public.project_performance_kpis add column if not exists comment text;
alter table public.project_performance_profiles add column if not exists zoho_dashboard_link text;
alter table public.project_performance_profiles add column if not exists zoho_password_encrypted text;
commit;

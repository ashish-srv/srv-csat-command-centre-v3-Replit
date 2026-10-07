begin;

-- Controlled dropdown values used by the Project Performance area.  These
-- lists are separate from CSAT and can be extended later without changing a
-- project's feedback status or conversation history.
create table if not exists public.performance_reference_values (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  value text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists performance_reference_values_unique
  on public.performance_reference_values (category, lower(value));
create index if not exists performance_reference_values_category_idx
  on public.performance_reference_values (category, active, sort_order);

create table if not exists public.client_performance_profiles (
  client_id uuid primary key references public.clients(id) on delete cascade,
  client_group text,
  client_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_performance_profiles (
  project_id uuid primary key references public.projects(id) on delete cascade,
  financial_year text,
  project_type text,
  revenue_category text,
  portfolio_type text,
  project_director_id uuid references public.internal_pocs(id) on delete set null,
  am_id uuid references public.internal_pocs(id) on delete set null,
  tl_id uuid references public.internal_pocs(id) on delete set null,
  ad_id uuid references public.internal_pocs(id) on delete set null,
  avp_id uuid references public.internal_pocs(id) on delete set null,
  currency text not null default 'INR',
  fx_rate_to_inr numeric(18, 6),
  po_amount_local numeric(18, 2),
  budget_allocated_local numeric(18, 2),
  budget_spent_local numeric(18, 2),
  revenue_generated_local numeric(18, 2),
  performance_status text,
  current_phase text,
  campaign_status text,
  client_sentiment text,
  mandates text,
  deliverables_status text,
  relationship_strength text,
  meeting_cadence text,
  last_meeting_date date,
  suggestion_frequency text,
  last_suggestion_date date,
  client_feedback text,
  next_steps text,
  comments text,
  mom_link text,
  consolidated_sheet_link text,
  project_drive_folder_link text,
  project_data_sheet_link text,
  version integer not null default 1,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_performance_financial_year_format check (
    financial_year is null or financial_year ~ '^\d{4}-\d{4}$'
  ),
  constraint project_performance_fx_rate_positive check (
    fx_rate_to_inr is null or fx_rate_to_inr > 0
  )
);

create table if not exists public.project_performance_kpis (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  kpi_name text not null,
  unit text not null default 'number',
  direction text not null default 'higher_better',
  target numeric(18, 4),
  actual numeric(18, 4),
  previous_year_actual numeric(18, 4),
  is_primary boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_performance_kpi_direction check (
    direction in ('higher_better', 'lower_better')
  ),
  constraint project_performance_kpi_unit check (
    unit in ('number', 'percent', 'currency', 'ratio')
  )
);

create index if not exists project_performance_kpis_project_idx
  on public.project_performance_kpis (project_id, sort_order);

create table if not exists public.project_performance_audit (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  updated_by text not null,
  changes jsonb not null default '{}'::jsonb,
  snapshot jsonb not null default '{}'::jsonb,
  changed_at timestamptz not null default now()
);

create index if not exists project_performance_audit_project_idx
  on public.project_performance_audit (project_id, changed_at desc);

drop trigger if exists set_performance_reference_values_updated_at on public.performance_reference_values;
create trigger set_performance_reference_values_updated_at
before update on public.performance_reference_values
for each row execute function public.set_updated_at();

drop trigger if exists set_client_performance_profiles_updated_at on public.client_performance_profiles;
create trigger set_client_performance_profiles_updated_at
before update on public.client_performance_profiles
for each row execute function public.set_updated_at();

drop trigger if exists set_project_performance_profiles_updated_at on public.project_performance_profiles;
create trigger set_project_performance_profiles_updated_at
before update on public.project_performance_profiles
for each row execute function public.set_updated_at();

drop trigger if exists set_project_performance_kpis_updated_at on public.project_performance_kpis;
create trigger set_project_performance_kpis_updated_at
before update on public.project_performance_kpis
for each row execute function public.set_updated_at();

insert into public.performance_reference_values (category, value, sort_order)
values
  ('client_category', 'Symbi', 10),
  ('client_category', 'Non-Symbi', 20),
  ('project_type', 'Performance Only', 10),
  ('project_type', 'Performance + Multiple', 20),
  ('project_type', 'SEO Only', 30),
  ('project_type', 'Social Media Only', 40),
  ('project_type', 'Branding / Creative', 50),
  ('project_type', 'Web Development', 60),
  ('project_type', 'Integrated (360)', 70),
  ('revenue_category', 'Above 1 CR', 10),
  ('revenue_category', 'Below 1 CR', 20),
  ('revenue_category', '25 L - 1 CR', 30),
  ('revenue_category', 'Below 25 L', 40),
  ('portfolio_type', 'Portfolio', 10),
  ('portfolio_type', 'Non-Portfolio', 20),
  ('portfolio_type', 'Strategic / Key Account', 30),
  ('performance_status', 'On Track', 10),
  ('performance_status', 'Needs Attention', 20),
  ('performance_status', 'At Risk', 30),
  ('performance_status', 'Off Track', 40),
  ('current_phase', 'Planning', 10),
  ('current_phase', 'Onboarding', 20),
  ('current_phase', 'Execution', 30),
  ('current_phase', 'Nearing Completion', 40),
  ('current_phase', 'Completed', 50),
  ('current_phase', 'On Hold', 60),
  ('current_phase', 'Discontinued', 70),
  ('current_phase', 'Ongoing', 80),
  ('campaign_status', 'Not Started', 10),
  ('campaign_status', 'LIVE', 20),
  ('campaign_status', 'Paused', 30),
  ('campaign_status', 'Completed', 40),
  ('campaign_status', 'Discontinued', 50),
  ('client_sentiment', 'Positive', 10),
  ('client_sentiment', 'Neutral', 20),
  ('client_sentiment', 'Concerned', 30),
  ('client_sentiment', 'Escalated', 40),
  ('currency', 'INR', 10),
  ('currency', 'AED', 20),
  ('currency', 'USD', 30),
  ('currency', 'GBP', 40),
  ('currency', 'EUR', 50),
  ('currency', 'THB', 60),
  ('relationship_strength', 'Strong', 10),
  ('relationship_strength', 'Good', 20),
  ('relationship_strength', 'Neutral', 30),
  ('relationship_strength', 'New', 40),
  ('relationship_strength', 'Needs Attention', 50),
  ('relationship_strength', 'Strained', 60),
  ('meeting_cadence', 'Weekly', 10),
  ('meeting_cadence', 'Fortnightly', 20),
  ('meeting_cadence', 'Monthly', 30),
  ('meeting_cadence', 'Quarterly', 40),
  ('meeting_cadence', 'Ad-hoc', 50),
  ('meeting_cadence', 'Not Established', 60),
  ('suggestion_frequency', 'Weekly', 10),
  ('suggestion_frequency', 'Fortnightly', 20),
  ('suggestion_frequency', 'Monthly', 30),
  ('suggestion_frequency', 'Quarterly', 40),
  ('suggestion_frequency', 'Ad-hoc', 50),
  ('suggestion_frequency', 'Not Established', 60),
  ('kpi_name', 'Leads', 10),
  ('kpi_name', 'MQLs', 20),
  ('kpi_name', 'Registrations', 30),
  ('kpi_name', 'Paid Applications', 40),
  ('kpi_name', 'Enrolments', 50),
  ('kpi_name', 'Admissions', 60),
  ('kpi_name', 'Leads to Admissions Rate %', 70),
  ('kpi_name', 'CPL', 80),
  ('kpi_name', 'CPA', 90),
  ('kpi_name', 'Cost per Registration', 100),
  ('kpi_name', 'Cost per Enrolment', 110),
  ('kpi_name', 'Lead Quality %', 120),
  ('kpi_name', 'Conversion Rate %', 130),
  ('kpi_name', 'ROAS', 140),
  ('kpi_name', 'Media Spend', 150),
  ('kpi_name', 'Website Sessions', 160),
  ('kpi_name', 'Keyword Rankings', 170),
  ('kpi_name', 'Impressions', 180),
  ('kpi_name', 'Posts- Static', 190),
  ('kpi_name', 'Posts- Video', 200),
  ('kpi_name', 'Stories', 210)
on conflict do nothing;

commit;

-- =====================================================================
-- SRV CSAT — Schema v2
-- Cluster > Client > Project > Client POCs (weighted) + Services
-- Internal POCs with department hierarchy and reporting manager
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Reference tables
-- ---------------------------------------------------------------------

create table if not exists public.clusters (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.sub_departments (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (department_id, name)
);

-- POC importance levels drive feedback weightage.
-- weight is relative; normalisation happens at read time across responders.
create table if not exists public.poc_levels (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  weight numeric(6, 2) not null default 1,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Internal side (SRV people who own services and receive alerts)
-- ---------------------------------------------------------------------

create table if not exists public.internal_pocs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  cluster_id uuid references public.clusters(id) on delete set null,
  department_id uuid references public.departments(id) on delete set null,
  sub_department_id uuid references public.sub_departments(id) on delete set null,
  reporting_manager_id uuid references public.internal_pocs(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Client side
-- ---------------------------------------------------------------------

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  client_key text not null unique,
  name text not null,
  cluster_id uuid references public.clusters(id) on delete set null,
  active_status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  project_key text not null unique,
  name text not null,
  goal text,
  active_status text not null default 'active',
  start_date date,
  end_date date,
  feedback_interval_days integer not null default 30,
  last_cycle_started_at timestamptz,
  next_cycle_due_at timestamptz,
  end_feedback_requested_at timestamptz,
  -- rolled-up, weighted across responding POCs (see Option B)
  csat_score numeric(4, 1),
  health_score integer,
  nps_score integer,
  risk_level text default 'Watch',
  root_cause text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per person per project. Each has their own WhatsApp number
-- and therefore their own conversation.
create table if not exists public.client_pocs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  designation text,
  contact_whatsapp text,
  contact_email text,
  birth_date date,
  salutation text,                 -- e.g. "Neha ma'am" — how the bot addresses them
  honorific text,                  -- 'sir' | 'ma'am' | null
  poc_level_id uuid references public.poc_levels(id) on delete set null,
  weight_percentage numeric(5, 2) not null default 0 check (weight_percentage between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, contact_whatsapp)
);

-- Services are scoped per project; each points at its internal owner.
create table if not exists public.project_services (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  service_key text not null,
  name text not null,
  kpis text,
  internal_poc_id uuid references public.internal_pocs(id) on delete set null,
  score numeric(4, 1),
  status text default 'watch',
  pulse text,
  owner_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, service_key)
);

-- ---------------------------------------------------------------------
-- Feedback
-- ---------------------------------------------------------------------

-- A cycle belongs to a project. Every active POC of that project gets a
-- session inside it.
create table if not exists public.feedback_cycles (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  cycle_type text not null default 'pulse',      -- 'pulse' | 'project_end'
  status text not null default 'open',           -- 'open' | 'closed'
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  -- weighted roll-up across responders, plus how much weight responded
  csat_score numeric(4, 1),
  nps_score integer,
  risk_level text,
  weight_responded numeric(5, 2),                -- 0..1 (Option B completeness)
  poc_total integer,
  poc_responded integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One session per POC per cycle — individually viewable conversation.
create table if not exists public.feedback_sessions (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.feedback_cycles(id) on delete cascade,
  client_poc_id uuid not null references public.client_pocs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  status text not null default 'started',
  completion_status text not null default 'not_started',
  conversation_state jsonb not null default '{}',
  channel text default 'whatsapp',
  started_at timestamptz not null default now(),
  last_client_response_at timestamptz,
  completed_at timestamptz,
  reminder_due_at timestamptz,
  reminder_count integer not null default 0,
  csat_score numeric(4, 1),
  nps_score integer,
  risk_level text default 'Watch',
  focus_service text,
  root_cause text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cycle_id, client_poc_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.feedback_sessions(id) on delete cascade,
  speaker text not null,
  side text not null,                            -- 'client' | 'srv' | 'system'
  body text not null,
  provider_message_id text,                      -- for duplicate protection
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.service_feedback (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.feedback_sessions(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  client_poc_id uuid not null references public.client_pocs(id) on delete cascade,
  service_key text not null,
  service_name text not null,
  sentiment text not null default 'neutral',
  rating integer,
  reason_text text,
  reason_tags text[] not null default '{}',
  internal_poc_id uuid references public.internal_pocs(id) on delete set null,
  status text not null default 'captured',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, service_key)
);

create table if not exists public.issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  session_id uuid references public.feedback_sessions(id) on delete set null,
  client_poc_id uuid references public.client_pocs(id) on delete set null,
  service_key text,
  service_name text,
  severity text default 'watch',
  status text not null default 'open',
  title text not null,
  root_cause text,
  internal_poc_id uuid references public.internal_pocs(id) on delete set null,
  sla text default '48h',
  due_at timestamptz,
  resolution_note text,
  reopen_reason text,
  closed_at timestamptz,
  reopened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.issue_events (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  session_id uuid references public.feedback_sessions(id) on delete set null,
  action text not null,
  previous_status text,
  next_status text not null,
  note text,
  actor_name text default 'SRV Team',
  created_at timestamptz not null default now()
);

create table if not exists public.automation_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  payload jsonb not null default '{}',
  status text not null default 'pending',
  webhook_url_configured boolean not null default false,
  status_code integer,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

create index if not exists clients_cluster_idx on public.clients(cluster_id);
create index if not exists projects_client_idx on public.projects(client_id);
create index if not exists projects_due_idx on public.projects(next_cycle_due_at) where active_status = 'active';
create index if not exists projects_end_idx on public.projects(end_date) where active_status = 'active';
create index if not exists client_pocs_project_idx on public.client_pocs(project_id);
create index if not exists client_pocs_whatsapp_idx on public.client_pocs(contact_whatsapp) where active;
create index if not exists project_services_project_idx on public.project_services(project_id);
create index if not exists internal_pocs_cluster_idx on public.internal_pocs(cluster_id);
create index if not exists cycles_project_idx on public.feedback_cycles(project_id);
create index if not exists sessions_cycle_idx on public.feedback_sessions(cycle_id);
create index if not exists sessions_poc_idx on public.feedback_sessions(client_poc_id);
create index if not exists sessions_reminder_idx on public.feedback_sessions(reminder_due_at)
  where status in ('started', 'no_response', 'partial');
create index if not exists messages_session_idx on public.messages(session_id);
create unique index if not exists messages_provider_id_idx on public.messages(provider_message_id)
  where provider_message_id is not null;
create index if not exists service_feedback_session_idx on public.service_feedback(session_id);
create index if not exists issues_project_status_idx on public.issues(project_id, status);
create index if not exists issue_events_issue_idx on public.issue_events(issue_id);
create index if not exists automation_events_type_idx on public.automation_events(event_type);

-- ---------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'internal_pocs', 'clients', 'projects', 'client_pocs', 'project_services',
    'feedback_cycles', 'feedback_sessions', 'service_feedback', 'issues'
  ] loop
    execute format('drop trigger if exists %I_set_updated_at on public.%I;', t, t);
    execute format(
      'create trigger %I_set_updated_at before update on public.%I
       for each row execute function public.set_updated_at();', t, t
    );
  end loop;
end $$;


-- TraceCrumb unified Supabase schema
-- Safe v1: text + check constraints instead of enum rewrites, so it can be rerun without policy/type conflicts.
-- Run this in Supabase SQL editor before deploying any MVP branch.

create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.org_members (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','member','viewer')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.org_members om
    where om.org_id = target_org_id
      and om.user_id = auth.uid()
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_tracecrumb on auth.users;
create trigger on_auth_user_created_tracecrumb
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  tier text not null default 'tier_2' check (tier in ('tier_0','tier_1','tier_2','tier_3')),
  owner_team text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

-- Branch 1: TraceCrumb First-60 / Incident Memory
create table if not exists public.incidents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  service_id uuid references public.services(id) on delete set null,
  service_name text not null default '',
  title text not null,
  severity text not null default 'high' check (severity in ('low','medium','high','critical')),
  status text not null default 'investigating' check (status in ('open','investigating','mitigated','resolved','closed')),
  symptom_text text not null,
  signals jsonb not null default '{}'::jsonb,
  impact text,
  fingerprint text[] not null default '{}',
  ai_summary jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.incident_timeline_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  event_type text not null default 'observation' check (event_type in ('observation','decision','action','handoff','mitigation','resolution','note')),
  body text not null,
  occurred_at timestamptz not null default now(),
  actor text,
  created_at timestamptz not null default now()
);

create table if not exists public.incident_recommendations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  suggested_branch text not null,
  priority_checks jsonb not null default '[]'::jsonb,
  loss_prevention_reason text,
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  provider text not null default 'heuristic',
  raw_response jsonb not null default '{}'::jsonb,
  status text not null default 'shown' check (status in ('shown','accepted','ignored','superseded')),
  shown_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.recommendation_outcomes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  recommendation_id uuid references public.incident_recommendations(id) on delete set null,
  adopted boolean,
  outcome text not null default 'unknown' check (outcome in ('successful','partial','failed','unknown')),
  time_to_resolution_minutes integer,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.root_causes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  incident_id uuid references public.incidents(id) on delete cascade,
  title text not null,
  description text,
  category text,
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.resolutions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  incident_id uuid references public.incidents(id) on delete set null,
  root_cause_id uuid references public.root_causes(id) on delete set null,
  title text not null,
  description text,
  outcome text not null default 'unknown' check (outcome in ('successful','partial','failed','unknown')),
  effectiveness_score numeric check (effectiveness_score is null or (effectiveness_score >= 0 and effectiveness_score <= 1)),
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Branch 2: TraceCrumb Resume / Context Restoration
create table if not exists public.work_blocks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  title text not null,
  objective text not null,
  task_ref text,
  status text not null default 'active' check (status in ('active','paused','resumed','completed','archived')),
  active_state text,
  interruption_type text default 'context_switch' check (interruption_type in ('meeting','overnight','incident','context_switch','handoff','other')),
  source_context text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.context_fragments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  work_block_id uuid references public.work_blocks(id) on delete cascade,
  source_type text not null default 'note' check (source_type in ('github','slack','jira','linear','doc','incident','note','calendar','other')),
  source_ref text,
  content text not null,
  importance numeric not null default 0.5 check (importance >= 0 and importance <= 1),
  created_at timestamptz not null default now()
);

create table if not exists public.resume_bundles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  work_block_id uuid not null references public.work_blocks(id) on delete cascade,
  bundle jsonb not null,
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  provider text not null default 'heuristic',
  created_at timestamptz not null default now()
);

create table if not exists public.restoration_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  work_block_id uuid references public.work_blocks(id) on delete cascade,
  resume_bundle_id uuid references public.resume_bundles(id) on delete set null,
  minutes_to_first_output integer,
  restoration_error_count integer not null default 0,
  confidence_score numeric check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1)),
  notes text,
  created_at timestamptz not null default now()
);

-- Branch 3: TraceCrumb Handoff / Continuity Transfer
create table if not exists public.handoff_packets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  workflow_ref text,
  from_actor text not null,
  to_actor text not null,
  packet jsonb not null,
  status text not null default 'draft' check (status in ('draft','sent','received','closed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.handoff_outcomes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  handoff_packet_id uuid not null references public.handoff_packets(id) on delete cascade,
  recontact_required boolean not null default false,
  recovery_minutes integer,
  continuity_score numeric check (continuity_score is null or (continuity_score >= 0 and continuity_score <= 1)),
  error_introduced boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

-- Branch 4: TraceCrumb Continuity / Async Coordination + ECI
create table if not exists public.coordination_artifacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  workflow_name text not null,
  meeting_type text not null default 'status_sync' check (meeting_type in ('broadcast','status_sync','decision_resolution','conflict_resolution','novel_reasoning','incident_sync','architecture_sync','other')),
  original_meeting_frequency text,
  substitutability text not null default 'partial' check (substitutability in ('high','partial','low')),
  artifact jsonb not null,
  status text not null default 'proposed' check (status in ('proposed','trial','adopted','rejected','archived')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.eci_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  workflow_name text not null,
  restoration_capacity numeric not null default 0.5 check (restoration_capacity >= 0 and restoration_capacity <= 1),
  handoff_integrity numeric not null default 0.5 check (handoff_integrity >= 0 and handoff_integrity <= 1),
  coordination_persistence numeric not null default 0.5 check (coordination_persistence >= 0 and coordination_persistence <= 1),
  decision_memory_density numeric not null default 0.5 check (decision_memory_density >= 0 and decision_memory_density <= 1),
  dependency_resilience numeric not null default 0.5 check (dependency_resilience >= 0 and dependency_resilience <= 1),
  interruption_sensitivity numeric not null default 0.5 check (interruption_sensitivity >= 0 and interruption_sensitivity <= 1),
  eci_score numeric not null check (eci_score >= 0 and eci_score <= 1),
  raw_inputs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Shared operational memory/event substrate
create table if not exists public.source_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  source_system text not null check (source_system in ('github','slack','jira','linear','pagerduty','opsgenie','datadog','doc','manual','calendar','other')),
  source_ref text,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.canonical_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  source_event_id uuid references public.source_events(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  canonical_type text not null,
  state_delta jsonb not null default '{}'::jsonb,
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now()
);

create table if not exists public.ai_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete cascade,
  branch text not null check (branch in ('first60','resume','handoff','continuity','shared')),
  action text not null,
  provider text,
  prompt_hash text,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  ok boolean not null default true,
  error text,
  created_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_org_members_user on public.org_members(user_id);
create index if not exists idx_services_org on public.services(org_id);
create index if not exists idx_incidents_org_created on public.incidents(org_id, created_at desc);
create index if not exists idx_incidents_fingerprint on public.incidents using gin(fingerprint);
create index if not exists idx_recommendations_incident on public.incident_recommendations(incident_id);
create index if not exists idx_work_blocks_org_created on public.work_blocks(org_id, created_at desc);
create index if not exists idx_resume_bundles_work_block on public.resume_bundles(work_block_id);
create index if not exists idx_handoff_packets_org_created on public.handoff_packets(org_id, created_at desc);
create index if not exists idx_coordination_artifacts_org_created on public.coordination_artifacts(org_id, created_at desc);
create index if not exists idx_eci_snapshots_org_created on public.eci_snapshots(org_id, created_at desc);
create index if not exists idx_source_events_org_source on public.source_events(org_id, source_system, occurred_at desc);
create index if not exists idx_canonical_events_org_entity on public.canonical_events(org_id, entity_type, entity_id);

-- Updated-at triggers
DO $$
declare t text;
begin
  foreach t in array array['profiles','orgs','services','incidents','root_causes','resolutions','work_blocks','handoff_packets','coordination_artifacts']
  loop
    execute format('drop trigger if exists set_%I_updated_at on public.%I', t, t);
    execute format('create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- RLS
alter table public.profiles enable row level security;
alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.services enable row level security;
alter table public.incidents enable row level security;
alter table public.incident_timeline_events enable row level security;
alter table public.incident_recommendations enable row level security;
alter table public.recommendation_outcomes enable row level security;
alter table public.root_causes enable row level security;
alter table public.resolutions enable row level security;
alter table public.work_blocks enable row level security;
alter table public.context_fragments enable row level security;
alter table public.resume_bundles enable row level security;
alter table public.restoration_events enable row level security;
alter table public.handoff_packets enable row level security;
alter table public.handoff_outcomes enable row level security;
alter table public.coordination_artifacts enable row level security;
alter table public.eci_snapshots enable row level security;
alter table public.source_events enable row level security;
alter table public.canonical_events enable row level security;
alter table public.ai_requests enable row level security;

-- Policies: drop/recreate to keep the SQL rerunnable.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select using (id = auth.uid());
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles for insert with check (id = auth.uid());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists orgs_select_member on public.orgs;
create policy orgs_select_member on public.orgs for select using (created_by = auth.uid() or public.is_org_member(id));
drop policy if exists orgs_insert_creator on public.orgs;
create policy orgs_insert_creator on public.orgs for insert with check (created_by = auth.uid());
drop policy if exists orgs_update_member on public.orgs;
create policy orgs_update_member on public.orgs for update using (created_by = auth.uid() or public.is_org_member(id)) with check (created_by = auth.uid() or public.is_org_member(id));
drop policy if exists orgs_delete_creator on public.orgs;
create policy orgs_delete_creator on public.orgs for delete using (created_by = auth.uid());

drop policy if exists org_members_select_member on public.org_members;
create policy org_members_select_member on public.org_members for select using (user_id = auth.uid() or public.is_org_member(org_id));
drop policy if exists org_members_insert_self_or_creator on public.org_members;
create policy org_members_insert_self_or_creator on public.org_members for insert with check (
  public.is_org_member(org_id)
  or exists (select 1 from public.orgs o where o.id = org_id and o.created_by = auth.uid())
);
drop policy if exists org_members_update_member on public.org_members;
create policy org_members_update_member on public.org_members for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists org_members_delete_member on public.org_members;
create policy org_members_delete_member on public.org_members for delete using (public.is_org_member(org_id));

-- Generic org-scoped policies
DO $$
declare t text;
begin
  foreach t in array array[
    'services','incidents','incident_timeline_events','incident_recommendations','recommendation_outcomes',
    'root_causes','resolutions','work_blocks','context_fragments','resume_bundles','restoration_events',
    'handoff_packets','handoff_outcomes','coordination_artifacts','eci_snapshots','source_events','canonical_events','ai_requests'
  ]
  loop
    execute format('drop policy if exists %I_select_member on public.%I', t, t);
    execute format('create policy %I_select_member on public.%I for select using (public.is_org_member(org_id))', t, t);

    execute format('drop policy if exists %I_insert_member on public.%I', t, t);
    execute format('create policy %I_insert_member on public.%I for insert with check (public.is_org_member(org_id))', t, t);

    execute format('drop policy if exists %I_update_member on public.%I', t, t);
    execute format('create policy %I_update_member on public.%I for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))', t, t);

    execute format('drop policy if exists %I_delete_member on public.%I', t, t);
    execute format('create policy %I_delete_member on public.%I for delete using (public.is_org_member(org_id))', t, t);
  end loop;
end $$;

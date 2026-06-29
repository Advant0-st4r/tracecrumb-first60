-- Optional deployment-signal migration for TraceCrumb branches.
-- Run after schema.sql if you want source-channel and behavioral validation logging.

create table if not exists public.deployment_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.orgs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  branch text not null,
  pipeline text,
  audience text,
  channel text,
  community text,
  source_channel text,
  pain_quote text,
  drop_url text,
  artifact_used boolean not null default false,
  reply_received boolean not null default false,
  tried_on_own_case boolean not null default false,
  reused boolean not null default false,
  asked_for_integration boolean not null default false,
  asked_for_team_use boolean not null default false,
  shared_with_others boolean not null default false,
  price_or_pilot_question boolean not null default false,
  objection text,
  next_iteration text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.deployment_events enable row level security;

drop policy if exists "deployment_events_select_org" on public.deployment_events;
create policy "deployment_events_select_org" on public.deployment_events
  for select using (org_id is null or public.is_org_member(org_id));

drop policy if exists "deployment_events_insert_org" on public.deployment_events;
create policy "deployment_events_insert_org" on public.deployment_events
  for insert with check (org_id is null or public.is_org_member(org_id));

drop policy if exists "deployment_events_update_org" on public.deployment_events;
create policy "deployment_events_update_org" on public.deployment_events
  for update using (org_id is null or public.is_org_member(org_id)) with check (org_id is null or public.is_org_member(org_id));

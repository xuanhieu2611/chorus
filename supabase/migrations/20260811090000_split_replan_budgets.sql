-- Phase 2: keep planning revisions and portfolio replans independent.
--
-- `replan_count` remains for one compatibility release. New runtime code reads
-- only the two counters below. The transition table is the idempotency boundary
-- for a worker retry: the counter update and its charge row are committed by
-- one Postgres function call.
alter table public.campaigns
  add column if not exists plan_revision_count int not null default 0,
  add column if not exists portfolio_replan_count int not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'campaigns_plan_revision_count_nonnegative'
      and conrelid = 'public.campaigns'::regclass
  ) then
    alter table public.campaigns
      add constraint campaigns_plan_revision_count_nonnegative
      check (plan_revision_count >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'campaigns_portfolio_replan_count_nonnegative'
      and conrelid = 'public.campaigns'::regclass
  ) then
    alter table public.campaigns
      add constraint campaigns_portfolio_replan_count_nonnegative
      check (portfolio_replan_count >= 0);
  end if;
end;
$$;

create table if not exists public.campaign_transition_charges (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references public.campaigns(id) on delete cascade,
  strategy_version  int not null check (strategy_version > 0),
  transition_kind   text not null check (transition_kind in (
    'director_replan',
    'strategy_gate_replan',
    'campaign_replan',
    'final_gate_replan'
  )),
  created_at        timestamptz not null default now(),
  unique (campaign_id, strategy_version, transition_kind)
);
create index if not exists campaign_transition_charges_campaign_idx
  on public.campaign_transition_charges (campaign_id, created_at);
alter table public.campaign_transition_charges enable row level security;

-- Backfill only durable transitions that actually pointed the graph at the
-- Strategist's revision nodes. A REPLAN review that went to the final gate is
-- intentionally absent. Old Director events did not always carry the strategy
-- version in JSON, so their `strategy vN` message is the compatibility source.
with raw_transitions as (
  select
    e.campaign_id,
    case
      when e.node = 'director_review_plan' and e.data->>'next' = 'strategize'
        then 'director_replan'
      when e.node = 'await_strategy_approval'
           and e.data->>'resume_node' = 'strategize'
           and e.data->>'transition_queued' = 'true'
        then 'strategy_gate_replan'
      when e.node = 'campaign_review' and e.data->>'next' = 'replan'
        then 'campaign_replan'
      when e.node = 'await_final_approval'
           and e.data->>'resume_node' = 'replan'
           and e.data->>'transition_queued' = 'true'
        then 'final_gate_replan'
    end as transition_kind,
    case
      when e.data->>'strategy_version' ~ '^[0-9]+$'
        then (e.data->>'strategy_version')::int
      when e.data->>'version' ~ '^[0-9]+$'
        then (e.data->>'version')::int
      when e.data->>'review_version' ~ '^[0-9]+$'
        then (e.data->>'review_version')::int
      when e.message ~ 'strategy v[0-9]+'
        then substring(e.message from 'strategy v([0-9]+)')::int
    end as strategy_version
  from public.agent_events e
  where (e.node = 'director_review_plan' and e.data->>'next' = 'strategize')
     or (e.node = 'await_strategy_approval'
         and e.data->>'resume_node' = 'strategize'
         and e.data->>'transition_queued' = 'true')
     or (e.node = 'campaign_review' and e.data->>'next' = 'replan')
     or (e.node = 'await_final_approval'
         and e.data->>'resume_node' = 'replan'
         and e.data->>'transition_queued' = 'true')
), known_transitions as (
  select distinct campaign_id, strategy_version, transition_kind
  from raw_transitions
  where transition_kind is not null
    and strategy_version is not null
    and strategy_version > 0
), transition_counts as (
  select
    campaign_id,
    count(*) filter (where transition_kind in ('director_replan', 'strategy_gate_replan'))::int
      as plan_count,
    count(*) filter (where transition_kind in ('campaign_replan', 'final_gate_replan'))::int
      as portfolio_count,
    count(*)::int as known_count
  from known_transitions
  group by campaign_id
), incomplete_history as (
  select
    c.id as campaign_id,
    c.replan_count,
    coalesce(tc.plan_count, 0) as plan_count,
    coalesce(tc.portfolio_count, 0) as portfolio_count,
    coalesce(tc.known_count, 0) as known_count,
    exists (
      select 1
      from raw_transitions rt
      where rt.campaign_id = c.id
        and (rt.transition_kind is null or rt.strategy_version is null or rt.strategy_version <= 0)
    ) as has_unkeyed_transition
  from public.campaigns c
  left join transition_counts tc on tc.campaign_id = c.id
)
update public.campaigns c
set
  -- If any transition is unkeyed or the durable events account for fewer
  -- transitions than the legacy shared counter, charge the unknown remainder
  -- to both budgets. This is deliberately conservative: it cannot silently
  -- create a new paid transition allowance from incomplete history.
  plan_revision_count = case
    when ih.has_unkeyed_transition or ih.known_count < c.replan_count
      then greatest(ih.plan_count, c.replan_count)
    else ih.plan_count
  end,
  portfolio_replan_count = case
    when ih.has_unkeyed_transition or ih.known_count < c.replan_count
      then greatest(ih.portfolio_count, c.replan_count)
    else ih.portfolio_count
  end,
  updated_at = now()
from incomplete_history ih
where c.id = ih.campaign_id;

insert into public.campaign_transition_charges (campaign_id, strategy_version, transition_kind)
with known_transitions as (
  select distinct
    e.campaign_id,
    case
      when e.node = 'director_review_plan' and e.data->>'next' = 'strategize'
        then 'director_replan'
      when e.node = 'await_strategy_approval'
           and e.data->>'resume_node' = 'strategize'
           and e.data->>'transition_queued' = 'true'
        then 'strategy_gate_replan'
      when e.node = 'campaign_review' and e.data->>'next' = 'replan'
        then 'campaign_replan'
      when e.node = 'await_final_approval'
           and e.data->>'resume_node' = 'replan'
           and e.data->>'transition_queued' = 'true'
        then 'final_gate_replan'
    end as transition_kind,
    case
      when e.data->>'strategy_version' ~ '^[0-9]+$'
        then (e.data->>'strategy_version')::int
      when e.data->>'version' ~ '^[0-9]+$'
        then (e.data->>'version')::int
      when e.data->>'review_version' ~ '^[0-9]+$'
        then (e.data->>'review_version')::int
      when e.message ~ 'strategy v[0-9]+'
        then substring(e.message from 'strategy v([0-9]+)')::int
    end as strategy_version
  from public.agent_events e
  where (e.node = 'director_review_plan' and e.data->>'next' = 'strategize')
     or (e.node = 'await_strategy_approval'
         and e.data->>'resume_node' = 'strategize'
         and e.data->>'transition_queued' = 'true')
     or (e.node = 'campaign_review' and e.data->>'next' = 'replan')
     or (e.node = 'await_final_approval'
         and e.data->>'resume_node' = 'replan'
         and e.data->>'transition_queued' = 'true')
)
select campaign_id, strategy_version, transition_kind
from known_transitions
where transition_kind is not null
  and strategy_version is not null
  and strategy_version > 0
on conflict (campaign_id, strategy_version, transition_kind) do nothing;

-- The RPC is the only runtime writer for transition counters. It returns the
-- post-charge values even when the idempotency key was already present, which
-- lets a worker recover after a crash without guessing whether its first call
-- committed.
create or replace function public.charge_campaign_transition(
  p_campaign_id uuid,
  p_strategy_version integer,
  p_transition_kind text,
  p_max_count integer
)
returns table (
  charged boolean,
  plan_revision_count integer,
  portfolio_replan_count integer,
  budget_exhausted boolean,
  transition_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_campaign public.campaigns;
begin
  if p_strategy_version is null or p_strategy_version <= 0 then
    raise exception 'strategy version must be positive';
  end if;
  if p_max_count is null or p_max_count < 0 then
    raise exception 'transition budget limit must be non-negative';
  end if;

  if p_transition_kind not in (
    'director_replan',
    'strategy_gate_replan',
    'campaign_replan',
    'final_gate_replan'
  ) then
    raise exception 'unknown campaign transition kind: %', p_transition_kind;
  end if;

  select * into v_campaign
  from public.campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'campaign % not found', p_campaign_id;
  end if;

  select id into v_id
  from public.campaign_transition_charges
  where campaign_id = p_campaign_id
    and strategy_version = p_strategy_version
    and transition_kind = p_transition_kind;

  -- The idempotency key wins over the budget check. This is what lets a retry
  -- recover after the first request committed the charge and then lost its
  -- response at the network or worker boundary.
  if v_id is not null then
    return query
    select
      false,
      v_campaign.plan_revision_count,
      v_campaign.portfolio_replan_count,
      false,
      v_id;
    return;
  end if;

  if (
    case
      when p_transition_kind in ('director_replan', 'strategy_gate_replan')
        then v_campaign.plan_revision_count
      else v_campaign.portfolio_replan_count
    end
  ) >= p_max_count then
    return query
    select
      false,
      v_campaign.plan_revision_count,
      v_campaign.portfolio_replan_count,
      true,
      null::uuid;
    return;
  end if;

  insert into public.campaign_transition_charges (
    campaign_id,
    strategy_version,
    transition_kind
  )
  values (p_campaign_id, p_strategy_version, p_transition_kind)
  on conflict (campaign_id, strategy_version, transition_kind) do nothing
  returning id into v_id;

  -- A pre-existing charge can be present when a migration backfill races a
  -- retry. Never increment a counter when the idempotency insert did not win.
  if v_id is null then
    select id into v_id
    from public.campaign_transition_charges
    where campaign_id = p_campaign_id
      and strategy_version = p_strategy_version
      and transition_kind = p_transition_kind;

    return query
    select
      false,
      v_campaign.plan_revision_count,
      v_campaign.portfolio_replan_count,
      false,
      v_id;
    return;
  end if;

  if p_transition_kind in ('director_replan', 'strategy_gate_replan') then
    update public.campaigns
    set plan_revision_count = plan_revision_count + 1,
        updated_at = now()
    where id = p_campaign_id
    returning * into v_campaign;
  else
    update public.campaigns
    set portfolio_replan_count = portfolio_replan_count + 1,
        updated_at = now()
    where id = p_campaign_id
    returning * into v_campaign;
  end if;

  return query
  select
    true,
    v_campaign.plan_revision_count,
    v_campaign.portfolio_replan_count,
    false,
    v_id;
end;
$$;

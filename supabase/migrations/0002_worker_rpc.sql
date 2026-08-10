-- Two things supabase-js cannot express over PostgREST, so they live in SQL.

-- ============ claim ============
-- The worker claim queue. `for update skip locked` is what lets two workers run
-- side by side without ever handing the same campaign to both.
--
-- The claimed row is moved out of 'queued' immediately, because 'queued' is the
-- only signal that a campaign is unclaimed. 'ingesting' is provisional: the graph
-- executor overwrites `status` (and `current_node`) as it enters its first node,
-- which for a resumed campaign is wherever `current_node` left off.
create or replace function public.claim_campaign(p_worker text)
returns public.campaigns
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id  uuid;
  v_row public.campaigns;
begin
  select c.id into v_id
  from public.campaigns c
  where c.status = 'queued'
  order by c.created_at
  for update skip locked
  limit 1;

  if v_id is null then
    return null;
  end if;

  update public.campaigns
     set status       = 'ingesting',
         claimed_by   = p_worker,
         claimed_at   = now(),
         heartbeat_at = now(),
         updated_at   = now()
   where id = v_id
  returning * into v_row;

  return v_row;
end;
$$;

-- ============ cost ceiling ============
-- Atomic so concurrent LLM calls within one campaign cannot both read a stale
-- total and slip past the ceiling. Returns the new total; the caller compares it
-- against CAMPAIGN_COST_CEILING_USD and fails the run.
create or replace function public.add_campaign_cost(p_campaign_id uuid, p_cost numeric)
returns numeric
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_total numeric;
begin
  update public.campaigns
     set cost_usd   = cost_usd + p_cost,
         updated_at = now()
   where id = p_campaign_id
  returning cost_usd into v_total;

  if v_total is null then
    raise exception 'campaign % not found', p_campaign_id;
  end if;

  return v_total;
end;
$$;

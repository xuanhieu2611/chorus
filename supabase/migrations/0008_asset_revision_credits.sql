-- Phase 6 revisions cost one credit and must reserve it atomically with the
-- revising -> generating transition. Re-entering a generating asset after a
-- worker crash is free, just like the initial generation RPC.
create or replace function public.begin_asset_revision(
  p_asset_id uuid
)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_asset public.assets%rowtype;
  v_campaign public.campaigns%rowtype;
  v_revision_cost constant int := 1;
begin
  select * into v_asset
  from public.assets
  where id = p_asset_id
  for update;

  if not found then
    raise exception 'Asset % does not exist', p_asset_id;
  end if;

  select * into v_campaign
  from public.campaigns
  where id = v_asset.campaign_id
  for update;

  if v_asset.status = 'revising' then
    if v_campaign.credits_spent + v_revision_cost > v_campaign.credit_budget then
      raise exception 'Campaign credit budget exceeded for revision: % + % > %',
        v_campaign.credits_spent, v_revision_cost, v_campaign.credit_budget;
    end if;

    update public.campaigns
    set credits_spent = credits_spent + v_revision_cost,
        updated_at = now()
    where id = v_asset.campaign_id
    returning * into v_campaign;

    update public.assets
    set status = 'generating',
        updated_at = now()
    where id = p_asset_id;
  elsif v_asset.status <> 'generating' then
    raise exception 'Asset % cannot begin revision from status %', p_asset_id, v_asset.status;
  end if;

  return v_campaign.credit_budget - v_campaign.credits_spent;
end;
$$;

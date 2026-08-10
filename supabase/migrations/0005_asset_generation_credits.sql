-- Reserve an asset's planned credits and mark it generating in one transaction.
-- Retrying an already-generating asset is intentionally free: the first model
-- call may have completed just before a worker crash, and graph resumption must
-- not spend the same planning credits twice.
create or replace function public.begin_asset_generation(
  p_asset_id uuid,
  p_credits int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asset public.assets%rowtype;
  v_campaign public.campaigns%rowtype;
  v_expected_credits int;
begin
  if p_credits <= 0 then
    raise exception 'Asset credits must be positive';
  end if;

  select * into v_asset
  from public.assets
  where id = p_asset_id
  for update;

  if not found then
    raise exception 'Asset % does not exist', p_asset_id;
  end if;

  v_expected_credits := case v_asset.type
    when 'short_video' then 3
    when 'x_thread' then 2
    when 'linkedin_post' then 2
    else null
  end;

  if v_expected_credits is null or p_credits <> v_expected_credits then
    raise exception 'Asset % requires % credits, not %', p_asset_id, v_expected_credits, p_credits;
  end if;

  select * into v_campaign
  from public.campaigns
  where id = v_asset.campaign_id
  for update;

  if v_asset.status = 'planned' then
    if v_campaign.credits_spent + p_credits > v_campaign.credit_budget then
      raise exception 'Campaign credit budget exceeded: % + % > %',
        v_campaign.credits_spent, p_credits, v_campaign.credit_budget;
    end if;

    update public.campaigns
    set credits_spent = credits_spent + p_credits,
        updated_at = now()
    where id = v_asset.campaign_id
    returning * into v_campaign;

    update public.assets
    set status = 'generating',
        updated_at = now()
    where id = p_asset_id;
  elsif v_asset.status <> 'generating' then
    raise exception 'Asset % cannot begin generation from status %', p_asset_id, v_asset.status;
  end if;

  return v_campaign.credit_budget - v_campaign.credits_spent;
end;
$$;

-- Phase 6: make the final human escape hatch explicit and durable.

alter table public.campaigns
  add column if not exists completion_mode text,
  add column if not exists completion_note text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'campaigns_completion_mode_valid'
      and conrelid = 'public.campaigns'::regclass
  ) then
    alter table public.campaigns
      add constraint campaigns_completion_mode_valid
      check (completion_mode is null or completion_mode in ('reviewer_approved', 'human_override'));
  end if;
end;
$$;

alter table public.campaign_reviews
  add column if not exists model_decision text,
  add column if not exists effective_decision text;

-- `decision` is the pre-Phase 6 compatibility column. Preserve it as the
-- model recommendation, then force the effective decision to REPLAN for any
-- stored portfolio below the deterministic diversity floor.
update public.campaign_reviews
set
  model_decision = coalesce(nullif(model_decision, ''), decision),
  effective_decision = case
    when (scores->>'diversity') ~ '^-?[0-9]+([.][0-9]+)?$'
      and (scores->>'diversity')::numeric < 60
      then 'REPLAN'
    else coalesce(nullif(effective_decision, ''), decision)
  end
where model_decision is null
   or effective_decision is null;

alter table public.campaign_reviews
  alter column model_decision set not null,
  alter column effective_decision set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'campaign_reviews_model_decision_valid'
      and conrelid = 'public.campaign_reviews'::regclass
  ) then
    alter table public.campaign_reviews
      add constraint campaign_reviews_model_decision_valid
      check (model_decision in ('APPROVE', 'REPLAN'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'campaign_reviews_effective_decision_valid'
      and conrelid = 'public.campaign_reviews'::regclass
  ) then
    alter table public.campaign_reviews
      add constraint campaign_reviews_effective_decision_valid
      check (effective_decision in ('APPROVE', 'REPLAN'));
  end if;
end;
$$;

-- Final approval events carry a stable key. This prevents two concurrent
-- retries from recording the same completion provenance twice.
create unique index if not exists agent_events_final_approval_key
  on public.agent_events (campaign_id, ((data->>'final_approval_key')))
  where agent = 'human'
    and node = 'await_final_approval'
    and data ? 'final_approval_key';

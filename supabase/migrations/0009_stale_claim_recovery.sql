-- Phase 9: reclaim a worker claim only after its heartbeat has gone stale.
--
-- The row lock and the claim transition remain one transaction. Two workers
-- cannot select the same queued or stale row, and human gates are not included
-- in the reclaimable status list. A reclaimed campaign resumes at current_node;
-- its durable transcript, agent runs, reviews, and asset transitions make that
-- retry safe after a process death.
drop function if exists public.claim_campaign(text);

create or replace function public.claim_campaign(
  p_worker text,
  p_stale_after_seconds integer default 90
)
returns setof public.campaigns
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select c.id into v_id
  from public.campaigns c
  where c.status = 'queued'
     or (
       c.status in (
         'ingesting', 'transcribing', 'analyzing', 'strategizing',
         'producing', 'critiquing', 'campaign_review'
       )
       and c.heartbeat_at < now() - make_interval(secs => greatest(p_stale_after_seconds, 30))
     )
  order by c.created_at
  for update skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  return query
  update public.campaigns
     set status       = 'ingesting',
         claimed_by   = p_worker,
         claimed_at   = now(),
         heartbeat_at = now(),
         error        = null,
         updated_at   = now()
   where id = v_id
  returning *;
end;
$$;

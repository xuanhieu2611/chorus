-- `claim_campaign` returned `public.campaigns`, a composite type. When it
-- returned NULL, PostgREST handed the client a row with every column null rather
-- than a null result, so a worker that claimed nothing believed it had claimed a
-- campaign with a null id and went on to "run" it.
--
-- `setof` removes the ambiguity: zero rows means nothing was claimed, and the
-- client gets an empty array it cannot misread.
drop function if exists public.claim_campaign(text);

create or replace function public.claim_campaign(p_worker text)
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
         updated_at   = now()
   where id = v_id
  returning *;
end;
$$;

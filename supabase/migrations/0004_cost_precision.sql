-- `campaigns.cost_usd` was numeric(10,4), which cannot represent the cost of a
-- single LLM call. A real Phase 0 call cost $0.0000174 and rounded to $0.0000, so
-- the campaign total stayed at zero no matter how many calls ran and the ceiling
-- could never be reached. Cheap models make this worse, not better: the whole
-- point of a dev model is that each call costs a fraction of a cent.
--
-- 6 decimal places matches `agent_runs.cost_usd`, which was already numeric(10,6),
-- so the per-run rows and the campaign total now agree instead of drifting.
alter table public.campaigns
  alter column cost_usd type numeric(12,6);

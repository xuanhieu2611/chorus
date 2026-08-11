-- Phase 4: persist the Critic's per-claim semantic grounding audit.
-- Lexical quote validation remains on the Writer path; this stores the
-- separately judged semantic result and its effective pass/fail state.
alter table public.reviews
  add column if not exists grounding_audit jsonb not null default '[]'::jsonb,
  add column if not exists grounding_audit_passed boolean not null default false;

alter table public.reviews
  drop constraint if exists reviews_grounding_audit_shape;

alter table public.reviews
  add constraint reviews_grounding_audit_shape
  check (jsonb_typeof(grounding_audit) = 'array');

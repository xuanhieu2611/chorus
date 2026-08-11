-- Phase 3: make a Critic PASS mean that the asset is shippable.
-- The required_checks JSON shape is explicit so the four hard checks remain
-- queryable and visible instead of being hidden inside prose feedback.
alter table public.reviews
  add column if not exists required_checks jsonb not null default '{"brief_compliant":false,"source_supported":false,"standalone":false,"payoff_delivered":false}'::jsonb,
  add column if not exists blocking_feedback text,
  add column if not exists polish_feedback text,
  add column if not exists materially_contradicted boolean not null default false;

alter table public.reviews
  drop constraint if exists reviews_required_checks_shape;

alter table public.reviews
  add constraint reviews_required_checks_shape
  check (
    jsonb_typeof(required_checks) = 'object'
    and required_checks ? 'brief_compliant'
    and required_checks ? 'source_supported'
    and required_checks ? 'standalone'
    and required_checks ? 'payoff_delivered'
  );

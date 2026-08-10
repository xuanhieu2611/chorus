-- Chorus initial schema. Mirrors MVP.md section 5.
-- Conventions: uuid primary keys (they appear in URLs and get passed to agents),
-- timestamptz never bare timestamp, text + check constraint instead of enum types
-- (cheaper to alter), foreign keys indexed.

-- ============ campaigns ============
create table public.campaigns (
  id                  uuid primary key default gen_random_uuid(),
  title               text,
  goal                text not null,
  audience            text,
  brand_voice         text,
  platforms           text[] not null default '{tiktok,x,linkedin}',
  max_assets          int  not null default 6,
  max_video_seconds   int  not null default 120,
  credit_budget       int  not null default 12,
  credits_spent       int  not null default 0,
  cost_usd            numeric(10,4) not null default 0,

  source_path         text,
  source_duration_sec numeric,
  has_video_stream    boolean,

  status              text not null default 'queued'
    check (status in ('queued','ingesting','transcribing','analyzing','strategizing',
                      'awaiting_strategy_approval','producing','critiquing',
                      'campaign_review','awaiting_final_approval','complete','failed','cancelled')),
  current_node        text,
  replan_count        int not null default 0,
  error               text,

  claimed_at          timestamptz,
  claimed_by          text,
  heartbeat_at        timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index campaigns_status_idx on public.campaigns (status, created_at);

-- ============ transcript ============
create table public.transcripts (
  campaign_id uuid primary key references public.campaigns(id) on delete cascade,
  text        text not null,
  words       jsonb not null,          -- [{ w, s, e }]  seconds, float
  language    text,
  provider    text not null default 'groq/whisper-large-v3-turbo',
  created_at  timestamptz not null default now()
);

-- ============ segments ============
create table public.segments (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.campaigns(id) on delete cascade,
  start_time    numeric not null,
  end_time      numeric not null,
  transcript    text not null,
  topic         text not null,
  summary       text,
  content_type  text not null
    check (content_type in ('personal_story','opinion','advice','educational',
                            'humor','quote','tangent','filler')),
  energy            numeric check (energy between 0 and 1),
  standalone_score  numeric check (standalone_score between 0 and 1),
  novelty_score     numeric check (novelty_score between 0 and 1),
  potential_hooks   text[] not null default '{}',
  context_deps      text,
  created_at        timestamptz not null default now(),
  constraint segments_time_valid check (end_time > start_time)
);
create index segments_campaign_idx on public.segments (campaign_id, start_time);

-- ============ strategy (versioned; replans create v2, v3) ============
create table public.strategies (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references public.campaigns(id) on delete cascade,
  version         int  not null,
  rationale       text not null,
  selected_topics jsonb not null,
  rejected_topics jsonb not null,   -- [{ topic, reason }]  <- shown in the UI, do not drop
  planned_assets  jsonb not null,   -- [{ plan_key, type, platform, topic, purpose, segment_ids, credits }]
  approved_by     text check (approved_by in ('director','human')),
  created_at      timestamptz not null default now(),
  unique (campaign_id, version)
);
create index strategies_campaign_idx on public.strategies (campaign_id);

-- ============ assets ============
create table public.assets (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null references public.campaigns(id) on delete cascade,
  plan_key           text not null,
  type               text not null check (type in ('short_video','x_thread','linkedin_post')),
  platform           text not null check (platform in ('tiktok','x','linkedin')),
  source_segment_ids uuid[] not null default '{}',

  hook               text,
  content            jsonb,   -- text: {body} | {tweets:[]} ; video: {hook,caption,clip_start,clip_end}
  media_url          text,    -- Supabase Storage public URL
  media_path         text,    -- local render path
  duration_sec       numeric,

  status             text not null default 'planned'
    check (status in ('planned','generating','needs_review','revising',
                      'passed','rejected','abandoned','replaced')),
  revision_count     int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (campaign_id, plan_key)
);
create index assets_campaign_idx on public.assets (campaign_id, status);

-- ============ per-asset reviews ============
create table public.reviews (
  id             uuid primary key default gen_random_uuid(),
  asset_id       uuid not null references public.assets(id) on delete cascade,
  campaign_id    uuid not null references public.campaigns(id) on delete cascade,
  reviewer_agent text not null default 'content_critic',
  scores         jsonb not null,  -- {hook,clarity,standalone,originality,audience_fit,payoff}
  feedback       text not null,
  decision       text not null check (decision in ('PASS','REVISE','REJECT')),
  revision_index int  not null default 0,
  created_at     timestamptz not null default now()
);
create index reviews_asset_idx on public.reviews (asset_id, created_at);
create index reviews_campaign_idx on public.reviews (campaign_id);

-- ============ campaign-level reviews ============
create table public.campaign_reviews (
  id              uuid primary key default gen_random_uuid(),
  campaign_id     uuid not null references public.campaigns(id) on delete cascade,
  version         int not null,
  scores          jsonb not null,  -- {asset_quality,diversity,audience_fit,brand_consistency,overall}
  problems        jsonb not null default '[]',
  recommendations jsonb not null default '[]',
  decision        text not null check (decision in ('APPROVE','REPLAN')),
  created_at      timestamptz not null default now()
);
create index campaign_reviews_campaign_idx on public.campaign_reviews (campaign_id);

-- ============ agent runs (one per LLM invocation) ============
create table public.agent_runs (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  agent        text not null,
  node         text not null,
  input        jsonb,
  output       jsonb,
  tool_calls   jsonb not null default '[]',
  model        text,
  prompt_tokens     int,
  completion_tokens int,
  cost_usd     numeric(10,6),
  status       text not null default 'running' check (status in ('running','succeeded','failed')),
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index agent_runs_campaign_idx on public.agent_runs (campaign_id, started_at);

-- ============ event log (drives SSE + timeline + graph) ============
create table public.agent_events (
  id           bigint generated always as identity primary key,  -- monotonic SSE cursor
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  agent        text not null,
  node         text,
  level        text not null default 'info'
    check (level in ('info','decision','tool','warn','error')),
  message      text not null,
  data         jsonb,
  created_at   timestamptz not null default now()
);
create index agent_events_cursor_idx on public.agent_events (campaign_id, id);

-- ============ security ============
-- RLS on with zero policies = deny all. Browser never touches Postgres directly;
-- every read goes through a Next.js route handler holding the service role key,
-- which bypasses RLS by design. Adding real auth later means adding policies,
-- not restructuring access.
alter table public.campaigns        enable row level security;
alter table public.transcripts      enable row level security;
alter table public.segments         enable row level security;
alter table public.strategies       enable row level security;
alter table public.assets           enable row level security;
alter table public.reviews          enable row level security;
alter table public.campaign_reviews enable row level security;
alter table public.agent_runs       enable row level security;
alter table public.agent_events     enable row level security;

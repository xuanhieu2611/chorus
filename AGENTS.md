# Chorus Agent Instructions

## What this is

Chorus turns one long-form podcast plus a growth objective into a multi-platform content campaign. Seven specialized agents decide what is worth making, produce it, critique their own output, revise it, then review the campaign as a portfolio.

The product thesis is that the system exercises judgment rather than running a pipeline. Anything that makes the agents behave like a fixed sequence works against the point of the project.

## Current state

**Phase 5 complete. Phase 6 is next.** Scaffold, schema, LLM wrapper, worker claim loop, the graph executor, `ingest`, `transcribe`, `analyze`, `strategize`, `director_review_plan`, the first human gate, grounded written-asset production, and the full Clip Producer media loop exist. Approve a strategy in the dashboard and production creates grounded X threads and LinkedIn posts plus 9:16 MP4 clips with word captions. Video sources get silence plus sampled-frame inspection; audio-only sources deterministically render caption cards without a vision call. Campaigns now park at the unbuilt `critique` frontier (see `docs/ARCHITECTURE.md`).

`MVP.md` is the working document. Read it before touching anything: it fixes the stack with verified versions, the Postgres schema, the agent graph, per-agent contracts and Zod schemas, the FFmpeg pipeline, guardrails, and a 10-phase build plan where each phase ends in something runnable. Build in phase order and do not start a phase before the previous one visibly works.

The structured-output spike (MVP section 7.0) has been run and retired; its findings, including two ceiling bugs it exposed, are recorded in `docs/ARCHITECTURE.md`. The short version: `Output.object` won, and **strict schema mode is not in effect through OpenRouter**, which is what pushed the judgement roles onto the Anthropic API directly.

**Two providers, chosen by the model id.** An id with a slash is an OpenRouter route (`google/gemini-2.5-flash`); a bare id goes to the Anthropic API directly (`claude-sonnet-5`). `MODEL_REASONING` and `MODEL_VISION` run direct so Claude enforces the agent schemas server-side; `MODEL_FAST` stays on Gemini through OpenRouter for the million-token context the Source Analyst's map pass needs. Anthropic reports tokens rather than dollars, so `lib/llm/pricing.ts` prices the direct path against the ceiling. See `docs/ARCHITECTURE.md`.

**Development runs on a cheap model.** `MODEL_OVERRIDE_ALL` in `.env.local` points every agent role at one model (currently `google/gemini-2.5-flash-lite`, ~20x cheaper input than Sonnet 5), leaving `MODEL_REASONING`/`FAST`/`VISION` intact as the real configuration. Comment it out before judging output quality or recording the demo. Anything set there must accept images, or the Clip Producer's vision pass breaks on video sources.

## Commands

Two processes run side by side:

```bash
npm run dev            # Next.js app on :3000
npm run worker         # tsx watch worker/index.ts, claims campaigns and runs the graph
```

Everything else:

```bash
npm run build          # production build; also the TypeScript 7 type-check
npx tsc --noEmit       # type-check alone, faster
npm run worker:once    # claim at most one campaign, then exit. The end-to-end smoke test
npm test               # node --test over lib/**/*.test.ts
npm test -- --test-name-pattern="chunk offset"   # a single test by name
node --import tsx --test lib/media/transcribe.test.ts   # a single test file
npm run db:push        # apply supabase/migrations to the linked project
npm run lint           # eslint

npx tsx scripts/verify-provider.ts                       # one real call per role; proves keys and routing
npx tsx scripts/inspect-transcript.ts <campaign-id>      # word timestamps, span, monotonicity
npx tsx scripts/verify-chunking.ts <audio-file> [secs]   # chunked vs whole-file timeline; costs Groq time
npx tsx scripts/verify-analysis.ts <campaign-id> [win] [overlap]  # forces the multi-window map-reduce; costs model calls
```

After any migration, regenerate the database types or the next type-check will lie to you:

```bash
supabase gen types typescript --linked --schema public > lib/db/database.types.ts
```

## Architecture

The parts below span several files and are not obvious from any one of them.

**Two processes, one database.** The Next.js app never runs the agent graph. It writes a campaign row with `status = 'queued'`; the worker claims it with `SELECT ... FOR UPDATE SKIP LOCKED`, runs the graph, and writes progress back. This is why a 20 minute campaign is not bounded by any request timeout.

**The graph is a hand-written state machine, not a framework.** Every node has the same signature and returns `{ next, patch, reason }`. Control flow lives in `lib/graph/nodes.ts`; the executor loop is `lib/graph/run.ts`. LLMs decide content and scores at nodes; TypeScript decides which edge is taken.

**Resumability comes from `campaigns.current_node`, not worker memory.** Human approval gates set `status = 'awaiting_*'` and return `next: null`. The approve route flips the row back to `queued`, and the worker picks it up wherever it left off. A worker crash mid-campaign is recoverable for the same reason.

**Strict layering: agent -> tool -> database.** Agents call `lib/tools/` and nothing else. No agent file imports the Supabase client, and no agent file calls the AI SDK directly (it goes through `lib/llm/structured.ts`). Both rules exist so that every action an agent takes is automatically logged to `agent_runs.tool_calls` and `agent_events`, which is what fills the live UI.

**The UI reads an event cursor, not the database.** `agent_events.id` is a monotonic bigint. The SSE route polls for `id > cursor` and streams new rows. Reconnects pass `?cursor=` so nothing is missed. The browser never holds database credentials.

**Media branches on a probed fact.** `campaigns.has_video_stream` is set by `ffprobe` at ingest. Audio-only sources skip the 9:16 crop, skip frame sampling, and skip the vision call entirely. See `MVP.md` section 9.1.

**Unimplemented nodes are absent from the registry, not stubbed.** `lib/graph/nodes.ts` registers only what exists; the executor parks a campaign that reaches anything else, leaving `current_node` on it so the phase that builds it resumes the same campaign in place. A stub returning an empty-but-plausible result would make an unbuilt phase look like a working one. The branch disappears on its own once every node is implemented.

**Uploads arrive before campaigns exist.** `/api/upload` streams the raw request body (not multipart, which would buffer gigabytes in memory) into `uploads/_pending/{token}/`. `POST /api/campaigns` inserts the row as `ingesting`, renames that directory to the campaign id, then flips to `queued`. `queued` is the claim signal, so it must not be set before `source_path` is.

## Invariants

These are the ways this codebase gets quietly broken.

**Decisions live in code, not prompts.** The Critic returns scores; TypeScript maps them to PASS/REVISE/REJECT. Budget arithmetic is validated in code because LLMs do arithmetic badly. A campaign diversity score below 60 forces a replan regardless of what the reviewer concludes. Moving any of these into a prompt makes runs non-reproducible and breaks the demo.

**The graph diagram is source of truth.** `MVP.md` section 6 holds a mermaid diagram of the agent graph. Changing `lib/graph/nodes.ts` means updating that diagram in the same commit. `components/AgentGraph.tsx` renders the same node set live.

**Never create `tailwind.config.js`.** Tailwind 4 is CSS-first. Config lives in an `@theme { }` block in `globals.css`. A generated JS config file is silently ignored and produces confusing debugging sessions.

**Never add `baseUrl` to `tsconfig.json`.** TypeScript 7 removed it. The stack sits on `typescript@6.0.3` (TS 7 breaks `typescript-eslint`, see `MVP.md` section 2), so `baseUrl` would technically work today, which is exactly the trap. Use `paths` alone, resolved relative to the config file, with `"moduleResolution": "bundler"`, and the eventual move back to TS 7 stays a version bump.

**Branch on `has_video_stream`, never on file extension.** An MP4 can legally contain no video track. Extension-sniffing sends blank frames to a vision model.

**Written assets must be grounded.** The Writing Agent returns a `grounding` array mapping each claim to a source quote, and code verifies each quote actually appears in the transcript. Failures trigger one regeneration. This is a correctness property, not a prompt suggestion.

**Service role key stays server-side.** RLS is enabled on every table with zero policies, which denies everything. All access goes through Next.js route handlers and the worker. Adding real auth later means adding policies, not restructuring access.

**Cost ceiling before agents.** Every LLM call adds to `campaigns.cost_usd`; crossing `CAMPAIGN_COST_CEILING_USD` fails the run. Build this in Phase 0. It is the protection against a loop bug spending real money overnight. The increment happens inside Postgres (`add_campaign_cost`) so two concurrent calls cannot both read a stale total and slip past the limit together.

**`lib/db/database.types.ts` is generated, never hand-edited.** It comes from the live database. Regenerate it in the same commit as any migration, or the type-checker will confidently describe a schema that no longer exists.

**A plpgsql function returning a composite type cannot signal "nothing".** A NULL composite reaches PostgREST as a row with every column null, which client code reads as a successful result full of nulls. `claim_campaign` returns `setof public.campaigns` for exactly this reason: zero rows is unambiguous. This already caused one bug where a worker "claimed" a campaign with a null id. Any future RPC that can return nothing follows the same rule.

## Out of scope

Do not build these without being asked. They are deliberately excluded and each one dilutes the agent system:

Direct social publishing, scheduling, analytics, team accounts, payments, mobile, voice cloning, image generation, B-roll, advanced transitions. Also deferred by choice: multi-user auth, cloud deploy, Supabase Realtime, face-tracking crop, and any orchestration framework (LangGraph, Trigger.dev, Inngest, Temporal). The hand-written state machine is the point.

## Media notes

Source uploads stay on local disk under `STORAGE_DIR`; only rendered clips go to Supabase Storage, because the free tier caps a single upload at 50 MB and a 90 minute recording is 1 to 3 GB.

Groq caps transcription uploads at 25 MB, so audio is downmixed to 16 kHz mono MP3 and chunked at 600 second boundaries above that. **Chunk offsets must be added to word timestamps before merging.** Getting this wrong silently misaligns every caption in the campaign, so it stays unit-tested.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

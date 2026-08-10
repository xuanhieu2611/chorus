# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chorus turns one long-form podcast plus a growth objective into a multi-platform content campaign. Seven specialized agents decide what is worth making, produce it, critique their own output, revise it, then review the campaign as a portfolio.

The product thesis is that the system exercises judgment rather than running a pipeline. Anything that makes the agents behave like a fixed sequence works against the point of the project.

## Current state

**Docs only. No code yet.** The repo contains `PRD.md` (what and why) and `MVP.md` (the build spec). Nothing is scaffolded.

`MVP.md` is the working document. Read it before touching anything: it fixes the stack with verified versions, the Postgres schema, the agent graph, per-agent contracts and Zod schemas, the FFmpeg pipeline, guardrails, and a 10-phase build plan where each phase ends in something runnable. Build in phase order and do not start a phase before the previous one visibly works.

## Commands

None exist yet. Once Phase 0 scaffolds the project, the intended model is two processes running side by side:

```bash
pnpm dev       # Next.js app
pnpm worker    # tsx watch worker/index.ts, runs the agent graph
```

Update this section with the real commands, including how to run a single test, as soon as they exist.

## Architecture

The parts below span several files and are not obvious from any one of them.

**Two processes, one database.** The Next.js app never runs the agent graph. It writes a campaign row with `status = 'queued'`; the worker claims it with `SELECT ... FOR UPDATE SKIP LOCKED`, runs the graph, and writes progress back. This is why a 20 minute campaign is not bounded by any request timeout.

**The graph is a hand-written state machine, not a framework.** Every node has the same signature and returns `{ next, patch, reason }`. Control flow lives in `lib/graph/nodes.ts`; the executor loop is `lib/graph/run.ts`. LLMs decide content and scores at nodes; TypeScript decides which edge is taken.

**Resumability comes from `campaigns.current_node`, not worker memory.** Human approval gates set `status = 'awaiting_*'` and return `next: null`. The approve route flips the row back to `queued`, and the worker picks it up wherever it left off. A worker crash mid-campaign is recoverable for the same reason.

**Strict layering: agent -> tool -> database.** Agents call `lib/tools/` and nothing else. No agent file imports the Supabase client, and no agent file calls the AI SDK directly (it goes through `lib/llm/structured.ts`). Both rules exist so that every action an agent takes is automatically logged to `agent_runs.tool_calls` and `agent_events`, which is what fills the live UI.

**The UI reads an event cursor, not the database.** `agent_events.id` is a monotonic bigint. The SSE route polls for `id > cursor` and streams new rows. Reconnects pass `?cursor=` so nothing is missed. The browser never holds database credentials.

**Media branches on a probed fact.** `campaigns.has_video_stream` is set by `ffprobe` at ingest. Audio-only sources skip the 9:16 crop, skip frame sampling, and skip the vision call entirely. See `MVP.md` section 9.1.

## Invariants

These are the ways this codebase gets quietly broken.

**Decisions live in code, not prompts.** The Critic returns scores; TypeScript maps them to PASS/REVISE/REJECT. Budget arithmetic is validated in code because LLMs do arithmetic badly. A campaign diversity score below 60 forces a replan regardless of what the reviewer concludes. Moving any of these into a prompt makes runs non-reproducible and breaks the demo.

**The graph diagram is source of truth.** `MVP.md` section 6 holds a mermaid diagram of the agent graph. Changing `lib/graph/nodes.ts` means updating that diagram in the same commit. `components/AgentGraph.tsx` renders the same node set live.

**Never create `tailwind.config.js`.** Tailwind 4 is CSS-first. Config lives in an `@theme { }` block in `globals.css`. A generated JS config file is silently ignored and produces confusing debugging sessions.

**Never add `baseUrl` to `tsconfig.json`.** TypeScript 7 removed it. Use `paths` alone, resolved relative to the config file, with `"moduleResolution": "bundler"`.

**Branch on `has_video_stream`, never on file extension.** An MP4 can legally contain no video track. Extension-sniffing sends blank frames to a vision model.

**Written assets must be grounded.** The Writing Agent returns a `grounding` array mapping each claim to a source quote, and code verifies each quote actually appears in the transcript. Failures trigger one regeneration. This is a correctness property, not a prompt suggestion.

**Service role key stays server-side.** RLS is enabled on every table with zero policies, which denies everything. All access goes through Next.js route handlers and the worker. Adding real auth later means adding policies, not restructuring access.

**Cost ceiling before agents.** Every LLM call adds to `campaigns.cost_usd`; crossing `CAMPAIGN_COST_CEILING_USD` fails the run. Build this in Phase 0. It is the protection against a loop bug spending real money overnight.

## Out of scope

Do not build these without being asked. They are deliberately excluded and each one dilutes the agent system:

Direct social publishing, scheduling, analytics, team accounts, payments, mobile, voice cloning, image generation, B-roll, advanced transitions. Also deferred by choice: multi-user auth, cloud deploy, Supabase Realtime, face-tracking crop, and any orchestration framework (LangGraph, Trigger.dev, Inngest, Temporal). The hand-written state machine is the point.

## Media notes

Source uploads stay on local disk under `STORAGE_DIR`; only rendered clips go to Supabase Storage, because the free tier caps a single upload at 50 MB and a 90 minute recording is 1 to 3 GB.

Groq caps transcription uploads at 25 MB, so audio is downmixed to 16 kHz mono MP3 and chunked at 600 second boundaries above that. **Chunk offsets must be added to word timestamps before merging.** Getting this wrong silently misaligns every caption in the campaign, so it stays unit-tested.

# Chorus architecture

Mirrors `MVP.md` section 6. **Changing `lib/graph/nodes.ts` means updating this diagram in the same commit**, and `components/AgentGraph.tsx` renders the same node set live.

**Build state:** Phase 3 complete. The executor runs through `ingest`, `transcribe`, `analyze`, `strategize`, `director_review_plan`, and the first human gate. It parks at `produce` after approval because Phase 4 is the next unbuilt frontier.

---

## Two processes, one database

The Next.js app never runs the agent graph. It writes a campaign row with `status = 'queued'` and returns. The worker claims that row with `claim_campaign` (`select ... for update skip locked`), runs the graph, and writes progress back. A 20 minute campaign is therefore bounded by nothing in the HTTP layer.

```
Next.js app ──write──> campaigns(status='queued') <──claim── worker
     ^                          │                              │
     │                    agent_events                          │
     └────── SSE (id > cursor) ─┘ <───────── emit() ────────────┘
```

Resumability lives in `campaigns.current_node`, not in worker memory. A human gate sets `status = 'awaiting_*'` and returns `next: null`; the approve route flips the row back to `queued`; the worker picks it up where it stopped. A worker crash mid-campaign is recoverable for the same reason.

## Agent graph

```mermaid
flowchart TD
    START([Campaign queued]) --> ingest[ingest<br/>ffprobe, extract audio]
    ingest --> transcribe[transcribe<br/>Groq whisper-large-v3-turbo]
    transcribe --> analyze[analyze<br/>SOURCE ANALYST]
    analyze --> strategize[strategize<br/>CONTENT STRATEGIST]
    strategize --> dirplan{director_review_plan<br/>CONTENT DIRECTOR}

    dirplan -->|REJECT, replans left| strategize
    dirplan -->|REJECT, no replans left| finalize
    dirplan -->|APPROVE| gate1[/await_strategy_approval<br/>HUMAN GATE/]

    gate1 -->|Request changes| strategize
    gate1 -->|Approve| produce[produce<br/>CLIP PRODUCER + WRITING AGENT<br/>one asset at a time]

    produce --> critique[critique<br/>CONTENT CRITIC]

    critique -->|PASS| more{assets remaining?}
    critique -->|REVISE, under limit| produce
    critique -->|REVISE, at limit| abandon[abandon asset]
    critique -->|REJECT| swap[select_alternative<br/>STRATEGIST picks new segment]

    swap -->|alternative found| produce
    swap -->|none left| abandon
    abandon --> more

    more -->|yes| produce
    more -->|no| creview{campaign_review<br/>CAMPAIGN REVIEWER}

    creview -->|REPLAN, under limit| replan[replan<br/>STRATEGIST revises plan]
    creview -->|REPLAN, at limit| gate2
    creview -->|APPROVE| gate2[/await_final_approval<br/>HUMAN GATE/]

    replan --> produce

    gate2 -->|Request changes| replan
    gate2 -->|Approve| finalize[finalize<br/>package + zip]
    finalize --> DONE([Campaign complete])

    classDef agent fill:#1e293b,stroke:#38bdf8,color:#e2e8f0
    classDef gate fill:#422006,stroke:#f59e0b,color:#fef3c7
    classDef mech fill:#0f172a,stroke:#475569,color:#cbd5e1
    class analyze,strategize,produce,critique,swap,replan agent
    class dirplan,creview agent
    class gate1,gate2 gate
    class ingest,transcribe,abandon,more,finalize mech
```

LLMs decide content and scores at nodes. TypeScript decides which edge is taken. Every node returns `{ next, patch, reason }`.

## Layering

```
node ──> agent ──> lib/tools/ ──> database / ffmpeg / storage
                        │
                 lib/llm/structured.ts ──> OpenRouter
```

Agents call `lib/tools/` and nothing else. No agent file imports the Supabase client, and no agent file calls the AI SDK directly. Both rules exist so that every action an agent takes is logged to `agent_runs.tool_calls` and `agent_events` without anyone remembering to log it, which is what fills the live UI.

## Phase 3 decisions

**The plan is schema-valid first and campaign-valid second.** Zod checks the output shape. TypeScript checks relationships the schema cannot know: fixed per-type credit costs, total budget, enabled platforms, source segment membership, unique stable plan keys, the hard asset cap, and short-video duration. A relationship failure is sent back once with the exact violations. The prompt explains arithmetic, but only code is trusted to enforce it.

**A paid decision is graph memory.** Strategies are versioned rows. If the worker crashes after saving one but before leaving `strategize`, the node reuses it instead of paying to recreate it. The Director's successful structured output already lives in `agent_runs`; `getDirectorReview` treats that as the durable decision record, so a crash after review does not buy the same review twice. A Director or human rejection is the only reason the Strategist creates the next version.

**Replan accounting is tied to strategy versions.** Initial strategy v1 exists before any replan. A rejection of v1 consumes replan 1 and creates v2; a rejection of v2 consumes replan 2 and creates v3. Comparing `replan_count` with the reviewed version makes the patch idempotent when a worker dies after incrementing the counter but before traversing the edge. The limit stays in TypeScript, never in a prompt.

**The gate route chooses a resume node.** The gate itself leaves `current_node = 'await_strategy_approval'`. Approval must queue `produce`, while a change request must queue `strategize` after its feedback is durable. Flipping only `status` back to `queued` would make the worker re-enter the gate and pause forever. Human feedback is written as an event before the campaign becomes claimable, which lets the Strategist read the exact request without adding transient worker memory.

## Phase 2 decisions

**Map-reduce is forced by more than context length.** A 90 minute episode is 120k to 180k tokens, so the map pass exists for the obvious reason. But it would still exist on a 1M context model, because two of the analyst's judgements are structurally impossible inside a single window: `novelty_score` is meaningless relative to one eight-minute slice, and a topic straddling a window boundary can only be recognised as one topic by something that sees both. So novelty is absent from the map schema entirely, and the reduce pass, the only stage that sees the whole candidate pool, owns both. It returns `candidate_ids` per segment, which makes a merge auditable against the candidates it claims to combine.

**Windows overlap by 60 s, and the last one is folded away.** Without overlap, a topic on a boundary is truncated in both windows; with it, anything shorter than the overlap is seen whole by at least one. The duplicate that creates is the reduce pass's job, and it is the cheap direction of the trade: a duplicate is recoverable, a bisected topic is not. A final window that adds less new material than the overlap is folded into its predecessor instead of emitted, because it is a paid call that can only produce duplicates. **The fold appends its unseen words to the previous window**; the first version only moved the boundary, which silently dropped the last twenty seconds of the episode from analysis. A unit test caught it, which is the argument for `planWindows` being pure.

**Schema strictness is decided per constraint.** Strict schema mode is not in effect through OpenRouter (Phase 0 finding, below), so every constraint in a Zod schema is a constraint the model may miss and the repair pass then pays a round trip to fix. Score *ranges* are worth that: a `standalone_score` of 7 is a semantic error and the retry genuinely corrects it. Array and string *lengths* are not: `.slice(0, 3)` on `potential_hooks` costs nothing. Code clamps the scores anyway, because `segments.energy` carries a `between 0 and 1` check constraint and one stray value would fail the whole insert and take the node down with it.

**The model proposes boundaries; TypeScript disposes.** `snapToWords` pulls each span onto real word edges and clamps it inside the transcript, so a hallucinated timestamp can never reach an ffmpeg `-ss`. `dropDuplicates` measures overlap against the *shorter* segment, so a 20 s aside living inside a 90 s answer counts as fully overlapping and is dropped. It is not a second topic. The 20-segment cap is applied to a list sorted by strength, weighted toward `standalone_score`, because everything this system produces is consumed with zero context by someone scrolling.

**Three map calls in flight.** Sequential is ~13 round trips on a 90 minute episode; unbounded is a provider rate limit. A single window failing is tolerated and emits a `warn` naming which minutes are missing, but losing more than a third of the windows fails the node: that is not a degraded analysis, it is a different episode. `CostCeilingExceededError` is rethrown rather than collected, since letting the other two in-flight windows continue spends money the campaign has already been told to stop spending.

**`analyze` is skipped when segments exist.** It is the first genuinely expensive node, and a campaign resumed after a crash further downstream must not pay for it twice. `saveSegments` deletes before inserting rather than upserting, because a re-analysis produces different segments rather than new versions of the old ones, and a partial old run interleaved with a complete new one is indistinguishable downstream.

## Phase 1 decisions

**The unbuilt frontier.** `lib/graph/nodes.ts` registers only the nodes that exist. Reaching an unregistered one parks the campaign: `current_node` keeps pointing at it, `status` becomes `complete`, and a `level:'warn'` event says the node is not built yet. Everything before it genuinely succeeded, and the moment that phase lands the same campaign resumes exactly there. Registering stubs instead would be worse — a node returning a plausible empty result makes an unbuilt phase look like a working one. This branch deletes itself: once every node has an implementation it is unreachable.

**Upload is a raw body, not multipart.** `request.formData()` buffers the entire upload in memory and a 90 minute recording is 1 to 3 GB. The browser sends the `File` as the request body with the name in an `x-filename` header, and the route streams it to disk at constant memory. The name on disk is always `source{ext}` — a filename that came from a browser never becomes a path component.

**The upload lands before the campaign row exists**, in `uploads/_pending/{token}/`. `POST /api/campaigns` inserts the row, renames that directory to the campaign id, and only then sets `status='queued'`. The row is inserted as `'ingesting'` for those few milliseconds because `'queued'` is the only signal the worker's claim query reads: enqueueing first would let a worker claim a campaign with no `source_path` and fail it instantly. Renaming beats copying — it is atomic on one filesystem and cannot half-move 3 GB.

**Groq transcription cost is estimated, not reported.** Unlike OpenRouter, the transcription API returns no cost figure, so `transcribe` charges `USD_PER_AUDIO_HOUR` (list price, read 2026-08-09) times audio hours. If Groq reprices, the campaign total drifts low rather than reporting a false zero.

**The transcript is saved before the cost is charged.** Crossing the ceiling must fail the run, but discarding a transcript that was already paid for would mean paying for it again on the retry. `transcribe` also returns early when a transcript already exists, so a campaign resumed after a crash in a later node does not re-transcribe.

**Chunk offsets are planned starts, not summed durations.** `-c copy` lands on the nearest MP3 frame boundary, so each slice can begin up to ~26 ms early. Seeking every chunk independently from the source keeps that error bounded per chunk; accumulating measured durations would let it compound across all nine chunks of a 90 minute episode. `mergeChunks` and `planChunks` are pure and unit-tested, and `scripts/verify-chunking.ts` proves the arithmetic is actually wired to the slicing by transcribing one real file both ways and comparing the timelines (measured drift: 0.70 s, which is Whisper run-to-run wobble; a dropped offset would show tens of seconds).

**An attached picture is not a video stream.** Cover art inside an MP3 is a video stream to `ffprobe`, and cropping a still image to 9:16 produces a frozen frame. `probe()` ignores streams with `disposition.attached_pic`, so `has_video_stream` means motion.

## Phase 0 decisions

**Structured output (MVP section 7.0). Spike run 2026-08-09 against `google/gemini-2.5-flash-lite` through OpenRouter; results below. `scripts/spike-structured-output.ts` has served its purpose and is deleted.**

The decision: `generateText({ output: Output.object({ schema }) })`, parsed value read from `result.output`. Both APIs work through OpenRouter (`generateObject` returned a valid `result.object` too), so this went to the non-deprecated one.

What the spike established:

| Question | Answer |
|---|---|
| Does `Output.object` return clean typed data? | Yes, on `result.output`, schema-valid. |
| Does `generateObject` still work? | Yes. Not used; `Output.object` is the forward path. |
| Is strict schema mode in effect? | **No.** `result.warnings` was empty but a `z.string().max(40)` was violated on the first attempt, so constraints are not enforced server-side. **The repair pass is a live path, not a safety net.** |
| Does OpenRouter report real cost? | Yes, at `providerMetadata.openrouter.usage.cost` (also `costDetails.upstreamInferenceCost`). Pinned by a test. |

**The repair pass was broken when first written, and the spike is what caught it.** A schema violation surfaces as `NoObjectGeneratedError("response did not match schema")`, with the actual Zod issues two levels down the `cause` chain inside a `TypeValidationError`. Feeding that top-level sentence back gave the retry nothing to act on and produced an identical second failure. `describeError` now walks the `cause` chain, and the retry prompt also includes the raw text the model produced. Verified both ways afterwards: a `max(40)` hook fails then succeeds on retry, a `max(12)` hook fails twice and the node fails loudly.

**Failed attempts are not charged.** The SDK's error carries `usage` but no provider metadata, so there is no cost figure to record. Each one emits a `level:'warn'` event naming the gap, so the campaign total is a known undercount rather than a silent one.

**Cost ceiling before agents.** `add_campaign_cost` increments `campaigns.cost_usd` in Postgres so two concurrent calls cannot both read a stale total and slip past the ceiling together. Crossing `CAMPAIGN_COST_CEILING_USD` throws `CostCeilingExceededError` and fails the run. This exists before any agent does, on purpose.

Two bugs in it were found by exercising it rather than by reading it, both worth remembering:

- `campaigns.cost_usd` was `numeric(10,4)` per MVP section 5. A real call cost `$0.0000174` and rounded to `$0.0000`, so the total stayed at zero forever and the ceiling was unreachable. Now `numeric(12,6)`, matching `agent_runs.cost_usd` (migration `0004`).
- `chargeCampaign` throws from *inside* `callStructured`'s try block, so `CostCeilingExceededError` was caught by the generic handler, treated as a schema failure, and **retried** — a runaway that spent more money on an already-overdrawn campaign, which is the exact failure the ceiling exists to prevent. It is now rethrown before any retry logic runs.

**Model selection (MVP open item 3).** All three IDs verified against `https://openrouter.ai/api/v1/models` on 2026-08-09: `anthropic/claude-sonnet-4.5` ($3/$15 per Mtok), `google/gemini-2.5-flash` ($0.30/$2.50), both multimodal.

`MODEL_OVERRIDE_ALL` points every role at one model for development, currently `google/gemini-2.5-flash-lite` ($0.10/$0.40, 1M context, accepts images). It leaves `MODEL_REASONING`/`FAST`/`VISION` intact as the real configuration, so switching back for a demo is one commented line. **Anything set there must accept images**, or the Clip Producer's vision pass breaks on video sources. The worker prints the override at boot so it cannot silently degrade a demo, and `agent_runs.model` records the model per call.

**Schema source of truth** is `supabase/migrations/`, not a checked-in `lib/db/schema.sql`. `lib/db/database.types.ts` is generated from the live database with `supabase gen types typescript --linked --schema public`; regenerate it after every migration.

**TypeScript 6, not 7.** `typescript-eslint` throws on load under TS 7.0 and takes `eslint-config-next` with it, so TS 7 means no linting at all. `MVP.md` section 2 has the full reasoning. The TS 7 constraints are still observed (no `baseUrl`, `moduleResolution: bundler`) so going back is a version bump.

**Claim semantics.** `claim_campaign` moves the row out of `'queued'` immediately, because `'queued'` is the only signal that a campaign is unclaimed. It sets `'ingesting'` provisionally; the executor overwrites `status` and `current_node` as it enters its first node, which for a resumed campaign is wherever it left off. Nothing reclaims a campaign whose worker died mid-run yet: heartbeats are written, but automatic stale-claim recovery is Phase 9.

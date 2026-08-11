# Chorus architecture

Mirrors `MVP.md` section 6. **Changing `lib/graph/nodes.ts` means updating this diagram in the same commit**, and `components/AgentGraph.tsx` renders the same node set live from the fixed display definition in `lib/graph/view.ts`.

**Build state:** Phase 9 complete. The executor runs through both human gates, produces one asset at a time, critiques it, revises or replaces it when needed, reviews the passing portfolio, validates and finalizes the package, and exposes a streaming export route. The dashboard and final review show durable loading, empty, failure, and recovery states.

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

    dirplan -->|REJECT, plan revision left| strategize
    dirplan -->|REJECT, plan budget exhausted| gate1
    dirplan -->|APPROVE| gate1[/await_strategy_approval<br/>HUMAN GATE/]

    gate1 -->|Request changes, plan revision| strategize
    gate1 -->|Approve| produce[produce<br/>CLIP PRODUCER + WRITING AGENT<br/>one asset at a time]

    produce --> critique[critique<br/>CONTENT CRITIC]

    critique -->|PASS| more_assets{assets remaining?}
    critique -->|REVISE, under limit| produce
    critique -->|REVISE, at limit| abandon[abandon asset]
    critique -->|REJECT| swap[select_alternative<br/>STRATEGIST picks new segment]

    swap -->|alternative found| produce
    swap -->|none left| abandon
    abandon --> more_assets

    more_assets -->|yes| produce
    more_assets -->|no| creview{campaign_review<br/>CAMPAIGN REVIEWER}

    creview -->|REPLAN, portfolio replan left| replan[replan<br/>STRATEGIST revises plan]
    creview -->|REPLAN, portfolio budget exhausted| gate2
    creview -->|APPROVE| gate2[/await_final_approval<br/>HUMAN GATE/]

    replan --> produce

    gate2 -->|Request changes, portfolio replan| replan
    gate2 -->|Approve| finalize[finalize<br/>package + zip]
    finalize --> DONE([Campaign complete])

    classDef agent fill:#1e293b,stroke:#38bdf8,color:#e2e8f0
    classDef gate fill:#422006,stroke:#f59e0b,color:#fef3c7
    classDef mech fill:#0f172a,stroke:#475569,color:#cbd5e1
    class analyze,strategize,produce,critique,swap,replan agent
    class dirplan,creview agent
    class gate1,gate2 gate
    class ingest,transcribe,abandon,more_assets,finalize mech
```

LLMs decide content and scores at nodes. TypeScript decides which edge is taken. Every node returns `{ next, patch, reason }`.

## Layering

```
node ──> agent ──> lib/tools/ ──> database / ffmpeg / storage
                        │
                 lib/llm/structured.ts ──> Anthropic API   (bare model id)
                                       └─> OpenRouter     (id with a slash)
```

Agents call `lib/tools/` and nothing else. No agent file imports the Supabase client, and no agent file calls the AI SDK directly. Both rules exist so that every action an agent takes is logged to `agent_runs.tool_calls` and `agent_events` without anyone remembering to log it, which is what fills the live UI.

## Phase 5 decisions

**A boundary is a word fact, not a model fact.** The model proposes an absolute source span, but `snapClipBoundaries` constrains it to one selected segment, starts on a real word, ends 300 ms after the final included word, and enforces the remaining campaign-wide video allowance assigned to that asset. The same function handles vision suggestions. A model cannot make ffmpeg seek outside the selected evidence or cut a word in half. The producer inspects the initial draft and permits at most two changed drafts; a repeated suggestion ends the loop rather than spending a third adjustment on identical media.

**Inspection branches on the probed database fact.** Video drafts run `silencedetect`, sample six chronological 512 px JPEGs, and send those frames plus opening word timings to `MODEL_VISION`. Audio drafts run silence and word-timing checks in code. `inspectClip` does not merely ask the model to ignore frames on audio: it never invokes the injected vision function, which the MP3 render test proves with a throwing spy. This is inspection, not video understanding, and events name the actual signals used.

**The final command is a correctness boundary.** Both render branches seek the source and set `-t` from the snapped span. Video scales and center-crops to 1080x1920; audio maps a generated 1080x1920 background to the source audio. Both burn one ASS file containing the three-second hook and word-highlight captions, encode H.264/AAC with faststart, then probe the result. Production refuses to save or upload a render whose measured duration differs from the requested span by more than 100 ms. The automated test exercises the real ffmpeg commands for synthetic video and MP3 fixtures.

**Caption burning requires libass.** Homebrew's regular `ffmpeg` 8.1.2 bottle does not include the `ass` filter even though the original prerequisite assumed it did. Phase 5 uses keg-only `ffmpeg-full`, and `.env.example` points to `/opt/homebrew/opt/ffmpeg-full/bin`. This was found by running the render test, not by inspecting a nominal version string.

**Only rendered clips leave local disk.** Drafts, frames, captions, and final scratch files live under `work/{campaignId}/assets/{planKey}`. The final MP4 is uploaded idempotently to the public Supabase `assets` bucket and its URL plus local relative path are saved atomically with the asset's `needs_review` transition. Source media remains local and never approaches Supabase's 50 MB object limit.

## Phase 6 decisions

**The Critic does not own control flow.** `content_critic` returns six 1-to-10 scores, four explicit required checks, a direct-source-contradiction hook, and separate blocking and optional polish feedback for one asset. TypeScript routes the result: any score at or below 3 or a material source contradiction is `REJECT`; any failed required check, blocking feedback on an otherwise passing review, or score below the PASS threshold is `REVISE`; `PASS` requires every check, a 7 average, no score below 5, and null blocking feedback. The decision and explicit review fields are stored in `reviews`, so a worker retry can apply the same edge without buying a second judgement. Only blocking feedback reaches regeneration, while polish remains visible to reviewers.

**Production is one asset at a time.** `produce` selects the first planned, revising, or in-progress row that is not terminal, then returns to `critique` as soon as that row is durable. A worker crash after a model call can reuse the successful `agent_runs` output, and a crash after rendering sees `needs_review` rather than generating the same asset again. This is the loop the dashboard can show rather than a bulk production phase hidden behind one status.

**Revision credits are separate from planned asset credits.** A Critic revision increments `assets.revision_count` before production and reserves one additional credit through `begin_asset_revision`, inside Postgres. Re-entering while the asset is already `generating` is free. `MAX_REVISIONS_PER_ASSET` is checked in the graph, not in a prompt; when the limit is reached the asset becomes `abandoned` and is excluded from the eventual package.

**Rejecting preserves history.** A rejected row is never overwritten. `select_alternative` asks the Strategist to choose from segments unused by every existing asset, replaces the rejected plan entry with a suffixed key such as `asset_1_alt_1`, and lets `produce` materialize the new row. If no candidate remains, the rejected row is abandoned. Rejected and abandoned rows stay visible in the dashboard and their reviews remain auditable.

## Phase 7 decisions

**The Campaign Reviewer owns the portfolio question.** The Critic sees one asset at a time. `campaign_review` sees only the current strategy's passing assets together, their Critic scorecards, and the unused segment pool. Its result is saved in `campaign_reviews` with one row per strategy version. A successful `agent_runs` row is replayed if the worker dies before that row is written.

**Diversity is a code-enforced floor.** The Campaign Reviewer may return `APPROVE` or `REPLAN`, but TypeScript always routes a diversity score below 60 to `REPLAN`. If the model omits a valid replacement while a forced replan is possible, the runtime selects the first passing asset and first genuinely unused segment as a visible safety-net recommendation rather than approving a repetitive portfolio.

**Replans are new strategy versions, not in-place edits.** The Strategist receives the scorecard and replacement instructions. Kept assets retain their original plan keys, type, platform, and source segment ids. Each replacement gets a deterministic unique suffix such as `asset_3_v2`; the old passing row is conditionally moved to `replaced` before the new strategy is saved. A retry reuses the successful replan run and repeats those conditional transitions safely.

**The final gate resumes explicitly.** Final approval queues `finalize`, while final change requests are written to `agent_events` before the campaign is requeued at `replan`. During Phase 7, `finalize` was intentionally unregistered; Phase 9 now registers the real packaging validation node.

## Phase 8 decisions

**The browser has one durable cursor.** The SSE route queries `agent_events` with `id > cursor`, emits each row with its id, and sends a keep-alive frame every 750 ms. The browser closes a failed `EventSource` and opens a new one with the latest cursor, rather than relying on the browser's automatic reconnect URL, so a reconnect always names the current position. A failed database poll closes the stream and lets the same cursor path retry.

**SSE carries events; the snapshot carries state.** The first `useEventStream` request uses the existing campaign snapshot contract and backfills the timeline. Each incoming event then triggers a cursor-based snapshot refresh, which keeps strategy versions, approval gates, review rows, assets, and media URLs in sync without putting database credentials in the browser. This is still poll-over-SSE, not Supabase Realtime: the worker and Next.js process remain independent.

**The graph is a fixed map, not a layout result.** `lib/graph/view.ts` mirrors the section 6 Mermaid graph with hardcoded positions and edges. Planning revision edges and portfolio replan edges have separate labels and budgets. `more_assets` is a display-only decision because the executor resolves that branch inside `produce`, `critique`, and `abandon_asset`; it is derived from the corresponding decision events and does not become a graph node or a Phase 9 stub in the machine. `current_node` drives the active state, `Entering` events establish completed nodes, and decision events mark traversed edges. Loop-back edges stay animated after traversal so a revision, replan, or change request remains visible in the run history.

**Timeline detail is progressive.** The timeline renders newest-first by default, can switch to oldest-first, filters by the event's agent, and uses closed `details` elements for tool events. The graph's skipped state remains available for genuinely unbuilt future nodes, while a worker error marks the current node failed. `finalize` is complete when packaging validation succeeds.

## Phase 4 decisions

**Grounding is a runtime property.** The Writing Agent sees verbatim transcript excerpts, not segment summaries. It also receives overlapping 24-word quote options generated deterministically from those excerpts, which gives weaker development models short spans they can copy without changing transcription grammar. Its output maps every factual claim to a `source_quote`, and TypeScript accepts a quote only when it occurs in one of the selected excerpts after normalizing case and whitespace. The already-paid Critic call then audits the complete grounding array semantically. TypeScript requires one audit row per claim, fails closed on missing, duplicate, or extra rows, and forces `source_supported = false` for unsupported or overstated claims. The resulting audit rows and pass/fail state are durable, so exact quote presence and semantic support remain separately visible.

**Schema repair and editorial validation are different runs.** `callStructured` repairs malformed shape inside one `agent_runs` row. Grounding and platform lengths are runtime checks: the development model repeatedly ignored Zod string maxima because strict provider schemas are unavailable, while an exact failure such as `tweet 2 is 314 characters` produced a useful correction. A schema-valid but ungrounded or overlong asset therefore creates a separate regeneration row. The history shows whether the model failed to format an answer or failed the product's correctness contract.

**Credits and generation status move atomically.** `begin_asset_generation` locks both rows, checks the fixed cost and campaign budget, increments `credits_spent`, and changes the asset from `planned` to `generating` in one transaction. Calling it again while the asset is already `generating` is free. A worker can die anywhere after that point without charging the planning credits twice when production resumes.

**Production sweeps assets temporarily.** The final graph alternates `produce` and `critique` one asset at a time, but the Critic does not exist until Phase 6. Phase 4 initially swept written assets; Phase 5 extends the sweep across clips, reusing any durable `needs_review` output after a crash. Once every planned output exists, production advances to the honest unbuilt `critique` frontier. Phase 6 removes the sweep in favor of the diagram's final loop.

## Phase 3 decisions

**The plan is schema-valid first and campaign-valid second.** Zod checks the output shape. TypeScript checks relationships the schema cannot know: fixed per-type credit costs, total budget, enabled platforms, source segment membership, unique stable plan keys, the hard asset cap, and the aggregate bounded duration of all short videos. Written assets consume none of that allowance. A relationship failure is sent back once with the exact violations. The prompt explains arithmetic, but only code is trusted to enforce it.

**A paid decision is graph memory.** Strategies are versioned rows. If the worker crashes after saving one but before leaving `strategize`, the node reuses it instead of paying to recreate it. The Director's successful structured output already lives in `agent_runs`; `getDirectorReview` treats that as the durable decision record, so a crash after review does not buy the same review twice. A Director or human rejection is the only reason the Strategist creates the next version.

**Transition accounting is tied to strategy versions.** Initial strategy v1 exists before any revision. Director and first-gate changes charge `plan_revision_count`; Campaign Reviewer and final-gate changes charge `portfolio_replan_count`. `campaign_transition_charges` uses `(campaign_id, strategy_version, transition_kind)` as a unique idempotency key, and `charge_campaign_transition` updates the counter and charge row atomically. A retry after a crash returns the existing charge instead of incrementing again. Legacy backfill counts only durable transitions that queued `strategize` or `replan`; incomplete history conservatively preserves the legacy allowance in both counters.

**The gate route chooses a resume node.** The gate itself leaves `current_node = 'await_strategy_approval'` or `await_final_approval`. Approval queues `produce` or `finalize`; a change request queues `strategize` or `replan` after its feedback is durable. The request is recorded before the row becomes claimable, and a second event marks the transition as actually queued for migration backfills. Flipping only `status` back to `queued` would make the worker re-enter the gate and pause forever. First-gate changes charge the planning counter; final-gate changes charge the portfolio counter.

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

**Model selection (MVP open item 3).** `google/gemini-2.5-flash` ($0.30/$2.50, multimodal) verified against `https://openrouter.ai/api/v1/models` on 2026-08-09.

**Two providers, routed by the model id (Phase 10).** An id containing a slash is an OpenRouter route; a bare id goes to the Anthropic API directly through `@ai-sdk/anthropic`. That one rule is the whole of `providerForModel` in `lib/llm/client.ts`, and it means moving a role between providers is an `.env` edit.

The reason is the spike finding below, not cost. Strict schema mode is not in effect through OpenRouter, so every agent's JSON came from a model that had merely been asked politely and the repair pass was a live path. Called directly, Claude enforces the schema server-side via `output_config.format`, so `MODEL_REASONING` and `MODEL_VISION` now default to `claude-sonnet-5` and the repair pass returns to being a safety net. The direct provider also drops the sampling parameters that Sonnet 5 and the other current Claude models reject outright, rather than forwarding them into a 400. `MODEL_FAST` stays on Gemini through OpenRouter: the Source Analyst's map pass reads a whole transcript and wants the million-token context and the cheap tokens more than it wants schema enforcement.

**Cost accounting had to fork with it.** OpenRouter reports real dollars on the response; the Anthropic API reports tokens only. `lib/llm/pricing.ts` is therefore the hand-maintained price table that `docs` above says OpenRouter saved us from, and it exists because a ceiling that silently records null for most calls is not a ceiling. It prices cache reads separately from fresh input (a tenth of the rate) rather than trusting the AI SDK's normalised `usage`, which folds the two together. An unpriced model returns null, which is recorded as an undercount warning, never as $0. `resolveCostUsd` picks the branch from the model id, so `chargeCampaign` and everything above it never learn which provider ran the call.

`MODEL_OVERRIDE_ALL` points every role at one model for development, currently `google/gemini-2.5-flash-lite` ($0.10/$0.40, 1M context, accepts images). It leaves `MODEL_REASONING`/`FAST`/`VISION` intact as the real configuration, so switching back for a demo is one commented line. **Anything set there must accept images**, or the Clip Producer's vision pass breaks on video sources. The worker prints the override at boot so it cannot silently degrade a demo, and `agent_runs.model` records the model per call.

**Schema source of truth** is `supabase/migrations/`, not a checked-in `lib/db/schema.sql`. `lib/db/database.types.ts` is generated from the live database with `supabase gen types typescript --linked --schema public`; regenerate it after every migration.

**TypeScript 6, not 7.** `typescript-eslint` throws on load under TS 7.0 and takes `eslint-config-next` with it, so TS 7 means no linting at all. `MVP.md` section 2 has the full reasoning. The TS 7 constraints are still observed (no `baseUrl`, `moduleResolution: bundler`) so going back is a version bump.

**Claim semantics.** `claim_campaign` moves the row out of `'queued'` immediately, because `'queued'` is the only signal that a campaign is unclaimed. It sets `'ingesting'` provisionally; the executor overwrites `status` and `current_node` as it enters its first node, which for a resumed campaign is wherever it left off. Phase 9 adds stale recovery in the same `for update skip locked` transaction: only active processing statuses with a heartbeat older than `STALE_CLAIM_AFTER_SECONDS` are eligible. Human gates and terminal states are never reclaimed. Heartbeats and failure writes include `claimed_by` fencing so a previous process cannot overwrite the worker that took over.

## Phase 9 decisions

**The final package is a code-enforced allowlist.** `lib/export.ts` selects assets whose status is exactly `passed`. Rejected, abandoned, replaced, planned, generating, revising, and needs-review rows are not export candidates. `finalize` validates that every selected row has content, every clip has a durable local media path and measured duration, and the sum of passed clip durations stays within the campaign-wide allowance. The export route repeats the selection, budget check, and media-path validation beneath `STORAGE_DIR`, then gives archiver file streams instead of reading clips into memory.

**Review and export are separate concerns.** The final review page can show a campaign while it is awaiting final approval or recovering from failure. The ZIP endpoint returns a clear conflict until the `finalize` node has marked the campaign complete. This keeps a partially reviewed campaign from being mistaken for a shippable package.

**Retry resumes the durable node.** A failed campaign keeps `current_node`; the retry route atomically changes only `failed` rows back to `queued`, clears the lease, and emits the recovery decision before the worker can claim it. Existing transcripts, successful structured runs, Critic rows, campaign reviews, and asset state transitions are reused by the graph's idempotency checks. A stale claim uses the same resume path without making human gates claimable.

**The final UI states are explicit.** Dashboard and review routes have route-level loading and error boundaries, while client components distinguish initial loading, empty collections, live connection loss, failed campaigns, and recovery actions. A completed campaign links to the final review; a missing worker or failed node explains the next local action.

# Chorus Judgment Reliability Plan

## Purpose

Fix the judgment and control-flow failures exposed by campaign `f9f88155-2911-412d-b11e-4151562a1fef` without turning Chorus into a fixed content pipeline.

The run proved that the graph, revision loops, grounding checks, portfolio review, human gates, media render, and export path work. The remaining problems are narrower:

1. The Director requested an impossible platform change and consumed a replan.
2. Director and portfolio replans shared one counter, so an early planning mistake blocked a later valid portfolio correction.
3. Source Analyst scores used a 1-to-10 scale and were clamped into twelve identical `1.0` scores.
4. The Critic could return PASS while naming an unresolved, objective-breaking problem.
5. Exact quote matching did not prevent a claim from overstating what its quote supported.
6. The Campaign Reviewer could recommend a topic that the Strategist had already rejected for a campaign-specific reason.
7. A human-approved REPLAN portfolio became indistinguishable from a reviewer-approved completed campaign.

This plan preserves the core invariant: models provide judgments and evidence, while TypeScript validates constraints and chooses graph edges.

## Success criteria

A replacement dogfood run is successful when all of the following are true:

- A Director cannot spend a planning revision on a change that violates a runtime platform or asset constraint.
- Planning revisions and post-production portfolio replans have independent limits and visible counters.
- Source Analyst scores preserve meaningful differences and cannot silently saturate at `1.0`.
- An asset cannot PASS while any required quality check is unresolved.
- PASS feedback is explicitly optional polish, not an ignored blocking fix.
- Written claims are checked for semantic support, not only for the presence of an exact transcript quote.
- The Campaign Reviewer sees prior topic rejections and explains any deliberate override.
- A portfolio whose latest review is REPLAN can ship only through an explicit human override.
- The dashboard, export, event log, and database distinguish reviewer approval from human override.
- The original campaign scenario is represented by regression tests.

## Non-goals

- Do not add publishing, analytics, B-roll, face tracking, or another orchestration framework.
- Do not let prompts own budgets, thresholds, platform compatibility, or graph routing.
- Do not require every piece of optional Critic polish to trigger a paid revision.
- Do not replace exact quote validation. Semantic checking is an additional layer.
- Do not hide rejected, replaced, or overridden history.

## Design decisions

### Separate the two replan budgets

Replace the overloaded `campaigns.replan_count` behavior with two explicit counters:

- `plan_revision_count`: Director and first human-gate changes before production.
- `portfolio_replan_count`: Campaign Reviewer and final human-gate changes after production.

Use separate configuration limits:

- `MAX_PLAN_REVISIONS`, default `2`.
- `MAX_PORTFOLIO_REPLANS`, default `2`.

Keep the real dollar ceiling and credit budget as the outer safety limits. Do not use strategy version as a proxy for whether either counter was already charged. Prefer a small transition-charge table with a unique key on campaign, strategy version, and transition kind. The counter update and charge insert must happen atomically in Postgres.

Backfill existing rows from durable decision events, counting only transitions that actually queued `strategize` or `replan`. Do not count a REPLAN review that reached the final gate without creating a new strategy. Use the legacy `replan_count` only as a conservative fallback when event history is incomplete. Retain it for one compatibility release if necessary, but remove all runtime reads before deleting it in a later migration.

### Make Critic hard checks explicit

Extend the Critic output with required checks that the model judges and TypeScript routes:

```ts
required_checks: {
  brief_compliant: boolean;
  source_supported: boolean;
  standalone: boolean;
  payoff_delivered: boolean;
}
blocking_feedback: string | null;
polish_feedback: string | null;
```

Routing rules:

- REJECT when any quality score is `<= 3`, or when the source is materially contradicted and a local revision cannot safely repair it.
- REVISE when any required check is false.
- PASS only when every required check is true, the average is at least 7, and no score is below 5.
- A PASS review must have `blocking_feedback = null`.
- `polish_feedback` remains visible but does not cause regeneration.

The model still judges the checks. TypeScript owns the edge.

### Record override provenance without multiplying worker statuses

Keep `campaigns.status = 'complete'` as the terminal worker status. Add:

- `completion_mode`: nullable check-constrained text with `reviewer_approved` or `human_override`.
- `completion_note`: nullable text for the human's override rationale.

If the latest Campaign Reviewer decision is REPLAN, final approval must use an explicit override action and require a short rationale. The approval route records the override event before requeueing `finalize`. The review page and exported `campaign.md` must display the mode and unresolved reviewer problems.

Persist both the model's recommendation and TypeScript's effective Campaign Reviewer decision. The effective decision is authoritative for graph routing, final approval, UI, and export, including when the diversity floor changes a model APPROVE into REPLAN.

## Phase 0 - Characterization and regression fixtures

Before changing behavior, encode the failures from the dogfood run as small deterministic fixtures. Do not commit the source video, full transcript, service credentials, or copied private campaign data.

Add tests that demonstrate:

- A Director platform change from `short_video/tiktok` to `x` is invalid.
- A Director planning revision does not consume a portfolio replan.
- A reduce result containing scores `7`, `8`, and `9` currently collapses under `clamp01`.
- Scores averaging above 7 can currently PASS with an unresolved payoff problem.
- Exact quote presence alone can accompany an overstated claim.
- A Campaign Reviewer can currently reintroduce a deliberately rejected topic.
- Final approval currently treats APPROVE and human-overridden REPLAN identically.

Likely files:

- `lib/agents/director.test.ts` or a new test file
- `lib/agents/source-analyst.test.ts`
- `lib/agents/critic.test.ts`
- `lib/agents/writer.test.ts`
- `lib/agents/campaign-reviewer.test.ts`
- route tests for `app/api/campaigns/[id]/approve/route.ts`
- graph-node tests around the two replan counters

Exit condition: confirm every new characterization test fails for the intended reason before implementation begins, then keep the fixtures for the implementing phase. Do not merge a commit with a failing suite.

## Phase 1 - Repair Source Analyst score handling

### Implementation

1. State the score scale explicitly in both map and reduce prompts:
   - `energy`, `standalone_score`, and `novelty_score` are decimal values from `0.0` to `1.0`.
   - Include anchored examples such as `0.2`, `0.6`, and `0.9`.
2. Replace blind `clamp01` with payload-level normalization:
   - If every finite score is within `0..1`, keep the scale.
   - If every finite score is within `0..10`, at least one is above `1`, and no nonzero fractional score is below `1`, divide the payload's scores by `10`.
   - Reject negative values, values above `10`, non-finite values, and mixed payloads such as `0.7` beside `7`.
3. Emit a warning event when a 1-to-10 payload is normalized so provider drift remains visible.
4. Add a saturation diagnostic. If every surviving segment has identical values for all three ranking fields, emit a warning with the raw distribution. Do not fail a genuinely uniform source solely for this reason.
5. Ensure ranking and the cap operate on normalized scores.

### Tests

- Preserve a valid `0..1` payload exactly.
- Normalize a `1..10` map payload and reduce payload.
- Reject invalid and mixed-scale payloads.
- Prove that the dogfood scores `7/8/9` become `0.7/0.8/0.9`, not `1/1/1`.
- Prove `segmentStrength` ranks the normalized fixtures correctly.
- Assert the warning event for automatic normalization.

Exit condition: a forced multi-window analysis produces differentiated stored scores and existing chunk, boundary, and deduplication tests still pass.

## Phase 2 - Constrain Director judgment and split replan budgets

### Database and environment

1. Create a migration with `supabase migration new <descriptive-name>`.
2. Add `plan_revision_count` and `portfolio_replan_count` with non-negative defaults.
3. Add the transition-charge table and its unique idempotency key.
4. Backfill counters from durable transition events, counting only replans that were actually queued.
5. Add `MAX_PLAN_REVISIONS` and `MAX_PORTFOLIO_REPLANS` to `.env.example` and `lib/env.ts`.
6. Regenerate `lib/db/database.types.ts` after applying the migration.

### Director contract

1. Pass the Director an explicit runtime constraint block containing:
   - enabled campaign platforms;
   - valid asset type and platform pairs;
   - asset count, credit, and video-duration limits;
   - a statement that the supplied plan has already passed runtime validation.
2. Replace free-form `required_changes: string[]` with structured changes containing:
   - `plan_key` when one asset is targeted;
   - `field` such as `topic`, `purpose`, `platform`, `source_segments`, or `portfolio_mix`;
   - `instruction`;
   - `target_platform` when `field = platform`.
3. Validate every structured change against the campaign and planned asset. If a change is impossible, retry the Director once with the exact violation. If the retry is still impossible, fail the node without incrementing a counter.
4. Never ask the Strategist to violate its own schema in order to satisfy a Director review.

### Counter behavior

1. Director REJECT and first-gate human changes increment only `plan_revision_count`.
2. Campaign Reviewer REPLAN and final-gate human changes increment only `portfolio_replan_count`.
3. Make charging idempotent across worker retries using a durable key based on campaign, strategy version, and transition kind.
4. Update warning events to name the exact budget that is exhausted.
5. When Director revisions are exhausted, stop at a human strategy gate with the rejected review visible. Do not finalize an unproduced rejected plan.

### Documentation and graph

Update all graph representations together:

- `MVP.md` section 6 and guardrails
- `docs/ARCHITECTURE.md`
- `lib/graph/view.ts`
- `components/AgentGraph.tsx` if labels are duplicated there

The node set need not change, but edge labels must distinguish planning revisions from portfolio replans.

### Tests

- Impossible Director changes do not increment either counter.
- A valid Director rejection increments only `plan_revision_count` once across retries.
- A Campaign Reviewer replan increments only `portfolio_replan_count` once across retries.
- Exhausting one budget does not exhaust the other.
- First and final human change requests use the correct counters.
- Recovery tests prove counters cannot double-charge after a crash.

Exit condition: replaying the campaign's first Director contradiction cannot reduce the later Campaign Reviewer replan allowance.

## Phase 3 - Make Critic PASS mean shippable

### Schema and prompt

1. Add the required checks and split blocking feedback from polish feedback.
2. Define each check using observable criteria:
   - `brief_compliant`: satisfies explicit campaign instructions and prohibitions.
   - `source_supported`: factual and causal claims are entailed by supplied evidence without stronger certainty.
   - `standalone`: no unexplained references or missing episode context.
   - `payoff_delivered`: the asset itself delivers its promised point. For video, captions outside the video do not count.
3. For video, require the Critic to inspect the opening words, final spoken sentence, hook overlay, inspection result, and any end card separately.
4. For written assets, require an audit of every claim-to-quote pair and any concrete examples derived from those claims.

### Routing and persistence

1. Update `decideCritic` to apply hard checks before average-score routing.
2. Persist required checks, blocking feedback, and polish feedback in `reviews`. Prefer explicit JSON columns or a documented shape inside existing JSON rather than burying them in prose.
3. Feed only blocking feedback into regeneration.
4. Display polish feedback as optional in `AssetCard` and the final review page.
5. Change event language from `no score below 5` to a summary that includes hard-check status.

### Tests

- The dogfood video's unresolved payoff forces REVISE even with a 7.5 average.
- Unsupported causal text forces REVISE or REJECT.
- A fully supported asset with minor polish notes can PASS.
- PASS with non-null blocking feedback is rejected by schema or runtime validation.
- Revision exhaustion still abandons the asset according to existing guardrails.

Exit condition: the rendered video cannot PASS until the promised payoff exists inside the video itself.

## Phase 4 - Add semantic grounding enforcement

Exact quote matching remains the first deterministic check. Add semantic support as a second check inside the already-paid Critic call.

### Implementation

1. Include the complete grounding array in the Critic's explicit audit instructions.
2. Require a structured per-claim result:

```ts
grounding_audit: Array<{
  claim: string;
  supported: boolean;
  overstates_source: boolean;
  reason: string;
}>
```

3. TypeScript verifies that every submitted grounding claim appears exactly once in the audit.
4. Any unsupported or overstated factual claim sets `source_supported = false` and forces REVISE.
5. In the Writer prompt, prohibit diagnostic shorthand such as "that is a dopamine problem" unless the source itself makes that diagnosis.
6. Keep lexical quote validation in `validateGrounding` as the pre-save guardrail.
7. Rename UI copy from "verified source quotes" to "exact source quotes" before Critic approval. After a Critic PASS, show "source-supported claims" only when the semantic audit passed.

### Tests

- An exact quote paired with a stronger causal claim fails semantic support.
- A faithful paraphrase paired with an exact quote passes.
- Missing, duplicate, and extra audit rows fail closed.
- The four categorical neuromodulator examples from the dogfood campaign force revision until softened.

Exit condition: lexical grounding and semantic support are separately visible and independently enforced.

## Phase 5 - Preserve rejected-topic context during campaign review

### Implementation

1. Pass the latest strategy rationale, planned assets, selected topics, and rejected topics into `reviewCampaign`.
2. Extend Strategist `rejected_topics` with `segment_ids` so exact reintroduction checks are deterministic. Existing rows may normalize missing ids to an empty array.
3. Render rejected topics, segment ids, and reasons immediately before the unused segment pool.
4. Extend replacement recommendations with:
   - `replacement_reason`;
   - `prior_rejection_addressed: string | null`.
5. If the proposed replacement overlaps a rejected topic, require a non-empty explanation of why the earlier rejection no longer applies after the current portfolio failure.
6. Add deterministic identity checks for exact topic or segment matches. Semantic near-matches remain model judgment but must be explained in the structured output.
7. Pass this context into the Strategist's replan prompt and require the new rationale to acknowledge any deliberate reversal.
8. Do not silently discard a contradictory recommendation and fall back to the first unused segment. Emit a warning and request one repair first. Keep the deterministic fallback only for malformed output after repair.

### Tests

- A previously rejected segment cannot return without an override explanation.
- A justified reversal remains possible when portfolio context has genuinely changed.
- The caffeine recommendation from the dogfood run is either rejected or explicitly reconciled with the anti-hype brief.
- Existing video-budget and unused-segment replacement protections still pass.

Exit condition: the Campaign Reviewer cannot unknowingly reverse a deliberate Strategist rejection.

## Phase 6 - Make human override explicit

### Database and API

1. Add `completion_mode` and `completion_note` in a migration.
2. Persist `model_decision` and `effective_decision` for campaign reviews, backfilling `effective_decision = REPLAN` whenever stored diversity is below 60.
3. Regenerate database types.
4. Split final approval actions:
   - `approve` is valid when the latest Campaign Reviewer decision is APPROVE.
   - `override_and_approve` is required when the latest decision is REPLAN and must include a rationale.
5. Use `effective_decision`, not the raw model recommendation, for this check.
6. Write the durable human event before requeueing `finalize`.
7. Have `finalize` verify that one of these valid paths exists before marking the campaign complete.
8. Set `completion_mode` in the final patch and preserve unresolved review problems.

### UI and export

1. At a REPLAN final gate, show a destructive warning with the diversity score, unresolved problems, and exhausted portfolio-replan count.
2. Replace the ordinary Approve button with `Ship with override` and require confirmation plus rationale.
3. Show `Human override` on completed dashboard and review pages.
4. Include completion mode, override rationale, latest review decision, and unresolved problems in `campaign.md`.
5. Keep the ZIP asset filter unchanged: only passed assets are packaged.

### Tests

- Ordinary approval is rejected when the latest review says REPLAN.
- Override without rationale is rejected.
- A valid override resumes at `finalize` and records provenance once.
- Reviewer-approved completion records `reviewer_approved`.
- Export and UI views expose override state.

Exit condition: no completed campaign can conceal that it shipped against the Campaign Reviewer's recommendation.

## Phase 7 - Integrated verification

Run the normal verification suite after each phase and the full suite at the end:

```bash
npx tsc --noEmit
npm test
npm run lint
npm run build
```

Then run one paid end-to-end dogfood campaign with the real model configuration. `MODEL_OVERRIDE_ALL` must be disabled.

Inspect and record:

- differentiated Source Analyst scores;
- valid Director requested changes;
- independent counter values in the timeline;
- at least one blocking Critic REVISE;
- semantic grounding audit results;
- Campaign Reviewer awareness of rejected-topic reasons;
- an actual portfolio replan when diversity is below 60;
- final completion mode;
- total credits, model cost, and elapsed active time.

The final dogfood portfolio must either:

- receive Campaign Reviewer APPROVE and complete as `reviewer_approved`; or
- remain at the final gate with REPLAN until a human explicitly ships it as `human_override`.

## Recommended implementation order

Execute the phases in order. Phase 1 is isolated and low risk. Phase 2 changes durable orchestration state and must land before Critic changes increase the number of legitimate replans. Phases 3 and 4 define what an individually shippable asset means. Phase 5 then improves portfolio replacement judgment using those stronger assets. Phase 6 makes the remaining human escape hatch honest and auditable.

Each phase should end in a runnable, reviewable commit. Any change to `lib/graph/nodes.ts` must update the MVP graph, architecture document, and live graph in the same commit.

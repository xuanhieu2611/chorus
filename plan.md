# PRD Alignment and MVP Acceptance Plan

## Goal

Close the remaining gaps between `PRD.md`, `MVP.md`, and the completed implementation, then verify the MVP through a real clean-clone campaign.

This work does not add new agents or change the product scope. It aligns existing behavior and finishes acceptance validation.

## Scope

1. Show the strategy on the final campaign review page.
2. Make `max_video_seconds` a campaign-wide total video-duration budget.
3. Align the max-assets form and API limits with the six-asset MVP hard cap.
4. Run and document a complete external-service acceptance campaign.

The optional PRD inputs for clip-length range and desired content style remain deferred. They are not part of the detailed MVP build specification or definition of done.

---

## Phase 1 - Final review strategy

### Objective

Make the final review satisfy PRD section 20 by showing the campaign objective, strategy rationale, selected topics, and deliberately rejected topics.

### Implementation

- Update `components/CampaignReview.tsx` to read `strategy` from `useEventStream`.
- Render `StrategyPanel` before the final asset list when a strategy exists.
- Pass `awaitingApproval={false}` so the final page never renders the strategy approval controls.
- Keep the existing campaign objective in the page header.
- Add a clear empty state if a completed campaign unexpectedly has no strategy snapshot.
- Reuse `StrategyPanel` instead of creating a second strategy presentation.

### Files

- `components/CampaignReview.tsx`
- `components/StrategyPanel.tsx` only if a small read-only prop or accessibility adjustment is needed

### Verification

- A completed campaign's final review shows:
  - campaign objective
  - strategy version and rationale
  - selected topics and purposes
  - rejected topics and reasons
  - final Campaign Reviewer scorecard
  - passed assets
- No approval controls appear inside the final strategy section.
- Loading, missing-strategy, and failed-campaign states remain legible.

---

## Phase 2 - Campaign-wide video-duration budget

### Decision

Treat `campaigns.max_video_seconds` as the maximum total duration of all final short-video assets, matching PRD sections 6 and 12.

Keep the database column name to avoid a migration. Update labels, prompts, validation, and comments so its aggregate meaning is unambiguous.

### 2.1 Form and API language

- Change the form label from `Max clip seconds` to `Maximum total video seconds`.
- Add helper text explaining that the value is shared across all short-video assets.
- Keep the existing accepted numeric range unless real campaign testing shows a better bound is needed.
- Update API/schema comments and user-facing validation errors to use aggregate-budget language.

### 2.2 Strategy validation

Update `validateStrategy` in `lib/agents/strategist.ts`:

- Calculate the planned duration of each short-video asset from its selected source segments.
- Sum those durations across the complete strategy.
- Reject a strategy when the sum exceeds `maxVideoSeconds`.
- Retain validation that each source span is usable by the Clip Producer.
- Return a specific error containing the proposed total and allowed total.
- Update the Strategist prompt from "maximum duration of each short video" to "maximum combined duration of all short videos."
- Update segment rendering so a segment is not incorrectly marked ineligible merely because it exceeds the entire campaign allowance. Eligibility should reflect whether a legal bounded clip can be selected from it.

### 2.3 Replans and replacements

Aggregate validation must also hold after portfolio replans and Critic replacements:

- Ensure `validateReplan` validates the complete revised strategy against the same total budget.
- Preserve durations for kept assets when calculating replacement capacity.
- Before selecting an alternative for a rejected video, calculate the remaining video budget after the other active or passing video assets.
- Exclude alternatives that cannot yield a legal clip within the remaining allowance.
- Pass the remaining allowance to the Clip Producer as the maximum duration for that asset.
- A revision of the same asset must not reserve its previous duration twice.
- Emit a warning and abandon/select another alternative when no legal duration remains rather than silently exceeding the campaign budget.

### 2.4 Finalization guard

Add a final deterministic check before completion:

- Sum `duration_sec` for all passed short-video assets selected for export.
- Fail finalization if the total exceeds `campaign.max_video_seconds`, with a message naming the actual and allowed totals.
- Keep this as a backstop. The Strategist and production loop should normally prevent it from firing.

### Files

Expected changes:

- `components/NewCampaignForm.tsx`
- `app/api/campaigns/route.ts`
- `lib/agents/strategist.ts`
- `lib/agents/strategist.test.ts`
- `lib/agents/clip-producer.ts`
- `lib/graph/nodes.ts`
- `lib/export.ts` or a small shared campaign-budget helper
- `lib/export.test.ts` or a focused graph/finalization test
- `MVP.md`, `README.md`, and `docs/ARCHITECTURE.md` where the old per-clip interpretation appears

### Tests

Add tests covering:

1. Two videos that each fit individually but exceed the combined budget are rejected.
2. A mixed strategy whose combined video duration fits is accepted.
3. Written assets do not consume video seconds.
4. A replan cannot replace an asset with a plan that exceeds the remaining video budget.
5. A Critic replacement receives only the remaining video allowance.
6. Revising a video does not count the old and revised render twice.
7. Finalization rejects a passed portfolio whose rendered durations exceed the cap.
8. A valid portfolio at or below the exact cap finalizes normally.

---

## Phase 3 - Six-asset hard-cap alignment

### Objective

Stop accepting a user setting that the graph will silently clamp later.

### Implementation

- Define the effective MVP asset cap as `min(MAX_ASSETS, 6)`.
- Pass that value from the server page into `NewCampaignForm` rather than importing server environment configuration into a client component.
- Set the form input's `max` and default value from that prop.
- Validate `max_assets` against the same effective cap in `POST /api/campaigns`.
- Return a clear 400 response when a caller exceeds the cap.
- Keep the graph-level `Math.min(campaign.max_assets, env.maxAssets)` as defense in depth for old rows or direct database inserts.
- Add helper text such as "Up to 6 assets in the MVP."

### Files

- `app/page.tsx`
- `components/NewCampaignForm.tsx`
- `app/api/campaigns/route.ts`
- `lib/env.ts` or a small shared server-only limits module
- API validation tests if route tests are introduced

### Verification

- The UI cannot request more than the effective cap.
- A direct API request above the cap receives a validation error.
- A lower `MAX_ASSETS` environment setting is reflected in both the form and API.
- Existing campaigns above the cap are still constrained by the graph.

---

## Phase 4 - Documentation alignment

Update documentation only after behavior is implemented and tests pass.

### Required updates

- `PRD.md`: mark the three alignment items as implemented without changing the original product intent.
- `MVP.md`:
  - document aggregate video-budget enforcement
  - document final-review strategy display
  - document the effective six-asset UI/API cap
  - update the status/date if appropriate
- `README.md`:
  - explain that maximum video duration is shared across clips
  - keep the known limitations unchanged
  - add the acceptance-run instructions and result
- `docs/ARCHITECTURE.md`:
  - record where aggregate duration is enforced
  - explain that finalization repeats the check as a correctness backstop

Do not add clip-length range or content-style inputs in this pass. Record them as optional post-MVP enhancements if they need explicit tracking.

---

## Phase 5 - Automated verification

Run the complete local suite:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

All commands must pass with no skipped tests introduced for the new constraints.

Also verify:

- existing real FFmpeg video-duration test still passes within 100 ms
- existing MP3 caption-card test still proves no vision call occurs
- export tests still exclude every non-passed asset status
- graph view tests still match the node registry and documented graph

---

## Phase 6 - Clean-clone acceptance campaign

### Environment

Use a fresh checkout or a clean temporary directory:

1. Run `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Configure the four required service credentials.
4. Apply all Supabase migrations and regenerate database types.
5. Confirm the configured FFmpeg build includes the `ass` filter.
6. Start `npm run dev` and `npm run worker` in separate terminals.
7. Remove `MODEL_OVERRIDE_ALL` before judging output quality or recording the demo.

### Source selection

Use a video podcast with:

- several independently usable topics
- at least two repetitive arguments
- one segment with a slow introduction or weak standalone framing
- enough unused material for Campaign Reviewer replacement

The source should make the desired review behavior genuine rather than fabricating database state.

### Acceptance checklist

- [ ] Upload and campaign creation complete successfully.
- [ ] Source probing identifies the video stream correctly.
- [ ] Transcription produces monotonic word timestamps.
- [ ] Source analysis produces grounded topic segments.
- [ ] Strategy includes selected and deliberately rejected topics.
- [ ] Director approves or visibly requests a replan.
- [ ] Human strategy approval resumes at production.
- [ ] At least one real Critic `REVISE` regenerates an asset.
- [ ] Revision score history is visible in the dashboard.
- [ ] At least one real Campaign Reviewer repetition finding causes replacement.
- [ ] Combined passed clip duration stays within the configured campaign budget.
- [ ] Final human approval resumes at `finalize`.
- [ ] Final review displays strategy, scorecard, source timestamps, quality scores, and passed assets.
- [ ] A rendered 9:16 MP4 plays in the browser with burned captions.
- [ ] ZIP download contains `campaign.md`, written Markdown, and passed clips.
- [ ] Rejected, abandoned, replaced, and unfinished assets are absent from the ZIP.
- [ ] Grounding quotes in written assets occur in the source transcript.

### Evidence to retain

Record in `docs/ACCEPTANCE.md`:

- date and commit SHA
- source type and duration, without including private media
- model IDs used
- campaign ID
- final status and asset counts
- total model cost and credits spent
- combined final video duration and configured limit
- Critic revision evidence
- Campaign Reviewer replacement evidence
- exported ZIP file listing
- any manual intervention or retry

Do not commit credentials, source media, rendered private media, or signed URLs.

---

## Phase 7 - Reliability metric

The PRD target of at least 90% of agent runs completing without manual repair cannot be established from one demo.

After the acceptance campaign succeeds:

- Run at least 10 representative campaigns across MP4, MOV, MP3, and WAV sources.
- Count a run as successful only if it reaches a human gate or completion without database edits, prompt patching, or manual state repair.
- Record failures by node and cause.
- Calculate both campaign completion rate and individual `agent_runs` success rate.
- Fix repeatable product defects before claiming the 90% target.
- Treat provider outages and cost-ceiling stops separately, but report them rather than deleting them from the sample.

This measurement is release evidence, not another product feature.

---

## Completion criteria

This plan is complete when:

1. The final review includes the latest strategy and rejected topics.
2. Total passed short-video duration cannot exceed the campaign-wide video budget.
3. The form, API, graph, and documentation agree on the six-asset MVP cap.
4. All automated checks pass.
5. A clean-clone campaign demonstrates a real Critic revision and Campaign Reviewer replacement.
6. The exported package contains only passed assets.
7. Acceptance evidence is recorded without secrets or private media.

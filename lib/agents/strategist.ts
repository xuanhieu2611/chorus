import { z } from 'zod';
import { callStructured } from '@/lib/llm/structured';
import type { Json } from '@/lib/db/database.types';
import type { SegmentRow } from '@/lib/db/client';
import type { CampaignReview } from '@/lib/agents/campaign-reviewer';
import {
  plannedVideoDuration,
  plannedVideoDurationForAsset,
  remainingVideoBudget,
  reservedVideoDuration,
  sourceSpanDuration,
  type BudgetAsset,
} from '@/lib/video-budget';

export const ASSET_TYPES = ['short_video', 'x_thread', 'linkedin_post'] as const;
export const PLATFORMS = ['tiktok', 'x', 'linkedin'] as const;

export const PlannedAssetSchema = z.object({
  plan_key: z.string(),
  type: z.enum(ASSET_TYPES),
  platform: z.enum(PLATFORMS),
  topic: z.string(),
  purpose: z.string(),
  segment_ids: z.array(z.string()).min(1),
  // Not `.int()`: Zod renders that with safe-integer `minimum`/`maximum`, which
  // some OpenRouter providers reject. `validateStrategy` already requires this to
  // equal `CREDIT_COST[type]` and `normalizeStrategy` overwrites it, so the
  // integer bound was never what made the number trustworthy.
  credits: z.number(),
});

export const StrategySchema = z.object({
  rationale: z.string(),
  // `validateStrategy` requires the two-asset minimum. Providers serving Claude
  // reject `minItems` above 1, so expressing it here fails the request outright.
  planned_assets: z.array(PlannedAssetSchema).min(1),
  rejected_topics: z.array(z.object({ topic: z.string(), reason: z.string() })).min(1),
});

export type StrategyPlan = z.infer<typeof StrategySchema>;
export type PlannedAsset = z.infer<typeof PlannedAssetSchema>;

export interface ReplanInput extends StrategyConstraints {
  campaignId: string;
  previous: StrategyPlan;
  review: CampaignReview;
  segments: SegmentRow[];
  targetVersion: number;
  occupiedPlanKeys: string[];
  humanFeedback?: string;
  /** Existing rows let replans preserve measured durations for kept assets. */
  existingAssets?: BudgetAsset[];
  goal: string;
  audience: string | null;
  brandVoice: string | null;
}

export const AlternativeSchema = z.object({
  segment_id: z.string().trim().min(1),
  reasoning: z.string().trim().min(1),
});

export type AlternativeSelection = z.infer<typeof AlternativeSchema>;

export interface AlternativeInput {
  campaignId: string;
  planKey: string;
  rejectedTopic: string;
  rejectionFeedback: string;
  assetType: PlannedAsset['type'];
  candidates: SegmentRow[];
  /** Remaining aggregate allowance, supplied for video replacements. */
  remainingVideoSeconds?: number;
  goal: string;
  audience: string | null;
  brandVoice: string | null;
}

export const CREDIT_COST: Record<PlannedAsset['type'], number> = {
  short_video: 3,
  x_thread: 2,
  linkedin_post: 2,
};

export interface StrategyConstraints {
  creditBudget: number;
  maxAssets: number;
  maxVideoSeconds: number;
  platforms: string[];
}

export interface StrategistInput extends StrategyConstraints {
  campaignId: string;
  segments: SegmentRow[];
  goal: string;
  audience: string | null;
  brandVoice: string | null;
  requiredChanges?: string[];
}

/**
 * Revise only the assets the Campaign Reviewer marked for replacement. Kept
 * plan keys and source ids are an idempotency boundary: their existing rows
 * already contain paid output and must not be regenerated under a new key.
 */
export async function replanStrategy(input: ReplanInput): Promise<StrategyPlan> {
  const replacements = input.review.recommendations.filter(
    (recommendation) => recommendation.action === 'replace',
  );
  if (replacements.length === 0) {
    throw new Error('Replan requires at least one replacement recommendation.');
  }

  const replacementKeys = replacementKeysFor(input);
  const replacementInstructions = replacements.map((recommendation) => {
    const replacementKey = replacementKeys.get(recommendation.plan_key)!;
    return `- Replace ${recommendation.plan_key} with ${replacementKey}. Topic: ${recommendation.replacement_topic}. Exact unused segment ids: ${recommendation.replacement_segment_ids.join(', ')}.`;
  });
  const keepInstructions = input.previous.planned_assets
    .filter((asset) => !replacementKeys.has(asset.plan_key))
    .map(
      (asset) =>
        `- Keep ${asset.plan_key} exactly: type ${asset.type}, platform ${asset.platform}, source segment ids ${asset.segment_ids.join(', ')}.`,
    );
  const replacementCapacityInstructions = renderReplacementCapacity(input, replacementKeys);

  let violations: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callStructured({
      campaignId: input.campaignId,
      agent: 'content_strategist',
      node: 'replan',
      role: 'reasoning',
      schema: StrategySchema,
      schemaName: 'campaign_replan',
      schemaDescription: 'A revised campaign plan with unchanged kept assets and suffixed replacement keys.',
      system: REPLAN_SYSTEM,
      prompt: [
        `Revise strategy v${input.targetVersion - 1} into strategy v${input.targetVersion}.`,
        'The Campaign Reviewer found a portfolio-level problem. Replace only the named assets and preserve every other asset exactly so already-produced work remains reusable.',
        `The maximum combined duration of all short videos remains ${input.maxVideoSeconds} seconds. The complete revised plan must fit it; written assets consume none of this allowance.`,
        '',
        'Required replacements:',
        ...replacementInstructions,
        ...(replacementCapacityInstructions.length
          ? ['', 'Replacement video capacity after kept assets:', ...replacementCapacityInstructions]
          : []),
        '',
        'Assets that must remain unchanged:',
        ...keepInstructions,
        '',
        'Previous plan:',
        JSON.stringify(input.previous, null, 2),
        '',
        'Campaign Reviewer scorecard:',
        JSON.stringify(input.review, null, 2),
        ...(input.humanFeedback ? ['', `Human final-review feedback: ${input.humanFeedback}`] : []),
        '',
        'Source segments:',
        renderSegments(input.segments, input.maxVideoSeconds),
        ...(violations.length
          ? [
              '',
              'Your previous plan violated these runtime constraints:',
              ...violations.map((violation) => `- ${violation}`),
              'Return a corrected plan. This is the final retry.',
            ]
          : []),
        '',
        describeObjective(input),
      ].join('\n'),
      input: {
        from_strategy_version: input.targetVersion - 1,
        target_strategy_version: input.targetVersion,
        replacement_keys: Object.fromEntries(replacementKeys),
        max_video_seconds: input.maxVideoSeconds,
        previous_plan: input.previous,
        campaign_review: input.review,
        human_feedback: input.humanFeedback ?? null,
        replacement_video_capacity: replacementCapacityInstructions,
      } as Json,
    });

    violations = validateReplan(result.value, input);
    if (violations.length === 0) return normalizeReplan(result.value, input);
    // The retry prompt names the violations, so a model that returned the wrong
    // keys gets one chance to return the right ones.
  }

  throw new Error(`Content Strategist could not produce a legal replan: ${violations.join('; ')}`);
}

/** Pure semantic checks for a replan. Exported so the relationship contract is
 * testable without paying for a model call. */
export function validateReplan(plan: StrategyPlan, input: ReplanInput): string[] {
  // Budget, platform and video checks run against the *normalized* plan, not the
  // raw one. `normalizeReplan` already owns every field a replan is not allowed
  // to move - type, platform, source segment ids, credits - by rebuilding each
  // entry from the previous plan and the Reviewer's recommendation. Judging the
  // raw plan on those fields failed campaigns for something code was about to
  // correct anyway: a real run died on "costs 2 credits, not 3" for a value
  // `normalizeReplan` overwrites on the next line. What the model actually owns
  // here is the topic, the purpose, and which keys it returns.
  const violations = validateStrategy(normalizeReplan(plan, input), input.segments, input);
  const replacementKeys = replacementKeysFor(input);
  const previousByKey = new Map(input.previous.planned_assets.map((asset) => [asset.plan_key, asset]));
  const actualByKey = new Map(plan.planned_assets.map((asset) => [asset.plan_key, asset]));

  for (const previous of input.previous.planned_assets) {
    const replacementKey = replacementKeys.get(previous.plan_key);
    if (replacementKey) {
      if (actualByKey.has(previous.plan_key)) {
        violations.push(`${previous.plan_key} must be removed from the revised plan`);
      }
      if (!actualByKey.has(replacementKey)) {
        violations.push(`replacement ${replacementKey} is missing from the revised plan`);
      }
      continue;
    }

    if (!actualByKey.has(previous.plan_key)) {
      violations.push(`kept asset ${previous.plan_key} is missing from the revised plan`);
    }
  }

  const expectedKeys = new Set(
    input.previous.planned_assets.map((asset) => replacementKeys.get(asset.plan_key) ?? asset.plan_key),
  );
  for (const key of actualByKey.keys()) {
    if (!expectedKeys.has(key)) violations.push(`unexpected plan key ${key} appeared in the revised plan`);
  }
  for (const key of expectedKeys) {
    if (!actualByKey.has(key)) violations.push(`expected plan key ${key} is missing from the revised plan`);
  }

  // Keep this lookup in the validation path so a future caller cannot pass a
  // recommendation for a plan key that was not in the source strategy.
  for (const recommendation of input.review.recommendations) {
    if (recommendation.action === 'replace' && !previousByKey.has(recommendation.plan_key)) {
      violations.push(`Reviewer replacement targets unknown plan key ${recommendation.plan_key}`);
    }
  }

  const capacity = replacementVideoCapacity(input, replacementKeys, plan);
  if (capacity.replacementVideoSeconds > capacity.remainingVideoSeconds + 0.000001) {
    violations.push(
      `video replacements require ${capacity.replacementVideoSeconds.toFixed(1)} seconds, but only ${capacity.remainingVideoSeconds.toFixed(1)} seconds remain after kept assets`,
    );
  }

  return violations;
}

/** Stable, collision-free suffix for a replacement plan key. */
export function replacementPlanKey(
  oldPlanKey: string,
  targetVersion: number,
  occupiedPlanKeys: Iterable<string>,
): string {
  const occupied = new Set(occupiedPlanKeys);
  const base = `${oldPlanKey}_v${targetVersion}`;
  let candidate = base;
  let suffix = 2;
  while (occupied.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix++;
  }
  return candidate;
}

function replacementKeysFor(input: ReplanInput): Map<string, string> {
  const occupied = new Set([
    ...input.occupiedPlanKeys,
    ...input.previous.planned_assets.map((asset) => asset.plan_key),
  ]);
  const keys = new Map<string, string>();
  for (const recommendation of input.review.recommendations) {
    if (recommendation.action !== 'replace' || keys.has(recommendation.plan_key)) continue;
    const replacement = replacementPlanKey(
      recommendation.plan_key,
      input.targetVersion,
      occupied,
    );
    keys.set(recommendation.plan_key, replacement);
    occupied.add(replacement);
  }
  return keys;
}

function renderReplacementCapacity(
  input: ReplanInput,
  replacementKeys: Map<string, string>,
): string[] {
  const replacementPlan: StrategyPlan = {
    ...input.previous,
    planned_assets: input.previous.planned_assets.map((asset) => {
      const replacementKey = replacementKeys.get(asset.plan_key);
      const recommendation = input.review.recommendations.find(
        (item) => item.action === 'replace' && item.plan_key === asset.plan_key,
      );
      return replacementKey && recommendation
        ? { ...asset, plan_key: replacementKey, segment_ids: recommendation.replacement_segment_ids }
        : asset;
    }),
  };
  const capacity = replacementVideoCapacity(input, replacementKeys, replacementPlan);
  if (capacity.replacementVideoSeconds === 0) return [];

  let remaining = capacity.remainingVideoSeconds;
  return input.previous.planned_assets.flatMap((asset) => {
    const replacementKey = replacementKeys.get(asset.plan_key);
    if (!replacementKey || asset.type !== 'short_video') return [];
    const replacement = replacementPlan.planned_assets.find((item) => item.plan_key === replacementKey);
    const duration = replacement
      ? plannedVideoDurationForAsset(replacement, input.segments, input.maxVideoSeconds)
      : 0;
    const allowance = Math.max(0, remaining);
    remaining -= duration;
    return [
      `- ${replacementKey}: ${duration.toFixed(1)} seconds planned; at most ${allowance.toFixed(1)} seconds remain before this replacement.`,
    ];
  });
}

function replacementVideoCapacity(
  input: ReplanInput,
  replacementKeys: Map<string, string>,
  plan: StrategyPlan,
): { remainingVideoSeconds: number; replacementVideoSeconds: number } {
  const keptAssets = input.previous.planned_assets.filter((asset) => !replacementKeys.has(asset.plan_key));
  const remainingVideoSeconds = remainingVideoBudget({
    maxVideoSeconds: input.maxVideoSeconds,
    plannedAssets: keptAssets,
    segments: input.segments,
    assets: input.existingAssets ?? [],
  });
  const replacementVideoSeconds = input.previous.planned_assets.reduce((total, previous) => {
    const replacementKey = replacementKeys.get(previous.plan_key);
    if (!replacementKey) return total;
    const replacement = plan.planned_assets.find((asset) => asset.plan_key === replacementKey);
    return replacement
      ? total + plannedVideoDurationForAsset(replacement, input.segments, input.maxVideoSeconds)
      : total;
  }, 0);
  return { remainingVideoSeconds, replacementVideoSeconds };
}

/**
 * Force every field a replan does not own. Exported because the graph reuses a
 * durable replan proposal from `agent_runs`, which is raw model output that has
 * never been through this.
 */
export function normalizeReplan(plan: StrategyPlan, input: ReplanInput): StrategyPlan {
  const replacementKeys = replacementKeysFor(input);
  const generatedByKey = new Map(plan.planned_assets.map((asset) => [asset.plan_key, asset]));

  return {
    rationale: plan.rationale.trim(),
    planned_assets: input.previous.planned_assets.map((previous) => {
      const replacementKey = replacementKeys.get(previous.plan_key);
      if (!replacementKey) return previous;

      const recommendation = input.review.recommendations.find(
        (item) => item.action === 'replace' && item.plan_key === previous.plan_key,
      );
      const generated = generatedByKey.get(replacementKey);
      return {
        ...previous,
        plan_key: replacementKey,
        topic: generated?.topic.trim() || recommendation?.replacement_topic || previous.topic,
        purpose: generated?.purpose.trim() || previous.purpose,
        segment_ids: recommendation?.replacement_segment_ids ?? previous.segment_ids,
        credits: CREDIT_COST[previous.type],
      };
    }),
    rejected_topics: plan.rejected_topics.map((item) => ({
      topic: item.topic.trim(),
      reason: item.reason.trim(),
    })),
  };
}

/**
 * Content Strategist. The model decides which ideas deserve a place in the
 * campaign. TypeScript decides whether the proposed plan is legal.
 *
 * Semantic validation is deliberately outside Zod. Budget sums, segment
 * membership, and aggregate video duration are relationships between the output
 * and the campaign, not properties of one JSON field. A failed plan is sent back once
 * with the exact violations instead of trusting a prompt to do arithmetic.
 */
export async function createStrategy(input: StrategistInput): Promise<StrategyPlan> {
  const listing = renderSegments(input.segments, input.maxVideoSeconds);
  const budgetOptions = renderBudgetOptions(input.creditBudget, input.maxAssets);
  const safeAssetCount = Math.min(
    input.maxAssets,
    Math.floor(input.creditBudget / CREDIT_COST.short_video),
  );
  if (safeAssetCount < 2) {
    throw new Error(
      `A ${input.creditBudget} credit budget cannot fund the two assets required by the strategy contract.`,
    );
  }
  let violations: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callStructured({
      campaignId: input.campaignId,
      agent: 'content_strategist',
      node: 'strategize',
      role: 'reasoning',
      schema: StrategySchema,
      schemaName: 'content_strategy',
      schemaDescription: 'A budget-valid multi-platform campaign plan with explicit topic rejections.',
      system: STRATEGIST_SYSTEM,
      prompt: [
        'Plan a content campaign from this scored source pool.',
        '',
        listing,
        '',
        'Campaign constraints:',
        `- Platforms: ${input.platforms.join(', ')}`,
        `- Credit budget: ${input.creditBudget}`,
        `- Maximum assets: ${input.maxAssets}`,
        `- Maximum combined duration of all short videos: ${input.maxVideoSeconds} seconds`,
        '- Costs are fixed: short_video = 3, x_thread = 2, linkedin_post = 2 credits.',
        `- Return between 2 and ${safeAssetCount} assets. This conservative cap guarantees the plan fits the credit budget even if every asset is a video. Do not fill the campaign maximum.`,
        '- Estimate each video from its selected source span, bound any longer span to a legal clip, and keep the combined video estimate within the shared allowance. Written assets consume none of it.',
        `- Legal asset-count combinations for this budget: ${budgetOptions}`,
        '- Count your proposed asset types against one of those combinations before returning the plan.',
        '- A short_video must target tiktok, an x_thread must target x, and a linkedin_post must target linkedin.',
        '- Only a source marked "video eligible: yes" can be used for a short_video.',
        '- Use only segment ids shown above. Prefer one segment per asset unless combining them has a clear editorial purpose.',
        '- Reject at least one plausible topic and explain the tradeoff. Do not use the rejected list for filler.',
        ...(input.requiredChanges?.length
          ? ['', 'Required changes from the previous review:', ...input.requiredChanges.map((item) => `- ${item}`)]
          : []),
        ...(violations.length
          ? [
              '',
              'Your previous plan was schema-valid but broke these runtime constraints:',
              ...violations.map((item) => `- ${item}`),
              'Return a corrected plan. This is the final retry.',
            ]
          : []),
        '',
        describeObjective(input),
      ].join('\n'),
      input: {
        segment_count: input.segments.length,
        credit_budget: input.creditBudget,
        max_assets: input.maxAssets,
        max_video_seconds: input.maxVideoSeconds,
        platforms: input.platforms,
        required_changes: input.requiredChanges ?? [],
        semantic_attempt: attempt + 1,
      } as Json,
    });

    violations = validateStrategy(result.value, input.segments, input);
    if (violations.length === 0) return normalizeStrategy(result.value);
  }

  throw new Error(`Content Strategist could not produce a legal plan: ${violations.join('; ')}`);
}

/** Pick one genuinely unused source segment for an asset the Critic rejected. */
export async function selectAlternative(input: AlternativeInput): Promise<AlternativeSelection> {
  if (input.candidates.length === 0) {
    throw new Error(`No unused segment is available for ${input.planKey}.`);
  }

  const candidateIds = new Set(input.candidates.map((segment) => segment.id));
  let violations: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callStructured({
      campaignId: input.campaignId,
      agent: 'content_strategist',
      node: 'select_alternative',
      role: 'reasoning',
      schema: AlternativeSchema,
      schemaName: 'alternative_segment_selection',
      schemaDescription: 'One unused source segment that can replace a rejected asset.',
      system: ALTERNATIVE_SYSTEM,
      prompt: [
        `Choose a replacement source segment for rejected plan ${input.planKey}.`,
        `Original topic: ${input.rejectedTopic}`,
        `Original asset type: ${input.assetType}`,
        `Why the Critic rejected it: ${input.rejectionFeedback}`,
        '',
        'Choose exactly one segment from this unused pool. The replacement should do the same platform job with a distinctly stronger source moment. Return the segment id exactly as shown.',
        ...(input.assetType === 'short_video' && input.remainingVideoSeconds !== undefined
          ? [`The replacement must fit within ${input.remainingVideoSeconds.toFixed(2)} seconds remaining in the campaign-wide video budget.`]
          : []),
        ...input.candidates.map((segment) => renderAlternativeCandidate(segment)),
        ...(violations.length
          ? [
              '',
              'Your previous selection was invalid:',
              ...violations.map((violation) => `- ${violation}`),
              'Return a corrected selection from the candidate pool.',
            ]
          : []),
        '',
        describeObjective(input),
      ].join('\n'),
      input: {
        plan_key: input.planKey,
        rejected_topic: input.rejectedTopic,
        rejection_feedback: input.rejectionFeedback,
        asset_type: input.assetType,
        remaining_video_seconds: input.remainingVideoSeconds ?? null,
        candidate_ids: input.candidates.map((segment) => segment.id),
        selection_attempt: attempt + 1,
      } as Json,
    });

    violations = [];
    if (!candidateIds.has(result.value.segment_id)) {
      violations.push(`segment_id ${result.value.segment_id} is not in the unused candidate pool`);
    }
    if (violations.length === 0) return result.value;
  }

  throw new Error(`Content Strategist could not select a valid alternative: ${violations.join('; ')}`);
}

/** Pure runtime validation, exported because budget failures are too expensive
 * to test by making real model calls. */
export function validateStrategy(
  strategy: StrategyPlan,
  segments: SegmentRow[],
  constraints: StrategyConstraints & { existingAssets?: BudgetAsset[] },
): string[] {
  const violations: string[] = [];
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const planKeys = new Set<string>();
  let credits = 0;
  let plannedVideoSeconds = 0;

  if (strategy.planned_assets.length < 2) {
    violations.push(
      `planned ${strategy.planned_assets.length} asset${strategy.planned_assets.length === 1 ? '' : 's'}, but a campaign is a portfolio and needs at least 2`,
    );
  }

  if (strategy.planned_assets.length > constraints.maxAssets) {
    violations.push(
      `planned ${strategy.planned_assets.length} assets, but the maximum is ${constraints.maxAssets}`,
    );
  }

  for (const [index, asset] of strategy.planned_assets.entries()) {
    const normalizedKey = asset.plan_key.trim();
    const label = normalizedKey || `asset ${index + 1}`;
    if (!normalizedKey) violations.push(`asset ${index + 1} has an empty plan_key`);
    if (planKeys.has(normalizedKey)) violations.push(`plan_key "${normalizedKey}" is duplicated`);
    planKeys.add(normalizedKey);

    const expectedCredits = CREDIT_COST[asset.type];
    if (asset.credits !== expectedCredits) {
      violations.push(`${label} costs ${expectedCredits} credits, not ${asset.credits}`);
    }
    credits += expectedCredits;

    const expectedPlatform = platformFor(asset.type);
    if (asset.platform !== expectedPlatform) {
      violations.push(`${label} is ${asset.type} and must target ${expectedPlatform}, not ${asset.platform}`);
    }
    if (!constraints.platforms.includes(asset.platform)) {
      violations.push(`${label} targets ${asset.platform}, which is not enabled for this campaign`);
    }

    const uniqueIds = new Set(asset.segment_ids);
    if (uniqueIds.size !== asset.segment_ids.length) {
      violations.push(`${label} repeats a source segment id`);
    }

    const sourceSegments = asset.segment_ids.map((id) => {
      const segment = segmentById.get(id);
      if (!segment) violations.push(`${label} references unknown segment ${id}`);
      return segment ?? null;
    });

    if (asset.type === 'short_video') {
      const sourceDurations = sourceSegments.map((segment) => (segment ? sourceSpanDuration(segment) : 0));
      for (const [sourceIndex, duration] of sourceDurations.entries()) {
        if (duration <= 0) {
          violations.push(
            `${label} references source segment ${asset.segment_ids[sourceIndex]} with no usable time span`,
          );
        }
      }
      plannedVideoSeconds += plannedVideoDuration(sourceDurations, constraints.maxVideoSeconds);
    }
  }

  // A replan supplies the rows that already exist, and an asset that has rendered
  // reserves what it actually produced rather than the source span it was planned
  // from. Without this a replan is judged on spans nobody can still change: kept
  // assets are fixed by code and the replacement's segment ids come from the
  // Reviewer, so an over-budget total had no legal correction and the retry
  // returned the identical number.
  const totalVideoSeconds = constraints.existingAssets
    ? reservedVideoDuration({
        maxVideoSeconds: constraints.maxVideoSeconds,
        plannedAssets: strategy.planned_assets,
        segments,
        assets: constraints.existingAssets,
      })
    : plannedVideoSeconds;

  if (totalVideoSeconds > constraints.maxVideoSeconds) {
    violations.push(
      `planned short videos use ${totalVideoSeconds.toFixed(1)} seconds in total, above the ${constraints.maxVideoSeconds} second campaign-wide video budget`,
    );
  }

  if (credits > constraints.creditBudget) {
    violations.push(`the plan costs ${credits} credits, above the ${constraints.creditBudget} credit budget`);
  }

  return violations;
}

function normalizeStrategy(strategy: StrategyPlan): StrategyPlan {
  return {
    rationale: strategy.rationale.trim(),
    planned_assets: strategy.planned_assets.map((asset, index) => ({
      ...asset,
      plan_key: asset.plan_key.trim() || `asset_${index + 1}`,
      topic: asset.topic.trim(),
      purpose: asset.purpose.trim(),
      segment_ids: [...new Set(asset.segment_ids)],
      credits: CREDIT_COST[asset.type],
    })),
    rejected_topics: strategy.rejected_topics.map((item) => ({
      topic: item.topic.trim(),
      reason: item.reason.trim(),
    })),
  };
}

function platformFor(type: PlannedAsset['type']): PlannedAsset['platform'] {
  if (type === 'short_video') return 'tiktok';
  if (type === 'x_thread') return 'x';
  return 'linkedin';
}

function renderAlternativeCandidate(segment: SegmentRow): string {
  const duration = Number(segment.end_time) - Number(segment.start_time);
  return [
    `# ${segment.id}`,
    `  ${Number(segment.start_time).toFixed(1)}-${Number(segment.end_time).toFixed(1)}s (${duration.toFixed(1)}s) | ${segment.content_type}`,
    `  topic: ${segment.topic}`,
    `  summary: ${(segment.summary ?? '').slice(0, 200)}`,
    `  scores: standalone ${score(segment.standalone_score)}, novelty ${score(segment.novelty_score)}, energy ${score(segment.energy)}`,
  ].join('\n');
}

function renderSegments(segments: SegmentRow[], maxVideoSeconds: number): string {
  return segments
    .map((segment) => {
      const duration = Number(segment.end_time) - Number(segment.start_time);
      const scores = [
        `standalone ${score(segment.standalone_score)}`,
        `novelty ${score(segment.novelty_score)}`,
        `energy ${score(segment.energy)}`,
      ].join(', ');
      const hooks = segment.potential_hooks.slice(0, 3).join(' | ');
      return [
        `# ${segment.id}`,
        `  ${Number(segment.start_time).toFixed(1)}-${Number(segment.end_time).toFixed(1)}s (${duration.toFixed(1)}s) | ${segment.content_type} | ${scores}`,
        `  video eligible: ${duration > 0 ? (duration > maxVideoSeconds ? `yes, Clip Producer can bound it to ${maxVideoSeconds}s` : 'yes') : 'no, invalid time span'}`,
        `  topic: ${segment.topic}`,
        `  summary: ${(segment.summary ?? '').slice(0, 200)}`,
        hooks ? `  possible hooks: ${hooks}` : null,
        segment.context_deps ? `  context dependency: ${segment.context_deps}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');
}

function renderBudgetOptions(creditBudget: number, maxAssets: number): string {
  const options: string[] = [];
  const maxVideos = Math.min(maxAssets, Math.floor(creditBudget / CREDIT_COST.short_video));
  for (let videos = 0; videos <= maxVideos; videos++) {
    const textAssets = Math.min(
      maxAssets - videos,
      Math.floor((creditBudget - videos * CREDIT_COST.short_video) / CREDIT_COST.x_thread),
    );
    const total = videos * CREDIT_COST.short_video + textAssets * CREDIT_COST.x_thread;
    if (videos + textAssets < 2) continue;
    options.push(`${videos} video + up to ${textAssets} text = ${total} credits`);
  }
  return options.join('; ');
}

function score(value: number | null): string {
  return value === null ? 'unscored' : Number(value).toFixed(2);
}

const STRATEGIST_SYSTEM = [
  'You are the Content Strategist for a podcast growth campaign.',
  'Exercise editorial judgement. Select a small portfolio whose assets do different jobs for the objective, rather than mechanically turning every high score into content.',
  'The rejected list matters as much as the selected list: name attractive ideas you are deliberately leaving out and the tradeoff behind each decision.',
  'Budget and platform constraints are hard runtime rules. Never invent source segment ids.',
].join('\n');

const ALTERNATIVE_SYSTEM = [
  'You are the Content Strategist selecting a replacement for one rejected asset.',
  'Choose a genuinely unused source segment that can perform the same platform job while avoiding the rejected idea’s weakness.',
  'Never invent a segment id. The runtime will reject anything outside the supplied candidate pool.',
].join('\n');

const REPLAN_SYSTEM = [
  'You are the Content Strategist revising a campaign after a portfolio review.',
  'Replace only the named assets. Keep every other plan key, asset type, platform, and source segment id exactly unchanged.',
  'Use the exact suffixed replacement plan keys and unused segment ids supplied by the runtime. Do not invent ids or add assets.',
  'The replacement should have a clear purpose for the campaign objective and a topic that matches the supplied source segment.',
].join('\n');

function describeObjective(input: Pick<StrategistInput, 'goal' | 'audience' | 'brandVoice'>): string {
  return [
    'Optimize the whole plan against this campaign objective.',
    `Goal: ${input.goal}`,
    input.audience ? `Audience: ${input.audience}` : 'Audience: not specified.',
    input.brandVoice ? `Brand voice: ${input.brandVoice}` : 'Brand voice: not specified.',
  ].join('\n');
}

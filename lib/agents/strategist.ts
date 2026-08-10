import { z } from 'zod';
import { callStructured } from '@/lib/llm/structured';
import type { Json } from '@/lib/db/database.types';
import type { SegmentRow } from '@/lib/db/client';

export const ASSET_TYPES = ['short_video', 'x_thread', 'linkedin_post'] as const;
export const PLATFORMS = ['tiktok', 'x', 'linkedin'] as const;

export const PlannedAssetSchema = z.object({
  plan_key: z.string(),
  type: z.enum(ASSET_TYPES),
  platform: z.enum(PLATFORMS),
  topic: z.string(),
  purpose: z.string(),
  segment_ids: z.array(z.string()).min(1),
  credits: z.number().int(),
});

export const StrategySchema = z.object({
  rationale: z.string(),
  planned_assets: z.array(PlannedAssetSchema).min(2),
  rejected_topics: z.array(z.object({ topic: z.string(), reason: z.string() })).min(1),
});

export type StrategyPlan = z.infer<typeof StrategySchema>;
export type PlannedAsset = z.infer<typeof PlannedAssetSchema>;

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
 * Content Strategist. The model decides which ideas deserve a place in the
 * campaign. TypeScript decides whether the proposed plan is legal.
 *
 * Semantic validation is deliberately outside Zod. Budget sums, segment
 * membership, and clip duration are relationships between the output and the
 * campaign, not properties of one JSON field. A failed plan is sent back once
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
        `- Maximum duration of each short video: ${input.maxVideoSeconds} seconds`,
        '- Costs are fixed: short_video = 3, x_thread = 2, linkedin_post = 2 credits.',
        `- Return between 2 and ${safeAssetCount} assets. This conservative cap guarantees the plan fits even if every asset is a video. Do not fill the campaign maximum.`,
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
  constraints: StrategyConstraints,
): string[] {
  const violations: string[] = [];
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const planKeys = new Set<string>();
  let credits = 0;

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

    const sourceSegments = asset.segment_ids.flatMap((id) => {
      const segment = segmentById.get(id);
      if (!segment) {
        violations.push(`${label} references unknown segment ${id}`);
        return [];
      }
      return [segment];
    });

    if (asset.type === 'short_video') {
      const duration = sourceSegments.reduce(
        (total, segment) => total + (Number(segment.end_time) - Number(segment.start_time)),
        0,
      );
      if (duration > constraints.maxVideoSeconds) {
        violations.push(
          `${label} uses ${duration.toFixed(1)} seconds of source, above the ${constraints.maxVideoSeconds} second clip limit`,
        );
      }
    }
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
        `  video eligible: ${duration <= maxVideoSeconds ? 'yes' : `no, exceeds ${maxVideoSeconds}s`}`,
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

function describeObjective(input: Pick<StrategistInput, 'goal' | 'audience' | 'brandVoice'>): string {
  return [
    'Optimize the whole plan against this campaign objective.',
    `Goal: ${input.goal}`,
    input.audience ? `Audience: ${input.audience}` : 'Audience: not specified.',
    input.brandVoice ? `Brand voice: ${input.brandVoice}` : 'Brand voice: not specified.',
  ].join('\n');
}

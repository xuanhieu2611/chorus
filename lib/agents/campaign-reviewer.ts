import { z } from 'zod';
import { callStructured } from '@/lib/llm/structured';
import type { Json } from '@/lib/db/database.types';

/**
 * Scores are 0 to 100, bounded by `clampReviewScore` rather than by the schema.
 * `minimum`/`maximum` are JSON Schema keywords that some OpenRouter providers
 * reject, and the diversity threshold below forces a replan, so the bound cannot
 * depend on which provider served the request. See `lib/agents/critic.ts`.
 */
const CampaignReviewScoresSchema = z.object({
  asset_quality: z.number(),
  diversity: z.number(),
  audience_fit: z.number(),
  brand_consistency: z.number(),
  overall: z.number(),
});

/** Hold a score inside 0 to 100; a non-finite score is treated as the floor. */
export function clampReviewScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

const RecommendationSchema = z.object({
  action: z.enum(['keep', 'replace']),
  plan_key: z.string().trim().min(1),
  replacement_topic: z.string().trim().min(1).nullable(),
  replacement_segment_ids: z.array(z.string().trim().min(1)),
});

export const CampaignReviewSchema = z
  .object({
    scores: CampaignReviewScoresSchema,
    problems: z.array(
      z.object({
        issue: z.string().trim().min(1),
        asset_plan_keys: z.array(z.string().trim().min(1)),
      }),
    ),
    recommendations: z.array(RecommendationSchema),
    decision: z.enum(['APPROVE', 'REPLAN']),
  })
  .superRefine((review, ctx) => {
    const replacementCount = review.recommendations.filter(
      (recommendation) => recommendation.action === 'replace',
    ).length;

    if (review.decision === 'REPLAN' && replacementCount === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendations'],
        message: 'REPLAN requires at least one replacement recommendation',
      });
    }

    for (const [index, recommendation] of review.recommendations.entries()) {
      if (recommendation.action === 'replace') {
        if (!recommendation.replacement_topic) {
          ctx.addIssue({
            code: 'custom',
            path: ['recommendations', index, 'replacement_topic'],
            message: 'replacement recommendations need a topic',
          });
        }
        if (recommendation.replacement_segment_ids.length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['recommendations', index, 'replacement_segment_ids'],
            message: 'replacement recommendations need an unused segment',
          });
        }
      } else if (
        recommendation.replacement_topic !== null ||
        recommendation.replacement_segment_ids.length > 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['recommendations', index],
          message: 'keep recommendations cannot include replacement details',
        });
      }
    }
  });

export type CampaignReview = z.infer<typeof CampaignReviewSchema>;
export type CampaignReviewScores = z.infer<typeof CampaignReviewScoresSchema>;
export type CampaignReviewRecommendation = CampaignReview['recommendations'][number];

export interface CampaignReviewAsset {
  planKey: string;
  type: string;
  platform: string;
  hook: string | null;
  content: Json;
  sourceSegmentIds: string[];
  criticScores: Json;
  criticFeedback: string;
}

export interface CampaignReviewSegment {
  id: string;
  topic: string;
  summary: string | null;
  contentType: string;
  startTime: number;
  endTime: number;
  noveltyScore: number | null;
}

export interface CampaignReviewInput {
  campaignId: string;
  strategyVersion: number;
  assets: CampaignReviewAsset[];
  unusedSegments: CampaignReviewSegment[];
  goal: string;
  audience: string | null;
  brandVoice: string | null;
}

export interface CampaignReviewRouting {
  decision: 'APPROVE' | 'REPLAN';
  forcedReplan: boolean;
}

/**
 * Review the passing portfolio as a whole. The model can recommend a route,
 * but it never owns the edge. A diversity score below 60 always reopens the
 * plan in TypeScript, even if the model says APPROVE.
 */
export async function reviewCampaign(input: CampaignReviewInput): Promise<CampaignReview> {
  const result = await callStructured({
    campaignId: input.campaignId,
    agent: 'campaign_reviewer',
    node: 'campaign_review',
    role: 'reasoning',
    schema: CampaignReviewSchema,
    schemaName: 'campaign_review',
    schemaDescription: 'A portfolio scorecard with specific cross-asset replacement recommendations.',
    system: CAMPAIGN_REVIEWER_SYSTEM,
    prompt: [
      `Review the passing portfolio for strategy v${input.strategyVersion}.`,
      '',
      'Judge the assets together, not one at a time. Look for repeated arguments, identical hooks, redundant platform jobs, and a campaign that would feel monotonous even if every asset is individually polished.',
      'Scores are 0 to 100. Diversity below 60 is a failing portfolio condition and must result in REPLAN.',
      'When recommending replacement, name the exact passing plan_key, choose a concrete topic from the unused segment pool, and return its segment id exactly as shown.',
      '',
      'Passing assets:',
      ...input.assets.map((asset) => renderAsset(asset)),
      '',
      'Unused source segments available for replacement:',
      ...(input.unusedSegments.length > 0
        ? input.unusedSegments.map((segment) => renderSegment(segment))
        : ['(none)']),
      '',
      describeObjective(input),
    ].join('\n'),
    input: {
      strategy_version: input.strategyVersion,
      assets: input.assets,
      unused_segments: input.unusedSegments,
    } as unknown as Json,
  });

  return result.value;
}

/** Deterministic Campaign Reviewer routing. */
export function decideCampaignReview(review: CampaignReview): CampaignReviewRouting {
  const forcedReplan = clampReviewScore(review.scores.diversity) < 60;
  return {
    decision: forcedReplan ? 'REPLAN' : review.decision,
    forcedReplan,
  };
}

/**
 * Keep a malformed or incomplete replacement proposal from silently turning a
 * forced REPLAN into an approval. Invalid replacement rows are discarded and a
 * deterministic first unused segment is paired with the first passing asset.
 * This is a routing safety net, not a substitute for the Reviewer's judgement.
 */
export function ensureReplanRecommendation(
  review: CampaignReview,
  assets: CampaignReviewAsset[],
  unusedSegments: CampaignReviewSegment[],
): CampaignReview {
  const assetKeys = new Set(assets.map((asset) => asset.planKey));
  const unusedIds = new Set(unusedSegments.map((segment) => segment.id));
  const usedReplacementIds = new Set<string>();
  const recommendations = review.recommendations.filter((recommendation) => {
    if (!assetKeys.has(recommendation.plan_key)) return false;
    if (recommendation.action === 'keep') return true;
    if (!recommendation.replacement_topic || recommendation.replacement_segment_ids.length === 0) {
      return false;
    }
    const valid = recommendation.replacement_segment_ids.every(
      (segmentId) => unusedIds.has(segmentId) && !usedReplacementIds.has(segmentId),
    );
    if (!valid) return false;
    for (const segmentId of recommendation.replacement_segment_ids) usedReplacementIds.add(segmentId);
    return true;
  });

  if (recommendations.some((recommendation) => recommendation.action === 'replace')) {
    return { ...review, decision: 'REPLAN', recommendations };
  }

  const target = assets[0];
  const segment = unusedSegments.find((candidate) => !usedReplacementIds.has(candidate.id));
  if (!target || !segment) {
    throw new Error('Campaign Reviewer forced a replan, but no passing asset and unused segment are available for replacement.');
  }

  return {
    ...review,
    decision: 'REPLAN',
    recommendations: [
      ...recommendations,
      {
        action: 'replace',
        plan_key: target.planKey,
        replacement_topic: segment.topic,
        replacement_segment_ids: [segment.id],
      },
    ],
  };
}

function renderAsset(asset: CampaignReviewAsset): string {
  return [
    `# ${asset.planKey} | ${asset.type} for ${asset.platform}`,
    `  hook: ${asset.hook ?? '(none)'}`,
    `  source segments: ${asset.sourceSegmentIds.join(', ')}`,
    `  content: ${JSON.stringify(asset.content)}`,
    `  Critic scores: ${JSON.stringify(asset.criticScores)}`,
    `  Critic feedback: ${asset.criticFeedback}`,
  ].join('\n');
}

function renderSegment(segment: CampaignReviewSegment): string {
  return [
    `# ${segment.id} | ${segment.startTime.toFixed(1)}-${segment.endTime.toFixed(1)}s | ${segment.contentType}`,
    `  topic: ${segment.topic}`,
    `  summary: ${segment.summary ?? '(none)'}`,
    `  novelty: ${segment.noveltyScore === null ? 'unscored' : segment.noveltyScore.toFixed(2)}`,
  ].join('\n');
}

function describeObjective(input: Pick<CampaignReviewInput, 'goal' | 'audience' | 'brandVoice'>): string {
  return [
    'Campaign objective:',
    `Goal: ${input.goal}`,
    input.audience ? `Audience: ${input.audience}` : 'Audience: not specified.',
    input.brandVoice ? `Brand voice: ${input.brandVoice}` : 'Brand voice: not specified.',
  ].join('\n');
}

const CAMPAIGN_REVIEWER_SYSTEM = [
  'You are the Campaign Reviewer for a podcast growth campaign.',
  'Judge the passing assets as a portfolio. Your job is to protect the campaign from repetition, not to flatter each individual asset.',
  'Use only the supplied asset details and source segment pool. If assets overlap, identify the exact plan keys and replace one with a genuinely unused segment.',
  'A recommendation must be actionable enough for the Strategist to execute without guessing.',
].join('\n');

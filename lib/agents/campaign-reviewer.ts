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

export interface ReplanVideoBudget {
  maxVideoSeconds: number;
  /** Video-second allowance available to replacements, after kept video assets. */
  remainingVideoSeconds: number;
}

/**
 * Keep a malformed or incomplete replacement proposal from silently turning a
 * forced REPLAN into an approval. Invalid replacement rows are discarded and a
 * deterministic first unused segment is paired with the first passing asset.
 * This is a routing safety net, not a substitute for the Reviewer's judgement.
 *
 * The Reviewer is never told the campaign-wide video-second budget (see
 * `renderSegment`), so a `replace` recommendation targeting a short_video asset
 * can name a segment that is individually fine but blows the aggregate budget
 * once combined with every video the campaign is keeping. The Content
 * Strategist that consumes this recommendation is not allowed to change its
 * segment choice during a replan (`normalizeReplan` owns that field), so a
 * budget-illegal segment reaches it as a dead end it cannot correct: the retry
 * loop just resubmits the same over-budget plan and the whole campaign fails.
 * Treating an over-budget segment choice the same as a malformed one - discard
 * it here, before it ever reaches the Strategist - keeps that failure from
 * happening at all.
 */
export function ensureReplanRecommendation(
  review: CampaignReview,
  assets: CampaignReviewAsset[],
  unusedSegments: CampaignReviewSegment[],
  videoBudget: ReplanVideoBudget,
): CampaignReview {
  const assetByKey = new Map(assets.map((asset) => [asset.planKey, asset]));
  const unusedByKey = new Map(unusedSegments.map((segment) => [segment.id, segment]));
  const usedReplacementIds = new Set<string>();
  let videoSecondsLeft = videoBudget.remainingVideoSeconds;

  const recommendations = review.recommendations.filter((recommendation) => {
    const target = assetByKey.get(recommendation.plan_key);
    if (!target) return false;
    if (recommendation.action === 'keep') return true;
    if (!recommendation.replacement_topic || recommendation.replacement_segment_ids.length === 0) {
      return false;
    }
    const validIds = recommendation.replacement_segment_ids.every(
      (segmentId) => unusedByKey.has(segmentId) && !usedReplacementIds.has(segmentId),
    );
    if (!validIds) return false;

    if (target.type === 'short_video') {
      const duration = replacementVideoDuration(
        recommendation.replacement_segment_ids,
        unusedByKey,
        videoBudget.maxVideoSeconds,
      );
      if (duration > videoSecondsLeft + 0.000001) return false;
      videoSecondsLeft -= duration;
    }

    for (const segmentId of recommendation.replacement_segment_ids) usedReplacementIds.add(segmentId);
    return true;
  });

  if (recommendations.some((recommendation) => recommendation.action === 'replace')) {
    return { ...review, decision: 'REPLAN', recommendations };
  }

  const fallback = findFallbackReplacement(assets, unusedSegments, usedReplacementIds, videoBudget, videoSecondsLeft);
  if (!fallback) {
    throw new Error(
      'Campaign Reviewer forced a replan, but no passing asset and unused segment are available for replacement within the video budget.',
    );
  }

  return {
    ...review,
    decision: 'REPLAN',
    recommendations: [
      ...recommendations,
      {
        action: 'replace',
        plan_key: fallback.asset.planKey,
        replacement_topic: fallback.segment.topic,
        replacement_segment_ids: [fallback.segment.id],
      },
    ],
  };
}

function replacementVideoDuration(
  segmentIds: readonly string[],
  segmentsById: Map<string, CampaignReviewSegment>,
  maxVideoSeconds: number,
): number {
  const total = segmentIds.reduce((sum, id) => {
    const segment = segmentsById.get(id);
    return sum + (segment ? segmentDuration(segment) : 0);
  }, 0);
  return Math.min(total, maxVideoSeconds);
}

function segmentDuration(segment: CampaignReviewSegment): number {
  const duration = segment.endTime - segment.startTime;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/** First passing asset with an unused segment that actually fits its type's
 * budget. Written assets consume no video allowance, so they are always
 * eligible; a short_video asset only qualifies if some unused segment fits
 * what remains after every recommendation already accepted above. */
function findFallbackReplacement(
  assets: CampaignReviewAsset[],
  unusedSegments: CampaignReviewSegment[],
  usedReplacementIds: Set<string>,
  videoBudget: ReplanVideoBudget,
  videoSecondsLeft: number,
): { asset: CampaignReviewAsset; segment: CampaignReviewSegment } | null {
  for (const asset of assets) {
    const segment = unusedSegments.find((candidate) => {
      if (usedReplacementIds.has(candidate.id)) return false;
      if (asset.type !== 'short_video') return true;
      const duration = Math.min(segmentDuration(candidate), videoBudget.maxVideoSeconds);
      return duration <= videoSecondsLeft + 0.000001;
    });
    if (segment) return { asset, segment };
  }
  return null;
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

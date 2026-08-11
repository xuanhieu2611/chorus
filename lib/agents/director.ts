import { z } from 'zod';
import { callStructured } from '@/lib/llm/structured';
import type { Json } from '@/lib/db/database.types';
import {
  CREDIT_COST,
  PLATFORMS,
  type PlannedAsset,
  type StrategyPlan,
} from '@/lib/agents/strategist';

const DIRECTOR_FIELDS = ['topic', 'purpose', 'platform', 'source_segments', 'portfolio_mix'] as const;

export const DirectorChangeSchema = z
  .object({
    /** Null means the instruction applies to the portfolio rather than one asset. */
    plan_key: z.string().trim().min(1).nullable(),
    field: z.enum(DIRECTOR_FIELDS),
    instruction: z.string().trim().min(1),
    /** Required only for a platform change. It is null for every other field. */
    target_platform: z.enum(PLATFORMS).nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.field === 'portfolio_mix' && value.plan_key !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['plan_key'],
        message: 'must be null for a portfolio_mix change',
      });
    }
    if (value.field !== 'portfolio_mix' && value.plan_key === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['plan_key'],
        message: 'is required when a change targets one asset',
      });
    }
    if (value.field === 'platform' && value.target_platform === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['target_platform'],
        message: 'is required for a platform change',
      });
    }
    if (value.field !== 'platform' && value.target_platform !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['target_platform'],
        message: 'must be null unless field is platform',
      });
    }
  });

export const DirectorSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reasoning: z.string(),
    required_changes: z.array(DirectorChangeSchema),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'REJECT' && value.required_changes.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['required_changes'],
        message: 'must name at least one concrete change when the decision is REJECT',
      });
    }
    if (value.decision === 'APPROVE' && value.required_changes.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['required_changes'],
        message: 'must be empty when the decision is APPROVE',
      });
    }
  });

export type DirectorChange = z.infer<typeof DirectorChangeSchema>;
export type DirectorReview = z.infer<typeof DirectorSchema>;

export interface DirectorRuntimeConstraints {
  enabledPlatforms: string[];
  validAssetPlatformPairs: Array<{
    type: PlannedAsset['type'];
    platform: PlannedAsset['platform'];
  }>;
  maxAssets: number;
  creditBudget: number;
  maxVideoSeconds: number;
  planAlreadyValidated: true;
}

export interface DirectorInput {
  campaignId: string;
  strategyVersion: number;
  strategy: StrategyPlan;
  goal: string;
  audience: string | null;
  brandVoice: string | null;
  runtimeConstraints: DirectorRuntimeConstraints;
  /** Used only when a durable invalid review is being repaired after a crash. */
  previousViolations?: string[];
}

/** The fixed compatibility matrix is a runtime rule, not a prompt suggestion. */
export const VALID_ASSET_PLATFORM_PAIRS: readonly DirectorRuntimeConstraints['validAssetPlatformPairs'][number][] = [
  { type: 'short_video', platform: 'tiktok' },
  { type: 'x_thread', platform: 'x' },
  { type: 'linkedin_post', platform: 'linkedin' },
];

export function makeDirectorRuntimeConstraints(input: {
  platforms: string[];
  maxAssets: number;
  creditBudget: number;
  maxVideoSeconds: number;
}): DirectorRuntimeConstraints {
  return {
    enabledPlatforms: [...input.platforms],
    validAssetPlatformPairs: VALID_ASSET_PLATFORM_PAIRS.map((pair) => ({ ...pair })),
    maxAssets: input.maxAssets,
    creditBudget: input.creditBudget,
    maxVideoSeconds: input.maxVideoSeconds,
    planAlreadyValidated: true,
  };
}

/**
 * Validate the part of a Director review that TypeScript can know from the
 * campaign and the saved plan. The model can judge the objective; it cannot
 * invent a platform/type pair or target an asset that is not in this plan.
 */
export function validateDirectorChanges(
  changes: DirectorChange[],
  strategy: StrategyPlan,
  constraints: DirectorRuntimeConstraints,
): string[] {
  const assetsByKey = new Map(strategy.planned_assets.map((asset) => [asset.plan_key, asset]));
  const violations: string[] = [];

  for (const [index, change] of changes.entries()) {
    const label = `required_changes[${index}]`;
    if (change.field === 'portfolio_mix') continue;

    if (!change.plan_key) {
      violations.push(`${label} must target a plan_key for field ${change.field}`);
      continue;
    }

    const asset = assetsByKey.get(change.plan_key);
    if (!asset) {
      violations.push(`${label} targets unknown plan_key ${change.plan_key}`);
      continue;
    }

    if (change.field !== 'platform') continue;
    const targetPlatform = change.target_platform;
    if (!targetPlatform) {
      violations.push(`${label} must provide target_platform for a platform change`);
      continue;
    }
    if (!constraints.enabledPlatforms.includes(targetPlatform)) {
      violations.push(
        `${label} cannot move ${change.plan_key} to ${targetPlatform}: the campaign enables ${constraints.enabledPlatforms.join(', ') || 'no platforms'}`,
      );
    }
    const compatible = constraints.validAssetPlatformPairs.some(
      (pair) => pair.type === asset.type && pair.platform === targetPlatform,
    );
    if (!compatible) {
      violations.push(
        `${label} cannot move ${change.plan_key} (${asset.type}) to ${targetPlatform}: valid platform for ${asset.type} is ${validPlatformsFor(asset.type).join(', ')}`,
      );
    }
  }

  return violations;
}

/**
 * Apply the semantic Director retry boundary. Schema repair happens inside
 * `callStructured`; this separate boundary is for a schema-valid review whose
 * requested change violates a campaign/runtime relationship.
 */
export async function resolveDirectorReview(
  initialReview: DirectorReview,
  retry: (violations: string[]) => Promise<DirectorReview>,
  validate: (review: DirectorReview) => string[],
): Promise<DirectorReview> {
  let review = normalizeReview(initialReview);

  for (let attempt = 0; attempt < 2; attempt++) {
    const violations = validate(review);
    if (violations.length === 0) return review;
    if (attempt === 1) {
      throw new Error(
        `Content Director returned impossible changes after one retry: ${violations.join('; ')}`,
      );
    }
    review = normalizeReview(await retry(violations));
  }

  throw new Error('Content Director review retry did not resolve.');
}

function validPlatformsFor(type: PlannedAsset['type']): string[] {
  return VALID_ASSET_PLATFORM_PAIRS.filter((pair) => pair.type === type).map((pair) => pair.platform);
}

function renderRuntimeConstraints(constraints: DirectorRuntimeConstraints): string[] {
  return [
    'Runtime constraints (authoritative; do not ask the Strategist to violate them):',
    `- Enabled campaign platforms: ${constraints.enabledPlatforms.join(', ') || 'none'}`,
    `- Valid asset type/platform pairs: ${constraints.validAssetPlatformPairs.map((pair) => `${pair.type}/${pair.platform}`).join(', ')}`,
    `- Asset count: at most ${constraints.maxAssets}`,
    `- Credit budget: at most ${constraints.creditBudget}; fixed costs are ${Object.entries(CREDIT_COST).map(([type, cost]) => `${type}=${cost}`).join(', ')}`,
    `- Combined short-video duration: at most ${constraints.maxVideoSeconds} seconds; written assets consume none of this allowance`,
    '- The supplied plan has already passed runtime validation. Requested changes must preserve that validity.',
  ];
}

/**
 * Content Director. It reviews the plan against the external objective, then
 * TypeScript rejects impossible requested changes before the graph can charge a
 * planning revision. A malformed relationship gets one exact corrective retry.
 */
export async function reviewStrategy(input: DirectorInput): Promise<DirectorReview> {
  const reviewOnce = async (violations: string[]): Promise<DirectorReview> => {
    const result = await callStructured({
      campaignId: input.campaignId,
      agent: 'content_director',
      node: 'director_review_plan',
      role: 'reasoning',
      schema: DirectorSchema,
      schemaName: 'director_plan_review',
      schemaDescription: 'An objective-focused approval or rejection of one content campaign plan.',
      system: DIRECTOR_SYSTEM,
      prompt: [
        `Review strategy version ${input.strategyVersion}.`,
        '',
        ...renderRuntimeConstraints(input.runtimeConstraints),
        ...(violations.length
          ? [
              '',
              'Your previous requested changes were impossible under those runtime constraints:',
              ...violations.map((violation) => `- ${violation}`),
              'Return a corrected review now. This is the final retry.',
            ]
          : []),
        '',
        `Rationale: ${input.strategy.rationale}`,
        '',
        'Planned assets:',
        ...input.strategy.planned_assets.map(
          (asset) =>
            `- ${asset.plan_key}: ${asset.type} for ${asset.platform}. Topic: ${asset.topic}. Purpose: ${asset.purpose}. Source segments: ${asset.segment_ids.join(', ')}. Credits: ${asset.credits}.`,
        ),
        '',
        'Topics deliberately rejected:',
        ...input.strategy.rejected_topics.map((item) => `- ${item.topic}: ${item.reason}`),
        '',
        'For REJECT, return structured required_changes. Use plan_key for one-asset changes. Use field=portfolio_mix and plan_key=null for a portfolio-wide instruction. Use target_platform only when field=platform. Do not request a platform/type pair outside the valid matrix.',
        'Judge whether this portfolio will advance the stated objective for the stated audience. A plan can be coherent, varied, and still be the wrong plan. Reject only with concrete changes the Strategist can make.',
        'Audience and brand voice are optional campaign inputs. When either is marked not specified, infer the useful standard from the goal and judge the best plan possible from the information available. Never reject merely to ask the user to supply missing optional metadata.',
        '',
        describeObjective(input),
      ].join('\n'),
      input: {
        strategy_version: input.strategyVersion,
        planned_assets: input.strategy.planned_assets,
        rejected_topics: input.strategy.rejected_topics,
        runtime_constraints: input.runtimeConstraints,
        validation_failures_from_previous_attempt: violations,
      } as unknown as Json,
    });

    return normalizeReview(result.value);
  };

  const validate = (review: DirectorReview) =>
    validateDirectorChanges(review.required_changes, input.strategy, input.runtimeConstraints);

  return resolveDirectorReview(
    await reviewOnce(input.previousViolations ?? []),
    async (violations) => reviewOnce(violations),
    validate,
  );
}
function normalizeReview(review: DirectorReview): DirectorReview {
  return {
    decision: review.decision,
    reasoning: review.reasoning.trim(),
    required_changes:
      review.decision === 'REJECT'
        ? review.required_changes.map((change) => ({
            plan_key: change.plan_key?.trim() || null,
            field: change.field,
            instruction: change.instruction.trim(),
            target_platform: change.target_platform,
          }))
        : [],
  };
}

const DIRECTOR_SYSTEM = [
  'You are the Content Director. You approve or reject campaign plans, but never produce content.',
  'Your standard is the campaign objective and audience, not whether the plan sounds polished or internally consistent.',
  'Look for a portfolio with distinct jobs, credible source support, and an intentional platform mix. Reject a technically valid plan when it would fail the real objective.',
  'Runtime constraints are authoritative. Never request an impossible asset type/platform pair, a disabled platform, an unknown plan key, or a change that breaks the supplied plan validity.',
  'Audience and brand voice may be intentionally unspecified. Do not reject a plan merely to request optional campaign metadata, and do not ask for information the Strategist cannot obtain.',
].join('\n');

function describeObjective(input: Pick<DirectorInput, 'goal' | 'audience' | 'brandVoice'>): string {
  return [
    'This is the objective the plan must earn approval against.',
    `Goal: ${input.goal}`,
    input.audience ? `Audience: ${input.audience}` : 'Audience: not specified.',
    input.brandVoice ? `Brand voice: ${input.brandVoice}` : 'Brand voice: not specified.',
  ].join('\n');
}

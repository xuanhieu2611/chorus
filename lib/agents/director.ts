import { z } from 'zod';
import { callStructured } from '@/lib/llm/structured';
import type { Json } from '@/lib/db/database.types';
import type { StrategyPlan } from '@/lib/agents/strategist';

export const DirectorSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reasoning: z.string(),
    required_changes: z.array(z.string().trim().min(1)),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'REJECT' && value.required_changes.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['required_changes'],
        message: 'must name at least one concrete change when the decision is REJECT',
      });
    }
  });

export type DirectorReview = z.infer<typeof DirectorSchema>;

export interface DirectorInput {
  campaignId: string;
  strategyVersion: number;
  strategy: StrategyPlan;
  goal: string;
  audience: string | null;
  brandVoice: string | null;
}

/**
 * Content Director. Reviews the plan against the external objective rather than
 * praising its internal coherence. It never creates content and never controls
 * the edge: the node maps this judgement to a deterministic route.
 */
export async function reviewStrategy(input: DirectorInput): Promise<DirectorReview> {
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
      `Rationale: ${input.strategy.rationale}`,
      '',
      'Planned assets:',
      ...input.strategy.planned_assets.map(
        (asset) =>
          `- ${asset.plan_key}: ${asset.type} for ${asset.platform}. Topic: ${asset.topic}. Purpose: ${asset.purpose}. Source segments: ${asset.segment_ids.join(', ')}.`,
      ),
      '',
      'Topics deliberately rejected:',
      ...input.strategy.rejected_topics.map((item) => `- ${item.topic}: ${item.reason}`),
      '',
      'Judge whether this portfolio will advance the stated objective for the stated audience. A plan can be coherent, varied, and still be the wrong plan. Reject only with concrete changes the Strategist can make.',
      'Audience and brand voice are optional campaign inputs. When either is marked not specified, infer the useful standard from the goal and judge the best plan possible from the information available. Never reject merely to ask the user to supply missing optional metadata.',
      '',
      describeObjective(input),
    ].join('\n'),
    input: {
      strategy_version: input.strategyVersion,
      planned_assets: input.strategy.planned_assets,
      rejected_topics: input.strategy.rejected_topics,
    } as Json,
  });

  return {
    decision: result.value.decision,
    reasoning: result.value.reasoning.trim(),
    required_changes:
      result.value.decision === 'REJECT'
        ? result.value.required_changes.map((item) => item.trim()).filter(Boolean)
        : [],
  };
}

const DIRECTOR_SYSTEM = [
  'You are the Content Director. You approve or reject campaign plans, but never produce content.',
  'Your standard is the campaign objective and audience, not whether the plan sounds polished or internally consistent.',
  'Look for a portfolio with distinct jobs, credible source support, and an intentional platform mix. Reject a technically valid plan when it would fail the real objective.',
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

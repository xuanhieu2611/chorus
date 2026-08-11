import { z } from 'zod';
import type { Json } from '@/lib/db/database.types';
import { callStructured } from '@/lib/llm/structured';

const SCORE_FIELDS = ['hook', 'clarity', 'standalone', 'originality', 'audience_fit', 'payoff'] as const;

/**
 * The 1 to 10 range is enforced by `decideCritic`, not by the schema.
 *
 * `minimum`/`maximum` become JSON Schema keywords that some OpenRouter providers
 * reject outright: a reduce pass on `anthropic/claude-sonnet-4.5` routed to Azure
 * failed every attempt with "For 'number' type, properties maximum, minimum are
 * not supported", and one model id can be served by several providers. A bound
 * that decides a campaign's routing cannot depend on which one answered, so it
 * lives in code like every other decision here.
 */
export const CriticScoresSchema = z.object({
  hook: z.number(),
  clarity: z.number(),
  standalone: z.number(),
  originality: z.number(),
  audience_fit: z.number(),
  payoff: z.number(),
});

/** Hold a score inside 1 to 10; a non-finite score is treated as the floor. */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(10, Math.max(1, value));
}

/** The model supplies scores and actionable feedback. TypeScript owns the edge. */
export const CriticSchema = z.object({
  scores: CriticScoresSchema,
  feedback: z.string().trim().min(1),
});

export type CriticScores = z.infer<typeof CriticScoresSchema>;
export type CriticReview = z.infer<typeof CriticSchema>;
export type CriticDecision = 'PASS' | 'REVISE' | 'REJECT';

export interface CriticSource {
  id: string;
  startTime: number;
  endTime: number;
  transcript: string;
}

export interface CriticInput {
  campaignId: string;
  assetId: string;
  planKey: string;
  type: 'short_video' | 'x_thread' | 'linkedin_post';
  platform: 'tiktok' | 'x' | 'linkedin';
  hook: string | null;
  content: Json;
  sources: CriticSource[];
  /** Video inspection is part of the evidence; written assets leave this null. */
  inspection: Json | null;
  revisionIndex: number;
  goal: string;
  audience: string | null;
  brandVoice: string | null;
}

export interface CriticRouting {
  decision: CriticDecision;
  average: number;
  lowest: number;
}

/**
 * Judge one asset in isolation. The Critic is deliberately not shown the rest
 * of the campaign: portfolio overlap belongs to the Campaign Reviewer in the
 * next phase. It returns no decision because routing is a code invariant.
 */
export async function critiqueAsset(input: CriticInput): Promise<CriticReview> {
  const result = await callStructured({
    campaignId: input.campaignId,
    agent: 'content_critic',
    node: 'critique',
    role: 'reasoning',
    schema: CriticSchema,
    schemaName: 'content_critic_review',
    schemaDescription: 'Six 1-to-10 quality scores and specific revision feedback for one asset.',
    system: CRITIC_SYSTEM,
    prompt: [
      `Critique one ${input.type} asset for plan ${input.planKey}.`,
      `Platform: ${input.platform}`,
      `Revision index: ${input.revisionIndex}. A revision index of 0 is the first attempt.`,
      '',
      'Do not compare this asset with any other campaign asset. Judge it on its own merits against the objective and audience.',
      'Score each dimension from 1 to 10:',
      '- hook: how quickly and compellingly it earns attention',
      '- clarity: whether the idea is easy to understand',
      '- standalone: whether it works for someone with no episode context',
      '- originality: whether the angle avoids generic repurposing language',
      '- audience_fit: whether it serves the stated audience and growth objective',
      '- payoff: whether the ending delivers a useful or satisfying point',
      '',
      'Asset hook:',
      input.hook ?? '(none)',
      '',
      'Asset content:',
      JSON.stringify(input.content, null, 2),
      '',
      input.inspection
        ? ['Draft inspection evidence:', JSON.stringify(input.inspection, null, 2), ''].join('\n')
        : '',
      'Verbatim source evidence:',
      ...input.sources.map(
        (source) =>
          `<source id="${source.id}" time="${source.startTime.toFixed(1)}-${source.endTime.toFixed(1)}s">\n${source.transcript}\n</source>`,
      ),
      '',
      'Feedback must be an actionable fix, not a vague verdict. Name the exact element to change and what to do instead. For example: “The strongest line lands nine seconds in; open with that line and cut the setup.”',
      'Return only scores and feedback. Do not return PASS, REVISE, or REJECT; the runtime calculates that decision.',
      '',
      describeObjective(input),
    ].join('\n'),
    input: {
      asset_id: input.assetId,
      plan_key: input.planKey,
      type: input.type,
      platform: input.platform,
      source_segment_ids: input.sources.map((source) => source.id),
      revision_index: input.revisionIndex,
      content: input.content,
      inspection: input.inspection,
    } as Json,
  });

  return {
    scores: result.value.scores,
    feedback: result.value.feedback.trim(),
  };
}

/**
 * Deterministic Critic routing. These thresholds intentionally live outside the
 * prompt so the same scores always take the same graph edge.
 */
export function decideCritic(scores: CriticScores): CriticRouting {
  const values = SCORE_FIELDS.map((field) => clampScore(scores[field]));
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const lowest = Math.min(...values);

  let decision: CriticDecision;
  if (lowest <= 3) decision = 'REJECT';
  else if (average >= 7 && lowest >= 5) decision = 'PASS';
  else decision = 'REVISE';

  return {
    decision,
    average: roundScore(average),
    lowest: roundScore(lowest),
  };
}

/** Alias with a verb that reads well at graph call sites and in tests. */
export const routeCritic = decideCritic;

function describeObjective(input: Pick<CriticInput, 'goal' | 'audience' | 'brandVoice'>): string {
  return [
    'Optimize this judgement against the campaign objective.',
    `Goal: ${input.goal}`,
    input.audience ? `Audience: ${input.audience}` : 'Audience: not specified.',
    input.brandVoice ? `Brand voice: ${input.brandVoice}` : 'Brand voice: not specified.',
  ].join('\n');
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

const CRITIC_SYSTEM = [
  'You are the Content Critic for a podcast growth campaign.',
  'Judge one finished asset independently and explain the smallest concrete change that would improve it.',
  'Use the supplied transcript as evidence. Do not invent source facts, and do not let polished wording hide a weak idea or missing payoff.',
  'Your feedback is handed directly to the producer for regeneration, so it must name an observable problem and an actionable fix.',
].join('\n');

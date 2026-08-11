import { z } from 'zod';
import type { Json } from '@/lib/db/database.types';
import { callStructured } from '@/lib/llm/structured';

const SCORE_FIELDS = ['hook', 'clarity', 'standalone', 'originality', 'audience_fit', 'payoff'] as const;

const REQUIRED_CHECK_FIELDS = [
  'brief_compliant',
  'source_supported',
  'standalone',
  'payoff_delivered',
] as const;

export const GroundingClaimSchema = z.object({
  claim: z.string().trim().min(1),
  source_quote: z.string().trim().min(1),
});

export const GroundingAuditRowSchema = z.object({
  claim: z.string().trim().min(1),
  supported: z.boolean(),
  overstates_source: z.boolean(),
  reason: z.string().trim().min(1),
});

export const GroundingAuditSchema = z.array(GroundingAuditRowSchema);

export const CriticRequiredChecksSchema = z.object({
  brief_compliant: z.boolean(),
  source_supported: z.boolean(),
  standalone: z.boolean(),
  payoff_delivered: z.boolean(),
});

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

/** The model supplies scores and observable checks. TypeScript owns the edge. */
export const CriticSchema = z.object({
  scores: CriticScoresSchema,
  required_checks: CriticRequiredChecksSchema,
  grounding_audit: GroundingAuditSchema,
  blocking_feedback: z.string().trim().min(1).nullable(),
  polish_feedback: z.string().trim().min(1).nullable(),
  /** Structural hook for direct source contradictions that a local wording change cannot repair. */
  materially_contradicted: z.boolean().default(false),
});

export type GroundingClaim = z.infer<typeof GroundingClaimSchema>;
export type GroundingAuditRow = z.infer<typeof GroundingAuditRowSchema>;
export type CriticScores = z.infer<typeof CriticScoresSchema>;
export type CriticRequiredChecks = z.infer<typeof CriticRequiredChecksSchema>;
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
  /** The complete grounding array submitted with the written asset. */
  grounding: GroundingClaim[];
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
  requiredChecks: CriticRequiredChecks;
  failedChecks: Array<keyof CriticRequiredChecks>;
  groundingAuditPassed: boolean;
  groundingAuditFailures: string[];
  materiallyContradicted: boolean;
  blockingFeedbackPresent: boolean;
}

export interface GroundingAuditValidation {
  passed: boolean;
  failures: string[];
  unsupportedClaims: string[];
  overstatedClaims: string[];
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
    schemaDescription:
      'Six 1-to-10 quality scores, four observable shipping checks, one exact grounding audit row per submitted claim, and split blocking versus optional polish feedback for one asset.',
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
      'Required shipping checks. Judge these as observable pass/fail criteria, not as an overall impression:',
      '- brief_compliant: the asset follows every explicit campaign instruction and prohibition, including the planned platform, format, topic, purpose, and voice.',
      '- source_supported: every factual or causal claim is entailed by the supplied source evidence without stronger certainty, invented detail, or unsupported causality. The structured grounding audit below is part of this check.',
      '- standalone: a person who did not hear the episode can understand the subject, claim, and conclusion without unexplained pronouns, references, or missing context.',
      '- payoff_delivered: the asset itself delivers the promised point or takeaway. For video, the spoken words and burned-in captions inside the rendered video must deliver it; captions or context outside the video do not count.',
      'Return false for any unresolved required check, even when the scores are high.',
      'Set materially_contradicted true only when the asset directly conflicts with the supplied source in a way that a local wording revision cannot safely repair. A merely unsupported or overstated claim should set source_supported false and materially_contradicted false.',
      '',
      input.type === 'short_video'
        ? [
            'Video inspection checklist. Inspect and report each item separately before setting the required checks:',
            '- opening_words: inspect the first spoken words of the rendered clip and whether they begin the promised idea quickly.',
            '- final_spoken_sentence: inspect the final spoken sentence and whether it completes the point rather than cutting into setup or ending abruptly.',
            '- hook_overlay: inspect the hook overlay text for legibility, truthfulness, fit with the opening words, and whether it promises the delivered payoff.',
            '- inspection_result: inspect every supplied render-inspection field, including hook latency, dead air, abrupt ending, sampled-frame result, and any suggested boundary adjustment.',
            '- end_card: inspect any end card if one exists. If none exists, explicitly treat it as absent rather than inventing one; an end card cannot supply a missing payoff.',
          ].join('\n')
        : [
            'Written-asset audit checklist:',
            '- Audit every factual or causal claim against its paired grounding quote and the full supplied source excerpt.',
            '- Audit concrete examples derived from those claims as well, not only the headline claim.',
            '- Exact quote presence is necessary but does not by itself prove that the claim is supported; flag stronger certainty or causal language.',
          ].join('\n'),
      '',
      'Asset hook:',
      input.hook ?? '(none)',
      '',
      'Asset content:',
      JSON.stringify(input.content, null, 2),
      '',
      'Complete submitted grounding array. Audit every row exactly once. Copy each claim into one grounding_audit row exactly as submitted; do not omit, merge, duplicate, or invent claims:',
      JSON.stringify(input.grounding, null, 2),
      'For each grounding_audit row, set supported=false when the claim is not entailed by its source quote and the full source excerpt. Set overstates_source=true when the claim is stronger, more certain, more causal, more diagnostic, or more categorical than the source. A faithful paraphrase can be supported=true and overstates_source=false.',
      'If the submitted grounding array is empty, return grounding_audit as an empty array.',
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
      'Feedback must be split into two fields:',
      '- blocking_feedback: null only when there is no required correction preventing shipment and the asset is otherwise eligible to PASS. Otherwise name the exact element to change and what to do instead. This is the only feedback sent into regeneration.',
      '- polish_feedback: optional minor improvements that do not block shipment. Keep it null when there is no useful polish note. Polish feedback never causes regeneration.',
      'Return only scores, required_checks, grounding_audit, materially_contradicted, blocking_feedback, and polish_feedback. Do not return PASS, REVISE, or REJECT; the runtime calculates that decision.',
      '',
      describeObjective(input),
    ].join('\n'),
    input: {
      asset_id: input.assetId,
      plan_key: input.planKey,
      type: input.type,
      platform: input.platform,
      source_segment_ids: input.sources.map((source) => source.id),
      grounding: input.grounding,
      revision_index: input.revisionIndex,
      content: input.content,
      inspection: input.inspection,
    } as Json,
  });

  return {
    scores: result.value.scores,
    required_checks: result.value.required_checks,
    grounding_audit: result.value.grounding_audit,
    blocking_feedback: result.value.blocking_feedback?.trim() ?? null,
    polish_feedback: result.value.polish_feedback?.trim() ?? null,
    materially_contradicted: result.value.materially_contradicted,
  };
}

/**
 * Deterministic Critic routing. These thresholds intentionally live outside the
 * prompt so the same scores always take the same graph edge.
 */
export function decideCritic(
  input: CriticScores | CriticReview,
  groundingClaims?: readonly GroundingClaim[],
): CriticRouting {
  const review = isCriticReview(input) ? input : legacyScoresAsReview(input);
  const values = SCORE_FIELDS.map((field) => clampScore(review.scores[field]));
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const lowest = Math.min(...values);
  const groundingAudit = groundingClaims
    ? validateGroundingAudit(groundingClaims, review.grounding_audit)
    : null;
  const requiredChecks = groundingAudit
    ? {
        ...review.required_checks,
        source_supported: review.required_checks.source_supported && groundingAudit.passed,
      }
    : review.required_checks;
  const failedChecks = REQUIRED_CHECK_FIELDS.filter((field) => !requiredChecks[field]);
  const materiallyContradicted = review.materially_contradicted;
  const blockingFeedbackPresent = review.blocking_feedback !== null;

  let decision: CriticDecision;
  if (lowest <= 3 || materiallyContradicted) decision = 'REJECT';
  else if (failedChecks.length > 0) decision = 'REVISE';
  else if (average >= 7 && lowest >= 5 && !blockingFeedbackPresent) decision = 'PASS';
  else decision = 'REVISE';

  return {
    decision,
    average: roundScore(average),
    lowest: roundScore(lowest),
    requiredChecks,
    failedChecks,
    groundingAuditPassed: groundingAudit?.passed ?? true,
    groundingAuditFailures: groundingAudit?.failures ?? [],
    materiallyContradicted,
    blockingFeedbackPresent,
  };
}

/** Apply the semantic audit result to the authoritative source check. */
export function enforceGroundingAudit(
  review: CriticReview,
  groundingClaims: readonly GroundingClaim[],
): { review: CriticReview; validation: GroundingAuditValidation } {
  const validation = validateGroundingAudit(groundingClaims, review.grounding_audit);
  if (validation.passed) return { review, validation };

  return {
    review: {
      ...review,
      required_checks: {
        ...review.required_checks,
        source_supported: false,
      },
    },
    validation,
  };
}

/**
 * Verify the model audited every submitted claim exactly once, then apply the
 * model's semantic judgement. Claim identity ignores only case and whitespace
 * so harmless formatting changes cannot hide omissions or duplicates.
 */
export function validateGroundingAudit(
  groundingClaims: readonly GroundingClaim[],
  audit: readonly GroundingAuditRow[],
): GroundingAuditValidation {
  const expectedCounts = new Map<string, { claim: string; count: number }>();
  for (const grounding of groundingClaims) {
    const key = normalizeClaim(grounding.claim);
    const current = expectedCounts.get(key);
    expectedCounts.set(key, {
      claim: current?.claim ?? grounding.claim,
      count: (current?.count ?? 0) + 1,
    });
  }

  const auditCounts = new Map<string, { claim: string; count: number }>();
  for (const row of audit) {
    const key = normalizeClaim(row.claim);
    const current = auditCounts.get(key);
    auditCounts.set(key, {
      claim: current?.claim ?? row.claim,
      count: (current?.count ?? 0) + 1,
    });
  }

  const failures: string[] = [];
  for (const [key, expected] of expectedCounts) {
    const actual = auditCounts.get(key)?.count ?? 0;
    if (actual === 0) {
      failures.push(`Missing grounding audit row for claim "${truncate(expected.claim, 120)}".`);
    } else if (actual !== expected.count) {
      failures.push(
        `Grounding audit claim "${truncate(expected.claim, 120)}" appears ${actual} times; expected exactly ${expected.count}.`,
      );
    }
  }

  for (const [key, actual] of auditCounts) {
    if (!expectedCounts.has(key)) {
      failures.push(`Extra grounding audit row for claim "${truncate(actual.claim, 120)}".`);
    }
  }

  const unsupportedClaims = uniqueClaims(
    audit.filter((row) => !row.supported).map((row) => row.claim),
  );
  const overstatedClaims = uniqueClaims(
    audit.filter((row) => row.overstates_source).map((row) => row.claim),
  );
  for (const claim of unsupportedClaims) {
    const row = audit.find((candidate) => normalizeClaim(candidate.claim) === normalizeClaim(claim));
    failures.push(`Unsupported grounding claim "${truncate(claim, 120)}": ${row?.reason ?? 'no reason supplied'}`);
  }
  for (const claim of overstatedClaims) {
    const row = audit.find((candidate) => normalizeClaim(candidate.claim) === normalizeClaim(claim));
    failures.push(`Overstated grounding claim "${truncate(claim, 120)}": ${row?.reason ?? 'no reason supplied'}`);
  }

  return {
    passed: failures.length === 0,
    failures,
    unsupportedClaims,
    overstatedClaims,
  };
}

/** Extract the Writer's grounding array from durable asset content. */
export function extractGroundingClaims(content: Json): GroundingClaim[] {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return [];
  const grounding = (content as Record<string, Json | undefined>).grounding;
  if (!Array.isArray(grounding)) return [];
  return grounding.flatMap((candidate) => {
    const parsed = GroundingClaimSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Alias with a verb that reads well at graph call sites and in tests. */
export const routeCritic = decideCritic;

/** Apply the existing per-asset revision guardrail after Critic routing. */
export function criticRevisionOutcome(
  decision: CriticDecision,
  revisionCount: number,
  maxRevisions: number,
): CriticDecision | 'ABANDON' {
  if (decision !== 'REVISE') return decision;
  return revisionCount < maxRevisions ? 'REVISE' : 'ABANDON';
}

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

function normalizeClaim(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function uniqueClaims(claims: string[]): string[] {
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const key = normalizeClaim(claim);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function isCriticReview(value: CriticScores | CriticReview): value is CriticReview {
  return 'scores' in value;
}

function legacyScoresAsReview(scores: CriticScores): CriticReview {
  return {
    scores,
    required_checks: {
      brief_compliant: true,
      source_supported: true,
      standalone: true,
      payoff_delivered: true,
    },
    grounding_audit: [],
    blocking_feedback: null,
    polish_feedback: null,
    materially_contradicted: false,
  };
}

const CRITIC_SYSTEM = [
  'You are the Content Critic for a podcast growth campaign.',
  'Judge one finished asset independently and explain the smallest concrete change that would improve it.',
  'Use the supplied transcript as evidence. Do not invent source facts, and do not let polished wording hide a weak idea or missing payoff.',
  'Treat the submitted grounding array as a complete list of factual claims. Audit every row exactly once and distinguish faithful paraphrase from stronger causal, diagnostic, or categorical language.',
  'Separate shipment-blocking defects from optional polish. Only shipment-blocking feedback is handed directly to the producer for regeneration.',
].join('\n');

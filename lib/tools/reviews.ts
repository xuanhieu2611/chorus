import { db, type CampaignReviewRow, type ReviewRow } from '@/lib/db/client';
import {
  CampaignReviewSchema,
  type CampaignReview,
} from '@/lib/agents/campaign-reviewer';
import {
  CriticSchema,
  type CriticDecision,
  type CriticReview,
  type CriticScores,
} from '@/lib/agents/critic';
import {
  AlternativeSchema,
  StrategySchema,
  type AlternativeSelection,
  type StrategyPlan,
} from '@/lib/agents/strategist';
import type { Json } from '@/lib/db/database.types';

export interface RecordReviewInput {
  campaignId: string;
  scores: CriticScores;
  feedback: string;
  decision: CriticDecision;
  revisionIndex: number;
}

export async function getCampaignReview(
  campaignId: string,
  version: number,
): Promise<CampaignReviewRow | null> {
  const { data, error } = await db()
    .from('campaign_reviews')
    .select('*')
    .eq('campaign_id', campaignId)
    .eq('version', version)
    .maybeSingle();

  if (error) throw new Error(`Failed to read Campaign Reviewer review: ${error.message}`);
  return data;
}

export async function getLatestCampaignReview(campaignId: string): Promise<CampaignReviewRow | null> {
  const { data, error } = await db()
    .from('campaign_reviews')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to read latest Campaign Reviewer review: ${error.message}`);
  return data;
}

/** Read the paid Campaign Reviewer decision if the worker died before saving its row. */
export async function getCampaignReviewRun(
  campaignId: string,
  strategyVersion: number,
): Promise<{ review: CampaignReview; createdAt: string } | null> {
  const { data, error } = await db()
    .from('agent_runs')
    .select('input, output, finished_at, started_at')
    .eq('campaign_id', campaignId)
    .eq('agent', 'campaign_reviewer')
    .eq('node', 'campaign_review')
    .eq('status', 'succeeded')
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) throw new Error(`Failed to read Campaign Reviewer history: ${error.message}`);

  for (const run of data ?? []) {
    const input = objectOf(run.input);
    if (input?.strategy_version !== strategyVersion) continue;
    const parsed = CampaignReviewSchema.safeParse(run.output);
    if (parsed.success) {
      return { review: parsed.data, createdAt: run.finished_at ?? run.started_at };
    }
  }
  return null;
}

/** Read a paid replan if the worker died after the Strategist call. */
export async function getReplanRun(
  campaignId: string,
  fromStrategyVersion: number,
  targetStrategyVersion: number,
): Promise<{ plan: StrategyPlan; createdAt: string } | null> {
  const { data, error } = await db()
    .from('agent_runs')
    .select('input, output, finished_at, started_at')
    .eq('campaign_id', campaignId)
    .eq('agent', 'content_strategist')
    .eq('node', 'replan')
    .eq('status', 'succeeded')
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) throw new Error(`Failed to read replan history: ${error.message}`);

  for (const run of data ?? []) {
    const input = objectOf(run.input);
    if (
      input?.from_strategy_version !== fromStrategyVersion ||
      input.target_strategy_version !== targetStrategyVersion
    ) {
      continue;
    }
    const parsed = StrategySchema.safeParse(run.output);
    if (parsed.success) {
      return { plan: parsed.data, createdAt: run.finished_at ?? run.started_at };
    }
  }
  return null;
}

/** Record one Campaign Reviewer result per strategy version. */
export async function recordCampaignReview(
  campaignId: string,
  version: number,
  review: CampaignReview,
): Promise<CampaignReviewRow> {
  const { data, error } = await db()
    .from('campaign_reviews')
    .upsert(
      {
        campaign_id: campaignId,
        version,
        scores: review.scores as Json,
        problems: review.problems as Json,
        recommendations: review.recommendations as Json,
        decision: review.decision,
      },
      { onConflict: 'campaign_id,version' },
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to record Campaign Reviewer review: ${error.message}`);
  return data;
}

export async function getFinalApprovalFeedback(
  campaignId: string,
  reviewVersion: number,
): Promise<string | null> {
  const { data, error } = await db()
    .from('agent_events')
    .select('data')
    .eq('campaign_id', campaignId)
    .eq('agent', 'human')
    .eq('node', 'await_final_approval')
    .eq('message', 'Final campaign changes requested.')
    .order('id', { ascending: false })
    .limit(20);

  if (error) throw new Error(`Failed to read final approval feedback: ${error.message}`);
  for (const event of data ?? []) {
    const value = objectOf(event.data);
    if (value?.review_version !== reviewVersion) continue;
    const feedback = value.feedback;
    if (typeof feedback === 'string' && feedback.trim()) return feedback.trim();
  }
  return null;
}

/** The most recent durable judgement for an asset. */
export async function getLatestReview(assetId: string): Promise<ReviewRow | null> {
  const { data, error } = await db()
    .from('reviews')
    .select('*')
    .eq('asset_id', assetId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to read review for asset ${assetId}: ${error.message}`);
  return data;
}

/**
 * If a worker dies after the Critic call but before its review row is written,
 * the successful agent_run is still enough to resume without buying the same
 * judgement again.
 */
export async function getCriticRun(
  campaignId: string,
  assetId: string,
  revisionIndex: number,
): Promise<{ review: CriticReview; createdAt: string } | null> {
  const { data, error } = await db()
    .from('agent_runs')
    .select('input, output, finished_at, started_at')
    .eq('campaign_id', campaignId)
    .eq('agent', 'content_critic')
    .eq('node', 'critique')
    .eq('status', 'succeeded')
    .order('started_at', { ascending: false })
    .limit(50);

  if (error) throw new Error(`Failed to read Critic history: ${error.message}`);

  for (const run of data ?? []) {
    const input = objectOf(run.input);
    if (input?.asset_id !== assetId || input.revision_index !== revisionIndex) continue;
    const parsed = CriticSchema.safeParse(run.output);
    if (parsed.success) {
      return { review: parsed.data, createdAt: run.finished_at ?? run.started_at };
    }
  }
  return null;
}

/** Reuse a paid alternative selection if the worker died before the plan update. */
export async function getAlternativeRun(
  campaignId: string,
  planKey: string,
): Promise<AlternativeSelection | null> {
  const { data, error } = await db()
    .from('agent_runs')
    .select('input, output')
    .eq('campaign_id', campaignId)
    .eq('agent', 'content_strategist')
    .eq('node', 'select_alternative')
    .eq('status', 'succeeded')
    .order('started_at', { ascending: false })
    .limit(50);

  if (error) throw new Error(`Failed to read alternative selection history: ${error.message}`);

  for (const run of data ?? []) {
    const input = objectOf(run.input);
    if (input?.plan_key !== planKey) continue;
    const parsed = AlternativeSchema.safeParse(run.output);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** Insert one review, reusing a row if a graph retry already recorded it. */
export async function recordReview(
  assetId: string,
  input: RecordReviewInput,
): Promise<ReviewRow> {
  const { data: existing, error: existingError } = await db()
    .from('reviews')
    .select('*')
    .eq('asset_id', assetId)
    .eq('revision_index', input.revisionIndex)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingError) throw new Error(`Failed to check existing review: ${existingError.message}`);
  if (existing) return existing;

  const { data, error } = await db()
    .from('reviews')
    .upsert(
      {
        asset_id: assetId,
        campaign_id: input.campaignId,
        reviewer_agent: 'content_critic',
        scores: input.scores as Json,
        feedback: input.feedback,
        decision: input.decision,
        revision_index: input.revisionIndex,
      },
      { onConflict: 'asset_id,revision_index' },
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to record Critic review: ${error.message}`);
  return data;
}

function objectOf(value: Json | null): Record<string, Json | undefined> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json | undefined>)
    : null;
}

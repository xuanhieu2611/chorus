import { db, type ReviewRow } from '@/lib/db/client';
import {
  CriticSchema,
  type CriticDecision,
  type CriticReview,
  type CriticScores,
} from '@/lib/agents/critic';
import { AlternativeSchema, type AlternativeSelection } from '@/lib/agents/strategist';
import type { Json } from '@/lib/db/database.types';

export interface RecordReviewInput {
  campaignId: string;
  scores: CriticScores;
  feedback: string;
  decision: CriticDecision;
  revisionIndex: number;
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
    .insert({
      asset_id: assetId,
      campaign_id: input.campaignId,
      reviewer_agent: 'content_critic',
      scores: input.scores as Json,
      feedback: input.feedback,
      decision: input.decision,
      revision_index: input.revisionIndex,
    })
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

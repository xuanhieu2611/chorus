import { db, type StrategyRow } from '@/lib/db/client';
import { DirectorSchema, type DirectorReview } from '@/lib/agents/director';
import {
  StrategySchema,
  type PlannedAsset,
  type StrategyPlan,
} from '@/lib/agents/strategist';
import type { Json } from '@/lib/db/database.types';

export interface RevisionRequest {
  source: 'content_director' | 'human';
  requiredChanges: string[];
  createdAt: string;
}

export async function getLatestStrategy(campaignId: string): Promise<StrategyRow | null> {
  const { data, error } = await db()
    .from('strategies')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to read strategy: ${error.message}`);
  return data;
}

export async function saveStrategy(
  campaignId: string,
  version: number,
  plan: StrategyPlan,
): Promise<StrategyRow> {
  const selectedTopics = plan.planned_assets.map((asset) => ({
    topic: asset.topic,
    segment_ids: asset.segment_ids,
    plan_key: asset.plan_key,
  }));

  const { data, error } = await db()
    .from('strategies')
    .insert({
      campaign_id: campaignId,
      version,
      rationale: plan.rationale,
      selected_topics: selectedTopics as Json,
      rejected_topics: plan.rejected_topics as Json,
      planned_assets: plan.planned_assets as Json,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to save strategy v${version}: ${error.message}`);
  return data;
}

export function planFromStrategy(row: StrategyRow): StrategyPlan {
  const parsed = StrategySchema.safeParse({
    rationale: row.rationale,
    planned_assets: row.planned_assets,
    rejected_topics: row.rejected_topics,
  });
  if (!parsed.success) {
    throw new Error(`Strategy v${row.version} in the database is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Replace one rejected plan entry while preserving its asset row and reviews. */
export async function replacePlannedAsset(
  strategy: StrategyRow,
  oldPlanKey: string,
  replacement: PlannedAsset,
): Promise<StrategyRow> {
  const plan = planFromStrategy(strategy);
  const index = plan.planned_assets.findIndex((asset) => asset.plan_key === oldPlanKey);
  if (index < 0) throw new Error(`Strategy v${strategy.version} has no ${oldPlanKey} to replace.`);
  if (plan.planned_assets.some((asset) => asset.plan_key === replacement.plan_key)) {
    throw new Error(`Strategy v${strategy.version} already contains ${replacement.plan_key}.`);
  }

  const plannedAssets = plan.planned_assets.map((asset, assetIndex) =>
    assetIndex === index ? replacement : asset,
  );
  const selectedTopics = plannedAssets.map((asset) => ({
    topic: asset.topic,
    segment_ids: asset.segment_ids,
    plan_key: asset.plan_key,
  }));

  const { data, error } = await db()
    .from('strategies')
    .update({
      planned_assets: plannedAssets as Json,
      selected_topics: selectedTopics as Json,
    })
    .eq('id', strategy.id)
    .select()
    .single();

  if (error) throw new Error(`Failed to save alternative plan for ${oldPlanKey}: ${error.message}`);
  return data;
}

export async function markStrategyApproved(
  strategyId: string,
  approvedBy: 'director' | 'human',
): Promise<void> {
  const { error } = await db()
    .from('strategies')
    .update({ approved_by: approvedBy })
    .eq('id', strategyId);
  if (error) throw new Error(`Failed to approve strategy: ${error.message}`);
}

/** The Director's successful structured output is durable graph memory. Looking
 * it up makes a crash after the paid review idempotent instead of paying again. */
export async function getDirectorReview(
  campaignId: string,
  strategy: StrategyRow,
): Promise<{ review: DirectorReview; createdAt: string } | null> {
  const { data, error } = await db()
    .from('agent_runs')
    .select('input, output, finished_at, started_at')
    .eq('campaign_id', campaignId)
    .eq('agent', 'content_director')
    .eq('node', 'director_review_plan')
    .eq('status', 'succeeded')
    .order('started_at', { ascending: false })
    .limit(20);

  if (error) throw new Error(`Failed to read Director review: ${error.message}`);

  for (const run of data ?? []) {
    if (strategyVersionOf(run.input) !== strategy.version) continue;
    const parsed = DirectorSchema.safeParse(run.output);
    if (parsed.success) {
      return { review: parsed.data, createdAt: run.finished_at ?? run.started_at };
    }
  }
  return null;
}

/** Returns the feedback that caused the latest strategy to be reopened. Director
 * feedback lives in its structured run; human feedback lives in the event that
 * the approval route writes before requeueing the campaign. */
export async function getRevisionRequest(
  campaignId: string,
  strategy: StrategyRow,
): Promise<RevisionRequest | null> {
  const [director, humanResult] = await Promise.all([
    getDirectorReview(campaignId, strategy),
    db()
      .from('agent_events')
      .select('data, created_at')
      .eq('campaign_id', campaignId)
      .eq('agent', 'human')
      .eq('node', 'await_strategy_approval')
      .eq('message', 'Strategy changes requested.')
      .order('id', { ascending: false })
      .limit(20),
  ]);

  if (humanResult.error) {
    throw new Error(`Failed to read human strategy feedback: ${humanResult.error.message}`);
  }

  const candidates: RevisionRequest[] = [];
  if (director?.review.decision === 'REJECT') {
    candidates.push({
      source: 'content_director',
      requiredChanges: director.review.required_changes,
      createdAt: director.createdAt,
    });
  }

  for (const event of humanResult.data ?? []) {
    const data = objectOf(event.data);
    if (data?.strategy_id !== strategy.id) continue;
    const feedback = typeof data.feedback === 'string' ? data.feedback.trim() : '';
    if (feedback) {
      candidates.push({ source: 'human', requiredChanges: [feedback], createdAt: event.created_at });
      break;
    }
  }

  return candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

function strategyVersionOf(value: Json | null): number | null {
  const object = objectOf(value);
  return typeof object?.strategy_version === 'number' ? object.strategy_version : null;
}

function objectOf(value: Json | null): Record<string, Json | undefined> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json | undefined>)
    : null;
}

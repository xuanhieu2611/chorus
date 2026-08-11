import { db } from '@/lib/db/client';
import type { Json } from '@/lib/db/database.types';
import type { TransitionKind } from '@/lib/transition-budget';

export interface ChargeTransitionInput {
  campaignId: string;
  strategyVersion: number;
  transitionKind: TransitionKind;
  maxCount: number;
}

export interface ChargeTransitionResult {
  charged: boolean;
  planRevisionCount: number;
  portfolioReplanCount: number;
  budgetExhausted: boolean;
  transitionId: string | null;
}

/**
 * Charge one graph transition through the database idempotency boundary. The
 * unique key is campaign + strategy version + transition kind, so a worker or
 * approval-route retry can safely ask again after an uncertain response.
 */
export async function chargeCampaignTransition(
  input: ChargeTransitionInput,
): Promise<ChargeTransitionResult> {
  const { data, error } = await (db() as unknown as {
    rpc(
      functionName: string,
      args: Record<string, unknown>,
    ): Promise<{ data: unknown; error: { message: string } | null }>;
  }).rpc('charge_campaign_transition', {
    p_campaign_id: input.campaignId,
    p_strategy_version: input.strategyVersion,
    p_transition_kind: input.transitionKind,
    p_max_count: input.maxCount,
  });

  if (error) throw new Error(`Failed to charge ${input.transitionKind}: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') {
    throw new Error(`Transition charge for ${input.transitionKind} returned no row.`);
  }

  const value = row as Record<string, Json | undefined>;
  if (
    typeof value.charged !== 'boolean' ||
    typeof value.plan_revision_count !== 'number' ||
    typeof value.portfolio_replan_count !== 'number' ||
    typeof value.budget_exhausted !== 'boolean' ||
    (typeof value.transition_id !== 'string' && value.transition_id !== null)
  ) {
    throw new Error(`Transition charge for ${input.transitionKind} returned an invalid row.`);
  }

  return {
    charged: value.charged,
    planRevisionCount: value.plan_revision_count,
    portfolioReplanCount: value.portfolio_replan_count,
    budgetExhausted: value.budget_exhausted,
    transitionId: value.transition_id,
  };
}

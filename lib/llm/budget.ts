import { db } from '@/lib/db/client';
import { env } from '@/lib/env';
import { emit } from '@/lib/events';
import { providerForModel } from '@/lib/llm/client';
import { computeAnthropicCostUsd } from '@/lib/llm/pricing';

/**
 * Real-money accounting. Distinct from campaign *credits*, which are a fictional
 * planning currency the Strategist trades off (MVP section 10).
 *
 * This exists before any agent does, on purpose: it is the protection against a
 * loop bug quietly spending forty dollars overnight.
 */
export class CostCeilingExceededError extends Error {
  constructor(
    readonly campaignId: string,
    readonly totalUsd: number,
    readonly ceilingUsd: number,
  ) {
    super(
      `Campaign ${campaignId} spent $${totalUsd.toFixed(4)}, over the $${ceilingUsd.toFixed(2)} ceiling.`,
    );
    this.name = 'CostCeilingExceededError';
  }
}

export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Pull the generation cost out of an AI SDK result.
 *
 * OpenRouter reports true cost in provider metadata when `usage.include` is set
 * (see `lib/llm/client.ts`). The shape is not part of the AI SDK's typed surface
 * and has moved between provider versions, so this probes a few known paths and
 * returns null rather than inventing a number. A null means "unknown", which the
 * caller records as a warning instead of as $0.
 */
export function extractCostUsd(providerMetadata: unknown): number | null {
  const openrouter = (providerMetadata as Record<string, unknown> | undefined)?.openrouter as
    | Record<string, unknown>
    | undefined;
  if (!openrouter) return null;

  const candidates: unknown[] = [
    openrouter.cost,
    (openrouter.usage as Record<string, unknown> | undefined)?.cost,
    (openrouter.usage as Record<string, unknown> | undefined)?.total_cost,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

/**
 * What a call cost, whichever provider served it.
 *
 * The two providers answer the question differently and neither answer
 * generalises: OpenRouter returns real dollars on the response, Anthropic
 * returns tokens that have to be priced locally. Routing on the model id keeps
 * that split in one place, so `chargeCampaign` and the ceiling above it never
 * learn which provider ran the call.
 *
 * A null means "unknown", which the caller records as a warning rather than $0.
 */
export function resolveCostUsd(modelId: string, providerMetadata: unknown): number | null {
  return providerForModel(modelId) === 'anthropic'
    ? computeAnthropicCostUsd(modelId, providerMetadata)
    : extractCostUsd(providerMetadata);
}

/**
 * Charge a campaign and enforce the ceiling.
 *
 * The increment happens in Postgres (`add_campaign_cost`) so two concurrent calls
 * cannot both read a stale total and slip past the limit together.
 */
export async function chargeCampaign(
  campaignId: string,
  costUsd: number | null,
  context: { agent: string; node?: string | null; model?: string },
): Promise<number> {
  if (costUsd === null) {
    await emit({
      campaignId,
      agent: context.agent,
      node: context.node ?? null,
      level: 'warn',
      message: `No cost could be determined for ${context.model ?? 'model call'}; campaign total is now an undercount.`,
    });
    return await currentSpend(campaignId);
  }

  const { data, error } = await db().rpc('add_campaign_cost', {
    p_campaign_id: campaignId,
    p_cost: costUsd,
  });
  if (error) throw new Error(`Failed to record cost: ${error.message}`);

  const total = Number(data);
  const ceiling = env.campaignCostCeilingUsd;

  if (total > ceiling) {
    await emit({
      campaignId,
      agent: context.agent,
      node: context.node ?? null,
      level: 'error',
      message: `Cost ceiling exceeded: $${total.toFixed(4)} of $${ceiling.toFixed(2)}.`,
      data: { total_usd: total, ceiling_usd: ceiling },
    });
    throw new CostCeilingExceededError(campaignId, total, ceiling);
  }
  return total;
}

export async function currentSpend(campaignId: string): Promise<number> {
  const { data, error } = await db()
    .from('campaigns')
    .select('cost_usd')
    .eq('id', campaignId)
    .single();
  if (error) throw new Error(error.message);
  return Number(data.cost_usd);
}

/**
 * Called by the graph executor between nodes. Catches a campaign that crossed the
 * ceiling through a path that did not charge through `chargeCampaign`.
 */
export async function assertBudget(campaignId: string): Promise<void> {
  const total = await currentSpend(campaignId);
  const ceiling = env.campaignCostCeilingUsd;
  if (total > ceiling) throw new CostCeilingExceededError(campaignId, total, ceiling);
}

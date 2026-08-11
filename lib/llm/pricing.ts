/**
 * Token prices for models called through the Anthropic API directly.
 *
 * OpenRouter reports true generation cost on the response, so nothing routed
 * through it needs this file. The Anthropic API reports tokens only, which
 * leaves two options: price them here, or let every direct call record a null
 * cost and quietly hold `campaigns.cost_usd` below the ceiling forever. The
 * ceiling is the protection against a loop bug spending real money overnight,
 * so it does not get to be approximate.
 *
 * Prices are USD per million tokens, taken from the Anthropic pricing page.
 * They are the one thing in this codebase that changes without any code
 * changing, so an unknown model returns null rather than a plausible guess.
 */

export interface TokenPrice {
  /** Uncached input. */
  input: number;
  output: number;
  /** Reading an existing cache entry: ~0.1x input. */
  cacheRead: number;
  /** Writing one at the default 5 minute TTL: ~1.25x input. */
  cacheWrite: number;
}

const PER_MTOK: Record<string, TokenPrice> = {
  // Introductory pricing runs through 2026-08-31; list is $3/$15 after that.
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
};

export function priceFor(modelId: string): TokenPrice | null {
  return PER_MTOK[modelId] ?? null;
}

/** The raw `usage` block Anthropic returns, as the AI SDK passes it through. */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Pull Anthropic's own usage block out of `result.providerMetadata`.
 *
 * The AI SDK's normalised `usage` is not enough: it folds cache reads into the
 * input count, and a cache read costs a tenth of fresh input. Charging them the
 * same would overstate a cached campaign by a lot. The provider passes the raw
 * block through under `providerMetadata.anthropic.usage`, which separates them.
 */
export function anthropicUsageOf(providerMetadata: unknown): AnthropicUsage | null {
  const anthropic = (providerMetadata as Record<string, unknown> | undefined)?.anthropic as
    | Record<string, unknown>
    | undefined;
  const usage = anthropic?.usage;
  return usage && typeof usage === 'object' ? (usage as AnthropicUsage) : null;
}

/**
 * Price one Anthropic call. Returns null for an unpriced model or missing usage,
 * which the caller records as an undercount warning rather than as $0.
 */
export function computeAnthropicCostUsd(
  modelId: string,
  providerMetadata: unknown,
): number | null {
  const price = priceFor(modelId);
  const usage = anthropicUsageOf(providerMetadata);
  if (!price || !usage) return null;

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  const total =
    (input * price.input +
      output * price.output +
      cacheRead * price.cacheRead +
      cacheWrite * price.cacheWrite) /
    1_000_000;

  return Number.isFinite(total) ? total : null;
}

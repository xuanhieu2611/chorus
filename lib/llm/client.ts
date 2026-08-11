import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { env } from '@/lib/env';

/**
 * Model access for the whole system, across two providers.
 *
 * **The model id decides the provider.** An id containing a slash is an
 * OpenRouter route (`google/gemini-2.5-flash`); a bare id is a first-party
 * Anthropic model (`claude-sonnet-5`). That rule is the entire routing logic,
 * and it is why switching a role between providers is an `.env` edit rather
 * than a code change.
 *
 * Anthropic direct is not a cost optimisation, it is a correctness one. The
 * structured-output spike (docs/ARCHITECTURE.md) found that strict schema mode
 * is not in effect through OpenRouter, so every agent's JSON is produced by a
 * model that was merely asked politely, and `lib/llm/structured.ts` repairs the
 * failures. Called directly, Claude enforces the schema server-side through
 * `output_config.format`, so the repair pass goes back to being a safety net.
 * The direct path also rejects the sampling parameters newer Claude models no
 * longer accept, instead of forwarding them into a 400.
 *
 * OpenRouter stays for everything else, which is what keeps `MODEL_FAST` on a
 * cheap million-token model for the Source Analyst's map pass over a full
 * transcript, and keeps `MODEL_OVERRIDE_ALL` pointing the whole system at one
 * cheap model during development.
 *
 * Nothing outside `lib/llm/` imports this. Agents go through
 * `lib/llm/structured.ts` so every call is schema-validated, logged, and costed.
 */
let openrouterProvider: ReturnType<typeof createOpenRouter> | null = null;
let anthropicProvider: ReturnType<typeof createAnthropic> | null = null;

export function openrouter() {
  if (!openrouterProvider) {
    openrouterProvider = createOpenRouter({
      apiKey: env.openrouterApiKey,
      // Asks OpenRouter to return real generation cost on the response, which is
      // what `lib/llm/budget.ts` charges against the campaign ceiling. Without
      // it we would be guessing from a hand-maintained price table. The
      // Anthropic API has no equivalent, which is why `lib/llm/pricing.ts` is
      // exactly that hand-maintained table for the direct path.
      extraBody: { usage: { include: true } },
    });
  }
  return openrouterProvider;
}

export function anthropic() {
  if (!anthropicProvider) {
    anthropicProvider = createAnthropic({ apiKey: env.anthropicApiKey });
  }
  return anthropicProvider;
}

export type ModelProvider = 'anthropic' | 'openrouter';

/** A slash means an OpenRouter route. A bare id is a first-party Anthropic model. */
export function providerForModel(modelId: string): ModelProvider {
  return modelId.includes('/') ? 'openrouter' : 'anthropic';
}

export type ModelRole = 'reasoning' | 'fast' | 'vision';

export function modelIdFor(role: ModelRole): string {
  switch (role) {
    case 'reasoning':
      return env.modelReasoning;
    case 'fast':
      return env.modelFast;
    case 'vision':
      return env.modelVision;
  }
}

export function modelFor(role: ModelRole) {
  const modelId = modelIdFor(role);
  return providerForModel(modelId) === 'anthropic' ? anthropic()(modelId) : openrouter()(modelId);
}

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { env } from '@/lib/env';

/**
 * OpenRouter access for the whole system. One key, many models.
 *
 * `usage.include` asks OpenRouter to return real generation cost on the response,
 * which is what `lib/llm/budget.ts` charges against the campaign ceiling. Without
 * it we would be guessing from a hand-maintained price table.
 *
 * Nothing outside `lib/llm/` imports this. Agents go through
 * `lib/llm/structured.ts` so every call is schema-validated, logged, and costed.
 */
let provider: ReturnType<typeof createOpenRouter> | null = null;

export function openrouter() {
  if (!provider) {
    provider = createOpenRouter({
      apiKey: env.openrouterApiKey,
      extraBody: { usage: { include: true } },
    });
  }
  return provider;
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
  return openrouter()(modelIdFor(role));
}

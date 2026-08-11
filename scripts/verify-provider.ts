import { loadEnv } from '../lib/load-env';
import type { ModelRole } from '../lib/llm/client';

/**
 * One real call per configured role, to prove the keys and the routing work
 * before a campaign spends twenty minutes discovering otherwise.
 *
 *   npx tsx scripts/verify-provider.ts
 *
 * It exercises the two things that only fail live: that each role's provider
 * accepts its key, and that a schema-constrained call comes back valid on the
 * first attempt. On the Anthropic path a first-attempt failure means the
 * server-side schema enforcement is not doing what `lib/llm/client.ts` claims.
 */
async function main(): Promise<void> {
  loadEnv();

  const { z } = await import('zod');
  const { env } = await import('../lib/env');
  const { modelIdFor, providerForModel } = await import('../lib/llm/client');
  const { callStructured } = await import('../lib/llm/structured');
  const { priceFor } = await import('../lib/llm/pricing');

  const Schema = z.object({
    city: z.string().describe('The capital city named in the question.'),
    country: z.string(),
  });

  const roles: ModelRole[] = ['reasoning', 'fast', 'vision'];
  let failed = false;

  if (env.modelOverrideAll) {
    console.log(`MODEL_OVERRIDE_ALL is set; every role resolves to ${env.modelOverrideAll}.\n`);
  }

  for (const role of roles) {
    const modelId = modelIdFor(role);
    const provider = providerForModel(modelId);
    process.stdout.write(`${role.padEnd(9)} ${modelId} via ${provider} ... `);

    try {
      const started = Date.now();
      const result = await callStructured({
        // No campaignId: nothing to log against and nothing to charge, so this
        // never writes an agent_runs row or moves a campaign total.
        agent: 'verify-provider',
        role,
        schema: Schema,
        schemaName: 'capital',
        prompt: 'What is the capital of Japan? Answer with the city and its country.',
      });

      const repaired = result.attempts.some((attempt) => attempt.repaired);
      const cost = result.costUsd === null ? 'cost unknown' : `$${result.costUsd.toFixed(6)}`;
      console.log(`ok in ${Date.now() - started}ms (${result.value.city}, ${cost})`);

      if (repaired) {
        console.log(
          `  warning: took ${result.attempts.length} attempts. On the ${provider} path this ` +
            'means the schema is not being enforced server-side.',
        );
      }
      if (provider === 'anthropic' && !priceFor(modelId)) {
        console.log(
          `  warning: ${modelId} is not in lib/llm/pricing.ts, so its calls record no cost ` +
            'and never count against CAMPAIGN_COST_CEILING_USD.',
        );
      }
    } catch (error) {
      failed = true;
      console.log(`FAILED\n  ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

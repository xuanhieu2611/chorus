import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { CampaignReviewSchema } from './campaign-reviewer';
import { ClipPlanSchema, InspectSchema } from './clip-producer';
import { CriticSchema } from './critic';
import { DirectorSchema } from './director';
import { MapSchema, ReduceSchema } from './source-analyst';
import { AlternativeSchema, StrategySchema } from './strategist';
import { LinkedInOutputSchema, ThreadOutputSchema } from './writer';

/**
 * Every schema this system sends to a model, and the keywords the provider will
 * not accept.
 *
 * OpenRouter's structured-output path for Claude rejects parts of JSON Schema
 * outright, and the request fails before the model answers, so no repair pass can
 * recover it. No provider routing avoids this: `only: ['anthropic']` reproduces
 * it on Bedrock. The limits were measured against `anthropic/claude-sonnet-4.5`:
 *
 *   accepted: minLength, maxLength, enum, const, anyOf (what `.nullable()` emits)
 *   rejected: minimum, maximum (number *and* integer), maxItems, minItems above
 *             1, oneOf (what `z.discriminatedUnion` emits)
 *
 * `z.number().int()` is the trap: Zod renders it as an integer carrying
 * safe-integer `minimum`/`maximum`, so it fails without naming a bound anywhere
 * in the source.
 *
 * None of this reproduces on `google/gemini-2.5-flash-lite`, which accepts all of
 * it, so MODEL_OVERRIDE_ALL hides the whole class of failure. That is what this
 * test is for: the bounds these schemas used to carry now live in code, and
 * nothing but this test stops them being written back.
 *
 * The constraint set is Anthropic's, not OpenRouter's, so calling the Anthropic
 * API directly does not relax it. It raises the stakes instead: the direct path
 * enforces the schema server-side, so these keywords are now rejected on the
 * roles that previously got away with a lenient provider.
 */
const MODEL_FACING_SCHEMAS: ReadonlyArray<readonly [string, z.ZodType]> = [
  ['source-analyst MapSchema', MapSchema],
  ['source-analyst ReduceSchema', ReduceSchema],
  ['strategist StrategySchema', StrategySchema],
  ['strategist AlternativeSchema', AlternativeSchema],
  ['director DirectorSchema', DirectorSchema],
  ['writer LinkedInOutputSchema', LinkedInOutputSchema],
  ['writer ThreadOutputSchema', ThreadOutputSchema],
  ['clip-producer ClipPlanSchema', ClipPlanSchema],
  ['clip-producer InspectSchema', InspectSchema],
  ['critic CriticSchema', CriticSchema],
  ['campaign-reviewer CampaignReviewSchema', CampaignReviewSchema],
];

const REJECTED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'maxItems',
  'oneOf',
] as const;

/** Walk the rendered JSON Schema and report every unsupported keyword by path. */
function unsupportedKeywords(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => unsupportedKeywords(item, `${path}[${index}]`));
  }
  if (node === null || typeof node !== 'object') return [];

  const found: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((REJECTED_KEYWORDS as readonly string[]).includes(key)) {
      found.push(`${path}.${key}`);
    }
    // minItems is the one bound with a legal range rather than a flat ban.
    if (key === 'minItems' && value !== 0 && value !== 1) {
      found.push(`${path}.minItems = ${String(value)} (only 0 or 1 are accepted)`);
    }
    found.push(...unsupportedKeywords(value, `${path}.${key}`));
  }
  return found;
}

for (const [name, schema] of MODEL_FACING_SCHEMAS) {
  test(`${name} renders JSON Schema the provider accepts`, () => {
    const rendered = z.toJSONSchema(schema, { io: 'output' });
    const violations = unsupportedKeywords(rendered);
    assert.deepEqual(
      violations,
      [],
      `${name} uses JSON Schema keywords the provider rejects: ${violations.join(', ')}. Move the bound into code, as lib/agents/critic.ts and lib/agents/writer.ts do.`,
    );
  });
}

test('the walker actually catches each rejected keyword', () => {
  // A guard that silently passes everything is worse than no guard.
  const bad = z.object({
    score: z.number().min(0).max(10),
    id: z.number().int(),
    few: z.array(z.string()).min(2),
    many: z.array(z.string()).max(9),
  });
  const found = unsupportedKeywords(z.toJSONSchema(bad, { io: 'output' })).join(' ');

  assert.match(found, /minimum/);
  assert.match(found, /maximum/);
  assert.match(found, /minItems = 2/);
  assert.match(found, /maxItems/);
});

test('anyOf from a nullable field is not mistaken for a rejected union', () => {
  const nullable = z.object({ note: z.string().nullable() });
  assert.deepEqual(unsupportedKeywords(z.toJSONSchema(nullable, { io: 'output' })), []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { describeError } from './structured';
import { extractCostUsd } from './budget';

/**
 * Both behaviours here were broken in Phase 0 and both failed silently, which is
 * why they are pinned. Neither test touches the network.
 */

test('describeError digs Zod issues out of the AI SDK cause chain', () => {
  // The real shape: NoObjectGeneratedError -> TypeValidationError -> ZodError.
  // Reading only the top level yields "response did not match schema", which
  // tells a repair attempt nothing and produces an identical second failure.
  const zodError = z.object({ hook: z.string().max(12) }).safeParse({ hook: 'far too long to fit' })
    .error!;

  const typeValidationError = Object.assign(new Error('Type validation failed'), {
    cause: zodError,
  });
  const noObjectError = Object.assign(new Error('No object generated: response did not match schema.'), {
    cause: typeValidationError,
  });

  const described = describeError(noObjectError);
  assert.match(described, /hook/);
  assert.match(described, /12/);
  assert.doesNotMatch(described, /No object generated/);
});

test('describeError falls back to the message when there are no issues', () => {
  assert.equal(describeError(new Error('rate limited')), 'rate limited');
});

test('describeError does not loop forever on a self-referential cause', () => {
  const error: Record<string, unknown> = { message: 'looping' };
  error.cause = error;
  assert.equal(describeError(error), 'looping');
});

test('extractCostUsd reads the shape OpenRouter actually returns', () => {
  // Verified against a live call on 2026-08-09.
  const providerMetadata = {
    openrouter: {
      provider: 'Google',
      usage: { promptTokens: 38, completionTokens: 56, cost: 0.0000262 },
    },
  };
  assert.equal(extractCostUsd(providerMetadata), 0.0000262);
});

test('extractCostUsd returns null rather than inventing a zero', () => {
  // A null is recorded as an undercount warning. A 0 would look like a free call
  // and quietly hold the campaign total below the ceiling forever.
  assert.equal(extractCostUsd(undefined), null);
  assert.equal(extractCostUsd({}), null);
  assert.equal(extractCostUsd({ openrouter: {} }), null);
  assert.equal(extractCostUsd({ openrouter: { usage: { cost: 'free' } } }), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampScore, decideCritic } from './critic';
import { clampReviewScore } from './campaign-reviewer';

/**
 * These bounds used to live in the Zod schemas as `minimum`/`maximum`, which some
 * OpenRouter providers reject outright. They now live in code, so the routing
 * they decide has to be tested here instead.
 */

test('a critic score is held inside 1 to 10', () => {
  assert.equal(clampScore(7), 7);
  assert.equal(clampScore(0), 1);
  assert.equal(clampScore(-4), 1);
  assert.equal(clampScore(50), 10);
  assert.equal(clampScore(Number.NaN), 1);
});

test('an out-of-range score cannot buy a PASS it did not earn', () => {
  // 11s would lift the average over the PASS threshold if left unclamped.
  const inflated = {
    hook: 99,
    clarity: 99,
    standalone: 2,
    originality: 99,
    audience_fit: 99,
    payoff: 99,
  };
  const routing = decideCritic(inflated);
  assert.equal(routing.decision, 'REJECT', 'a 2 is still a REJECT');
  assert.equal(routing.lowest, 2);
  assert.ok(routing.average <= 10, 'the average stays on the scale');
});

test('a negative score floors at 1 rather than dragging the average below the scale', () => {
  const routing = decideCritic({
    hook: 8,
    clarity: 8,
    standalone: 8,
    originality: 8,
    audience_fit: 8,
    payoff: -100,
  });
  assert.equal(routing.lowest, 1);
  assert.equal(routing.decision, 'REJECT');
});

test('a review score is held inside 0 to 100', () => {
  assert.equal(clampReviewScore(72), 72);
  assert.equal(clampReviewScore(-1), 0);
  assert.equal(clampReviewScore(1000), 100);
  assert.equal(clampReviewScore(Number.NaN), 0);
});

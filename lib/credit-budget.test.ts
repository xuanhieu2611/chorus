import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CRITIQUE_RESERVE_RATIO,
  REVISION_CREDIT_COST,
  canAffordCredits,
  planningCreditBudget,
  remainingCredits,
} from './credit-budget';

test('the Strategist plans against less than the whole budget', () => {
  assert.equal(planningCreditBudget(24), 16);
  assert.equal(planningCreditBudget(30), 20);
  // The reserve is what the critique loop spends, so it must be real.
  assert.ok(planningCreditBudget(24) < 24);
  assert.ok(CRITIQUE_RESERVE_RATIO > 0 && CRITIQUE_RESERVE_RATIO < 1);
});

test('the reserve yields rather than making a legal two-asset plan impossible', () => {
  // Two short videos cost 6, the contract's floor. Reserving a third of 6 would
  // leave 4 and fail planning outright instead of protecting the loop.
  assert.equal(planningCreditBudget(6), 6);
  assert.equal(planningCreditBudget(9), 6);
  assert.equal(planningCreditBudget(12), 8);
});

test('a degenerate budget produces no planning credits', () => {
  assert.equal(planningCreditBudget(0), 0);
  assert.equal(planningCreditBudget(-5), 0);
  assert.equal(planningCreditBudget(Number.NaN), 0);
});

test('remaining credits never go negative', () => {
  assert.equal(remainingCredits({ credit_budget: 24, credits_spent: 16 }), 8);
  assert.equal(remainingCredits({ credit_budget: 24, credits_spent: 24 }), 0);
  assert.equal(remainingCredits({ credit_budget: 24, credits_spent: 30 }), 0);
});

test('affordability is what the graph checks before reserving', () => {
  const nearlySpent = { credit_budget: 24, credits_spent: 23 };
  assert.equal(canAffordCredits(nearlySpent, REVISION_CREDIT_COST), true);
  assert.equal(canAffordCredits(nearlySpent, 3), false);

  const spent = { credit_budget: 24, credits_spent: 24 };
  assert.equal(canAffordCredits(spent, REVISION_CREDIT_COST), false);
  assert.equal(canAffordCredits(spent, 0), true);
});

test('a full plan leaves room for the critique loop', () => {
  // The regression: a 12-credit plan against a 12-credit budget meant the first
  // revision or replacement failed the campaign inside begin_asset_generation.
  const budget = 24;
  const planned = planningCreditBudget(budget);
  const afterPlan = { credit_budget: budget, credits_spent: planned };

  assert.ok(canAffordCredits(afterPlan, REVISION_CREDIT_COST));
  assert.ok(canAffordCredits(afterPlan, 3), 'a full-price replacement must still fit');
});

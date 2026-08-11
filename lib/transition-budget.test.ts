import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  counterForTransition,
  transitionBudgetExhausted,
  transitionBudgetWarning,
} from './transition-budget';

const limits = { maxPlanRevisions: 2, maxPortfolioReplans: 2 };

test('planning and portfolio transition kinds map to independent counters', () => {
  assert.equal(counterForTransition('director_replan'), 'plan_revision_count');
  assert.equal(counterForTransition('strategy_gate_replan'), 'plan_revision_count');
  assert.equal(counterForTransition('campaign_replan'), 'portfolio_replan_count');
  assert.equal(counterForTransition('final_gate_replan'), 'portfolio_replan_count');

  const planExhausted = { plan_revision_count: 2, portfolio_replan_count: 0 };
  assert.equal(transitionBudgetExhausted(planExhausted, 'director_replan', limits), true);
  assert.equal(transitionBudgetExhausted(planExhausted, 'campaign_replan', limits), false);
});

test('budget warnings name the exact exhausted allowance', () => {
  assert.equal(
    transitionBudgetWarning('director_replan', { plan_revision_count: 2, portfolio_replan_count: 0 }, limits),
    'plan revisions budget exhausted (2/2).',
  );
  assert.equal(
    transitionBudgetWarning('campaign_replan', { plan_revision_count: 2, portfolio_replan_count: 2 }, limits),
    'portfolio replans budget exhausted (2/2).',
  );
});

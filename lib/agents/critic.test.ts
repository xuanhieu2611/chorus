import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideCritic, type CriticScores } from './critic';

function scores(value: number): CriticScores {
  return {
    hook: value,
    clarity: value,
    standalone: value,
    originality: value,
    audience_fit: value,
    payoff: value,
  };
}

test('Critic rejects an asset when any dimension is 3 or below', () => {
  const routing = decideCritic({ ...scores(9), hook: 3 });
  assert.equal(routing.decision, 'REJECT');
  assert.equal(routing.average, 8);
  assert.equal(routing.lowest, 3);
});

test('Critic passes only with a seven average and no score below five', () => {
  assert.equal(decideCritic(scores(7)).decision, 'PASS');
  assert.equal(decideCritic({ ...scores(8), payoff: 4.9 }).decision, 'REVISE');
});

test('Critic routes a middle score to revision', () => {
  const routing = decideCritic({ ...scores(7), clarity: 6 });
  assert.equal(routing.decision, 'REVISE');
  assert.equal(routing.average, 6.83);
  assert.equal(routing.lowest, 6);
});

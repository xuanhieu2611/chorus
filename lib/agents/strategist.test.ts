import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  replacementPlanKey,
  validateReplan,
  validateStrategy,
  type StrategyPlan,
} from './strategist';
import type { CampaignReview } from './campaign-reviewer';
import type { SegmentRow } from '../db/client';

function segment(id: string, start: number, end: number): SegmentRow {
  return {
    id,
    campaign_id: 'campaign',
    start_time: start,
    end_time: end,
    transcript: 'source words',
    topic: `Topic ${id}`,
    summary: 'Summary',
    content_type: 'advice',
    energy: 0.7,
    standalone_score: 0.8,
    novelty_score: 0.6,
    potential_hooks: [],
    context_deps: null,
    created_at: new Date(0).toISOString(),
  };
}

const segments = [segment('s1', 0, 60), segment('s2', 100, 180), segment('s3', 200, 360)];

function plan(overrides: Partial<StrategyPlan> = {}): StrategyPlan {
  return {
    rationale: 'Two assets do distinct jobs.',
    planned_assets: [
      {
        plan_key: 'asset_1',
        type: 'short_video',
        platform: 'tiktok',
        topic: 'Topic one',
        purpose: 'Reach new viewers',
        segment_ids: ['s1'],
        credits: 3,
      },
      {
        plan_key: 'asset_2',
        type: 'linkedin_post',
        platform: 'linkedin',
        topic: 'Topic two',
        purpose: 'Build authority',
        segment_ids: ['s2'],
        credits: 2,
      },
    ],
    rejected_topics: [{ topic: 'Topic three', reason: 'It repeats the first argument.' }],
    ...overrides,
  };
}

const constraints = {
  creditBudget: 12,
  maxAssets: 6,
  maxVideoSeconds: 120,
  platforms: ['tiktok', 'x', 'linkedin'],
};

test('validateStrategy accepts a legal mixed-platform plan', () => {
  assert.deepEqual(validateStrategy(plan(), segments, constraints), []);
});

test('validateStrategy enforces fixed costs and the total credit budget in code', () => {
  const invalid = plan({
    planned_assets: [
      ...plan().planned_assets,
      {
        plan_key: 'asset_3',
        type: 'short_video',
        platform: 'tiktok',
        topic: 'Topic three',
        purpose: 'Spend too much',
        segment_ids: ['s2'],
        credits: 1,
      },
    ],
  });

  const errors = validateStrategy(invalid, segments, { ...constraints, creditBudget: 6 });
  assert.ok(errors.some((error) => error.includes('costs 3 credits, not 1')));
  assert.ok(errors.some((error) => error.includes('above the 6 credit budget')));
});

test('validateStrategy rejects invented segments, wrong platforms, and oversized clips', () => {
  const invalid = plan({
    planned_assets: [
      {
        plan_key: 'asset_1',
        type: 'short_video',
        platform: 'linkedin',
        topic: 'Bad clip',
        purpose: 'Break constraints',
        segment_ids: ['s3', 'invented'],
        credits: 3,
      },
      plan().planned_assets[1],
    ],
  });

  const errors = validateStrategy(invalid, segments, constraints);
  assert.ok(errors.some((error) => error.includes('must target tiktok')));
  assert.ok(errors.some((error) => error.includes('unknown segment invented')));
  assert.ok(errors.some((error) => error.includes('above the 120 second clip limit')));
});

test('validateStrategy rejects duplicate stable plan keys and campaign-disabled platforms', () => {
  const invalid = plan({
    planned_assets: [
      plan().planned_assets[0],
      { ...plan().planned_assets[1], plan_key: ' asset_1 ' },
    ],
  });

  const errors = validateStrategy(invalid, segments, { ...constraints, platforms: ['tiktok'] });
  assert.ok(errors.some((error) => error.includes('duplicated')));
  assert.ok(errors.some((error) => error.includes('not enabled')));
});

test('validateReplan preserves kept assets and requires a suffixed replacement key', () => {
  const replanReview: CampaignReview = {
    scores: {
      asset_quality: 80,
      diversity: 40,
      audience_fit: 80,
      brand_consistency: 80,
      overall: 70,
    },
    problems: [{ issue: 'The two assets make the same argument.', asset_plan_keys: ['asset_2'] }],
    recommendations: [{
      action: 'replace',
      plan_key: 'asset_2',
      replacement_topic: 'A distinct topic',
      replacement_segment_ids: ['s3'],
    }],
    decision: 'REPLAN',
  };
  const input = {
    campaignId: 'campaign',
    previous: plan(),
    review: replanReview,
    segments,
    targetVersion: 2,
    occupiedPlanKeys: ['asset_1', 'asset_2'],
    goal: 'Grow the show',
    audience: 'Builders',
    brandVoice: 'Direct',
    creditBudget: 12,
    maxAssets: 6,
    maxVideoSeconds: 120,
    platforms: ['tiktok', 'x', 'linkedin'],
  };
  const valid = {
    ...plan(),
    planned_assets: [
      plan().planned_assets[0],
      {
        ...plan().planned_assets[1],
        plan_key: 'asset_2_v2',
        topic: 'A distinct topic',
        segment_ids: ['s3'],
      },
    ],
  };

  assert.deepEqual(validateReplan(valid, input), []);
  assert.equal(replacementPlanKey('asset_2', 2, ['asset_2', 'asset_2_v2']), 'asset_2_v2_2');
  assert.ok(
    validateReplan(
      { ...valid, planned_assets: [plan().planned_assets[0], plan().planned_assets[1]] },
      input,
    ).some((error) => error.includes('must be removed')),
  );
});

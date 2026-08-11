import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  replacementPlanKey,
  StrategySchema,
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

const segments = [
  segment('s1', 0, 60),
  segment('s2', 100, 180),
  segment('s3', 200, 360),
  segment('s4', 400, 460),
];

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
    rejected_topics: [{ topic: 'Topic three', reason: 'It repeats the first argument.', segment_ids: ['s4'] }],
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

test('legacy rejected topics normalize missing segment ids to an empty array', () => {
  const parsed = StrategySchema.parse({
    ...plan(),
    rejected_topics: [{ topic: 'Legacy topic', reason: 'It is too close to the selected angle.' }],
  });
  assert.deepEqual(parsed.rejected_topics, [{
    topic: 'Legacy topic',
    reason: 'It is too close to the selected angle.',
    segment_ids: [],
  }]);
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

test('validateStrategy rejects invented segments and wrong platforms', () => {
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
});

test('validateStrategy treats a long source segment as a bounded legal clip', () => {
  const bounded = plan({
    planned_assets: [
      {
        ...plan().planned_assets[0],
        segment_ids: ['s3'],
      },
      plan().planned_assets[1],
    ],
  });

  assert.deepEqual(validateStrategy(bounded, segments, constraints), []);
});

test('validateStrategy rejects videos that exceed the combined campaign budget', () => {
  const invalid = plan({
    planned_assets: [
      plan().planned_assets[0],
      {
        ...plan().planned_assets[1],
        plan_key: 'asset_2',
        type: 'short_video',
        platform: 'tiktok',
        segment_ids: ['s2'],
        credits: 3,
      },
    ],
  });

  const errors = validateStrategy(invalid, segments, constraints);
  assert.ok(errors.some((error) => error.includes('140.0 seconds in total')));
  assert.ok(errors.some((error) => error.includes('campaign-wide video budget')));
});

test('written assets do not consume the combined video budget', () => {
  const mixed = plan({
    planned_assets: [
      {
        ...plan().planned_assets[0],
        segment_ids: ['s1'],
      },
      plan().planned_assets[1],
      {
        plan_key: 'asset_3',
        type: 'x_thread',
        platform: 'x',
        topic: 'Topic three',
        purpose: 'Share a lesson',
        segment_ids: ['s3'],
        credits: 2,
      },
    ],
  });

  assert.deepEqual(validateStrategy(mixed, segments, constraints), []);
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
      replacement_reason: 'The portfolio repeats the current argument.',
      prior_rejection_addressed: null,
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

test('validateReplan rejects a replacement that breaks the combined video budget', () => {
  const previous: StrategyPlan = {
    ...plan(),
    planned_assets: [
      plan().planned_assets[0],
      {
        ...plan().planned_assets[0],
        plan_key: 'asset_2',
        segment_ids: ['s2'],
      },
    ],
  };
  const input = {
    campaignId: 'campaign',
    previous,
    review: {
      scores: {
        asset_quality: 80,
        diversity: 40,
        audience_fit: 80,
        brand_consistency: 80,
        overall: 70,
      },
      problems: [{ issue: 'Repeated videos.', asset_plan_keys: ['asset_2'] }],
      recommendations: [{
        action: 'replace' as const,
        plan_key: 'asset_2',
        replacement_topic: 'A distinct topic',
        replacement_segment_ids: ['s3'],
        replacement_reason: 'The portfolio repeats the current argument.',
        prior_rejection_addressed: null,
      }],
      decision: 'REPLAN' as const,
    },
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
  const revised: StrategyPlan = {
    ...previous,
    planned_assets: [
      previous.planned_assets[0],
      {
        ...previous.planned_assets[1],
        plan_key: 'asset_2_v2',
        segment_ids: ['s3'],
      },
    ],
  };

  assert.ok(
    validateReplan(revised, input).some((error) => error.includes('campaign-wide video budget')),
  );
});

test('validateStrategy enforces the two-asset portfolio minimum in code', () => {
  // The rule used to be `.min(2)` on the schema. Providers serving Claude reject
  // minItems above 1, so the schema cannot carry it and this check must.
  const thin = plan({ planned_assets: [plan().planned_assets[0]] });
  const errors = validateStrategy(thin, segments, constraints);
  assert.ok(
    errors.some((error) => error.includes('at least 2')),
    `expected a portfolio-minimum violation, got ${JSON.stringify(errors)}`,
  );
});

test('validateReplan lets normalization own the fields a replan cannot move', () => {
  // A real campaign died here: the model returned the replacement as a 2 credit
  // asset, and validation rejected it for a value `normalizeReplan` overwrites
  // with CREDIT_COST on the next line. Type, platform, segment ids and credits
  // are code's to set, so they must not also be code's to reject.
  const previous: StrategyPlan = plan();
  const input = {
    campaignId: 'c1',
    previous,
    review: {
      decision: 'REPLAN' as const,
      scores: { asset_quality: 70, diversity: 42, audience_fit: 70, brand_consistency: 70, overall: 60 },
      rationale: 'Too repetitive.',
      problems: [{ issue: 'Two assets cover the same idea.', asset_plan_keys: ['asset_2'] }],
      recommendations: [
        {
          action: 'replace' as const,
          plan_key: 'asset_2',
          replacement_topic: 'A distinct topic',
          replacement_segment_ids: ['s3'],
          replacement_reason: 'The portfolio repeats the current argument.',
          prior_rejection_addressed: null,
        },
      ],
    },
    segments,
    targetVersion: 2,
    occupiedPlanKeys: [],
    goal: 'Grow an audience.',
    audience: null,
    brandVoice: null,
    ...constraints,
  };

  const wrongFields: StrategyPlan = {
    ...previous,
    planned_assets: [
      previous.planned_assets[0],
      {
        ...previous.planned_assets[1],
        plan_key: 'asset_2_v2',
        topic: 'A distinct topic',
        type: 'x_thread',
        platform: 'x',
        credits: 2,
        segment_ids: ['s1'],
      },
    ],
  };

  assert.deepEqual(validateReplan(wrongFields, input), []);

  // Presence is still the model's responsibility and still fails loudly.
  assert.ok(
    validateReplan({ ...wrongFields, planned_assets: [previous.planned_assets[0]] }, input).some(
      (error) => error.includes('missing from the revised plan'),
    ),
  );
});

test('validateReplan requires rationale acknowledgement for a deliberate rejection reversal', () => {
  const previous = plan({
    rejected_topics: [{
      topic: 'Caffeine as a productivity hack',
      reason: 'The brief is anti-hype.',
      segment_ids: ['s3'],
    }],
  });
  const input = {
    campaignId: 'caffeine-campaign',
    previous,
    review: {
      scores: { asset_quality: 70, diversity: 40, audience_fit: 70, brand_consistency: 70, overall: 60 },
      problems: [{ issue: 'The portfolio repeats its argument.', asset_plan_keys: ['asset_2'] }],
      recommendations: [{
        action: 'replace' as const,
        plan_key: 'asset_2',
        replacement_topic: 'Caffeine as a productivity hack',
        replacement_segment_ids: ['s3'],
        replacement_reason: 'The portfolio now needs a skeptical counterpoint.',
        prior_rejection_addressed: 'The replacement critiques the hype instead of endorsing it.',
      }],
      decision: 'REPLAN' as const,
    },
    segments,
    targetVersion: 2,
    occupiedPlanKeys: ['asset_1', 'asset_2'],
    goal: 'Grow an audience',
    audience: 'Builders',
    brandVoice: 'Anti-hype',
    ...constraints,
  };
  const revised = {
    ...previous,
    planned_assets: [
      previous.planned_assets[0],
      {
        ...previous.planned_assets[1],
        plan_key: 'asset_2_v2',
        topic: 'Caffeine as a productivity hack',
        segment_ids: ['s3'],
      },
    ],
  };

  assert.ok(validateReplan(revised, input).some((error) => error.includes('Deliberate reversal')));
  assert.deepEqual(
    validateReplan({ ...revised, rationale: 'Deliberate reversal: Caffeine as a productivity hack / s3 is now a critique of hype.' }, input),
    [],
  );
});

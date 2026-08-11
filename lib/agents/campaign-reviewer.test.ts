import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decideCampaignReview,
  ensureReplanRecommendation,
  type CampaignReview,
  type CampaignReviewAsset,
  type CampaignReviewSegment,
} from './campaign-reviewer';

function review(overrides: Partial<CampaignReview> = {}): CampaignReview {
  return {
    scores: {
      asset_quality: 82,
      diversity: 78,
      audience_fit: 80,
      brand_consistency: 84,
      overall: 81,
    },
    problems: [],
    recommendations: [{
      action: 'keep',
      plan_key: 'asset_1',
      replacement_topic: null,
      replacement_segment_ids: [],
      replacement_reason: null,
      prior_rejection_addressed: null,
    }],
    decision: 'APPROVE',
    ...overrides,
  };
}

const assets: CampaignReviewAsset[] = [
  {
    planKey: 'asset_1',
    type: 'short_video',
    platform: 'tiktok',
    hook: 'A strong opening',
    content: { kind: 'short_video' },
    sourceSegmentIds: ['used-1'],
    criticScores: { hook: 8 },
    criticFeedback: 'Keep the opening direct.',
  },
];

const unusedSegments: CampaignReviewSegment[] = [
  {
    id: 'unused-1',
    topic: 'A different argument',
    summary: 'A distinct source moment.',
    contentType: 'advice',
    startTime: 20,
    endTime: 40,
    noveltyScore: 0.9,
  },
];

test('Campaign Reviewer forces REPLAN below the diversity floor', () => {
  const routing = decideCampaignReview(
    review({ scores: { ...review().scores, diversity: 59 }, decision: 'APPROVE' }),
  );
  assert.equal(routing.decision, 'REPLAN');
  assert.equal(routing.forcedReplan, true);
});

test('Campaign Reviewer keeps an explicit REPLAN above the diversity floor', () => {
  const routing = decideCampaignReview(
    review({
      scores: { ...review().scores, diversity: 72 },
      decision: 'REPLAN',
      recommendations: [{
        action: 'replace',
        plan_key: 'asset_1',
        replacement_topic: 'A different argument',
        replacement_segment_ids: ['unused-1'],
        replacement_reason: 'The portfolio needs a distinct argument.',
        prior_rejection_addressed: null,
      }],
    }),
  );
  assert.equal(routing.decision, 'REPLAN');
  assert.equal(routing.forcedReplan, false);
});

const generousVideoBudget = { maxVideoSeconds: 180, remainingVideoSeconds: 180 };

test('forced replans get a deterministic unused-segment replacement when the model omits one', () => {
  const repaired = ensureReplanRecommendation(review(), assets, unusedSegments, generousVideoBudget);
  assert.equal(repaired.decision, 'REPLAN');
  assert.deepEqual(repaired.recommendations.at(-1), {
    action: 'replace',
    plan_key: 'asset_1',
    replacement_topic: 'A different argument',
    replacement_segment_ids: ['unused-1'],
    replacement_reason: 'Deterministic repair after the Campaign Reviewer returned malformed replacement details.',
    prior_rejection_addressed: null,
  });
});

test('a replacement segment that would blow the video budget is dropped like a malformed one', () => {
  const overBudget = review({
    decision: 'REPLAN',
    recommendations: [{
      action: 'replace',
      plan_key: 'asset_1',
      replacement_topic: 'A different argument',
      // unused-1 spans 20s (20-40); only 5s remain in the video budget.
      replacement_segment_ids: ['unused-1'],
      replacement_reason: 'The portfolio needs a distinct argument.',
      prior_rejection_addressed: null,
    }],
  });

  // No unused segment fits 5 remaining seconds and asset_1 is the only passing
  // asset, so the safety net has nothing legal to propose.
  assert.throws(
    () => ensureReplanRecommendation(overBudget, assets, unusedSegments, {
      maxVideoSeconds: 180,
      remainingVideoSeconds: 5,
    }),
    /no passing asset and unused segment are available/,
  );
});

test('the fallback prefers a written asset over one that would blow the video budget', () => {
  const mixedAssets: CampaignReviewAsset[] = [
    { ...assets[0], planKey: 'video_asset' },
    {
      planKey: 'text_asset',
      type: 'linkedin_post',
      platform: 'linkedin',
      hook: 'A strong hook',
      content: { kind: 'linkedin_post' },
      sourceSegmentIds: ['used-2'],
      criticScores: { hook: 7 },
      criticFeedback: 'Tighten the close.',
    },
  ];

  const repaired = ensureReplanRecommendation(
    review({
      recommendations: [
        { action: 'keep', plan_key: 'video_asset', replacement_topic: null, replacement_segment_ids: [], replacement_reason: null, prior_rejection_addressed: null },
        { action: 'keep', plan_key: 'text_asset', replacement_topic: null, replacement_segment_ids: [], replacement_reason: null, prior_rejection_addressed: null },
      ],
    }),
    mixedAssets,
    unusedSegments,
    { maxVideoSeconds: 180, remainingVideoSeconds: 5 },
  );

  assert.deepEqual(repaired.recommendations.at(-1), {
    action: 'replace',
    plan_key: 'text_asset',
    replacement_topic: 'A different argument',
    replacement_segment_ids: ['unused-1'],
    replacement_reason: 'Deterministic repair after the Campaign Reviewer returned malformed replacement details.',
    prior_rejection_addressed: null,
  });
});

test('Campaign Reviewer does not reintroduce a topic rejected by the strategy', () => {
  const rejectedTopic = 'A different argument';
  const reviewWithHistory = {
    ...review({
      decision: 'REPLAN',
      recommendations: [{
        action: 'replace',
        plan_key: 'asset_1',
        replacement_topic: rejectedTopic,
        replacement_segment_ids: ['rejected-1'],
        replacement_reason: 'The current portfolio now needs this angle.',
        prior_rejection_addressed: null,
      }],
    }),
  };

  assert.throws(
    () => ensureReplanRecommendation(
      reviewWithHistory,
      assets,
      [{ ...unusedSegments[0], id: 'rejected-1', topic: rejectedTopic }],
      generousVideoBudget,
      [{ topic: rejectedTopic, reason: 'Too close to the selected campaign angle.', segmentIds: ['rejected-1'] }],
    ),
    /not discarded/,
  );
});

test('an exact rejected segment cannot return under a reframed topic without an override explanation', () => {
  const contradictory = review({
    decision: 'REPLAN',
    recommendations: [{
      action: 'replace',
      plan_key: 'asset_1',
      replacement_topic: 'A reframed argument',
      replacement_segment_ids: ['rejected-1'],
      replacement_reason: 'The portfolio needs a new angle.',
      prior_rejection_addressed: null,
    }],
  });

  assert.throws(
    () => ensureReplanRecommendation(
      contradictory,
      assets,
      [{ ...unusedSegments[0], id: 'rejected-1', topic: 'A reframed argument' }],
      generousVideoBudget,
      [{ topic: 'The original argument', reason: 'Too close to the selected angle.', segmentIds: ['rejected-1'] }],
    ),
    /prior rejection no longer applies/,
  );
});

test('a justified reversal remains possible when the portfolio context changes', () => {
  const justified = review({
    decision: 'REPLAN',
    recommendations: [{
      action: 'replace',
      plan_key: 'asset_1',
      replacement_topic: 'A different argument',
      replacement_segment_ids: ['rejected-1'],
      replacement_reason: 'The current portfolio is repetitive, so this angle now fills a distinct job.',
      prior_rejection_addressed: 'The earlier rejection avoided duplication, but the current portfolio failure is the duplication itself.',
    }],
  });

  const result = ensureReplanRecommendation(
    justified,
    assets,
    [{ ...unusedSegments[0], id: 'rejected-1' }],
    generousVideoBudget,
    [{ topic: 'A different argument', reason: 'Too close to the selected angle.', segmentIds: ['rejected-1'] }],
  );

  assert.equal(result.recommendations[0].prior_rejection_addressed?.startsWith('The earlier rejection'), true);
});

test('the caffeine recommendation must reconcile an anti-hype rejection', () => {
  const antiHypeHistory = [{
    topic: 'Caffeine as a productivity hack',
    reason: 'The brief is anti-hype and rejects simplistic optimization claims.',
    segmentIds: ['caffeine-1'],
  }];
  const recommendation = review({
    decision: 'REPLAN',
    recommendations: [{
      action: 'replace',
      plan_key: 'asset_1',
      replacement_topic: 'Caffeine as a productivity hack',
      replacement_segment_ids: ['caffeine-1'],
      replacement_reason: 'The current portfolio needs this topic.',
      prior_rejection_addressed: null,
    }],
  });

  assert.throws(
    () => ensureReplanRecommendation(
      recommendation,
      assets,
      [{ ...unusedSegments[0], id: 'caffeine-1', topic: 'Caffeine as a productivity hack' }],
      generousVideoBudget,
      antiHypeHistory,
    ),
    /prior rejection no longer applies/,
  );

  const reconciled = ensureReplanRecommendation(
    {
      ...recommendation,
      recommendations: [{
        ...recommendation.recommendations[0],
        replacement_reason: 'Use the caffeine moment to critique hype, not to promote a productivity hack.',
        prior_rejection_addressed: 'The replacement explicitly critiques the anti-hype failure mode, so the earlier rejection no longer applies.',
      }],
    },
    assets,
    [{ ...unusedSegments[0], id: 'caffeine-1', topic: 'Caffeine as a productivity hack' }],
    generousVideoBudget,
    antiHypeHistory,
  );
  assert.equal(reconciled.recommendations[0].action, 'replace');
});

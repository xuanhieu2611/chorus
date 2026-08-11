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
        { action: 'keep', plan_key: 'video_asset', replacement_topic: null, replacement_segment_ids: [] },
        { action: 'keep', plan_key: 'text_asset', replacement_topic: null, replacement_segment_ids: [] },
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
  });
});

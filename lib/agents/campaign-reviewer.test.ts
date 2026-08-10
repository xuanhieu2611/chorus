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

test('forced replans get a deterministic unused-segment replacement when the model omits one', () => {
  const repaired = ensureReplanRecommendation(review(), assets, unusedSegments);
  assert.equal(repaired.decision, 'REPLAN');
  assert.deepEqual(repaired.recommendations.at(-1), {
    action: 'replace',
    plan_key: 'asset_1',
    replacement_topic: 'A different argument',
    replacement_segment_ids: ['unused-1'],
  });
});

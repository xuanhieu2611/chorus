import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DirectorSchema,
  makeDirectorRuntimeConstraints,
  resolveDirectorReview,
  validateDirectorChanges,
  type DirectorReview,
} from './director';
import type { StrategyPlan } from './strategist';

test('Director cannot accept a free-form change from short_video/tiktok to x', () => {
  const invalidPlatformChange = DirectorSchema.safeParse({
    decision: 'REJECT',
    reasoning: 'The plan needs a platform adjustment.',
    required_changes: ['Change asset_1 from short_video/tiktok to x.'],
  });

  assert.equal(
    invalidPlatformChange.success,
    false,
    'a platform change must be checked against the planned asset type and enabled platforms',
  );
});

const strategy: StrategyPlan = {
  rationale: 'Distinct jobs for distinct platforms.',
  planned_assets: [
    {
      plan_key: 'asset_1',
      type: 'short_video',
      platform: 'tiktok',
      topic: 'A useful idea',
      purpose: 'Reach new viewers',
      segment_ids: ['segment_1'],
      credits: 3,
    },
    {
      plan_key: 'asset_2',
      type: 'x_thread',
      platform: 'x',
      topic: 'A deeper idea',
      purpose: 'Earn discussion',
      segment_ids: ['segment_2'],
      credits: 2,
    },
  ],
  rejected_topics: [{ topic: 'A repeated idea', reason: 'It duplicates asset_1.', segment_ids: ['segment_3'] }],
};

const constraints = makeDirectorRuntimeConstraints({
  platforms: ['tiktok', 'x', 'linkedin'],
  maxAssets: 6,
  creditBudget: 12,
  maxVideoSeconds: 120,
});

function review(change: DirectorReview['required_changes'][number]): DirectorReview {
  return {
    decision: 'REJECT',
    reasoning: 'Make this concrete change.',
    required_changes: [change],
  };
}

test('structured Director changes validate a legal platform move and reject an impossible one', () => {
  const legal = review({
    plan_key: 'asset_2',
    field: 'platform',
    instruction: 'Keep the thread on X.',
    target_platform: 'x',
  });
  assert.deepEqual(validateDirectorChanges(legal.required_changes, strategy, constraints), []);

  const impossible = review({
    plan_key: 'asset_1',
    field: 'platform',
    instruction: 'Move this short video to X.',
    target_platform: 'x',
  });
  assert.deepEqual(validateDirectorChanges(impossible.required_changes, strategy, constraints), [
    'required_changes[0] cannot move asset_1 (short_video) to x: valid platform for short_video is tiktok',
  ]);
});

test('impossible Director changes get one semantic retry and then fail without a budget decision', async () => {
  const first = review({
    plan_key: 'asset_1',
    field: 'platform',
    instruction: 'Move this short video to X.',
    target_platform: 'x',
  });
  let retries = 0;

  await assert.rejects(
    resolveDirectorReview(
      first,
      async (violations) => {
        retries += 1;
        assert.match(violations[0], /short_video.*x/);
        return first;
      },
      (candidate) => validateDirectorChanges(candidate.required_changes, strategy, constraints),
    ),
    /after one retry/,
  );
  assert.equal(retries, 1);
});

test('a corrected Director review resolves on the single retry', async () => {
  const impossible = review({
    plan_key: 'asset_1',
    field: 'platform',
    instruction: 'Move this short video to X.',
    target_platform: 'x',
  });
  const corrected = review({
    plan_key: 'asset_1',
    field: 'topic',
    instruction: 'Clarify the hook while keeping the valid platform.',
    target_platform: null,
  });

  const resolved = await resolveDirectorReview(
    impossible,
    async () => corrected,
    (candidate) => validateDirectorChanges(candidate.required_changes, strategy, constraints),
  );
  assert.deepEqual(resolved, corrected);
});

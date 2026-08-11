import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  plannedVideoDurationForAsset,
  remainingVideoBudget,
  reservedVideoDuration,
  totalPassedVideoDuration,
  videoBudgetError,
} from './video-budget';

function segment(id: string, start: number, end: number) {
  return { id, start_time: start, end_time: end };
}

const segments = [
  segment('s1', 0, 70),
  segment('s2', 100, 140),
  segment('s3', 200, 300),
];

const plannedAssets = [
  { plan_key: 'video_1', type: 'short_video', segment_ids: ['s1'] },
  { plan_key: 'video_2', type: 'short_video', segment_ids: ['s2'] },
  { plan_key: 'post', type: 'linkedin_post', segment_ids: ['s3'] },
];

test('a replacement is rejected when its planned source duration exceeds the remaining budget', () => {
  const remaining = remainingVideoBudget({
    maxVideoSeconds: 120,
    plannedAssets,
    segments,
    assets: [
      { plan_key: 'video_1', type: 'short_video', status: 'passed', duration_sec: 70 },
      { plan_key: 'video_2', type: 'short_video', status: 'rejected', duration_sec: 40 },
      { plan_key: 'post', type: 'linkedin_post', status: 'passed', duration_sec: null },
    ],
    excludePlanKey: 'video_2',
  });

  assert.equal(remaining, 50);
  assert.equal(
    plannedVideoDurationForAsset(
      { plan_key: 'replacement', type: 'short_video', segment_ids: ['s3'] },
      segments,
      120,
    ),
    100,
  );
  assert.ok(100 > remaining);
});

test('written assets do not reserve video seconds and a critic replacement receives the remainder', () => {
  const remaining = remainingVideoBudget({
    maxVideoSeconds: 120,
    plannedAssets,
    segments,
    assets: [
      { plan_key: 'video_1', type: 'short_video', status: 'passed', duration_sec: 70 },
      { plan_key: 'video_2', type: 'short_video', status: 'rejected', duration_sec: null },
      { plan_key: 'post', type: 'linkedin_post', status: 'passed', duration_sec: null },
    ],
    excludePlanKey: 'video_2',
  });

  assert.equal(remaining, 50);
});

test('revising a video excludes its old render so it is not reserved twice', () => {
  const remainingForRevision = remainingVideoBudget({
    maxVideoSeconds: 120,
    plannedAssets,
    segments,
    assets: [
      { plan_key: 'video_1', type: 'short_video', status: 'revising', duration_sec: 70 },
      { plan_key: 'video_2', type: 'short_video', status: 'passed', duration_sec: 40 },
      { plan_key: 'post', type: 'linkedin_post', status: 'passed', duration_sec: null },
    ],
    excludePlanKey: 'video_1',
  });

  assert.equal(remainingForRevision, 80);
});

test('finalization accepts an exact cap and rejects a passed portfolio above it', () => {
  const exact = [
    { type: 'short_video', status: 'passed' as const, duration_sec: 70 },
    { type: 'short_video', status: 'passed' as const, duration_sec: 50 },
    { type: 'linkedin_post', status: 'passed' as const, duration_sec: null },
  ];
  assert.equal(totalPassedVideoDuration(exact), 120);
  assert.equal(videoBudgetError(120, 120), null);
  assert.match(videoBudgetError(120.01, 120) ?? '', /120\.01/);
  assert.match(videoBudgetError(120.01, 120) ?? '', /campaign-wide video budget/);
});

test('a rendered asset reserves what it produced, not the span it was planned from', () => {
  // The deadlock this came from: two kept clips were charged 161.2s of source
  // span for 97.1s of real video, so a replan had no legal solution and the
  // Strategist returned the identical over-budget total on every retry.
  const planned = [
    { plan_key: 'kept_1', type: 'short_video', segment_ids: ['s1'] },
    { plan_key: 'kept_2', type: 'short_video', segment_ids: ['s3'] },
  ];
  const rendered = [
    { plan_key: 'kept_1', type: 'short_video', status: 'passed', duration_sec: 20 },
    { plan_key: 'kept_2', type: 'short_video', status: 'passed', duration_sec: 25 },
  ];

  const bySource = reservedVideoDuration({
    maxVideoSeconds: 180,
    plannedAssets: planned,
    segments,
    assets: [],
  });
  const byRender = reservedVideoDuration({
    maxVideoSeconds: 180,
    plannedAssets: planned,
    segments,
    assets: rendered,
  });

  assert.equal(bySource, 170, 's1 is 70s and s3 is 100s of source span');
  assert.equal(byRender, 45, 'the rendered clips are what actually ship');
  assert.ok(byRender < bySource, 'a tight sub-span must free allowance for a replan');
});

test('an unrendered asset still reserves its bounded source span', () => {
  const reserved = reservedVideoDuration({
    maxVideoSeconds: 180,
    plannedAssets: [
      { plan_key: 'kept_1', type: 'short_video', segment_ids: ['s1'] },
      { plan_key: 'replacement', type: 'short_video', segment_ids: ['s3'] },
    ],
    segments,
    // Only the kept asset has rendered; the replacement has no row yet.
    assets: [{ plan_key: 'kept_1', type: 'short_video', status: 'passed', duration_sec: 20 }],
  });
  assert.equal(reserved, 120, '20s rendered plus the replacement 100s source span');
});

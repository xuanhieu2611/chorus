import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCampaignExportManifest,
  exportVideoBudgetProblem,
  safeFilename,
  selectExportAssets,
} from '@/lib/export';
import type { AssetRow, CampaignRow } from '@/lib/db/client';

function asset(overrides: Partial<AssetRow>): AssetRow {
  return {
    id: 'asset-id',
    campaign_id: 'campaign-id',
    plan_key: 'asset_1',
    type: 'linkedin_post',
    platform: 'linkedin',
    source_segment_ids: [],
    hook: null,
    content: { kind: 'linkedin_post', body: 'A useful post.' },
    media_url: null,
    media_path: null,
    duration_sec: null,
    status: 'passed',
    revision_count: 0,
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

function campaign(): CampaignRow {
  return {
    id: 'campaign-id',
    title: 'Launch notes',
    goal: 'Grow an audience',
    audience: 'Builders',
    brand_voice: 'Direct',
    platforms: ['linkedin'],
    max_assets: 6,
    max_video_seconds: 120,
    credit_budget: 12,
    credits_spent: 2,
    cost_usd: 0.1,
    source_path: 'uploads/campaign-id/source.mp4',
    source_duration_sec: 3600,
    has_video_stream: true,
    status: 'complete',
    current_node: 'finalize',
    plan_revision_count: 0,
    portfolio_replan_count: 0,
    replan_count: 0,
    completion_mode: null,
    completion_note: null,
    error: null,
    claimed_at: null,
    claimed_by: null,
    heartbeat_at: null,
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
  };
}

test('export selection excludes every non-passed asset status', () => {
  const selected = selectExportAssets([
    asset({ id: 'passed', plan_key: 'passed', status: 'passed' }),
    asset({ id: 'rejected', plan_key: 'rejected', status: 'rejected' }),
    asset({ id: 'abandoned', plan_key: 'abandoned', status: 'abandoned' }),
    asset({ id: 'replaced', plan_key: 'replaced', status: 'replaced' }),
    asset({ id: 'planned', plan_key: 'planned', status: 'planned' }),
  ]);

  assert.deepEqual(selected.map((item) => item.id), ['passed']);
});

test('final export budget accepts an exact cap and rejects an over-budget portfolio', () => {
  const videos = [
    asset({ type: 'short_video', platform: 'tiktok', duration_sec: 70, media_path: 'clips/a.mp4' }),
    asset({ type: 'short_video', platform: 'tiktok', duration_sec: 50, media_path: 'clips/b.mp4' }),
  ];
  assert.equal(exportVideoBudgetProblem(campaign(), videos), null);
  assert.match(
    exportVideoBudgetProblem(campaign(), [
      ...videos,
      asset({ type: 'short_video', platform: 'tiktok', duration_sec: 0.01, media_path: 'clips/c.mp4' }),
    ]) ?? '',
    /120\.01/,
  );
});

test('export manifest uses safe, stable entry names and campaign summary', () => {
  const manifest = buildCampaignExportManifest({
    campaign: {
      ...campaign(),
      completion_mode: 'human_override',
      completion_note: 'Editorial review accepted the remaining repetition.',
    },
    assets: [
      asset({
        plan_key: '../bad key/one',
        type: 'x_thread',
        platform: 'x',
        hook: 'Start here',
        content: { kind: 'x_thread', tweets: ['First', 'Second'], grounding: [] },
      }),
    ],
    campaignReview: null,
  });

  assert.equal(manifest.assets[0]?.filename, 'written/01-bad-key-one.md');
  assert.match(manifest.assets[0]?.markdown ?? '', /First/);
  assert.match(manifest.campaignMarkdown, /Rejected, abandoned, replaced/);
  assert.equal(safeFilename('..//'), 'asset');
});

test('campaign markdown preserves completion provenance and unresolved review problems', () => {
  const manifest = buildCampaignExportManifest({
    campaign: {
      ...campaign(),
      completion_mode: 'human_override',
      completion_note: 'Editorial review accepted the remaining repetition.',
    },
    assets: [asset({ media_path: null })],
    campaignReview: {
      id: 'review-id',
      campaign_id: 'campaign-id',
      version: 2,
      scores: { diversity: 42, overall: 70 },
      problems: [{ issue: 'Two assets repeat the same argument.', asset_plan_keys: ['asset_1'] }],
      recommendations: [],
      decision: 'APPROVE',
      model_decision: 'APPROVE',
      effective_decision: 'REPLAN',
      created_at: '2026-08-10T00:00:00.000Z',
    },
  });

  assert.match(manifest.campaignMarkdown, /Completion mode: human_override/);
  assert.match(manifest.campaignMarkdown, /Completion rationale: Editorial review accepted the remaining repetition/);
  assert.match(manifest.campaignMarkdown, /Effective decision: REPLAN/);
  assert.match(manifest.campaignMarkdown, /Unresolved reviewer problems/);
  assert.match(manifest.campaignMarkdown, /Two assets repeat the same argument/);
});

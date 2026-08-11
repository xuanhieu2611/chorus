import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { GRAPH_EDGES } from './graph/view';

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('the split-budget migration has an atomic idempotency boundary and crash recovery path', () => {
  const migration = read('../supabase/migrations/20260811090000_split_replan_budgets.sql');

  assert.match(migration, /unique \(campaign_id, strategy_version, transition_kind\)/i);
  assert.match(migration, /create or replace function public\.charge_campaign_transition/i);
  assert.match(migration, /from public\.campaigns[\s\S]*for update/i);
  assert.match(migration, /on conflict \(campaign_id, strategy_version, transition_kind\) do nothing/i);
  assert.match(migration, /if v_id is null then[\s\S]*return query[\s\S]*false[\s\S]*return;/i);
  assert.match(migration, /transition_queued.*true/i);
  assert.match(migration, /review_version/);
});

test('runtime source no longer reads the legacy shared replan budget names', () => {
  const runtimeFiles = [
    '../app/api/campaigns/[id]/approve/route.ts',
    '../lib/env.ts',
    '../lib/graph/nodes.ts',
    '../lib/tools/transitions.ts',
    '../scripts/scratch-check-campaigns.ts',
  ];

  for (const relativePath of runtimeFiles) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /MAX_CAMPAIGN_REPLANS|maxCampaignReplans|\breplan_count\b/);
  }
});

test('graph labels distinguish planning revisions from portfolio replans', () => {
  const labels = GRAPH_EDGES.map((edge) => edge.label).filter((label): label is string => Boolean(label));

  assert.ok(labels.some((label) => label.includes('plan revision')));
  assert.ok(labels.some((label) => label.includes('portfolio replan')));
  assert.ok(labels.includes('REJECT · plan budget exhausted'));
  assert.ok(labels.includes('APPROVE / portfolio budget exhausted'));
});

test('human gate routes charge the corresponding independent counter', () => {
  const route = read('../app/api/campaigns/[id]/approve/route.ts');

  assert.match(
    route,
    /transitionKind: 'strategy_gate_replan',[\s\S]*maxCount: env\.maxPlanRevisions/,
  );
  assert.match(
    route,
    /transitionKind: 'final_gate_replan',[\s\S]*maxCount: env\.maxPortfolioReplans/,
  );
});

test('the local type-generation command is documented next to the migration workflow', () => {
  const instructions = read('../AGENTS.md');
  assert.match(instructions, /supabase gen types typescript --linked --schema public/);
  assert.ok(fileURLToPath(new URL('../lib/db/database.types.ts', import.meta.url)).length > 0);
});

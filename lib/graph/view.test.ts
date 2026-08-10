import test from 'node:test';
import assert from 'node:assert/strict';
import type { CampaignEvent } from '@/lib/events/types';
import { deriveGraphState, graphEdgeId } from '@/lib/graph/view';

function event(
  id: number,
  node: string,
  message: string,
  data: unknown = undefined,
): CampaignEvent {
  return {
    id,
    campaign_id: 'campaign',
    agent_run_id: null,
    agent: 'system',
    node,
    level: data === undefined ? 'info' : 'decision',
    message,
    data,
    created_at: new Date(id * 1000).toISOString(),
  };
}

test('derives completed and active graph nodes from a live snapshot', () => {
  const state = deriveGraphState(
    { status: 'analyzing', current_node: 'analyze' },
    [event(1, 'ingest', 'Entering ingest.'), event(2, 'transcribe', 'Entering transcribe.'), event(3, 'analyze', 'Entering analyze.')],
  );

  assert.equal(state.states.ingest, 'complete');
  assert.equal(state.states.transcribe, 'complete');
  assert.equal(state.states.analyze, 'active');
  assert.equal(state.states.strategize, 'idle');
});

test('records loop-back traversal and the display-only asset decision', () => {
  const state = deriveGraphState(
    { status: 'producing', current_node: 'produce' },
    [
      event(1, 'director_review_plan', 'Director rejected the plan.', { next: 'strategize' }),
      event(2, 'strategize', 'Entering strategize.'),
      event(3, 'critique', 'Critic PASS for asset_1.', { next: 'produce' }),
    ],
  );

  assert.equal(state.states.more_assets, 'complete');
  assert.equal(state.traversedEdges.has(graphEdgeId('director_review_plan', 'strategize')), true);
  assert.equal(state.traversedEdges.has(graphEdgeId('critique', 'more_assets')), true);
  assert.equal(state.traversedEdges.has(graphEdgeId('more_assets', 'produce')), true);
});

test('marks finalized work complete in its terminal node and failed work as failed', () => {
  const finalized = deriveGraphState({ status: 'complete', current_node: 'finalize' }, [
    event(1, 'finalize', 'Entering finalize.'),
  ]);
  assert.equal(finalized.states.finalize, 'complete');

  const failed = deriveGraphState({ status: 'failed', current_node: 'produce' }, [
    event(1, 'produce', 'Entering produce.'),
  ]);
  assert.equal(failed.states.produce, 'failed');
});

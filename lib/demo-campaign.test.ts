import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_MOMENTS, demoStream } from '@/lib/demo-campaign';
import { deriveGraphState, graphEdgeId } from '@/lib/graph/view';

test('the demo follows the runtime graph and keeps more_assets display-only', () => {
  assert.equal(DEMO_MOMENTS.some((moment) => String(moment.currentNode) === 'more_assets'), false);

  const final = demoStream(DEMO_MOMENTS.length - 1);
  assert.equal(final.events.some((event) => event.node === 'more_assets'), false);

  const graph = deriveGraphState(final.campaign!, final.events);
  assert.equal(graph.traversedEdges.has(graphEdgeId('critique', 'more_assets')), true);
  assert.equal(graph.traversedEdges.has(graphEdgeId('more_assets', 'produce')), true);
  assert.equal(graph.traversedEdges.has(graphEdgeId('more_assets', 'campaign_review')), true);
  assert.equal(graph.traversedEdges.has(graphEdgeId('campaign_review', 'replan')), true);
  assert.equal(graph.traversedEdges.has(graphEdgeId('replan', 'produce')), true);
});

test('the demo ends with one portfolio replan and four approved outputs', () => {
  const final = demoStream(DEMO_MOMENTS.length - 1);

  assert.equal(final.campaign?.status, 'complete');
  assert.equal(final.campaign?.portfolio_replan_count, 1);
  assert.equal(final.campaignReview?.decision, 'APPROVE');
  assert.equal(final.campaignReview?.scores.diversity, 86);
  assert.equal(final.assets.length, 4);
  assert.equal(final.assets.every((asset) => asset.status === 'passed'), true);
  assert.equal(final.assets.some((asset) => asset.plan_key === 'clip-eval-loop'), false);
  assert.equal(final.assets.some((asset) => asset.plan_key === 'clip-feedback-tax_v2'), true);
});

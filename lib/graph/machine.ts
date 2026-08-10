import { NODES } from '@/lib/graph/nodes';
import type { NodeFn, NodeId } from '@/lib/graph/types';
import type { CampaignRow } from '@/lib/db/client';

/**
 * Node registry and the node-to-status mapping.
 *
 * `campaigns.status` is the coarse, human-facing state ("transcribing"); it
 * drives the dashboard headline and the `queued` claim query.
 * `campaigns.current_node` is the precise resume point. They are separate
 * because several nodes share one status, and because resumability must not
 * depend on reverse-engineering a node from a status.
 */

export type CampaignStatus = CampaignRow['status'];

const STATUS_FOR_NODE: Partial<Record<NodeId, CampaignStatus>> = {
  ingest: 'ingesting',
  transcribe: 'transcribing',
  analyze: 'analyzing',
  strategize: 'strategizing',
  director_review_plan: 'strategizing',
  await_strategy_approval: 'awaiting_strategy_approval',
  produce: 'producing',
  critique: 'critiquing',
  select_alternative: 'critiquing',
  abandon_asset: 'critiquing',
  campaign_review: 'campaign_review',
  replan: 'campaign_review',
  await_final_approval: 'awaiting_final_approval',
  failed: 'failed',
};

export function statusForNode(node: NodeId): CampaignStatus | null {
  // `finalize` is deliberately absent: it sets 'complete' itself when the
  // packaging actually succeeds, so a crash inside it cannot leave a campaign
  // claiming to be finished.
  return STATUS_FOR_NODE[node] ?? null;
}

export function nodeFn(node: NodeId): NodeFn | null {
  return NODES[node] ?? null;
}

/** True for a node the graph names but no phase has built yet. */
export function isUnbuilt(node: NodeId): boolean {
  return nodeFn(node) === null;
}

import type { CampaignPatch, CampaignRow } from '@/lib/db/client';

/**
 * The node contract. Every node in the graph has this exact shape, which is what
 * makes the machine testable and what keeps control flow out of prompts.
 *
 * The graph is a hand-written state machine, not a framework. LLMs decide
 * content and scores inside nodes; TypeScript decides which edge is taken. Any
 * change to the node set updates the mermaid diagram in `MVP.md` section 6 and
 * `docs/ARCHITECTURE.md` in the same commit.
 */

export const NODE_IDS = [
  'ingest',
  'transcribe',
  'analyze',
  'strategize',
  'director_review_plan',
  'await_strategy_approval',
  'produce',
  'critique',
  'select_alternative',
  'abandon_asset',
  'campaign_review',
  'replan',
  'await_final_approval',
  'finalize',
  'failed',
] as const;

export type NodeId = (typeof NODE_IDS)[number];

export const ENTRY_NODE: NodeId = 'ingest';

export function isNodeId(value: unknown): value is NodeId {
  return typeof value === 'string' && (NODE_IDS as readonly string[]).includes(value);
}

export interface RunContext {
  /**
   * The campaign as of the start of this node. The executor refreshes it from
   * the row after each patch, so a node never reads a value an earlier node
   * wrote in this same run and gets a stale one.
   */
  campaign: CampaignRow;
  campaignId: string;
  node: NodeId;
}

export interface NodeResult {
  /** `null` pauses the run: a human gate, or a terminal state. */
  next: NodeId | null;
  patch?: CampaignPatch;
  /** Written to `agent_events` at `level:'decision'`. This is the sentence a
   * person reads in the timeline to understand why the run went where it did,
   * so write it for them, not for a log file. */
  reason: string;
}

export type NodeFn = (ctx: RunContext) => Promise<NodeResult>;

import { db, unwrap, type CampaignPatch, type CampaignRow } from '@/lib/db/client';
import { emit } from '@/lib/events';
import { assertBudget } from '@/lib/llm/budget';
import { isUnbuilt, nodeFn, statusForNode } from '@/lib/graph/machine';
import { ENTRY_NODE, isNodeId, type NodeId, type RunContext } from '@/lib/graph/types';

/**
 * The executor. Walks the state machine one node at a time and writes the
 * position back to the row after every step.
 *
 * Resumability comes from `campaigns.current_node`, not from worker memory. A
 * human gate returns `next: null` with a status of `awaiting_*`; the approve
 * route flips the row back to `queued` and a worker picks it up at exactly the
 * node it stopped on. A worker that dies mid-campaign is recoverable for the
 * same reason: nothing about where the run had got to lived in that process.
 */

/**
 * A campaign that ping-ponged between two nodes forever would burn money until
 * the cost ceiling caught it, which is a real but slow and expensive backstop.
 * Every loop in the graph has its own hard limit (3 revisions, 2 replans, 3
 * boundary adjustments), so a run reaching this number means one of those limits
 * is not being enforced. It is a bug detector, not a budget.
 */
const MAX_STEPS = 200;

export type StopReason = 'terminal' | 'gate' | 'unbuilt';

export interface GraphRunResult {
  stoppedAt: NodeId | null;
  stopReason: StopReason;
  steps: number;
}

export async function runGraph(initial: CampaignRow): Promise<GraphRunResult> {
  const campaignId = initial.id;
  let campaign = initial;

  // A resumed campaign restarts at the node it stopped on. An unrecognised value
  // is data corruption, not something to paper over by silently re-ingesting a
  // campaign that is halfway through producing assets.
  let node: NodeId | null = resumeNode(campaign);
  let steps = 0;

  while (node) {
    if (steps++ >= MAX_STEPS) {
      throw new Error(
        `Graph exceeded ${MAX_STEPS} steps and is looping. A per-loop limit is not being enforced.`,
      );
    }

    if (isUnbuilt(node)) {
      return await stopAtUnbuiltNode(campaignId, node, steps);
    }

    await emit({
      campaignId,
      agent: 'system',
      node,
      level: 'info',
      message: `Entering ${node}.`,
    });

    campaign = await applyPatch(campaignId, {
      current_node: node,
      status: statusForNode(node) ?? campaign.status,
    });

    const ctx: RunContext = { campaign, campaignId, node };
    const result = await nodeFn(node)!(ctx);

    if (result.patch) {
      campaign = await applyPatch(campaignId, result.patch);
    }

    await emit({
      campaignId,
      agent: 'system',
      node,
      level: 'decision',
      message: result.reason,
      data: { next: result.next },
    });

    const from = node;
    node = result.next;

    if (!node) {
      // Either a human gate or a terminal node. The node owns the final status,
      // so the executor does not guess one here.
      const refreshed = await readCampaign(campaignId);
      const gate = refreshed.status.startsWith('awaiting_');
      return { stoppedAt: from, stopReason: gate ? 'gate' : 'terminal', steps };
    }

    // Between nodes, not only inside LLM calls: this catches a campaign that
    // crossed the ceiling through a path that did not charge through
    // `chargeCampaign`. It throws, and the worker marks the campaign failed.
    await assertBudget(campaignId);
  }

  return { stoppedAt: null, stopReason: 'terminal', steps };
}

function resumeNode(campaign: CampaignRow): NodeId {
  if (campaign.current_node === null) return ENTRY_NODE;
  if (isNodeId(campaign.current_node)) return campaign.current_node;
  throw new Error(
    `Campaign ${campaign.id} has current_node "${campaign.current_node}", which is not a node in the graph.`,
  );
}

/**
 * Scaffolding for the phased build, and it removes itself: once every node in
 * the graph has an implementation this branch is unreachable.
 *
 * The campaign is parked rather than failed. Everything up to this point really
 * did succeed, and the row keeps `current_node` pointing at the unbuilt node, so
 * the moment that phase lands the same campaign resumes exactly there.
 */
async function stopAtUnbuiltNode(
  campaignId: string,
  node: NodeId,
  steps: number,
): Promise<GraphRunResult> {
  await applyPatch(campaignId, { current_node: node, status: 'complete' });
  await emit({
    campaignId,
    agent: 'system',
    node,
    level: 'warn',
    message: `Graph stops at "${node}": that node is not built yet. Everything before it completed, and the campaign will resume here once it exists.`,
  });
  return { stoppedAt: node, stopReason: 'unbuilt', steps };
}

async function applyPatch(campaignId: string, patch: CampaignPatch): Promise<CampaignRow> {
  return unwrap(
    await db()
      .from('campaigns')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', campaignId)
      .select()
      .single(),
  );
}

async function readCampaign(campaignId: string): Promise<CampaignRow> {
  return unwrap(await db().from('campaigns').select('*').eq('id', campaignId).single());
}

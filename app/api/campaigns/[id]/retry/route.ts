import { db } from '@/lib/db/client';
import { emit } from '@/lib/events';
import { ENTRY_NODE, isNodeId } from '@/lib/graph/types';

export const runtime = 'nodejs';

/** Queue a failed campaign at its durable current node. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const { data: campaign, error: readError } = await db()
    .from('campaigns')
    .select('id, status, current_node')
    .eq('id', id)
    .maybeSingle();

  if (readError) return Response.json({ error: readError.message }, { status: 500 });
  if (!campaign) return Response.json({ error: 'Campaign not found.' }, { status: 404 });
  if (campaign.status !== 'failed') {
    return Response.json({ error: 'Only failed campaigns can be retried.' }, { status: 409 });
  }

  const resumeNode = campaign.current_node ?? ENTRY_NODE;
  if (!isNodeId(resumeNode) || resumeNode === 'failed') {
    return Response.json({ error: `Campaign has no safe resume node: ${String(resumeNode)}.` }, { status: 409 });
  }

  const { data: queued, error: queueError } = await db()
    .from('campaigns')
    .update({
      status: 'queued',
      current_node: resumeNode,
      error: null,
      claimed_at: null,
      claimed_by: null,
      heartbeat_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'failed')
    .select('id')
    .maybeSingle();

  if (queueError) return Response.json({ error: queueError.message }, { status: 500 });
  if (!queued) return Response.json({ error: 'The failed campaign was already retried.' }, { status: 409 });

  await emit({
    campaignId: id,
    agent: 'human',
    node: resumeNode,
    level: 'info',
    message: `Retry queued at ${resumeNode}. Durable outputs will be reused before any paid work is repeated.`,
    data: { resume_node: resumeNode },
  });

  return Response.json({ status: 'queued', resume_node: resumeNode });
}

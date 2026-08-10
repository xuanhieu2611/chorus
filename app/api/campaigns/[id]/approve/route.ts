import { z } from 'zod';
import { db } from '@/lib/db/client';
import { emit } from '@/lib/events';
import { env } from '@/lib/env';
import { getLatestStrategy, markStrategyApproved } from '@/lib/tools/strategies';

export const runtime = 'nodejs';

const ApprovalAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({
    action: z.literal('request_changes'),
    feedback: z.string().trim().min(3).max(2_000),
  }),
]);

/**
 * Resolve the first human gate and choose the exact resume node.
 *
 * Merely changing status to `queued` is not enough: `current_node` is the gate,
 * and a resumed worker would immediately pause there again. Approval resumes at
 * `produce`; a change request resumes at `strategize` after its feedback has
 * been durably written to the event log.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const parsed = ApprovalAction.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'Invalid approval action.', issues: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  const { data: campaign, error } = await db()
    .from('campaigns')
    .select('id, status, current_node, replan_count')
    .eq('id', id)
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!campaign) return Response.json({ error: 'Campaign not found.' }, { status: 404 });
  if (
    campaign.status !== 'awaiting_strategy_approval' ||
    campaign.current_node !== 'await_strategy_approval'
  ) {
    return Response.json(
      { error: 'This campaign is not waiting for strategy approval.' },
      { status: 409 },
    );
  }

  const strategy = await getLatestStrategy(id);
  if (!strategy) {
    return Response.json({ error: 'No strategy exists to approve.' }, { status: 409 });
  }

  if (parsed.data.action === 'approve') {
    await markStrategyApproved(strategy.id, 'human');

    const { data: resumed, error: resumeError } = await db()
      .from('campaigns')
      .update({
        status: 'queued',
        current_node: 'produce',
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'awaiting_strategy_approval')
      .select('id')
      .maybeSingle();

    if (resumeError) return Response.json({ error: resumeError.message }, { status: 500 });
    if (!resumed) return Response.json({ error: 'The gate was already resolved.' }, { status: 409 });

    await emit({
      campaignId: id,
      agent: 'human',
      node: 'await_strategy_approval',
      level: 'decision',
      message: `Strategy v${strategy.version} approved. Production queued.`,
      data: { strategy_id: strategy.id, version: strategy.version, resume_node: 'produce' },
    });

    return Response.json({ status: 'queued', resume_node: 'produce' });
  }

  if (campaign.replan_count >= env.maxCampaignReplans) {
    return Response.json(
      { error: `This campaign has used all ${env.maxCampaignReplans} strategy replans.` },
      { status: 409 },
    );
  }

  // Feedback must exist before the row becomes claimable. The Strategist reads
  // this event when it starts, and a fast worker is allowed to claim immediately
  // after the update below.
  const feedbackEvent = await emit({
    campaignId: id,
    agent: 'human',
    node: 'await_strategy_approval',
    level: 'decision',
    message: 'Strategy changes requested.',
    data: {
      strategy_id: strategy.id,
      version: strategy.version,
      feedback: parsed.data.feedback,
      resume_node: 'strategize',
    },
  });
  if (!feedbackEvent) {
    return Response.json(
      { error: 'Could not save the requested changes. The campaign was not requeued.' },
      { status: 500 },
    );
  }

  const { data: resumed, error: resumeError } = await db()
    .from('campaigns')
    .update({
      status: 'queued',
      current_node: 'strategize',
      replan_count: campaign.replan_count + 1,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'awaiting_strategy_approval')
    .select('id')
    .maybeSingle();

  if (resumeError) return Response.json({ error: resumeError.message }, { status: 500 });
  if (!resumed) return Response.json({ error: 'The gate was already resolved.' }, { status: 409 });

  return Response.json({ status: 'queued', resume_node: 'strategize' });
}

import { z } from 'zod';
import { db } from '@/lib/db/client';
import { emit } from '@/lib/events';
import { env } from '@/lib/env';
import {
  completionModeForAction,
  validateFinalApprovalAction,
  type FinalApprovalAction,
} from '@/lib/final-approval';
import { chargeCampaignTransition } from '@/lib/tools/transitions';
import {
  getFinalApprovalProvenance,
  getLatestCampaignReview,
} from '@/lib/tools/reviews';
import { getLatestStrategy, markStrategyApproved } from '@/lib/tools/strategies';

export const runtime = 'nodejs';

const ApprovalAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({
    action: z.literal('override_and_approve'),
    rationale: z.string().trim().min(1).max(2_000),
  }),
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
    .select('id, status, current_node')
    .eq('id', id)
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!campaign) return Response.json({ error: 'Campaign not found.' }, { status: 404 });
  const isStrategyGate =
    campaign.status === 'awaiting_strategy_approval' &&
    campaign.current_node === 'await_strategy_approval';
  const isFinalGate =
    campaign.status === 'awaiting_final_approval' && campaign.current_node === 'await_final_approval';
  if (!isStrategyGate && !isFinalGate) {
    return Response.json(
      { error: 'This campaign is not waiting at an approval gate.' },
      { status: 409 },
    );
  }

  if (isFinalGate) {
    return resolveFinalApproval(id, parsed.data);
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
      .eq('current_node', 'await_strategy_approval')
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

  if (parsed.data.action !== 'request_changes') {
    return Response.json(
      { error: 'This action is only valid at the final approval gate.' },
      { status: 409 },
    );
  }

  // Reserve the transition before writing the feedback event. This keeps a
  // retry safe if the route loses its response after the Postgres charge, while
  // the campaign remains at the gate until the feedback and queue update land.
  const charge = await chargeCampaignTransition({
    campaignId: id,
    strategyVersion: strategy.version,
    transitionKind: 'strategy_gate_replan',
    maxCount: env.maxPlanRevisions,
  });
  if (charge.budgetExhausted) {
    return Response.json(
      {
        error: `This campaign has used all ${env.maxPlanRevisions} plan revisions. The rejected strategy remains at the strategy gate.`,
      },
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
      transition_kind: 'strategy_gate_replan',
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
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'awaiting_strategy_approval')
    .eq('current_node', 'await_strategy_approval')
    .select('id')
    .maybeSingle();

  if (resumeError) return Response.json({ error: resumeError.message }, { status: 500 });
  if (!resumed) return Response.json({ error: 'The gate was already resolved.' }, { status: 409 });

  await emit({
    campaignId: id,
    agent: 'human',
    node: 'await_strategy_approval',
    level: 'decision',
    message: 'Strategy changes queued.',
    data: {
      strategy_id: strategy.id,
      version: strategy.version,
      resume_node: 'strategize',
      transition_kind: 'strategy_gate_replan',
      transition_queued: true,
    },
  });

  return Response.json({ status: 'queued', resume_node: 'strategize' });
}

async function resolveFinalApproval(
  campaignId: string,
  action: z.infer<typeof ApprovalAction>,
): Promise<Response> {
  const review = await getLatestCampaignReview(campaignId);
  if (!review) return Response.json({ error: 'No campaign review exists to approve.' }, { status: 409 });

  if (action.action === 'approve' || action.action === 'override_and_approve') {
    if (review.effective_decision !== 'APPROVE' && review.effective_decision !== 'REPLAN') {
      return Response.json({ error: 'The latest Campaign Reviewer has no valid effective decision.' }, { status: 409 });
    }
    const finalAction: FinalApprovalAction = action.action;
    const validationError = validateFinalApprovalAction({
      action: finalAction,
      effectiveDecision: review.effective_decision,
      rationale: action.action === 'override_and_approve' ? action.rationale : null,
    });
    if (validationError) return Response.json({ error: validationError }, { status: 409 });

    const completionMode = completionModeForAction(finalAction);
    const completionNote = action.action === 'override_and_approve' ? action.rationale.trim() : null;
    const finalApprovalKey = `final-approval:${review.id}`;
    let provenance = await getFinalApprovalProvenance(campaignId, review.id);
    if (provenance) {
      if (
        provenance.effectiveDecision !== review.effective_decision ||
        provenance.completionMode !== completionMode ||
        provenance.completionNote !== completionNote
      ) {
        return Response.json({ error: 'A different final approval is already recorded for this review.' }, { status: 409 });
      }
    } else {
      await emit({
        campaignId,
        agent: 'human',
        node: 'await_final_approval',
        level: 'decision',
        message: completionMode === 'human_override'
          ? 'Human override recorded. Packaging will be queued.'
          : 'Reviewer-approved final approval recorded. Packaging will be queued.',
        data: {
          final_approval_key: finalApprovalKey,
          review_id: review.id,
          review_version: review.version,
          effective_decision: review.effective_decision,
          completion_mode: completionMode,
          completion_note: completionNote,
          resume_node: 'finalize',
          transition_queued: true,
        },
      });
      provenance = await getFinalApprovalProvenance(campaignId, review.id);
      if (!provenance) {
        return Response.json(
          { error: 'Could not save final approval provenance. The campaign was not requeued.' },
          { status: 500 },
        );
      }
    }

    const { data: resumed, error } = await db()
      .from('campaigns')
      .update({
        status: 'queued',
        current_node: 'finalize',
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', campaignId)
      .eq('status', 'awaiting_final_approval')
      .eq('current_node', 'await_final_approval')
      .select('id')
      .maybeSingle();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (!resumed) return Response.json({ error: 'The final gate was already resolved.' }, { status: 409 });

    return Response.json({ status: 'queued', resume_node: 'finalize', completion_mode: completionMode });
  }

  const charge = await chargeCampaignTransition({
    campaignId,
    strategyVersion: review.version,
    transitionKind: 'final_gate_replan',
    maxCount: env.maxPortfolioReplans,
  });
  if (charge.budgetExhausted) {
    return Response.json(
      { error: `This campaign has used all ${env.maxPortfolioReplans} portfolio replans.` },
      { status: 409 },
    );
  }

  const feedbackEvent = await emit({
    campaignId,
    agent: 'human',
    node: 'await_final_approval',
    level: 'decision',
    message: 'Final campaign changes requested.',
    data: {
      review_id: review.id,
      review_version: review.version,
      feedback: action.feedback,
      resume_node: 'replan',
      transition_kind: 'final_gate_replan',
    },
  });
  if (!feedbackEvent) {
    return Response.json(
      { error: 'Could not save the requested changes. The campaign was not requeued.' },
      { status: 500 },
    );
  }

  const { data: resumed, error } = await db()
    .from('campaigns')
    .update({
      status: 'queued',
      current_node: 'replan',
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId)
    .eq('status', 'awaiting_final_approval')
    .eq('current_node', 'await_final_approval')
    .select('id')
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!resumed) return Response.json({ error: 'The final gate was already resolved.' }, { status: 409 });
  await emit({
    campaignId,
    agent: 'human',
    node: 'await_final_approval',
    level: 'decision',
    message: 'Final campaign changes queued.',
    data: {
      review_id: review.id,
      review_version: review.version,
      resume_node: 'replan',
      transition_kind: 'final_gate_replan',
      transition_queued: true,
    },
  });
  return Response.json({ status: 'queued', resume_node: 'replan' });
}

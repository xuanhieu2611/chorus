export type CampaignReviewDecision = 'APPROVE' | 'REPLAN';
export type FinalApprovalAction = 'approve' | 'override_and_approve';
export type CompletionMode = 'reviewer_approved' | 'human_override';

export interface FinalApprovalValidationInput {
  action: FinalApprovalAction;
  effectiveDecision: CampaignReviewDecision;
  rationale?: string | null;
}

/**
 * Keep the final-gate escape hatch deterministic and easy to test. The route
 * owns persistence and queueing; this function owns only the action contract.
 */
export function validateFinalApprovalAction(
  input: FinalApprovalValidationInput,
): string | null {
  if (input.action === 'approve') {
    return input.effectiveDecision === 'APPROVE'
      ? null
      : 'The latest Campaign Reviewer decision is REPLAN. Use override_and_approve with a rationale to ship this portfolio.';
  }

  if (input.effectiveDecision === 'APPROVE') {
    return 'The latest Campaign Reviewer approved this portfolio. Use approve instead of a human override.';
  }

  return input.rationale?.trim()
    ? null
    : 'A human override requires a non-empty rationale.';
}

export function completionModeForAction(action: FinalApprovalAction): CompletionMode {
  return action === 'approve' ? 'reviewer_approved' : 'human_override';
}

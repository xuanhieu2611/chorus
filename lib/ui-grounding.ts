export interface GroundingReviewPresentation {
  decision: string;
  grounding_audit_passed: boolean;
}

/** Only a Critic PASS with an effective semantic audit may claim source support. */
export function showsSourceSupportedClaims(
  review: GroundingReviewPresentation | null | undefined,
): boolean {
  return review?.decision === 'PASS' && review.grounding_audit_passed;
}

export function groundingEvidenceLabel(
  count: number,
  review: GroundingReviewPresentation | null | undefined,
): string {
  const noun = showsSourceSupportedClaims(review) ? 'source-supported claim' : 'exact source quote';
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

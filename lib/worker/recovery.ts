export const DEFAULT_STALE_CLAIM_AFTER_SECONDS = 90;

/** States that mean a worker owns the campaign and should heartbeat it. */
export const CLAIMED_CAMPAIGN_STATUSES = [
  'ingesting',
  'transcribing',
  'analyzing',
  'strategizing',
  'producing',
  'critiquing',
  'campaign_review',
] as const;

export function staleClaimCutoff(now: Date, afterSeconds: number): string {
  if (!Number.isFinite(afterSeconds) || afterSeconds <= 0) {
    throw new Error('Stale claim timeout must be a positive number of seconds.');
  }
  return new Date(now.getTime() - afterSeconds * 1000).toISOString();
}

export function ownsClaim(claimedBy: string | null, workerId: string): boolean {
  return claimedBy !== null && claimedBy === workerId;
}

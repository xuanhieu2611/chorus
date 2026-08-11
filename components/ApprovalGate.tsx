'use client';

import { useState } from 'react';
import type { CampaignReviewView } from '@/components/CampaignReviewCard';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function ApprovalGate({
  campaignId,
  gate = 'strategy',
  review,
  portfolioReplanCount = 0,
  portfolioReplanLimit = 0,
  compact = false,
  onAction,
}: {
  campaignId: string;
  gate?: 'strategy' | 'final';
  review?: CampaignReviewView | null;
  portfolioReplanCount?: number;
  portfolioReplanLimit?: number;
  compact?: boolean;
  onAction?: (action: 'approve' | 'override_and_approve' | 'request_changes', detail?: string) => void | Promise<void>;
}) {
  const [showChanges, setShowChanges] = useState(false);
  const [showOverride, setShowOverride] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [rationale, setRationale] = useState('');
  const [confirmedOverride, setConfirmedOverride] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'override_and_approve' | 'request_changes' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<string | null>(null);
  const needsOverride = gate === 'final' && review?.effective_decision === 'REPLAN';
  const portfolioBudgetExhausted = portfolioReplanLimit > 0 && portfolioReplanCount >= portfolioReplanLimit;

  async function submit(action: 'approve' | 'override_and_approve' | 'request_changes') {
    setBusy(action);
    setError(null);
    try {
      const detail = action === 'override_and_approve' ? rationale.trim() : action === 'request_changes' ? feedback.trim() : undefined;
      if (onAction) {
        await onAction(action, detail);
      } else {
      const response = await fetch(`/api/campaigns/${campaignId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          action === 'approve'
            ? { action }
            : action === 'override_and_approve'
              ? { action, rationale: rationale.trim() }
              : { action, feedback: feedback.trim() },
        ),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Could not resolve the approval gate.');
      }
      setResolved(
        action === 'approve'
          ? gate === 'final'
            ? 'Approved. Packaging is queued.'
            : 'Approved. Production is queued.'
          : action === 'override_and_approve'
            ? 'Human override recorded. Packaging is queued.'
          : gate === 'final'
            ? 'Changes saved. The Strategist is queued for another portfolio pass.'
            : 'Changes saved. The Strategist is queued for another pass.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  if (resolved) {
    return <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{resolved}</p>;
  }

  return (
    <div
      className={
        compact
          ? 'flex flex-col gap-3'
          : 'flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4'
      }
    >
      {!compact && <div>
        <p className="text-sm font-medium">
          {gate === 'final' ? 'Final approval is required' : 'Your approval is required'}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {gate === 'final'
            ? needsOverride
              ? 'The Campaign Reviewer requested a replan. Shipping this portfolio requires an explicit human override.'
              : 'The Campaign Reviewer has approved the portfolio. Approve it to queue packaging or request a specific replacement.'
            : 'The Director approved this plan. Nothing will be produced until you approve it or request a specific change.'}
        </p>
      </div>}

      {needsOverride && review && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">Warning: this portfolio is below the Campaign Reviewer’s shipping bar.</p>
          <p className="text-xs">Diversity: {review.scores.diversity.toFixed(1)}/100</p>
          <p className="text-xs">
            Portfolio replans: {portfolioReplanCount}/{portfolioReplanLimit}
            {portfolioBudgetExhausted ? ' - budget exhausted' : ''}
          </p>
          {review.problems.length > 0 && (
            <ul className="list-disc pl-5 text-xs">
              {review.problems.map((problem, index) => <li key={`${problem.issue}-${index}`}>{problem.issue}</li>)}
            </ul>
          )}
        </div>
      )}

      {showChanges && (
        <Textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          rows={3}
          disabled={busy !== null}
          placeholder={
            gate === 'final'
              ? 'What should the revised portfolio change?'
              : 'What should the next strategy do differently?'
          }
          aria-label="Requested strategy changes"
        />
      )}

      {showOverride && needsOverride && (
        <div className="flex flex-col gap-3 rounded-md border border-destructive/30 p-3">
          <Textarea
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            rows={3}
            disabled={busy !== null}
            placeholder="Why is it acceptable to ship despite the unresolved portfolio problems?"
            aria-label="Human override rationale"
          />
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={confirmedOverride}
              onChange={(event) => setConfirmedOverride(event.target.checked)}
              disabled={busy !== null}
              className="mt-0.5"
            />
            <span>I understand this ships against the latest Campaign Reviewer recommendation.</span>
          </label>
        </div>
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className={compact ? 'grid gap-2' : 'flex flex-wrap gap-2'}>
        {needsOverride ? (
          showOverride ? (
            <Button
              className={compact ? 'w-full' : undefined}
              variant="destructive"
              onClick={() => void submit('override_and_approve')}
              disabled={busy !== null || !confirmedOverride || rationale.trim().length === 0}
            >
              {busy === 'override_and_approve' ? 'Shipping...' : 'Confirm ship with override'}
            </Button>
          ) : (
            <Button className={compact ? 'w-full' : undefined} variant="destructive" onClick={() => setShowOverride(true)} disabled={busy !== null}>
              Ship with override
            </Button>
          )
        ) : (
          <Button className={compact ? 'w-full' : undefined} size={compact ? 'lg' : 'default'} onClick={() => void submit('approve')} disabled={busy !== null}>
            {busy === 'approve'
              ? 'Approving...'
              : gate === 'final'
                ? 'Approve campaign'
                : 'Approve strategy'}
          </Button>
        )}
        {showChanges ? (
          <Button
            className={compact ? 'w-full' : undefined}
            variant="outline"
            onClick={() => void submit('request_changes')}
            disabled={busy !== null || feedback.trim().length < 3}
          >
            {busy === 'request_changes' ? 'Sending…' : 'Send change request'}
          </Button>
        ) : (
          <Button className={compact ? 'w-full' : undefined} variant="outline" onClick={() => setShowChanges(true)} disabled={busy !== null}>
            Request changes
          </Button>
        )}
      </div>
    </div>
  );
}

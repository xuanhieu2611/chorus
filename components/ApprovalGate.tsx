'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function ApprovalGate({ campaignId }: { campaignId: string }) {
  const [showChanges, setShowChanges] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<'approve' | 'request_changes' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<string | null>(null);

  async function submit(action: 'approve' | 'request_changes') {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          action === 'approve' ? { action } : { action, feedback: feedback.trim() },
        ),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Could not resolve the approval gate.');
      setResolved(
        action === 'approve'
          ? 'Approved. Production is queued.'
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
    <div className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div>
        <p className="text-sm font-medium">Your approval is required</p>
        <p className="text-muted-foreground mt-1 text-xs">
          The Director approved this plan. Nothing will be produced until you approve it or request
          a specific change.
        </p>
      </div>

      {showChanges && (
        <Textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          rows={3}
          disabled={busy !== null}
          placeholder="What should the next strategy do differently?"
          aria-label="Requested strategy changes"
        />
      )}

      {error && <p className="text-destructive text-xs">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void submit('approve')} disabled={busy !== null}>
          {busy === 'approve' ? 'Approving…' : 'Approve strategy'}
        </Button>
        {showChanges ? (
          <Button
            variant="outline"
            onClick={() => void submit('request_changes')}
            disabled={busy !== null || feedback.trim().length < 3}
          >
            {busy === 'request_changes' ? 'Sending…' : 'Send change request'}
          </Button>
        ) : (
          <Button variant="outline" onClick={() => setShowChanges(true)} disabled={busy !== null}>
            Request changes
          </Button>
        )}
      </div>
    </div>
  );
}

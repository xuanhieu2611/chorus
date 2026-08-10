'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function RetryCampaignButton({ campaignId }: { campaignId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/retry`, { method: 'POST' });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Could not queue the retry.');
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button type="button" variant="outline" onClick={() => void retry()} disabled={busy}>
        {busy ? 'Queueing retry…' : 'Retry from failed node'}
      </Button>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

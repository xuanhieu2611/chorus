'use client';

import Link from 'next/link';
import { AssetShowcase } from '@/components/AssetShowcase';
import { Button } from '@/components/ui/button';
import { RetryCampaignButton } from '@/components/RetryCampaignButton';
import { useEventStream } from '@/components/useEventStream';

export function CampaignReview({ campaignId }: { campaignId: string }) {
  const stream = useEventStream(campaignId);
  const { campaign, campaignReview, assets } = stream;

  if (!campaign) {
    return (
      <div className="demo-panel flex min-h-80 flex-1 flex-col items-center justify-center gap-3 text-center">
        {stream.status === 'error' ? (
          <>
            <p className="text-destructive text-sm">{stream.error ?? 'The campaign could not be loaded.'}</p>
            <Button type="button" variant="outline" onClick={stream.retry}>Try again</Button>
          </>
        ) : <div className="bg-muted size-8 animate-pulse rounded-xl" />}
      </div>
    );
  }

  const eligibleAssets = assets.filter((asset) => asset.status === 'passed');
  const packageReady = campaign.status === 'complete' && eligibleAssets.length > 0;

  return (
    <div className="campaign-workspace">
      <header className="campaign-header">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="chorus-wordmark" aria-label="Chorus home">
            <span className="chorus-glyph" aria-hidden><i /><i /><i /></span>
            <span>chorus</span>
          </Link>
          <span className="hidden h-4 w-px bg-border sm:block" />
          <div className="min-w-0">
            <p className="text-muted-foreground text-[9px] font-medium uppercase tracking-[0.16em]">Final campaign</p>
            <h1 className="mt-0.5 truncate text-sm font-semibold tracking-tight sm:text-base">
              {campaign.title ?? 'Campaign package'}
            </h1>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {campaignReview && (
            <span className="hidden font-mono text-[10px] text-muted-foreground sm:block">
              {campaignReview.scores.overall.toFixed(0)} / 100 portfolio
            </span>
          )}
          <Button asChild variant="ghost"><Link href={`/campaigns/${campaignId}`}>Agent flow</Link></Button>
          {packageReady && <Button asChild><a href={`/api/campaigns/${campaignId}/export`}>Download .zip</a></Button>}
        </div>
      </header>

      {campaign.status === 'failed' && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-destructive/35 bg-destructive/8 px-4 py-3">
          <p className="text-sm">{campaign.error ?? 'Packaging stopped before it finished.'}</p>
          <RetryCampaignButton campaignId={campaignId} />
        </div>
      )}

      {campaign.completion_mode === 'human_override' && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-2 text-xs text-amber-200">
          Shipped with human override: {campaign.completion_note ?? 'No rationale recorded.'}
        </div>
      )}

      <main className="min-h-0 flex-1">
        <AssetShowcase
          campaignId={campaignId}
          assets={eligibleAssets}
          complete={packageReady}
          actionHref={`/api/campaigns/${campaignId}/export`}
          actionLabel="Download campaign.zip"
        />
      </main>
    </div>
  );
}

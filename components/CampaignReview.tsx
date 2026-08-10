'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AssetCard } from '@/components/AssetCard';
import { CampaignReviewCard } from '@/components/CampaignReviewCard';
import { RetryCampaignButton } from '@/components/RetryCampaignButton';
import { useEventStream } from '@/components/useEventStream';

export function CampaignReview({ campaignId }: { campaignId: string }) {
  const stream = useEventStream(campaignId);
  const { campaign, campaignReview, assets, segments } = stream;

  if (!campaign) {
    return (
      <Card>
        <CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
          {stream.status === 'error' ? (
            <>
              <p className="text-destructive text-sm">{stream.error ?? 'The campaign review could not be loaded.'}</p>
              <Button type="button" variant="outline" onClick={stream.retry}>Try again</Button>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">Loading the final campaign…</p>
          )}
        </CardContent>
      </Card>
    );
  }

  const eligibleAssets = assets.filter((asset) => asset.status === 'passed');
  const packageReady = campaign.status === 'complete' && eligibleAssets.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{campaign.title ?? 'Final campaign'}</h1>
          <Badge variant={statusVariant(campaign.status)}>{campaign.status.replace(/_/g, ' ')}</Badge>
        </div>
        <p className="text-muted-foreground max-w-3xl text-sm">{campaign.goal}</p>
        <div className="flex flex-wrap items-center gap-3">
          {packageReady ? (
            <Button asChild>
              <a href={`/api/campaigns/${campaignId}/export`}>Download campaign.zip</a>
            </Button>
          ) : (
            <p className="text-muted-foreground rounded-md border px-3 py-2 text-xs">
              Download becomes available after final approval, successful packaging, and at least one passed asset.
            </p>
          )}
          <Link href={`/campaigns/${campaignId}`} className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline">
            Back to live dashboard
          </Link>
        </div>
      </header>

      {campaign.status === 'failed' && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base">Packaging stopped before it finished</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm">{campaign.error ?? 'The worker stopped at a failed node.'}</p>
            <p className="text-muted-foreground text-xs">
              Retry resumes from the durable node position. Completed transcripts, model reviews, and asset outputs are reused where available.
            </p>
            <RetryCampaignButton campaignId={campaignId} />
          </CardContent>
        </Card>
      )}

      {campaignReview && <CampaignReviewCard review={campaignReview} />}

      {eligibleAssets.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-40 flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium">No passed assets are ready for the final package.</p>
            <p className="text-muted-foreground max-w-xl text-xs">
              Rejected, abandoned, replaced, unfinished, and failed assets stay visible on the dashboard for auditability but are never exported.
            </p>
          </CardContent>
        </Card>
      ) : (
        <section className="flex flex-col gap-3" aria-labelledby="final-assets-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="final-assets-heading" className="text-base font-semibold">Included assets</h2>
            <span className="text-muted-foreground text-xs">{eligibleAssets.length} passed asset{eligibleAssets.length === 1 ? '' : 's'}</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {eligibleAssets.map((asset) => <AssetCard key={asset.id} asset={asset} sources={segments} />)}
          </div>
        </section>
      )}

      {stream.error && stream.status !== 'connected' && (
        <p className="text-muted-foreground text-xs">Live refresh: {stream.error}</p>
      )}
    </div>
  );
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed' || status === 'cancelled') return 'destructive';
  if (status === 'complete') return 'default';
  return 'secondary';
}

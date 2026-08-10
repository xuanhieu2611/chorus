'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { AgentGraph } from '@/components/AgentGraph';
import { AgentTimeline } from '@/components/AgentTimeline';
import { StrategyPanel } from '@/components/StrategyPanel';
import { AssetCard } from '@/components/AssetCard';
import { ApprovalGate } from '@/components/ApprovalGate';
import { CampaignReviewCard } from '@/components/CampaignReviewCard';
import { RetryCampaignButton } from '@/components/RetryCampaignButton';
import Link from 'next/link';
import { useEventStream } from '@/components/useEventStream';

export function CampaignMonitor({ campaignId }: { campaignId: string }) {
  const stream = useEventStream(campaignId);
  const { campaign, transcript, segments, strategy, campaignReview, assets, events } = stream;

  if (!campaign) {
    if (stream.status === 'error') {
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive text-sm">{stream.error ?? 'Could not load this campaign.'}</p>
          <button
            type="button"
            onClick={stream.retry}
            className="border-border hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
          >
            Try again
          </button>
        </div>
      );
    }
    return <p className="text-muted-foreground text-sm">Loading campaign…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {campaign.title ?? 'Untitled campaign'}
          </h1>
          <Badge variant={statusVariant(campaign.status)}>{campaign.status.replace(/_/g, ' ')}</Badge>
          {campaign.current_node && (
            <span className="text-muted-foreground font-mono text-xs">{campaign.current_node}</span>
          )}
        </div>
        <p className="text-muted-foreground text-sm">{campaign.goal}</p>
        {campaign.status === 'complete' && (
          <Link href={`/campaigns/${campaignId}/review`} className="text-primary w-fit text-sm underline-offset-4 hover:underline">
            Open final campaign review →
          </Link>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Source</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Stat label="Duration" value={formatDuration(campaign.source_duration_sec)} />
          <Stat
            label="Media"
            value={
              campaign.has_video_stream === null
                ? '—'
                : campaign.has_video_stream
                  ? 'Video + audio'
                  : 'Audio only'
            }
          />
          <Stat
            label="Transcript"
            value={transcript ? `${transcript.word_count.toLocaleString('en-US')} words` : '—'}
          />
          <Stat
            label="Spend"
            value={`$${Number(campaign.cost_usd).toFixed(4)} · ${campaign.credits_spent}/${campaign.credit_budget} cr`}
          />
        </CardContent>
      </Card>

      {campaign.status === 'failed' ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base">Campaign stopped at {campaign.current_node ?? 'the entry point'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-destructive text-sm">{campaign.error ?? 'The worker reported a failure without details.'}</p>
            <p className="text-muted-foreground text-xs">
              Retry resumes from the durable node position. Existing transcript, agent decisions, and saved asset output are checked before paid work runs again.
            </p>
            <RetryCampaignButton campaignId={campaignId} />
          </CardContent>
        </Card>
      ) : campaign.error ? (
        <p className="text-destructive border-destructive/40 bg-destructive/5 rounded-md border px-3 py-2 text-sm">
          {campaign.error}
        </p>
      ) : null}

      {campaign.status === 'awaiting_final_approval' && (
        <p className="text-muted-foreground rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
          The portfolio review is complete. Resolve the final approval gate below to queue packaging.
        </p>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.12fr)_minmax(360px,0.88fr)]">
        <AgentGraph campaign={campaign} events={events} />
        <AgentTimeline
          events={events}
          connectionStatus={stream.status}
          connectionError={stream.error}
          onRetry={stream.retry}
        />
      </div>

      {segments.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {segments.length} candidate topics
              <span className="text-muted-foreground ml-2 text-xs font-normal">
                found by the Source Analyst
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col">
            {segments.map((segment, index) => (
              <div key={segment.id}>
                {index > 0 && <Separator />}
                <div className="flex flex-col gap-1.5 py-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                      {clock(segment.start_time)}-{clock(segment.end_time)}
                    </span>
                    <span className="text-sm font-medium">{segment.topic}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {segment.content_type.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                  {segment.summary && (
                    <p className="text-muted-foreground text-sm">{segment.summary}</p>
                  )}
                  {segment.potential_hooks.length > 0 && (
                    <p className="text-muted-foreground text-xs italic">
                      “{segment.potential_hooks[0]}”
                    </p>
                  )}
                  <div className="text-muted-foreground flex gap-4 font-mono text-[11px]">
                    <span>standalone {score(segment.standalone_score)}</span>
                    <span>novelty {score(segment.novelty_score)}</span>
                    <span>energy {score(segment.energy)}</span>
                    {segment.context_deps && (
                      <span className="text-amber-500">needs: {segment.context_deps}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex min-h-28 flex-col justify-center gap-1">
            <p className="text-sm font-medium">No source topics yet</p>
            <p className="text-muted-foreground text-xs">
              The Source Analyst will add grounded topic candidates after transcription. If the campaign failed here, retry from the failed node above.
            </p>
          </CardContent>
        </Card>
      )}

      {strategy ? (
        <StrategyPanel
          campaignId={campaignId}
          strategy={strategy}
          awaitingApproval={campaign.status === 'awaiting_strategy_approval'}
        />
      ) : (
        <Card>
          <CardContent className="flex min-h-28 flex-col justify-center gap-1">
            <p className="text-sm font-medium">Strategy pending</p>
            <p className="text-muted-foreground text-xs">The Strategist cannot plan production until source analysis has finished.</p>
          </CardContent>
        </Card>
      )}

      {assets.length > 0 ? (
        <section className="flex flex-col gap-3" aria-labelledby="campaign-assets-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="campaign-assets-heading" className="text-base font-semibold">
              Campaign assets
            </h2>
            <span className="text-muted-foreground text-xs">
              {assets.filter((asset) => asset.status === 'needs_review').length} ready for critique
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {assets.map((asset) => (
              <AssetCard key={asset.id} asset={asset} sources={segments} />
            ))}
          </div>
        </section>
      ) : (
        <Card>
          <CardContent className="flex min-h-28 flex-col justify-center gap-1">
            <p className="text-sm font-medium">No generated assets yet</p>
            <p className="text-muted-foreground text-xs">Approve the strategy to start production. Rejected and abandoned history appears here once it exists.</p>
          </CardContent>
        </Card>
      )}

      {campaignReview && <CampaignReviewCard review={campaignReview} />}

      {campaign.status === 'awaiting_final_approval' && (
        <ApprovalGate campaignId={campaignId} gate="final" />
      )}

      {stream.error && stream.status !== 'connected' && (
        <p className="text-muted-foreground text-xs">{stream.error}</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed' || status === 'cancelled') return 'destructive';
  if (status === 'complete') return 'default';
  return 'secondary';
}

/** Segment boundaries as mm:ss, so they can be checked against the audio by hand. */
function clock(seconds: number | string): string {
  const total = Math.floor(Number(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function score(value: number | string | null): string {
  return value === null ? '—' : Number(value).toFixed(2);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const total = Math.round(Number(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

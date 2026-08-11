'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AgentGraph } from '@/components/AgentGraph';
import { AgentTimeline } from '@/components/AgentTimeline';
import { ApprovalGate } from '@/components/ApprovalGate';
import { AssetCard } from '@/components/AssetCard';
import { AssetShowcase } from '@/components/AssetShowcase';
import { CampaignReviewCard } from '@/components/CampaignReviewCard';
import { LiveRunPanel } from '@/components/LiveRunPanel';
import { RetryCampaignButton } from '@/components/RetryCampaignButton';
import { StrategyPanel } from '@/components/StrategyPanel';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useEventStream, type CampaignSnapshot } from '@/components/useEventStream';
import type { CampaignEvent } from '@/lib/events/types';

type WorkspaceView = 'flow' | 'outputs' | 'evidence';

const WORKSPACE_VIEWS: Array<{ id: WorkspaceView; label: string }> = [
  { id: 'flow', label: 'Agent flow' },
  { id: 'outputs', label: 'Outputs' },
  { id: 'evidence', label: 'Evidence' },
];

const PHASES = [
  { label: 'Source', nodes: ['ingest', 'transcribe', 'analyze'] },
  { label: 'Strategy', nodes: ['strategize', 'director_review_plan', 'await_strategy_approval'] },
  { label: 'Create', nodes: ['produce'] },
  { label: 'Quality', nodes: ['critique', 'select_alternative', 'abandon_asset', 'campaign_review', 'replan'] },
  { label: 'Ship', nodes: ['await_final_approval', 'finalize'] },
] as const;

export function CampaignMonitor({ campaignId }: { campaignId: string }) {
  const stream = useEventStream(campaignId);
  return <CampaignWorkspace campaignId={campaignId} stream={stream} />;
}

export function CampaignWorkspace({
  campaignId,
  stream,
  demoControls,
  onApprovalAction,
}: {
  campaignId: string;
  stream: ReturnType<typeof useEventStream>;
  demoControls?: ReactNode;
  onApprovalAction?: (action: 'approve' | 'override_and_approve' | 'request_changes', detail?: string) => void | Promise<void>;
}) {
  const { campaign, transcript, segments, strategy, campaignReview, assets, events } = stream;
  const [view, setView] = useState<WorkspaceView>('flow');
  const priorStatus = useRef<string | null>(null);

  useEffect(() => {
    if (campaign?.status === 'complete' && priorStatus.current !== 'complete') {
      setView('outputs');
    }
    priorStatus.current = campaign?.status ?? null;
  }, [campaign?.status]);

  if (!campaign) {
    if (stream.status === 'error') {
      return (
        <div className="demo-panel flex min-h-80 flex-col items-center justify-center gap-3 text-center">
          <p className="text-destructive text-sm">{stream.error ?? 'Could not load this campaign.'}</p>
          <button type="button" onClick={stream.retry} className="border-border hover:bg-muted rounded-lg border px-3 py-2 text-sm">
            Try again
          </button>
        </div>
      );
    }
    return <CampaignSkeleton />;
  }

  const needsAction = campaign.status === 'awaiting_strategy_approval' || campaign.status === 'awaiting_final_approval';
  const complete = campaign.status === 'complete';

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
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold tracking-tight sm:text-base">
                {campaign.title ?? 'Untitled campaign'}
              </h1>
              <CampaignStatus status={campaign.status} />
              {complete && campaign.completion_mode === 'human_override' && <Badge variant="destructive">Override</Badge>}
            </div>
            <p className="text-muted-foreground mt-0.5 hidden max-w-2xl truncate text-xs md:block" title={campaign.goal}>
              {campaign.goal}
            </p>
          </div>
        </div>

        {demoControls ?? <div className="hidden shrink-0 items-center gap-5 xl:flex">
          <HeaderStat label="source" value={formatDuration(campaign.source_duration_sec)} />
          <HeaderStat label="transcript" value={transcript ? `${transcript.word_count.toLocaleString('en-US')} words` : 'pending'} />
          <HeaderStat label="cost" value={`$${Number(campaign.cost_usd).toFixed(2)}`} />
        </div>}
      </header>

      <div className="campaign-stage-row">
        <CampaignPhases campaign={campaign} />
        <nav className="workspace-tabs" aria-label="Campaign views">
          {WORKSPACE_VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={view === item.id ? 'workspace-tab workspace-tab--active' : 'workspace-tab'}
              aria-current={view === item.id ? 'page' : undefined}
            >
              {item.label}
              {item.id === 'outputs' && assets.length > 0 && <span>{assets.length}</span>}
            </button>
          ))}
        </nav>
      </div>

      {campaign.status === 'failed' && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-destructive/35 bg-destructive/8 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Stopped at {campaign.current_node ?? 'the entry point'}</p>
            <p className="text-muted-foreground mt-0.5 truncate text-xs">{campaign.error ?? 'The worker reported a failure.'}</p>
          </div>
          <RetryCampaignButton campaignId={campaignId} />
        </div>
      )}

      <main className="min-h-0 flex-1">
        {view === 'flow' && (
          <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[minmax(0,1fr)_19rem] xl:grid-cols-[minmax(0,1fr)_21rem]">
            <AgentGraph campaign={campaign} events={events} compact />
            {needsAction ? (
              <ActionPanel
                campaignId={campaignId}
                campaign={campaign}
                strategy={strategy}
                campaignReview={campaignReview}
                onApprovalAction={onApprovalAction}
              />
            ) : (
              <LiveRunPanel campaign={campaign} events={events} connectionStatus={stream.status} />
            )}
          </div>
        )}

        {view === 'outputs' && (
          <AssetShowcase campaignId={campaignId} assets={assets} complete={complete} staticComplete={Boolean(demoControls)} />
        )}

        {view === 'evidence' && (
          <div className="evidence-scroll h-full overflow-y-auto pr-1">
            <EvidenceView
              campaignId={campaignId}
              campaign={campaign}
              transcriptWords={transcript?.word_count ?? null}
              segments={segments}
              strategy={strategy}
              assets={assets}
              campaignReview={campaignReview}
              events={events}
              stream={stream}
            />
          </div>
        )}
      </main>

      {stream.error && stream.status !== 'connected' && campaign.status !== 'failed' && (
        <p className="bg-foreground text-background absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[11px] shadow-lg">
          {stream.error}
        </p>
      )}
    </div>
  );
}

function CampaignPhases({ campaign }: { campaign: CampaignSnapshot }) {
  const currentPhase = PHASES.findIndex((phase) => campaign.current_node && phase.nodes.includes(campaign.current_node as never));
  return (
    <ol className="phase-rail" aria-label="Campaign progress">
      {PHASES.map((phase, index) => {
        const state = campaign.status === 'complete' || index < currentPhase
          ? 'complete'
          : index === currentPhase
            ? campaign.status.startsWith('awaiting_') ? 'gate' : 'active'
            : 'idle';
        return (
          <li key={phase.label} className={`phase-step phase-step--${state}`}>
            <span className="phase-step__mark">{state === 'complete' ? '✓' : index + 1}</span>
            <span>{phase.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ActionPanel({
  campaignId,
  campaign,
  strategy,
  campaignReview,
  onApprovalAction,
}: {
  campaignId: string;
  campaign: CampaignSnapshot;
  strategy: ReturnType<typeof useEventStream>['strategy'];
  campaignReview: ReturnType<typeof useEventStream>['campaignReview'];
  onApprovalAction?: (action: 'approve' | 'override_and_approve' | 'request_changes', detail?: string) => void | Promise<void>;
}) {
  const final = campaign.status === 'awaiting_final_approval';
  return (
    <aside className="demo-panel flex min-h-0 flex-col overflow-y-auto p-4">
      <div className="mb-4">
        <p className="text-state-gate text-[11px] font-semibold uppercase tracking-[0.14em]">Human checkpoint</p>
        <h2 className="mt-2 text-xl font-semibold tracking-[-0.03em]">
          {final ? 'Campaign ready to ship' : 'Strategy ready to review'}
        </h2>
        <p className="text-muted-foreground mt-2 text-[13px] leading-5">
          {final
            ? `${campaignReview?.scores.overall.toFixed(0) ?? '-'} overall portfolio score`
            : `${strategy?.planned_assets.length ?? 0} outputs planned across ${new Set(strategy?.planned_assets.map((asset) => asset.platform)).size || 0} platforms`}
        </p>
      </div>
      {strategy && !final && (
        <div className="mb-4 space-y-2 border-y border-border py-3">
          {strategy.planned_assets.slice(0, 4).map((asset) => (
            <div key={asset.plan_key} className="flex items-center gap-2 text-[13px]">
              <span className="size-1.5 rounded-full bg-primary/70" />
              <span className="min-w-0 flex-1 truncate">{asset.topic}</span>
              <span className="text-muted-foreground">{asset.platform}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-auto">
        <ApprovalGate
          campaignId={campaignId}
          gate={final ? 'final' : 'strategy'}
          review={campaignReview}
          portfolioReplanCount={campaign.portfolio_replan_count}
          portfolioReplanLimit={campaign.portfolio_replan_limit}
          compact
          onAction={onApprovalAction}
        />
      </div>
    </aside>
  );
}

function EvidenceView({
  campaignId,
  campaign,
  transcriptWords,
  segments,
  strategy,
  assets,
  campaignReview,
  events,
  stream,
}: {
  campaignId: string;
  campaign: CampaignSnapshot;
  transcriptWords: number | null;
  segments: ReturnType<typeof useEventStream>['segments'];
  strategy: ReturnType<typeof useEventStream>['strategy'];
  assets: ReturnType<typeof useEventStream>['assets'];
  campaignReview: ReturnType<typeof useEventStream>['campaignReview'];
  events: CampaignEvent[];
  stream: ReturnType<typeof useEventStream>;
}) {
  return (
    <div className="grid gap-4 pb-8 xl:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Source intelligence</CardTitle></CardHeader>
        <CardContent>
          <div className="mb-4 grid grid-cols-3 gap-2">
            <EvidenceStat label="source" value={formatDuration(campaign.source_duration_sec)} />
            <EvidenceStat label="transcript" value={transcriptWords ? transcriptWords.toLocaleString('en-US') : 'pending'} />
            <EvidenceStat label="topics" value={String(segments.length)} />
          </div>
          <div className="divide-y divide-border">
            {segments.map((segment) => (
              <details key={segment.id} className="group py-3">
                <summary className="flex cursor-pointer list-none items-center gap-3 text-sm [&::-webkit-details-marker]:hidden">
                  <span className="text-muted-foreground font-mono text-[10px]">{clock(segment.start_time)}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{segment.topic}</span>
                  <span className="text-muted-foreground text-xs transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="text-muted-foreground mt-2 pl-12 text-xs leading-5">{segment.summary}</p>
              </details>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {strategy && <StrategyPanel campaignId={campaignId} strategy={strategy} awaitingApproval={false} />}
        {campaignReview && <CampaignReviewCard review={campaignReview} />}
      </div>

      <section className="space-y-3 xl:col-span-2" aria-labelledby="asset-evidence-heading">
        <h2 id="asset-evidence-heading" className="text-sm font-semibold">Asset evidence</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {assets.map((asset) => <AssetCard key={asset.id} asset={asset} sources={segments} />)}
        </div>
      </section>

      <div className="xl:col-span-2">
        <AgentTimeline
          events={events}
          liveEventIds={stream.liveEventIds}
          connectionStatus={stream.status}
          connectionError={stream.error}
          onRetry={stream.retry}
        />
      </div>
    </div>
  );
}

function CampaignStatus({ status }: { status: string }) {
  const running = !['complete', 'failed', 'cancelled'].includes(status) && !status.startsWith('awaiting_');
  return (
    <span className={`campaign-status campaign-status--${status === 'complete' ? 'complete' : status === 'failed' ? 'failed' : status.startsWith('awaiting_') ? 'gate' : 'active'}`}>
      {running && <span className="chorus-state-dot chorus-state-dot-active" />}
      {status === 'awaiting_strategy_approval' || status === 'awaiting_final_approval'
        ? 'needs review'
        : status.replace(/_/g, ' ')}
    </span>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return <div className="text-right"><span className="text-muted-foreground block text-[9px] uppercase tracking-[0.16em]">{label}</span><span className="mt-0.5 block font-mono text-[11px]">{value}</span></div>;
}

function EvidenceStat({ label, value }: { label: string; value: string }) {
  return <div className="bg-muted/60 rounded-lg px-3 py-2"><p className="text-muted-foreground text-[10px] uppercase tracking-[0.12em]">{label}</p><p className="mt-1 font-mono text-xs">{value}</p></div>;
}

function CampaignSkeleton() {
  return <div className="campaign-workspace animate-pulse"><div className="bg-muted h-14 rounded-xl" /><div className="bg-muted/80 h-12 rounded-xl" /><div className="bg-muted/80 min-h-0 flex-1 rounded-2xl" /></div>;
}

function clock(seconds: number | string): string {
  const total = Math.floor(Number(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '-';
  const total = Math.round(Number(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { StrategyPanel, type StrategyView } from '@/components/StrategyPanel';
import { AssetCard, type AssetView } from '@/components/AssetCard';

/**
 * Live view of one campaign.
 *
 * Polls the snapshot route with an event cursor: `agent_events.id` is a
 * monotonic bigint, so each request asks only for rows newer than the last one
 * it saw and a refresh cannot drop or duplicate a line. Phase 8 swaps the poll
 * for the SSE route and keeps this exact cursor contract.
 */

interface CampaignSnapshot {
  id: string;
  title: string | null;
  goal: string;
  status: string;
  current_node: string | null;
  source_duration_sec: number | null;
  has_video_stream: boolean | null;
  cost_usd: number | string;
  credits_spent: number;
  credit_budget: number;
  error: string | null;
}

interface EventRow {
  id: number;
  agent: string;
  node: string | null;
  level: 'info' | 'decision' | 'tool' | 'warn' | 'error';
  message: string;
  created_at: string;
}

interface ReviewRow {
  id: string;
  asset_id: string;
  reviewer_agent: string;
  scores: unknown;
  feedback: string;
  decision: 'PASS' | 'REVISE' | 'REJECT';
  revision_index: number;
  created_at: string;
}

interface TranscriptSummary {
  language: string | null;
  provider: string;
  word_count: number;
}

interface SegmentRow {
  id: string;
  start_time: number | string;
  end_time: number | string;
  topic: string;
  summary: string | null;
  content_type: string;
  energy: number | string | null;
  standalone_score: number | string | null;
  novelty_score: number | string | null;
  potential_hooks: string[];
  context_deps: string | null;
}

const TERMINAL = ['complete', 'failed', 'cancelled'];
const POLL_MS = 1_500;

export function CampaignMonitor({ campaignId }: { campaignId: string }) {
  const [campaign, setCampaign] = useState<CampaignSnapshot | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSummary | null>(null);
  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [strategy, setStrategy] = useState<StrategyView | null>(null);
  const [assets, setAssets] = useState<AssetView[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const cursor = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const response = await fetch(`/api/campaigns/${campaignId}?cursor=${cursor.current}`);
        const payload = await response.json();
        if (cancelled) return;

        if (!response.ok) {
          setLoadError(payload.error ?? `Request failed with status ${response.status}.`);
        } else {
          setLoadError(null);
          setCampaign(payload.campaign);
          setTranscript(payload.transcript);
          setSegments(payload.segments ?? []);
          setStrategy(payload.strategy ?? null);
          const nextReviews = (payload.reviews ?? []) as ReviewRow[];
          setAssets(
            (payload.assets ?? []).map((asset: AssetView) => ({
              ...asset,
              reviews: nextReviews.filter((review) => review.asset_id === asset.id),
            })),
          );
          if (payload.events.length > 0) {
            setEvents((previous) => [...previous, ...payload.events]);
            cursor.current = payload.events[payload.events.length - 1].id;
          }
          // Stop polling once the worker is done; nothing more will arrive until
          // a human action requeues the campaign.
          if (TERMINAL.includes(payload.campaign.status)) return;
        }
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [campaignId]);

  if (!campaign) {
    return <p className="text-muted-foreground text-sm">{loadError ?? 'Loading campaign…'}</p>;
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

      {campaign.error && (
        <p className="text-destructive border-destructive/40 bg-destructive/5 rounded-md border px-3 py-2 text-sm">
          {campaign.error}
        </p>
      )}

      {segments.length > 0 && (
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
      )}

      {strategy && (
        <StrategyPanel
          campaignId={campaignId}
          strategy={strategy}
          awaitingApproval={campaign.status === 'awaiting_strategy_approval'}
        />
      )}

      {assets.length > 0 && (
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
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col">
          {events.length === 0 && (
            <p className="text-muted-foreground text-sm">
              Waiting for a worker to claim this campaign. Is <code>npm run worker</code> running?
            </p>
          )}
          {events.map((event, index) => (
            <div key={event.id}>
              {index > 0 && <Separator />}
              <div className="flex items-baseline gap-3 py-2">
                <span className="text-muted-foreground w-16 shrink-0 font-mono text-[11px]">
                  {new Date(event.created_at).toLocaleTimeString('en-US', { hour12: false })}
                </span>
                <span className={`w-16 shrink-0 font-mono text-[11px] ${levelColor(event.level)}`}>
                  {event.level}
                </span>
                <span className="text-sm">{event.message}</span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {loadError && <p className="text-muted-foreground text-xs">Reconnecting: {loadError}</p>}
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

function levelColor(level: EventRow['level']): string {
  switch (level) {
    case 'error':
      return 'text-destructive';
    case 'warn':
      return 'text-amber-500';
    case 'decision':
      return 'text-sky-500';
    case 'tool':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
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

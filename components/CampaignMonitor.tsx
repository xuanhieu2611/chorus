'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

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

interface TranscriptSummary {
  language: string | null;
  provider: string;
  word_count: number;
}

const TERMINAL = ['complete', 'failed', 'cancelled'];
const POLL_MS = 1_500;

export function CampaignMonitor({ campaignId }: { campaignId: string }) {
  const [campaign, setCampaign] = useState<CampaignSnapshot | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSummary | null>(null);
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
          <Stat label="Spend" value={`$${Number(campaign.cost_usd).toFixed(4)}`} />
        </CardContent>
      </Card>

      {campaign.error && (
        <p className="text-destructive border-destructive/40 bg-destructive/5 rounded-md border px-3 py-2 text-sm">
          {campaign.error}
        </p>
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

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const total = Math.round(Number(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

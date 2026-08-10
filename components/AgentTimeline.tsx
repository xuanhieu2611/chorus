'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { CampaignEvent } from '@/lib/events/types';
import type { EventStreamStatus } from '@/components/useEventStream';

interface AgentTimelineProps {
  events: CampaignEvent[];
  connectionStatus: EventStreamStatus;
  connectionError: string | null;
  onRetry: () => void;
}

type EventOrder = 'newest' | 'oldest';

export function AgentTimeline({
  events,
  connectionStatus,
  connectionError,
  onRetry,
}: AgentTimelineProps) {
  const [agentFilter, setAgentFilter] = useState('all');
  const [order, setOrder] = useState<EventOrder>('newest');
  const agents = useMemo(
    () => [...new Set(events.map((event) => event.agent))].sort((left, right) => left.localeCompare(right)),
    [events],
  );
  const visibleEvents = useMemo(() => {
    const filtered =
      agentFilter === 'all' ? events : events.filter((event) => event.agent === agentFilter);
    return order === 'newest' ? [...filtered].reverse() : filtered;
  }, [agentFilter, events, order]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Agent timeline</CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              {events.length} event{events.length === 1 ? '' : 's'} · tool logs start collapsed
            </p>
          </div>
          <ConnectionBadge status={connectionStatus} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            Agent
            <select
              value={agentFilter}
              onChange={(event) => setAgentFilter(event.target.value)}
              className="bg-background h-8 rounded-md border px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Filter timeline by agent"
            >
              <option value="all">All agents</option>
              {agents.map((agent) => (
                <option key={agent} value={agent}>
                  {agent.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <div className="ml-auto flex gap-1" role="group" aria-label="Timeline order">
            <Button
              type="button"
              size="xs"
              variant={order === 'newest' ? 'secondary' : 'ghost'}
              onClick={() => setOrder('newest')}
            >
              Newest
            </Button>
            <Button
              type="button"
              size="xs"
              variant={order === 'oldest' ? 'secondary' : 'ghost'}
              onClick={() => setOrder('oldest')}
            >
              Oldest
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[620px] overflow-y-auto border-y" aria-live="polite">
          {visibleEvents.length === 0 ? (
            <TimelineEmpty
              hasEvents={events.length > 0}
              connectionStatus={connectionStatus}
              onRetry={onRetry}
            />
          ) : (
            <div className="divide-y">
              {visibleEvents.map((event) => (
                <TimelineEvent key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>
        {connectionError && connectionStatus !== 'connected' && (
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <p className="text-muted-foreground min-w-0 text-xs">{connectionError}</p>
            {connectionStatus === 'error' && (
              <Button type="button" size="xs" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TimelineEvent({ event }: { event: CampaignEvent }) {
  const meta = (
    <div className="flex min-w-0 items-start gap-3">
      <time className="text-muted-foreground w-16 shrink-0 pt-0.5 font-mono text-[10px]" dateTime={event.created_at}>
        {formatTime(event.created_at)}
      </time>
      <span className={`w-14 shrink-0 pt-0.5 font-mono text-[10px] uppercase ${levelColor(event.level)}`}>
        {event.level}
      </span>
      <span className="text-muted-foreground min-w-0 truncate font-mono text-[10px]">
        {event.agent.replace(/_/g, ' ')}
        {event.node ? ` · ${event.node}` : ''}
      </span>
    </div>
  );

  if (event.level === 'tool') {
    return (
      <details className="group px-4 py-3">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          {meta}
          <div className="mt-1 flex items-start gap-2 pl-[7.25rem] text-sm">
            <span className="text-muted-foreground transition-transform group-open:rotate-90">›</span>
            <span>{event.message}</span>
          </div>
        </summary>
        <EventData data={event.data} />
      </details>
    );
  }

  return (
    <div className="px-4 py-3">
      {meta}
      <div className="mt-1 flex items-start gap-2 pl-[7.25rem] text-sm">
        <Badge variant={event.level === 'error' ? 'destructive' : 'outline'} className="mt-0.5 text-[9px]">
          {event.level === 'decision' ? 'route' : event.level}
        </Badge>
        <span className="leading-5">{event.message}</span>
      </div>
      {event.data != null && event.level !== 'info' ? <EventData data={event.data} /> : null}
    </div>
  );
}

function EventData({ data }: { data: unknown }) {
  if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) return null;
  const serialized = JSON.stringify(data, null, 2) ?? '';
  return (
    <pre className="bg-muted/45 text-muted-foreground mt-3 ml-[7.25rem] max-h-40 overflow-auto rounded-md border p-2 font-mono text-[10px] leading-4">
      {serialized}
    </pre>
  );
}

function TimelineEmpty({
  hasEvents,
  connectionStatus,
  onRetry,
}: {
  hasEvents: boolean;
  connectionStatus: EventStreamStatus;
  onRetry: () => void;
}) {
  if (hasEvents) {
    return <p className="text-muted-foreground px-4 py-8 text-center text-sm">No events match this agent filter.</p>;
  }
  if (connectionStatus === 'loading' || connectionStatus === 'connecting') {
    return <p className="text-muted-foreground px-4 py-8 text-center text-sm">Loading the campaign activity…</p>;
  }
  if (connectionStatus === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <p className="text-muted-foreground text-sm">The campaign activity could not be loaded.</p>
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <p className="text-muted-foreground px-4 py-8 text-center text-sm">
      Waiting for the worker to claim this campaign.
    </p>
  );
}

function ConnectionBadge({ status }: { status: EventStreamStatus }) {
  const label = {
    loading: 'Loading',
    connecting: 'Connecting',
    connected: 'Live',
    reconnecting: 'Reconnecting',
    error: 'Offline',
  }[status];
  return <Badge variant={status === 'error' ? 'destructive' : status === 'connected' ? 'default' : 'secondary'}>{label}</Badge>;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? '-'
    : date.toLocaleTimeString('en-US', { hour12: false });
}

function levelColor(level: CampaignEvent['level']): string {
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

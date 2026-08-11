'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CampaignEvent } from '@/lib/events/types';
import type { AssetReviewView, AssetView } from '@/components/AssetCard';
import type { CampaignReviewView } from '@/components/CampaignReviewCard';
import type { StrategyView } from '@/components/StrategyPanel';

export interface CampaignSnapshot {
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

export interface TranscriptSummary {
  language: string | null;
  provider: string;
  word_count: number;
}

export interface SegmentRow {
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

interface SnapshotResponse {
  campaign: CampaignSnapshot;
  transcript: TranscriptSummary | null;
  segments: SegmentRow[];
  strategy: StrategyView | null;
  assets: AssetView[];
  reviews: AssetReviewView[];
  campaign_review: CampaignReviewView | null;
  events: CampaignEvent[];
  cursor: number;
}

export type EventStreamStatus = 'loading' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface EventStreamState {
  campaign: CampaignSnapshot | null;
  transcript: TranscriptSummary | null;
  segments: SegmentRow[];
  strategy: StrategyView | null;
  campaignReview: CampaignReviewView | null;
  assets: AssetView[];
  events: CampaignEvent[];
  /**
   * Ids that arrived over the live stream rather than in a snapshot backfill.
   * Only the source can tell these apart, and the timeline needs to know so it
   * flashes genuinely new activity instead of re-animating history.
   */
  liveEventIds: ReadonlySet<number>;
  cursor: number;
  status: EventStreamStatus;
  error: string | null;
  retry: () => void;
}

/** Enough recent ids to cover anything still on screen; the rest cannot re-animate. */
const LIVE_ID_MEMORY = 100;

/** Trailing delay used to collapse a burst of events into one snapshot fetch. */
const SNAPSHOT_REFRESH_MS = 350;
/** Backstop for a stream that stays open but stops delivering. */
const SAFETY_POLL_MS = 15_000;

const EMPTY_STATE: Omit<EventStreamState, 'retry'> = {
  campaign: null,
  transcript: null,
  segments: [],
  strategy: null,
  campaignReview: null,
  assets: [],
  events: [],
  liveEventIds: new Set<number>(),
  cursor: 0,
  status: 'loading',
  error: null,
};

export function useEventStream(campaignId: string): EventStreamState {
  const [state, setState] = useState<Omit<EventStreamState, 'retry'>>(EMPTY_STATE);
  const [retryKey, setRetryKey] = useState(0);
  const cursorRef = useRef(0);

  const retry = useCallback(() => setRetryKey((value) => value + 1), []);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    let snapshotRequest = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    cursorRef.current = 0;

    const setError = (error: unknown) => {
      if (disposed) return;
      setState((current) => ({
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }));
    };

    const applySnapshot = (payload: SnapshotResponse) => {
      const incomingEvents = normalizeEvents(payload.events);
      const nextCursor = Math.max(
        cursorRef.current,
        payload.cursor ?? 0,
        ...incomingEvents.map((event) => event.id),
      );
      cursorRef.current = nextCursor;

      setState((current) => ({
        ...current,
        campaign: payload.campaign,
        transcript: payload.transcript,
        segments: payload.segments ?? [],
        strategy: payload.strategy,
        campaignReview: payload.campaign_review,
        assets: attachReviews(payload.assets ?? [], payload.reviews ?? []),
        events: mergeEvents(current.events, incomingEvents),
        cursor: nextCursor,
        error: null,
      }));
    };

    const loadSnapshot = async (initial: boolean) => {
      const requestNumber = ++snapshotRequest;
      const response = await fetch(
        `/api/campaigns/${campaignId}?cursor=${initial ? 0 : cursorRef.current}`,
        { cache: 'no-store' },
      );
      const payload = (await response.json()) as SnapshotResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Snapshot failed with status ${response.status}.`);
      if (disposed || requestNumber !== snapshotRequest) return;
      applySnapshot(payload);
    };

    /**
     * A node that emits ten tool events in a second must not trigger ten full
     * snapshot fetches. Events already carry the timeline; the snapshot exists
     * to refresh the rows around it (status, assets, strategy), so a trailing
     * refresh per burst is enough and keeps the dashboard responsive.
     */
    const scheduleRefresh = () => {
      if (disposed || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void loadSnapshot(false).catch((error: unknown) => {
          if (!disposed) setError(error);
        });
      }, SNAPSHOT_REFRESH_MS);
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      const delay = Math.min(8_000, 1_000 * 2 ** Math.min(reconnectAttempt, 3));
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;
      if (typeof EventSource === 'undefined') {
        setError('This browser does not support live event streams.');
        return;
      }

      setState((current) => ({
        ...current,
        status: reconnectAttempt > 0 ? 'reconnecting' : 'connecting',
      }));
      source?.close();
      const nextSource = new EventSource(
        `/api/campaigns/${campaignId}/events?cursor=${cursorRef.current}`,
      );
      source = nextSource;

      nextSource.onopen = () => {
        reconnectAttempt = 0;
        setState((current) => ({ ...current, status: 'connected', error: null }));
      };

      nextSource.onmessage = (message) => {
        const event = parseEvent(message.data);
        if (!event || event.id <= cursorRef.current) return;
        cursorRef.current = event.id;
        setState((current) => ({
          ...current,
          events: mergeEvents(current.events, [event]),
          liveEventIds: rememberLiveId(current.liveEventIds, event.id),
          cursor: event.id,
          status: 'connected',
          error: null,
        }));
        scheduleRefresh();
      };

      nextSource.onerror = () => {
        if (source !== nextSource) return;
        nextSource.close();
        source = null;
        if (disposed) return;
        setState((current) => ({
          ...current,
          status: 'reconnecting',
          error: 'Live connection lost. Reconnecting from the last event...',
        }));
        scheduleReconnect();
      };
    };

    const start = async () => {
      try {
        await loadSnapshot(true);
        if (!disposed) connect();
      } catch (error) {
        setError(error);
      }
    };

    void start();

    // A proxy can hold an SSE connection open while delivering nothing, which
    // never trips `onerror`. A slow snapshot poll means the worst case is a
    // stale-by-seconds dashboard rather than one that looks frozen.
    const safetyTimer = setInterval(() => {
      void loadSnapshot(false).catch(() => {});
    }, SAFETY_POLL_MS);

    return () => {
      disposed = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(safetyTimer);
    };
  }, [campaignId, retryKey]);

  return { ...state, retry };
}

function attachReviews(assets: AssetView[], reviews: AssetReviewView[]): AssetView[] {
  return assets.map((asset) => ({
    ...asset,
    reviews: reviews.filter((review) => review.asset_id === asset.id),
  }));
}

function rememberLiveId(current: ReadonlySet<number>, id: number): ReadonlySet<number> {
  const next = [...current, id];
  return new Set(next.slice(-LIVE_ID_MEMORY));
}

function mergeEvents(current: CampaignEvent[], incoming: CampaignEvent[]): CampaignEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

function normalizeEvents(value: unknown): CampaignEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const event = parseEvent(candidate);
    return event ? [event] : [];
  });
}

/**
 * Accepts either a decoded row (snapshot backfill) or the raw `data:` line of an
 * SSE frame, which arrives as a JSON *string*. Rejecting strings here silently
 * dropped every live event and made the dashboard look like it needed a refresh.
 */
function parseEvent(value: unknown): CampaignEvent | null {
  const decoded = typeof value === 'string' ? safeJsonParse(value) : value;
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
  const candidate = decoded as Record<string, unknown>;
  const id = typeof candidate.id === 'number' ? candidate.id : Number(candidate.id);
  if (!Number.isSafeInteger(id) || id < 0) return null;
  if (typeof candidate.agent !== 'string' || typeof candidate.message !== 'string') return null;
  const level = candidate.level;
  if (level !== 'info' && level !== 'decision' && level !== 'tool' && level !== 'warn' && level !== 'error') {
    return null;
  }
  return {
    id,
    campaign_id: typeof candidate.campaign_id === 'string' ? candidate.campaign_id : '',
    agent_run_id: typeof candidate.agent_run_id === 'string' ? candidate.agent_run_id : null,
    agent: candidate.agent,
    node: typeof candidate.node === 'string' ? candidate.node : null,
    level,
    message: candidate.message,
    data: candidate.data ?? null,
    created_at: typeof candidate.created_at === 'string' ? candidate.created_at : new Date(0).toISOString(),
  };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

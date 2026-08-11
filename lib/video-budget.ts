import type { AssetRow, SegmentRow } from '@/lib/db/client';

/**
 * `campaigns.max_video_seconds` is an aggregate allowance for the final
 * short-video portfolio. These statuses can still reserve part of it while a
 * campaign is in production; rejected, abandoned, and replaced history cannot.
 */
const VIDEO_BUDGET_STATUSES = new Set([
  'planned',
  'generating',
  'needs_review',
  'revising',
  'passed',
]);

export type TimedSegment = Pick<SegmentRow, 'id' | 'start_time' | 'end_time'>;

export interface PlannedVideoAsset {
  plan_key: string;
  type: string;
  segment_ids: readonly string[];
}

export interface BudgetAsset {
  plan_key: string;
  type: string;
  status?: string | null;
  duration_sec?: number | string | null;
}

/** Return a source span's usable duration, or zero for malformed timestamps. */
export function sourceSpanDuration(segment: Pick<SegmentRow, 'start_time' | 'end_time'>): number {
  const start = Number(segment.start_time);
  const end = Number(segment.end_time);
  const duration = end - start;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/**
 * A Strategist plan contains source spans rather than final cut points. Reserve
 * the selected spans, bounded by the allowance, because the Clip Producer can
 * choose a legal word-aligned sub-span from a longer source segment.
 */
export function plannedVideoDuration(
  sourceDurations: readonly number[],
  maxVideoSeconds: number,
): number {
  if (!Number.isFinite(maxVideoSeconds) || maxVideoSeconds <= 0) return 0;
  const sourceDuration = sourceDurations.reduce(
    (total, duration) => total + (Number.isFinite(duration) && duration > 0 ? duration : 0),
    0,
  );
  return Math.min(sourceDuration, maxVideoSeconds);
}

export function plannedVideoDurationForAsset(
  asset: PlannedVideoAsset,
  segments: readonly TimedSegment[],
  maxVideoSeconds: number,
): number {
  if (asset.type !== 'short_video') return 0;
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  return plannedVideoDuration(
    asset.segment_ids.map((id) => {
      const segment = segmentById.get(id);
      return segment ? sourceSpanDuration(segment) : 0;
    }),
    maxVideoSeconds,
  );
}

export function totalPlannedVideoDuration(
  assets: readonly PlannedVideoAsset[],
  segments: readonly TimedSegment[],
  maxVideoSeconds: number,
): number {
  return assets.reduce(
    (total, asset) => total + plannedVideoDurationForAsset(asset, segments, maxVideoSeconds),
    0,
  );
}

/**
 * Calculate the allowance available to one asset after every other active or
 * passing video asset has reserved its actual render duration. Assets without a
 * render yet reserve their source-derived planned duration instead.
 */
export function remainingVideoBudget(input: {
  maxVideoSeconds: number;
  plannedAssets: readonly PlannedVideoAsset[];
  segments: readonly TimedSegment[];
  assets: readonly BudgetAsset[];
  excludePlanKey?: string;
}): number {
  const assetByKey = new Map(input.assets.map((asset) => [asset.plan_key, asset]));
  let reserved = 0;

  for (const planned of input.plannedAssets) {
    if (planned.type !== 'short_video' || planned.plan_key === input.excludePlanKey) continue;

    const existing = assetByKey.get(planned.plan_key);
    // A missing row is treated as active. In normal production the rows are
    // materialized first, but reserving it here is safer for old/direct rows.
    if (existing && !countsTowardVideoBudget(existing.status)) continue;

    const plannedDuration = plannedVideoDurationForAsset(
      planned,
      input.segments,
      input.maxVideoSeconds,
    );
    const measuredDuration = existing ? positiveFiniteNumber(existing.duration_sec) : null;
    reserved += measuredDuration ?? plannedDuration;
  }

  return Math.max(0, input.maxVideoSeconds - reserved);
}

export function countsTowardVideoBudget(status: string | null | undefined): boolean {
  return status === undefined || status === null || VIDEO_BUDGET_STATUSES.has(status);
}

export function totalPassedVideoDuration(
  assets: readonly Pick<AssetRow, 'type' | 'status' | 'duration_sec'>[],
): number {
  return assets.reduce((total, asset) => {
    if (asset.type !== 'short_video' || asset.status !== 'passed') return total;
    return total + (positiveFiniteNumber(asset.duration_sec) ?? 0);
  }, 0);
}

export function positiveFiniteNumber(value: number | string | null | undefined): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function videoBudgetError(
  actualSeconds: number,
  maxVideoSeconds: number,
  subject = 'passed short-video assets',
): string | null {
  return actualSeconds > maxVideoSeconds + 0.000001
    ? `${subject} use ${actualSeconds.toFixed(2)} seconds in total, above the ${maxVideoSeconds.toFixed(2)} second campaign-wide video budget.`
    : null;
}

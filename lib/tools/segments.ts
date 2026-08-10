import { db, type SegmentRow } from '@/lib/db/client';
import type { AnalyzedSegment, ContentType } from '@/lib/agents/source-analyst';
import { getTranscript } from '@/lib/tools/transcript';
import type { Word } from '@/lib/media/transcribe';

/**
 * Segment access. Part of the tool layer, which is the only path an agent takes
 * to the world: no agent file imports the Supabase client, so every read and
 * write an agent performs is a call that can be logged and shown in the timeline.
 */

export interface SegmentFilter {
  /** Only these content types. Used by the Strategist to ignore tangents. */
  contentTypes?: ContentType[];
  minStandalone?: number;
  limit?: number;
}

export async function getSegments(
  campaignId: string,
  filter: SegmentFilter = {},
): Promise<SegmentRow[]> {
  let query = db()
    .from('segments')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('start_time', { ascending: true });

  if (filter.contentTypes?.length) query = query.in('content_type', filter.contentTypes);
  if (filter.minStandalone !== undefined) {
    query = query.gte('standalone_score', filter.minStandalone);
  }
  if (filter.limit !== undefined) query = query.limit(filter.limit);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to read segments: ${error.message}`);
  return data ?? [];
}

export interface ReadSegmentResult {
  id: string;
  transcript: string;
  words: Word[];
  start: number;
  end: number;
  topic: string;
}

/** Verbatim segment text plus source-timeline words for clip boundaries. */
export async function readSegment(segmentId: string): Promise<ReadSegmentResult> {
  const { data: segment, error } = await db()
    .from('segments')
    .select('*')
    .eq('id', segmentId)
    .single();
  if (error) throw new Error(`Failed to read segment ${segmentId}: ${error.message}`);

  const start = Number(segment.start_time);
  const end = Number(segment.end_time);
  const transcript = await getTranscript(segment.campaign_id);
  return {
    id: segment.id,
    transcript: segment.transcript,
    words: transcript.words.filter((word) => word.e > start && word.s < end),
    start,
    end,
    topic: segment.topic,
  };
}

export async function countSegments(campaignId: string): Promise<number> {
  const { count, error } = await db()
    .from('segments')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId);

  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Replace a campaign's segments with a fresh analysis.
 *
 * Delete-then-insert rather than upsert, because segment ids are generated and a
 * re-analysis produces genuinely different segments, not new versions of the old
 * ones. The delete matters: a campaign re-analyzed after a crash mid-insert
 * would otherwise end up with a partial old run interleaved with a complete new
 * one, and nothing downstream could tell them apart.
 *
 * Nothing references `segments.id` yet at this point in the graph - strategies
 * are written after `analyze` - so this cannot orphan a foreign key.
 */
export async function saveSegments(
  campaignId: string,
  segments: AnalyzedSegment[],
): Promise<SegmentRow[]> {
  const { error: deleteError } = await db()
    .from('segments')
    .delete()
    .eq('campaign_id', campaignId);
  if (deleteError) throw new Error(`Failed to clear old segments: ${deleteError.message}`);

  if (segments.length === 0) return [];

  const { data, error } = await db()
    .from('segments')
    .insert(
      segments.map((segment) => ({
        campaign_id: campaignId,
        start_time: segment.start_time,
        end_time: segment.end_time,
        transcript: segment.transcript,
        topic: segment.topic,
        summary: segment.summary,
        content_type: segment.content_type,
        energy: segment.energy,
        standalone_score: segment.standalone_score,
        novelty_score: segment.novelty_score,
        potential_hooks: segment.potential_hooks,
        context_deps: segment.context_deps,
      })),
    )
    .select();

  if (error) throw new Error(`Failed to save segments: ${error.message}`);
  return data ?? [];
}

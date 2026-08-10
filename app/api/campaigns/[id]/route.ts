import { db } from '@/lib/db/client';
import { readEventsSince } from '@/lib/events';

/**
 * Full state snapshot for the dashboard.
 *
 * `?cursor=` returns only events newer than that id, so the page can poll
 * cheaply without re-sending the whole timeline. `agent_events.id` is a
 * monotonic bigint for exactly this reason. Phase 8 replaces the polling with
 * the SSE route; the cursor contract is the same either way.
 *
 * The browser never holds database credentials: this handler runs server-side
 * with the service role key and returns only what the UI needs.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const cursor = Number(new URL(request.url).searchParams.get('cursor') ?? 0);

  const { data: campaign, error } = await db()
    .from('campaigns')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!campaign) return Response.json({ error: 'Campaign not found.' }, { status: 404 });

  // These reads are independent. Start them together so the dashboard pays one
  // database round-trip interval rather than four in series.
  const [transcriptResult, segmentsResult, strategyResult, events] = await Promise.all([
    // The transcript itself is up to a megabyte of text and nothing on the
    // dashboard renders it, so the snapshot carries only proof that it exists.
    db()
      .from('transcripts')
      .select('language, provider, created_at, words')
      .eq('campaign_id', id)
      .maybeSingle(),
    // There are at most 20 segments and they only change when analysis re-runs.
    db()
      .from('segments')
      .select(
        'id, start_time, end_time, topic, summary, content_type, energy, standalone_score, novelty_score, potential_hooks, context_deps',
      )
      .eq('campaign_id', id)
      .order('start_time', { ascending: true }),
    db()
      .from('strategies')
      .select('id, version, rationale, selected_topics, rejected_topics, planned_assets, approved_by, created_at')
      .eq('campaign_id', id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle(),
    readEventsSince(id, Number.isFinite(cursor) ? cursor : 0),
  ]);

  const secondaryError = transcriptResult.error ?? segmentsResult.error ?? strategyResult.error;
  if (secondaryError) return Response.json({ error: secondaryError.message }, { status: 500 });

  const transcript = transcriptResult.data;
  const segments = segmentsResult.data;

  return Response.json({
    campaign,
    transcript: transcript
      ? {
          language: transcript.language,
          provider: transcript.provider,
          created_at: transcript.created_at,
          word_count: Array.isArray(transcript.words) ? transcript.words.length : 0,
        }
      : null,
    segments: segments ?? [],
    strategy: strategyResult.data,
    events,
    cursor: events.length > 0 ? events[events.length - 1].id : cursor,
  });
}

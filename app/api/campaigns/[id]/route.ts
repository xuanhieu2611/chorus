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

  // The transcript itself is up to a megabyte of text and nothing on the
  // dashboard renders it, so the snapshot carries only proof that it exists.
  const { data: transcript } = await db()
    .from('transcripts')
    .select('language, provider, created_at, words')
    .eq('campaign_id', id)
    .maybeSingle();

  const events = await readEventsSince(id, Number.isFinite(cursor) ? cursor : 0);

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
    events,
    cursor: events.length > 0 ? events[events.length - 1].id : cursor,
  });
}

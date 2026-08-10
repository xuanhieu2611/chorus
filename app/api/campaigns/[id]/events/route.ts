import { db } from '@/lib/db/client';
import { readEventsSince } from '@/lib/events';
import type { CampaignEvent } from '@/lib/events/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const POLL_INTERVAL_MS = 750;

/**
 * Poll-over-SSE keeps the worker and the web process independent. The cursor is
 * the database identity column, not a timestamp, so reconnects cannot miss two
 * events emitted in the same millisecond.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const campaignResult = await db().from('campaigns').select('id').eq('id', id).maybeSingle();

  if (campaignResult.error) {
    return Response.json({ error: campaignResult.error.message }, { status: 500 });
  }
  if (!campaignResult.data) return Response.json({ error: 'Campaign not found.' }, { status: 404 });

  const initialCursor = parseCursor(new URL(request.url).searchParams.get('cursor'));
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = initialCursor;
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        closed = true;
        if (timer) clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => cleanup();

      const poll = async () => {
        if (closed) return;

        try {
          const events = await readEventsSince(id, cursor);
          for (const event of events) {
            if (closed) return;
            const payload = event as CampaignEvent;
            controller.enqueue(encoder.encode(formatEvent(payload)));
            cursor = payload.id;
          }
          if (!closed) controller.enqueue(encoder.encode(': keep-alive\n\n'));
          if (!closed) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        } catch (error) {
          if (closed) return;
          controller.error(error instanceof Error ? error : new Error(String(error)));
          cleanup();
        }
      };

      request.signal.addEventListener('abort', onAbort);
      void poll();
    },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
}

function parseCursor(value: string | null): number {
  if (!value) return 0;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function formatEvent(event: CampaignEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

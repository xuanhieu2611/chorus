import { db, type AgentEventRow } from '@/lib/db/client';
import type { Json } from '@/lib/db/database.types';
import type { EventLevel } from '@/lib/events/types';

export type { CampaignEvent, EventLevel } from '@/lib/events/types';

export interface EmitInput {
  campaignId: string;
  agent: string;
  node?: string | null;
  level?: EventLevel;
  message: string;
  data?: Json;
  agentRunId?: string | null;
}

/**
 * Append one row to `agent_events`. This is the only writer.
 *
 * `agent_events.id` is a monotonic bigint, which is the SSE cursor: the events
 * route streams rows with `id > cursor`, so a browser reconnect resumes exactly
 * where it stopped. Anything the UI needs to show has to pass through here.
 *
 * Emitting must never take down a campaign. A failed insert is logged and
 * swallowed: losing a timeline line is a cosmetic problem, throwing out of a
 * graph node over one is not.
 */
export async function emit(input: EmitInput): Promise<AgentEventRow | null> {
  const row = {
    campaign_id: input.campaignId,
    agent_run_id: input.agentRunId ?? null,
    agent: input.agent,
    node: input.node ?? null,
    level: input.level ?? 'info',
    message: input.message,
    data: input.data ?? null,
  };

  const { data, error } = await db().from('agent_events').insert(row).select().single();

  if (error) {
    console.error(`[events] failed to emit "${input.message}": ${error.message}`);
    return null;
  }
  return data;
}

/** Reads events after a cursor. Drives the SSE route and the timeline backfill. */
export async function readEventsSince(campaignId: string, cursor: number, limit = 200) {
  const { data, error } = await db()
    .from('agent_events')
    .select('*')
    .eq('campaign_id', campaignId)
    .gt('id', cursor)
    .order('id', { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);
  return data ?? [];
}

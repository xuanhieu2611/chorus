import { db } from '@/lib/db/client';
import type { Json } from '@/lib/db/database.types';
import type { Word } from '@/lib/media/transcribe';

/**
 * Transcript access. Part of the tool layer, which is the only path an agent
 * takes to the world: no agent file imports the Supabase client, so every read
 * and write an agent performs is a call that can be logged to
 * `agent_runs.tool_calls` and shown in the timeline.
 */

export interface Transcript {
  text: string;
  words: Word[];
  language: string | null;
  provider: string;
}

export async function getTranscript(campaignId: string): Promise<Transcript> {
  const { data: row, error } = await db()
    .from('transcripts')
    .select('text, words, language, provider')
    .eq('campaign_id', campaignId)
    .single();

  if (error) throw new Error(`No transcript for campaign ${campaignId}: ${error.message}`);

  return {
    text: row.text,
    // `words` is jsonb, so the generated type is `Json`. The shape is written by
    // `saveTranscript` and never by hand.
    words: row.words as unknown as Word[],
    language: row.language,
    provider: row.provider,
  };
}

export async function hasTranscript(campaignId: string): Promise<boolean> {
  const { count, error } = await db()
    .from('transcripts')
    .select('campaign_id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId);

  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

/**
 * Upsert rather than insert: a campaign resumed after a crash in a later node
 * must not fail on a primary key collision with its own transcript.
 */
export async function saveTranscript(
  campaignId: string,
  input: { text: string; words: Word[]; language: string | null; provider: string },
): Promise<void> {
  const { error } = await db()
    .from('transcripts')
    .upsert(
      {
        campaign_id: campaignId,
        text: input.text,
        words: input.words as unknown as Json,
        language: input.language,
        provider: input.provider,
      },
      { onConflict: 'campaign_id' },
    );

  if (error) throw new Error(`Failed to save transcript: ${error.message}`);
}

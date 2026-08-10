import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import type { Database } from '@/lib/db/database.types';

/**
 * The service-role Supabase client. Bypasses RLS by design.
 *
 * RLS is enabled on every table with zero policies, which denies everything.
 * This key is the only way anything reads or writes, and it must never reach the
 * browser: import this module from route handlers, the worker, and scripts only.
 */
let client: SupabaseClient<Database> | null = null;

export function db(): SupabaseClient<Database> {
  if (!client) {
    client = createClient<Database>(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export type Tables = Database['public']['Tables'];
export type CampaignRow = Tables['campaigns']['Row'];
export type CampaignPatch = Tables['campaigns']['Update'];
export type TranscriptRow = Tables['transcripts']['Row'];
export type SegmentRow = Tables['segments']['Row'];
export type StrategyRow = Tables['strategies']['Row'];
export type AssetRow = Tables['assets']['Row'];
export type ReviewRow = Tables['reviews']['Row'];
export type CampaignReviewRow = Tables['campaign_reviews']['Row'];
export type AgentRunRow = Tables['agent_runs']['Row'];
export type AgentEventRow = Tables['agent_events']['Row'];

/** Throws on a PostgREST error instead of letting a null result flow onward. */
export function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error('Query returned no rows.');
  return result.data;
}

export type EventLevel = 'info' | 'decision' | 'tool' | 'warn' | 'error';

/** The server-safe shape sent by the snapshot and SSE routes. */
export interface CampaignEvent {
  id: number;
  campaign_id: string;
  agent_run_id: string | null;
  agent: string;
  node: string | null;
  level: EventLevel;
  message: string;
  data: unknown;
  created_at: string;
}

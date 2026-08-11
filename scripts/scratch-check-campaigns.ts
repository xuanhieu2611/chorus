import { loadEnv } from '../lib/load-env';
import { db } from '../lib/db/client';

async function main() {
  loadEnv();
  const campaignId = '922719a4-f125-4355-9625-90d8042f4039';

  const { data: campaign } = await db().from('campaigns').select('status, current_node, error, replan_count, cost_usd').eq('id', campaignId).single();
  console.log(campaign);

  const { data: events } = await db()
    .from('agent_events')
    .select('id, agent, node, level, message, created_at')
    .eq('campaign_id', campaignId)
    .order('id', { ascending: false })
    .limit(15);
  for (const e of (events ?? []).reverse()) {
    console.log(`[${e.id}] ${e.level.toUpperCase()} ${e.agent ?? '-'}/${e.node ?? '-'}: ${e.message}`);
  }
}

main();

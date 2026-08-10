import { hostname } from 'node:os';
import { loadEnv } from '../lib/load-env';
import { db, type CampaignRow } from '../lib/db/client';
import { emit } from '../lib/events';
import { env } from '../lib/env';
import { assertBudget, CostCeilingExceededError } from '../lib/llm/budget';

loadEnv();

/**
 * The worker. One of two processes; the Next.js app is the other.
 *
 * The app never runs the agent graph. It writes a campaign row with
 * `status = 'queued'` and returns immediately. This process claims that row via
 * `claim_campaign` (`for update skip locked`) and runs the graph to completion or
 * to a human gate. That split is why a 20 minute campaign is not bounded by any
 * HTTP request timeout, and why two workers can run side by side without ever
 * being handed the same campaign.
 *
 * Phase 0 scope: claim, heartbeat, log, release. The graph executor lands in
 * Phase 1 at the marked seam.
 */

const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const WORKER_ID = `${hostname()}:${process.pid}`;

let shuttingDown = false;

async function claim(): Promise<CampaignRow | null> {
  // `claim_campaign` returns `setof campaigns`: zero rows means nothing was
  // claimed. It returned a composite type once, and a NULL composite reaches
  // PostgREST as a row of all-null columns, which reads as a successful claim of
  // a campaign with a null id. See migration 0003.
  const { data, error } = await db().rpc('claim_campaign', { p_worker: WORKER_ID });
  if (error) throw new Error(`claim_campaign failed: ${error.message}`);

  const rows = (data ?? []) as CampaignRow[];
  return rows[0] ?? null;
}

/**
 * Proof of life while a campaign runs. Nothing reclaims a stale campaign yet;
 * automatic recovery from an abandoned claim is Phase 9 work. Until then the
 * column is the evidence you need to tell "stuck" from "still working".
 */
function startHeartbeat(campaignId: string): () => void {
  const timer = setInterval(async () => {
    const { error } = await db()
      .from('campaigns')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', campaignId);
    if (error) console.error(`[worker] heartbeat failed: ${error.message}`);
  }, HEARTBEAT_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}

async function runCampaign(campaign: CampaignRow): Promise<void> {
  const stopHeartbeat = startHeartbeat(campaign.id);

  await emit({
    campaignId: campaign.id,
    agent: 'worker',
    node: campaign.current_node,
    level: 'info',
    message: `Claimed by ${WORKER_ID}${campaign.current_node ? ` (resuming at ${campaign.current_node})` : ''}.`,
    data: { worker: WORKER_ID, goal: campaign.goal },
  });

  try {
    // The ceiling is checked before any work, not only between nodes, so a
    // campaign that was already over budget cannot be restarted into more spend.
    await assertBudget(campaign.id);

    // ---------------------------------------------------------------------
    // Phase 1 seam: `await runGraph({ campaign })` from lib/graph/run.ts goes
    // here. Until then the claim loop is exercised end to end without agents.
    // ---------------------------------------------------------------------
    await emit({
      campaignId: campaign.id,
      agent: 'worker',
      node: campaign.current_node,
      level: 'decision',
      message: 'No graph wired up yet (Phase 0). Marking the campaign complete.',
    });

    await db()
      .from('campaigns')
      .update({ status: 'complete', current_node: null, updated_at: new Date().toISOString() })
      .eq('id', campaign.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await emit({
      campaignId: campaign.id,
      agent: 'worker',
      node: campaign.current_node,
      level: 'error',
      message:
        error instanceof CostCeilingExceededError
          ? `Campaign halted on the cost ceiling: ${message}`
          : `Campaign failed: ${message}`,
    });

    await db()
      .from('campaigns')
      .update({ status: 'failed', error: message, updated_at: new Date().toISOString() })
      .eq('id', campaign.id);
  } finally {
    stopHeartbeat();
  }
}

async function loop(): Promise<void> {
  console.log(`[worker] ${WORKER_ID} polling for queued campaigns.`);

  // A cheap dev model silently in effect during a demo is a bad surprise, so it
  // announces itself every boot.
  if (env.modelOverrideAll) {
    console.log(
      `[worker] MODEL_OVERRIDE_ALL is set: every agent uses ${env.modelOverrideAll}. ` +
        'Unset it in .env.local for real output quality.',
    );
  } else {
    console.log(
      `[worker] models: reasoning=${env.modelReasoning} fast=${env.modelFast} vision=${env.modelVision}`,
    );
  }

  while (!shuttingDown) {
    let campaign: CampaignRow | null = null;
    try {
      campaign = await claim();
    } catch (error) {
      console.error(`[worker] ${error instanceof Error ? error.message : error}`);
    }

    if (!campaign) {
      // `--once` keeps the Phase 0 check honest: claim a row, log, exit clean.
      if (process.argv.includes('--once')) {
        console.log('[worker] nothing queued; exiting (--once).');
        return;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    console.log(`[worker] claimed campaign ${campaign.id}`);
    await runCampaign(campaign);
    console.log(`[worker] finished campaign ${campaign.id}`);

    if (process.argv.includes('--once')) return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`\n[worker] ${signal} received, finishing current campaign then exiting.`);
  });
}

loop()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[worker] fatal:', error);
    process.exit(1);
  });

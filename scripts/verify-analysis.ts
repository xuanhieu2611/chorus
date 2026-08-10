import { loadEnv } from '../lib/load-env';

/**
 * Run the Source Analyst over a campaign's existing transcript with a forced
 * window size, and print what came back without writing anything.
 *
 *   npx tsx scripts/verify-analysis.ts <campaign-id> [windowSeconds] [overlapSeconds]
 *
 * The unit tests in `lib/agents/source-analyst.test.ts` prove the windowing and
 * boundary arithmetic. This proves the map-reduce is actually wired to it: that
 * several windows really are analyzed in parallel, that the reduce pass sees
 * candidates from all of them, and that a topic straddling a boundary comes back
 * as one segment rather than two.
 *
 * Shrinking the window is what makes that reachable without a 90 minute
 * recording - at the production 480 seconds, a test clip is a single window and
 * the interesting half of this agent never runs. It costs real model calls and
 * charges them to the campaign, which is why it is a script rather than a test.
 */
async function main(): Promise<void> {
  loadEnv();
  const { analyzeSource } = await import('../lib/agents/source-analyst');
  const { getTranscript } = await import('../lib/tools');
  const { db } = await import('../lib/db/client');

  const campaignId = process.argv[2];
  const windowSeconds = Number(process.argv[3] ?? 20);
  const overlapSeconds = Number(process.argv[4] ?? 5);
  if (!campaignId) {
    throw new Error(
      'Usage: npx tsx scripts/verify-analysis.ts <campaign-id> [windowSeconds] [overlapSeconds]',
    );
  }

  const { data: campaign, error } = await db()
    .from('campaigns')
    .select('goal, audience, brand_voice, source_duration_sec')
    .eq('id', campaignId)
    .single();
  if (error) throw new Error(error.message);

  const transcript = await getTranscript(campaignId);
  console.log(
    `transcript: ${transcript.words.length} words over ${Number(campaign.source_duration_sec ?? 0).toFixed(1)}s`,
  );
  console.log(`windows:    ${windowSeconds}s with ${overlapSeconds}s overlap\n`);

  const started = Date.now();
  const result = await analyzeSource({
    campaignId,
    words: transcript.words,
    goal: campaign.goal,
    audience: campaign.audience,
    brandVoice: campaign.brand_voice,
    windowSeconds,
    overlapSeconds,
    onProgress: ({ done, of }) => console.log(`  window ${done}/${of}`),
    onWindowFailure: ({ index, error: message }) =>
      console.log(`  window ${index + 1} FAILED: ${message}`),
  });

  console.log(
    `\n${result.windowCount} windows -> ${result.candidateCount} candidates -> ${result.segments.length} segments in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  if (result.failedWindows > 0) console.log(`${result.failedWindows} window(s) failed`);
  console.log(`\nreduce reasoning: ${result.reasoning}\n`);

  for (const segment of result.segments) {
    console.log(
      `[${segment.start_time.toFixed(1)}-${segment.end_time.toFixed(1)}] (${segment.content_type}) ${segment.topic}`,
    );
    console.log(
      `   standalone ${segment.standalone_score.toFixed(2)}  novelty ${segment.novelty_score.toFixed(2)}  energy ${segment.energy.toFixed(2)}`,
    );
    console.log(`   ${segment.summary}`);
    if (segment.potential_hooks.length > 0) console.log(`   hook: ${segment.potential_hooks[0]}`);
    console.log(`   text: ${segment.transcript.slice(0, 120)}...\n`);
  }

  // A segment whose span is not inside the transcript would render as the wrong
  // sentence, and nothing downstream would notice.
  const last = transcript.words[transcript.words.length - 1].e;
  const outOfRange = result.segments.filter((s) => s.start_time < 0 || s.end_time > last + 0.001);
  console.log(
    outOfRange.length === 0
      ? `all ${result.segments.length} segments inside the transcript span (0 to ${last.toFixed(1)}s)`
      : `${outOfRange.length} SEGMENT(S) OUTSIDE THE TRANSCRIPT SPAN`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

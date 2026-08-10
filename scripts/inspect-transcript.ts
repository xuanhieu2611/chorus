import { loadEnv } from '../lib/load-env';

/**
 * Print a stored transcript's shape for a campaign.
 *
 *   npx tsx scripts/inspect-transcript.ts <campaign-id>
 *
 * This is the fastest way to catch the chunk-offset bug on real media: word
 * timestamps must be monotonic and must span the source duration. A merge that
 * dropped the offset looks perfectly healthy in the UI and produces a transcript
 * where every chunk restarts near zero.
 */
async function main(): Promise<void> {
  loadEnv();
  const { db } = await import('../lib/db/client');

  const campaignId = process.argv[2];
  if (!campaignId) throw new Error('Usage: npx tsx scripts/inspect-transcript.ts <campaign-id>');

  const { data, error } = await db()
    .from('transcripts')
    .select('*')
    .eq('campaign_id', campaignId)
    .single();
  if (error) throw new Error(error.message);

  const words = data.words as unknown as Array<{ w: string; s: number; e: number }>;
  if (words.length === 0) throw new Error('Transcript has no words.');

  const outOfOrder = words.filter((word, i) => i > 0 && word.s < words[i - 1].s).length;

  console.log(`language:  ${data.language} (${data.provider})`);
  console.log(`words:     ${words.length}`);
  console.log(`span:      ${words[0].s.toFixed(2)}s -> ${words.at(-1)!.e.toFixed(2)}s`);
  console.log(`monotonic: ${outOfOrder === 0 ? 'yes' : `NO - ${outOfOrder} words go backwards`}`);
  console.log(`\nfirst:  ${preview(words.slice(0, 8))}`);
  console.log(`last:   ${preview(words.slice(-8))}`);
  console.log(`\ntext:   ${data.text.slice(0, 300)}${data.text.length > 300 ? '…' : ''}`);
}

function preview(words: Array<{ w: string; s: number }>): string {
  return words.map((word) => `${word.w}@${word.s.toFixed(2)}`).join(' ');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

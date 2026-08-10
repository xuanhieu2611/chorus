import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../lib/load-env';

/**
 * Transcribe one audio file twice - once whole, once forced through the chunked
 * path - and compare the timelines.
 *
 *   npx tsx scripts/verify-chunking.ts <audio-file> [chunkSeconds]
 *
 * The unit tests in `lib/media/transcribe.test.ts` prove the merge arithmetic.
 * This proves the arithmetic is wired to the real slicing: that chunk three of a
 * real MP3 lands where chunk three of the source actually is, frame-boundary
 * rounding included. It costs a couple of cents of Groq time and needs a real
 * key, which is why it is a script rather than part of `npm test`.
 */
async function main(): Promise<void> {
  loadEnv();
  const { probe } = await import('../lib/media/ffmpeg');
  const { transcribeAudio } = await import('../lib/media/transcribe');

  const audioPath = process.argv[2];
  const chunkSeconds = Number(process.argv[3] ?? 20);
  if (!audioPath) throw new Error('Usage: npx tsx scripts/verify-chunking.ts <audio-file> [chunkSeconds]');

  const { durationSec } = await probe(audioPath);
  const workDir = await mkdtemp(join(tmpdir(), 'chorus-chunk-'));

  try {
    const whole = await transcribeAudio(audioPath, { durationSec, workDir });
    const chunked = await transcribeAudio(audioPath, {
      durationSec,
      workDir,
      chunkSeconds,
      maxUploadBytes: 1, // force the chunked path regardless of file size
    });

    console.log(`duration:   ${durationSec.toFixed(2)}s`);
    console.log(`whole:      ${whole.words.length} words, 1 request`);
    console.log(`chunked:    ${chunked.words.length} words, ${chunked.chunkCount} requests`);
    console.log(`last word:  whole ${last(whole.words)} vs chunked ${last(chunked.words)}`);

    const drift = compare(whole.words, chunked.words);
    console.log(`\nmax drift:  ${drift.max.toFixed(2)}s on "${drift.word}"`);
    console.log(
      drift.max < 1
        ? 'PASS - chunk offsets line up with the whole-file timeline.'
        : 'FAIL - chunked timestamps do not match the whole-file timeline.',
    );
    process.exitCode = drift.max < 1 ? 0 : 1;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Whisper does not return byte-identical words across runs, so this walks the
 * two lists in parallel and compares timestamps only where the words agree.
 * A dropped offset shows up as tens or hundreds of seconds of drift, not the
 * sub-second wobble two runs of the same model produce.
 */
function compare(
  whole: Array<{ w: string; s: number }>,
  chunked: Array<{ w: string; s: number }>,
): { max: number; word: string } {
  let max = 0;
  let word = '';

  for (let i = 0; i < Math.min(whole.length, chunked.length); i++) {
    if (normalize(whole[i].w) !== normalize(chunked[i].w)) continue;
    const delta = Math.abs(whole[i].s - chunked[i].s);
    if (delta > max) {
      max = delta;
      word = whole[i].w;
    }
  }
  return { max, word };
}

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function last(words: Array<{ w: string; s: number }>): string {
  const word = words.at(-1);
  return word ? `${word.w}@${word.s.toFixed(2)}s` : 'none';
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

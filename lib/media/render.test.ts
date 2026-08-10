import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { inspectClip } from '@/lib/agents/clip-producer';
import { probe, renderVertical } from '@/lib/media/ffmpeg';
import { generateAssSubtitles } from '@/lib/media/subtitles';
import type { Word } from '@/lib/media/transcribe';

const exec = promisify(execFile);
const TEST_FFMPEG =
  process.env.FFMPEG_PATH ??
  (process.platform === 'darwin' ? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg' : 'ffmpeg');
process.env.FFMPEG_PATH = TEST_FFMPEG;
process.env.FFPROBE_PATH ??=
  process.platform === 'darwin' ? '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe' : 'ffprobe';
const START = 1;
const END = 3.2;
const WORDS: Word[] = [
  { w: 'This', s: 1, e: 1.35 },
  { w: 'render', s: 1.4, e: 1.85 },
  { w: 'matches', s: 1.9, e: 2.35 },
  { w: 'boundaries', s: 2.4, e: 2.9 },
];

async function fixture(): Promise<{ dir: string; ass: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'chorus-render-'));
  const ass = join(dir, 'captions.ass');
  await generateAssSubtitles({
    words: WORDS,
    clipStart: START,
    clipEnd: END,
    assPath: ass,
    hook: 'Boundary test',
  });
  return { dir, ass };
}

function assertDuration(actual: number): void {
  const requested = END - START;
  assert.ok(
    Math.abs(actual - requested) <= 0.1,
    `rendered ${actual.toFixed(3)}s for ${requested.toFixed(3)}s boundaries`,
  );
}

test('video render duration matches requested boundaries within 100 ms', { timeout: 120_000 }, async () => {
  const { dir, ass } = await fixture();
  try {
    const source = join(dir, 'source.mp4');
    const output = join(dir, 'vertical.mp4');
    await exec(TEST_FFMPEG, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
    ]);

    await renderVertical({
      sourcePath: source,
      destPath: output,
      assPath: ass,
      startSec: START,
      endSec: END,
      hasVideoStream: true,
    });
    const rendered = await probe(output);
    assert.equal(rendered.hasVideoStream, true);
    assertDuration(rendered.durationSec);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('MP3 render makes a caption card at the requested duration without a vision call', { timeout: 120_000 }, async () => {
  const { dir, ass } = await fixture();
  try {
    const source = join(dir, 'source.mp3');
    const output = join(dir, 'caption-card.mp4');
    await exec(TEST_FFMPEG, [
      '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
      '-b:a', '128k', source,
    ]);

    let visionCalls = 0;
    const inspection = await inspectClip(
      false,
      {
        campaignId: 'test',
        planKey: 'audio',
        clipStart: START,
        clipEnd: END,
        words: WORDS,
        silences: [],
        frames: [],
        durationSec: END - START,
        goal: 'test',
        audience: null,
        brandVoice: null,
      },
      async () => {
        visionCalls++;
        throw new Error('audio-only inspection must never call vision');
      },
    );
    assert.equal(visionCalls, 0);
    assert.equal(inspection.verdict, 'SHIP');

    await renderVertical({
      sourcePath: source,
      destPath: output,
      assPath: ass,
      startSec: START,
      endSec: END,
      hasVideoStream: false,
    });
    const rendered = await probe(output);
    assert.equal(rendered.hasVideoStream, true, 'caption card output must be a postable video');
    assertDuration(rendered.durationSec);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

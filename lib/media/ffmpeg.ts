import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { env } from '@/lib/env';

/**
 * Every ffmpeg and ffprobe invocation in the system goes through here.
 *
 * `execFile`, never a shell string. Source filenames come from user uploads, and
 * a filename containing a quote or a semicolon must not be able to become a
 * command. There is no shell in this path to break out of.
 */
const exec = promisify(execFile);

/** ffprobe JSON runs to a few hundred KB on a long file; the 1 MB default truncates. */
const MAX_BUFFER = 32 * 1024 * 1024;

export class FfmpegError extends Error {
  constructor(
    readonly bin: string,
    readonly args: string[],
    readonly stderr: string,
  ) {
    // ffmpeg puts the real diagnosis in the last few lines and banner noise above.
    const tail = stderr.trim().split('\n').slice(-6).join('\n');
    super(`${bin} failed: ${tail}`);
    this.name = 'FfmpegError';
  }
}

async function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec(bin, args, { maxBuffer: MAX_BUFFER });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? String(error);
    throw new FfmpegError(bin, args, stderr);
  }
}

export interface ProbeResult {
  durationSec: number;
  hasVideoStream: boolean;
  hasAudioStream: boolean;
  formatName: string | null;
  sizeBytes: number | null;
}

/**
 * The one place `has_video_stream` is decided.
 *
 * An MP4 can legally contain no video track, and an extension-sniffing branch
 * would send blank frames to a vision model. This answer is written to
 * `campaigns.has_video_stream` at ingest and every downstream branch reads that
 * column instead of guessing again.
 */
export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await run(env.ffprobePath, [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    path,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      duration?: string;
      disposition?: Record<string, number>;
    }>;
    format?: { duration?: string; format_name?: string; size?: string };
  };

  const streams = parsed.streams ?? [];
  const video = streams.filter((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio');

  // Container duration is the reliable figure; per-stream duration is missing in
  // some containers. Fall back to the longest stream that reports one.
  const durations = [parsed.format?.duration, ...streams.map((s) => s.duration)]
    .map((value) => (value === undefined ? NaN : Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (durations.length === 0) {
    throw new Error(`ffprobe reported no usable duration for ${path}.`);
  }

  return {
    durationSec: Math.max(...durations),
    // A cover-art JPEG inside an MP3 is a video stream to ffprobe, and cropping
    // a still image to 9:16 produces a frozen frame, not a talking head. An
    // attached picture is not motion, so it does not count.
    hasVideoStream: video.some((s) => !isAttachedPicture(s)),
    hasAudioStream: audio.length > 0,
    formatName: parsed.format?.format_name ?? null,
    sizeBytes: parsed.format?.size ? Number(parsed.format.size) : null,
  };
}

function isAttachedPicture(stream: { disposition?: Record<string, number> }): boolean {
  return (stream.disposition?.attached_pic ?? 0) === 1;
}

/**
 * Downmix to the smallest thing Whisper still reads well.
 *
 * Groq caps a single upload at 25 MB. Ninety minutes of 16 kHz mono WAV is about
 * 172 MB; the same audio as a 32 kbps mono MP3 is about 22 MB. Whisper resamples
 * to 16 kHz internally anyway, so nothing useful is lost.
 */
export async function extractAudio(sourcePath: string, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  await run(env.ffmpegPath, [
    '-y',
    '-i',
    sourcePath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-b:a',
    '32k',
    destPath,
  ]);
}

/**
 * Cut one transcription chunk out of an already-compressed audio file.
 *
 * `-c copy` on an MP3 lands on the nearest frame boundary rather than the exact
 * requested second, which is why the caller must not assume chunk N starts at
 * exactly `n * chunkSeconds`. It re-probes each chunk and accumulates real
 * durations; see `lib/media/transcribe.ts`.
 */
export async function sliceAudio(
  sourcePath: string,
  destPath: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  await run(env.ffmpegPath, [
    '-y',
    '-ss',
    startSec.toFixed(3),
    '-i',
    sourcePath,
    '-t',
    durationSec.toFixed(3),
    '-c',
    'copy',
    destPath,
  ]);
}

export interface SilenceRange {
  start: number;
  end: number;
}

/** Fast inspection cut. Video is encoded ultrafast; audio-only inputs stay audio. */
export async function cutDraft(
  sourcePath: string,
  destPath: string,
  startSec: number,
  endSec: number,
  hasVideoStream: boolean,
): Promise<void> {
  assertRange(startSec, endSec);
  await mkdir(dirname(destPath), { recursive: true });
  const common = [
    '-y',
    '-ss',
    startSec.toFixed(3),
    '-i',
    sourcePath,
    '-t',
    (endSec - startSec).toFixed(3),
  ];
  await run(
    env.ffmpegPath,
    hasVideoStream
      ? [...common, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', destPath]
      : [...common, '-vn', '-c:a', 'aac', '-b:a', '128k', destPath],
  );
}

/** Silence timestamps are relative to the draft, exactly as the inspector needs. */
export async function detectSilences(path: string): Promise<SilenceRange[]> {
  const { stderr } = await run(env.ffmpegPath, [
    '-i',
    path,
    '-af',
    'silencedetect=noise=-30dB:d=0.6',
    '-f',
    'null',
    '-',
  ]);
  return parseSilenceDetect(stderr);
}

export function parseSilenceDetect(stderr: string): SilenceRange[] {
  const ranges: SilenceRange[] = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*([0-9.]+)/.exec(line);
    if (start) pendingStart = Number(start[1]);
    const end = /silence_end:\s*([0-9.]+)/.exec(line);
    if (end) {
      const endSec = Number(end[1]);
      if (pendingStart !== null && Number.isFinite(endSec)) {
        ranges.push({ start: pendingStart, end: endSec });
      }
      pendingStart = null;
    }
  }
  return ranges;
}

/** Six small JPEGs are enough to catch black frames and broken center crops. */
export async function sampleFrames(
  path: string,
  outputDir: string,
  durationSec: number,
  count = 6,
): Promise<string[]> {
  if (durationSec <= 0 || count <= 0) return [];
  await mkdir(outputDir, { recursive: true });
  for (const file of await readdir(outputDir)) {
    if (/^frame-\d+\.jpg$/.test(file)) await rm(join(outputDir, file));
  }

  await run(env.ffmpegPath, [
    '-y',
    '-i',
    path,
    '-vf',
    `fps=${count}/${durationSec.toFixed(3)},scale=512:-2`,
    '-frames:v',
    String(count),
    join(outputDir, 'frame-%02d.jpg'),
  ]);

  return (await readdir(outputDir))
    .filter((file) => /^frame-\d+\.jpg$/.test(file))
    .sort()
    .map((file) => join(outputDir, file));
}

export interface VerticalRenderInput {
  sourcePath: string;
  destPath: string;
  assPath: string;
  startSec: number;
  endSec: number;
  hasVideoStream: boolean;
}

/** Accurate final render. The duration is owned by -t, not keyframe placement. */
export async function renderVertical(input: VerticalRenderInput): Promise<void> {
  assertRange(input.startSec, input.endSec);
  await mkdir(dirname(input.destPath), { recursive: true });
  const duration = (input.endSec - input.startSec).toFixed(3);
  const ass = escapeFilterPath(input.assPath);

  const args = input.hasVideoStream
    ? [
        '-y',
        '-ss',
        input.startSec.toFixed(3),
        '-i',
        input.sourcePath,
        '-t',
        duration,
        '-vf',
        `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,ass=filename='${ass}'`,
      ]
    : [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=0x0B0B0F:s=1080x1920:r=30:d=${duration}`,
        '-ss',
        input.startSec.toFixed(3),
        '-i',
        input.sourcePath,
        '-t',
        duration,
        '-vf',
        `ass=filename='${ass}'`,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-shortest',
      ];

  await run(env.ffmpegPath, [
    ...args,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    input.destPath,
  ]);
}

function assertRange(startSec: number, endSec: number): void {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    throw new Error(`Invalid media range ${startSec}-${endSec}.`);
  }
}

/** ffmpeg's filter parser treats backslashes, colons, quotes, and commas specially. */
function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,');
}

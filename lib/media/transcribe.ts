import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import Groq, { toFile } from 'groq-sdk';
import { z } from 'zod';
import { env } from '@/lib/env';
import { sliceAudio } from '@/lib/media/ffmpeg';

/**
 * Groq transcription with chunking.
 *
 * The whole reason this file has unit tests is the offset merge. Groq returns
 * word timestamps relative to the file it was given, so a word at 00:04 of chunk
 * three is really at 20:04 of the podcast. Forget to add the offset and every
 * caption in the campaign is silently misaligned, every clip boundary is wrong,
 * and nothing anywhere throws. That is the worst failure mode in the codebase,
 * so `mergeChunks` and `planChunks` are pure functions tested without a network.
 */

export const MODEL = 'whisper-large-v3-turbo';
export const PROVIDER = `groq/${MODEL}`;

/**
 * Groq caps a single upload at 25 MB. The margin covers MP3 frame padding and
 * the multipart envelope, so a file just under the real cap is not rejected in
 * flight after minutes of upload.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Chunk length when the file is over the cap. 600 s of 32 kbps mono is ~2.4 MB. */
export const CHUNK_SECONDS = 600;

/**
 * Published list price per hour of audio, read from Groq's pricing page on
 * 2026-08-09. The transcription API returns no cost figure, unlike OpenRouter,
 * so this is the only way the ceiling sees transcription spend at all. It is an
 * estimate by construction: if Groq repriced, this number is stale, and the
 * campaign total drifts low rather than reporting a false zero.
 */
export const USD_PER_AUDIO_HOUR = 0.04;

/** The word shape stored in `transcripts.words`. Deliberately short: a 90 minute
 * episode is ~15k words, and `{w,s,e}` over `{word,start,end}` is a third of the
 * JSON. */
export interface Word {
  w: string;
  s: number;
  e: number;
}

export interface TranscriptChunk {
  /** Seconds from the start of the source that this chunk's timestamps are relative to. */
  offsetSec: number;
  text: string;
  words: Word[];
}

export interface TranscriptResult {
  text: string;
  words: Word[];
  language: string | null;
  chunkCount: number;
  costUsd: number;
}

export interface ChunkPlanEntry {
  index: number;
  startSec: number;
  durationSec: number;
}

/**
 * Split a duration into transcription chunks.
 *
 * Boundaries are exact multiples of `chunkSeconds` with no overlap. A word
 * straddling a boundary can come back as two partial words, which is a cosmetic
 * caption artefact once per ten minutes; overlapping the chunks instead would
 * duplicate words and require a fuzzy dedupe pass, which is a much worse trade.
 */
export function planChunks(durationSec: number, chunkSeconds = CHUNK_SECONDS): ChunkPlanEntry[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`Cannot plan chunks for duration ${durationSec}.`);
  }
  if (chunkSeconds <= 0) throw new Error('chunkSeconds must be positive.');

  const plan: ChunkPlanEntry[] = [];
  for (let start = 0, index = 0; start < durationSec; start += chunkSeconds, index++) {
    plan.push({
      index,
      startSec: start,
      durationSec: Math.min(chunkSeconds, durationSec - start),
    });
  }
  return plan;
}

/**
 * Shift every chunk's timestamps into source time and concatenate.
 *
 * Words are sorted by start time after shifting rather than trusting input
 * order, so an out-of-order chunk array cannot produce a transcript whose
 * timestamps run backwards. Words with unusable timestamps are dropped: a NaN
 * reaching an ffmpeg `-ss` argument is a render failure much further downstream,
 * where the cause is no longer visible.
 */
export function mergeChunks(chunks: TranscriptChunk[]): { text: string; words: Word[] } {
  const words: Word[] = [];

  for (const chunk of chunks) {
    for (const word of chunk.words) {
      const s = word.s + chunk.offsetSec;
      const e = word.e + chunk.offsetSec;
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      words.push({ w: word.w, s, e });
    }
  }

  words.sort((a, b) => a.s - b.s || a.e - b.e);

  const text = chunks
    .slice()
    .sort((a, b) => a.offsetSec - b.offsetSec)
    .map((chunk) => chunk.text.trim())
    .filter((part) => part !== '')
    .join(' ');

  return { text, words };
}

/** Groq's `verbose_json`. The SDK types the response as `{ text }` only, so the
 * extra fields are validated here rather than cast into existence. */
const VerboseTranscription = z.object({
  text: z.string(),
  language: z.string().nullish(),
  duration: z.number().nullish(),
  words: z
    .array(z.object({ word: z.string(), start: z.number(), end: z.number() }))
    .nullish()
    .transform((value) => value ?? []),
});

let client: Groq | null = null;
function groq(): Groq {
  if (!client) client = new Groq({ apiKey: env.groqApiKey });
  return client;
}

export interface TranscribeOptions {
  /** Source duration in seconds, from `probe()`. Drives chunk planning. */
  durationSec: number;
  /** Where chunk files are written. Cleaned up by the caller. */
  workDir: string;
  /** Progress reporting, so a 90 minute file is not a silent ten-minute wait. */
  onProgress?: (info: { chunk: number; of: number }) => void;
  /**
   * Thresholds, overridable so the chunked path can be exercised against real
   * audio without a 90 minute file. Production always uses the defaults; the
   * offset merge is where the silent failure lives, and a path that only ever
   * runs on long inputs is a path that only ever gets tested by accident.
   */
  maxUploadBytes?: number;
  chunkSeconds?: number;
}

/**
 * Transcribe a prepared audio file, chunking only when it exceeds the upload cap.
 */
export async function transcribeAudio(
  audioPath: string,
  options: TranscribeOptions,
): Promise<TranscriptResult> {
  const { size } = await stat(audioPath);
  const costUsd = (options.durationSec / 3600) * USD_PER_AUDIO_HOUR;

  if (size <= (options.maxUploadBytes ?? MAX_UPLOAD_BYTES)) {
    options.onProgress?.({ chunk: 1, of: 1 });
    const single = await transcribeOneFile(audioPath);
    const merged = mergeChunks([{ offsetSec: 0, text: single.text, words: single.words }]);
    return { ...merged, language: single.language, chunkCount: 1, costUsd };
  }

  const plan = planChunks(options.durationSec, options.chunkSeconds ?? CHUNK_SECONDS);
  const chunks: TranscriptChunk[] = [];
  let language: string | null = null;

  for (const entry of plan) {
    const chunkPath = join(options.workDir, `chunk-${String(entry.index).padStart(3, '0')}.mp3`);
    await sliceAudio(audioPath, chunkPath, entry.startSec, entry.durationSec);

    options.onProgress?.({ chunk: entry.index + 1, of: plan.length });
    const part = await transcribeOneFile(chunkPath);

    // The offset is the *planned* start, not a running sum of chunk durations.
    // `-c copy` lands on the nearest MP3 frame boundary, so each slice may begin
    // up to ~26 ms early. Seeking each chunk independently from the source keeps
    // that error bounded per chunk; summing measured durations would instead let
    // it accumulate across all nine chunks of a 90 minute episode.
    chunks.push({ offsetSec: entry.startSec, text: part.text, words: part.words });
    language ??= part.language;
  }

  const merged = mergeChunks(chunks);
  return { ...merged, language, chunkCount: plan.length, costUsd };
}

async function transcribeOneFile(
  path: string,
): Promise<{ text: string; words: Word[]; language: string | null }> {
  const response = await withRetry(() => sendToGroq(path));
  const parsed = VerboseTranscription.parse(response);

  return {
    text: parsed.text,
    words: parsed.words.map((word) => ({ w: word.word, s: word.start, e: word.end })),
    language: parsed.language ?? null,
  };
}

async function sendToGroq(path: string): Promise<unknown> {
  const file = await toFile(createReadStream(path), basename(path));
  return await groq().audio.transcriptions.create({
    file,
    model: MODEL,
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
    temperature: 0,
  });
}

/**
 * Retry transient failures only.
 *
 * A 90 minute episode is nine uploads; a single 503 on chunk seven should not
 * throw away eight successful transcriptions. A 400 means the request is wrong
 * and retrying it just wastes minutes, so status codes under 500 (other than
 * 429) fail immediately.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      const retryable = status === undefined || status === 429 || status >= 500;
      if (!retryable || attempt === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt));
    }
  }

  throw lastError;
}

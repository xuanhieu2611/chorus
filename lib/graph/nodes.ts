import { mkdir, stat } from 'node:fs/promises';
import { analyzeSource } from '@/lib/agents/source-analyst';
import { emit } from '@/lib/events';
import { chargeCampaign } from '@/lib/llm/budget';
import { extractAudio, probe } from '@/lib/media/ffmpeg';
import {
  campaignAudioPath,
  campaignWorkDir,
  resolveSourcePath,
} from '@/lib/media/paths';
import { PROVIDER, transcribeAudio } from '@/lib/media/transcribe';
import {
  countSegments,
  getTranscript,
  hasTranscript,
  saveSegments,
  saveTranscript,
} from '@/lib/tools';
import type { NodeFn, NodeId, NodeResult } from '@/lib/graph/types';

/**
 * One function per node. Control flow lives here; the executor in
 * `lib/graph/run.ts` only walks the edges these functions return.
 *
 * Built so far: `ingest` and `transcribe` (Phase 1), `analyze` (Phase 2). Nodes
 * for later phases are absent from the registry rather than stubbed, and
 * `run.ts` stops cleanly when it reaches one. A stub that returns a plausible-looking empty result is worse
 * than a missing entry: it makes an unbuilt phase look like a working one.
 */

/**
 * ffprobe the source, then downmix its audio for transcription.
 *
 * `has_video_stream` is decided here, once, and written to the row. Every later
 * branch reads that column rather than looking at the file extension, because an
 * MP4 can legally contain no video track and extension-sniffing sends blank
 * frames to a vision model.
 */
const ingest: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;

  if (!campaign.source_path) {
    throw new Error('Campaign has no source_path. The upload did not complete.');
  }

  const sourcePath = resolveSourcePath(campaign.source_path);
  await assertReadable(sourcePath);

  const probed = await probe(sourcePath);
  await emit({
    campaignId,
    agent: 'system',
    node: 'ingest',
    level: 'tool',
    message: `ffprobe: ${formatDuration(probed.durationSec)}, ${probed.hasVideoStream ? 'video + audio' : 'audio only'}.`,
    data: {
      duration_sec: probed.durationSec,
      has_video_stream: probed.hasVideoStream,
      format: probed.formatName,
      size_bytes: probed.sizeBytes,
    },
  });

  if (!probed.hasAudioStream) {
    throw new Error('Source has no audio stream, so there is nothing to transcribe.');
  }

  const audioPath = campaignAudioPath(campaignId);
  await mkdir(campaignWorkDir(campaignId), { recursive: true });

  // Re-extraction after a crash costs a minute of CPU for no new information, so
  // an audio file that already exists is trusted. It is derived from an
  // immutable source, so it cannot be stale.
  const existing = await sizeOf(audioPath);
  if (existing !== null && existing > 0) {
    await emit({
      campaignId,
      agent: 'system',
      node: 'ingest',
      level: 'info',
      message: `Reusing audio extracted by an earlier run (${formatBytes(existing)}).`,
    });
  } else {
    await extractAudio(sourcePath, audioPath);
    const size = (await sizeOf(audioPath)) ?? 0;
    await emit({
      campaignId,
      agent: 'system',
      node: 'ingest',
      level: 'tool',
      message: `ffmpeg: extracted 16 kHz mono audio, ${formatBytes(size)}.`,
      data: { audio_bytes: size },
    });
  }

  return {
    next: 'transcribe',
    patch: {
      source_duration_sec: probed.durationSec,
      has_video_stream: probed.hasVideoStream,
    },
    reason: `Ingested ${formatDuration(probed.durationSec)} of ${probed.hasVideoStream ? 'video' : 'audio-only'} source. ${
      probed.hasVideoStream
        ? 'Clips can be cropped to 9:16 from the video track.'
        : 'Clips will be caption cards; the 9:16 crop and the vision pass are skipped.'
    }`,
  };
};

/**
 * Word-timestamped transcript via Groq, chunked when the file exceeds the upload
 * cap. The chunk-offset merge lives in `lib/media/transcribe.ts` and is unit
 * tested, because getting it wrong misaligns every caption in the campaign
 * without throwing anything.
 */
const transcribe: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;

  if (await hasTranscript(campaignId)) {
    return {
      next: 'analyze',
      reason: 'Transcript already exists from an earlier run; not paying to transcribe it twice.',
    };
  }

  const audioPath = campaignAudioPath(campaignId);
  await assertReadable(audioPath);

  const durationSec = Number(campaign.source_duration_sec ?? 0);
  if (durationSec <= 0) {
    throw new Error('Campaign has no source duration; ingest did not complete.');
  }

  const result = await transcribeAudio(audioPath, {
    durationSec,
    workDir: campaignWorkDir(campaignId),
    onProgress: ({ chunk, of }) => {
      if (of === 1) return;
      void emit({
        campaignId,
        agent: 'system',
        node: 'transcribe',
        level: 'tool',
        message: `Transcribing chunk ${chunk} of ${of}.`,
      });
    },
  });

  // Save before charging. If the cost lands over the ceiling the run must fail,
  // but throwing away a transcript that was already paid for would mean paying
  // for it again on the retry.
  await saveTranscript(campaignId, {
    text: result.text,
    words: result.words,
    language: result.language,
    provider: PROVIDER,
  });

  // Groq's transcription API returns no cost figure, so this is list price times
  // audio hours rather than a reported number. See `USD_PER_AUDIO_HOUR`.
  await chargeCampaign(campaignId, result.costUsd, {
    agent: 'system',
    node: 'transcribe',
    model: PROVIDER,
  });

  if (result.words.length === 0) {
    throw new Error(
      'Transcription returned no word timestamps. Every clip boundary and caption depends on them.',
    );
  }

  return {
    next: 'analyze',
    reason: `Transcribed ${formatDuration(durationSec)} into ${result.words.length.toLocaleString('en-US')} word-timestamped words${
      result.chunkCount > 1 ? ` across ${result.chunkCount} chunks` : ''
    }.`,
  };
};

/**
 * Source Analyst: the transcript becomes a scored pool of topic segments.
 *
 * The agent owns judgement (what is interesting, how standalone it is); this
 * node owns everything around it: resumption, progress reporting, and turning
 * the result into the one line the demo opens on. The map-reduce and the
 * boundary arithmetic live in `lib/agents/source-analyst.ts`.
 */
const analyze: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;

  // Analysis is the first genuinely expensive node, a dozen model calls on a
  // 90 minute episode. A campaign resumed after a crash further downstream must
  // not pay for it twice, and segments already in the table are as good as the
  // ones a re-run would produce.
  const existing = await countSegments(campaignId);
  if (existing > 0) {
    return {
      next: 'strategize',
      reason: `Reusing ${existing} segments from an earlier analysis of this campaign.`,
    };
  }

  const transcript = await getTranscript(campaignId);

  const result = await analyzeSource({
    campaignId,
    words: transcript.words,
    goal: campaign.goal,
    audience: campaign.audience,
    brandVoice: campaign.brand_voice,
    onProgress: ({ done, of }) => {
      void emit({
        campaignId,
        agent: 'source_analyst',
        node: 'analyze',
        level: 'tool',
        message: `Scanned window ${done} of ${of}.`,
      });
    },
    onWindowFailure: ({ index, error }) => {
      // Named rather than swallowed. A window that produced nothing is a hole in
      // the episode, and a person reading the timeline should be able to see
      // which minutes the campaign was planned without.
      void emit({
        campaignId,
        agent: 'source_analyst',
        node: 'analyze',
        level: 'warn',
        message: `Window ${index + 1} could not be analyzed and was skipped: ${error}`,
      });
    },
  });

  const saved = await saveSegments(campaignId, result.segments);

  await emit({
    campaignId,
    agent: 'source_analyst',
    node: 'analyze',
    level: 'info',
    message: `Reduced ${result.candidateCount} candidates from ${result.windowCount} windows down to ${saved.length} segments. ${result.reasoning}`,
    data: {
      window_count: result.windowCount,
      candidate_count: result.candidateCount,
      failed_windows: result.failedWindows,
      segment_count: saved.length,
    },
  });

  // The line the demo opens on (MVP section 13, step 2).
  return {
    next: 'strategize',
    reason: `Found ${saved.length} candidate topic${saved.length === 1 ? '' : 's'} across ${formatDuration(Number(campaign.source_duration_sec ?? 0))} of source.`,
  };
};

/** The registry the executor walks. Later phases add their nodes here and to the
 * mermaid diagram in `MVP.md` section 6 in the same commit. */
export const NODES: Partial<Record<NodeId, NodeFn>> = {
  ingest,
  transcribe,
  analyze,
};

async function assertReadable(path: string): Promise<void> {
  const size = await sizeOf(path);
  if (size === null) throw new Error(`File not found: ${path}`);
  if (size === 0) throw new Error(`File is empty: ${path}`);
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

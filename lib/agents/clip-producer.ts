import { z } from 'zod';
import type { Json } from '@/lib/db/database.types';
import { callStructured } from '@/lib/llm/structured';
import type { Word } from '@/lib/media/transcribe';
import {
  extractVideo,
  generateSubtitles,
  getCampaignMedia,
  inspectRenderedVideo,
  loadFrameImages,
  localMediaPath,
  readSegment,
  renderVerticalVideo,
  uploadAsset,
  type ReadSegmentResult,
} from '@/lib/tools';

export const ClipPlanSchema = z.object({
  clip_start: z.number(),
  clip_end: z.number(),
  hook: z.string().trim().min(1).max(90),
  caption: z.string().trim().min(1).max(2200),
  reasoning: z.string().trim().min(1),
});

export const InspectSchema = z.object({
  hook_latency_sec: z.number(),
  dead_air: z.array(z.object({ start: z.number(), end: z.number() })),
  ends_abruptly: z.boolean(),
  verdict: z.enum(['SHIP', 'ADJUST']),
  suggested_start: z.number().nullable(),
  suggested_end: z.number().nullable(),
});

export type ClipPlan = z.infer<typeof ClipPlanSchema>;
export type ClipInspection = z.infer<typeof InspectSchema>;

export interface ClipProducerInput {
  campaignId: string;
  planKey: string;
  segmentIds: string[];
  topic: string;
  purpose: string;
  maxVideoSeconds: number;
  sourceDurationSec: number;
  hasVideoStream: boolean;
  goal: string;
  audience: string | null;
  brandVoice: string | null;
}

export interface ProducedClip {
  hook: string;
  caption: string;
  clipStart: number;
  clipEnd: number;
  reasoning: string;
  inspection: ClipInspection;
  boundaryAdjustments: number;
  mediaUrl: string;
  mediaPath: string;
  durationSec: number;
}

interface InspectionContext {
  campaignId: string;
  planKey: string;
  clipStart: number;
  clipEnd: number;
  words: Word[];
  silences: Array<{ start: number; end: number }>;
  frames: string[];
  durationSec: number;
  goal: string;
  audience: string | null;
  brandVoice: string | null;
}

export type VisionInspector = (context: InspectionContext) => Promise<ClipInspection>;

/**
 * The Clip Producer's perceive-act-perceive loop. TypeScript snaps every model
 * suggestion to real word edges and permits at most two boundary adjustments.
 */
export async function produceClip(input: ClipProducerInput): Promise<ProducedClip> {
  if (input.segmentIds.length === 0) throw new Error(`${input.planKey} has no source segments.`);
  const [media, ...sources] = await Promise.all([
    getCampaignMedia(input.campaignId),
    ...input.segmentIds.map((id) => readSegment(id)),
  ]);
  if (media.hasVideoStream !== input.hasVideoStream) {
    throw new Error('Clip Producer branch disagrees with the probed has_video_stream fact.');
  }

  const proposed = await chooseClipPlan(input, sources);
  const allWords = sources.flatMap((source) => source.words).sort((a, b) => a.s - b.s);
  let boundary = snapClipBoundaries(
    allWords,
    proposed.clip_start,
    proposed.clip_end,
    sources,
    input.maxVideoSeconds,
    input.sourceDurationSec,
  );
  if (!boundary) throw new Error(`No valid word-aligned clip can be made for ${input.planKey}.`);

  let inspection: ClipInspection | null = null;
  let boundaryAdjustments = 0;

  for (let pass = 0; pass < 3; pass++) {
    const draft = await extractVideo(
      input.campaignId,
      input.planKey,
      boundary.start,
      boundary.end,
      input.hasVideoStream,
    );
    const measured = await inspectRenderedVideo(draft.path, {
      hasVideoStream: input.hasVideoStream,
      campaignId: input.campaignId,
      planKey: input.planKey,
    });
    const context: InspectionContext = {
      campaignId: input.campaignId,
      planKey: input.planKey,
      clipStart: boundary.start,
      clipEnd: boundary.end,
      words: allWords,
      silences: measured.silences,
      frames: measured.frames,
      durationSec: measured.durationSec,
      goal: input.goal,
      audience: input.audience,
      brandVoice: input.brandVoice,
    };
    inspection = await inspectClip(input.hasVideoStream, context, inspectVideoWithModel);

    if (inspection.verdict === 'SHIP' || pass === 2) break;
    const adjusted = snapClipBoundaries(
      allWords,
      inspection.suggested_start ?? boundary.start,
      inspection.suggested_end ?? boundary.end,
      sources,
      input.maxVideoSeconds,
      input.sourceDurationSec,
    );
    if (!adjusted || sameBoundary(boundary, adjusted)) break;
    boundary = adjusted;
    boundaryAdjustments++;
  }

  if (!inspection) throw new Error('Clip inspection did not run.');

  const { assPath } = await generateSubtitles(
    input.campaignId,
    input.planKey,
    allWords,
    boundary.start,
    boundary.end,
    proposed.hook,
  );
  const rendered = await renderVerticalVideo({
    campaignId: input.campaignId,
    planKey: input.planKey,
    start: boundary.start,
    end: boundary.end,
    assPath,
    hasVideoStream: input.hasVideoStream,
  });
  const requestedDuration = boundary.end - boundary.start;
  if (Math.abs(rendered.duration - requestedDuration) > 0.1) {
    throw new Error(
      `Rendered duration ${rendered.duration.toFixed(3)}s differs from requested boundaries (${requestedDuration.toFixed(3)}s) by more than 100 ms.`,
    );
  }
  const uploaded = await uploadAsset(input.campaignId, input.planKey, rendered.path);

  return {
    hook: proposed.hook.trim(),
    caption: proposed.caption.trim(),
    clipStart: boundary.start,
    clipEnd: boundary.end,
    reasoning: proposed.reasoning.trim(),
    inspection,
    boundaryAdjustments,
    mediaUrl: uploaded.publicUrl,
    mediaPath: localMediaPath(rendered.path),
    durationSec: rendered.duration,
  };
}

async function chooseClipPlan(
  input: ClipProducerInput,
  sources: ReadSegmentResult[],
): Promise<ClipPlan> {
  const result = await callStructured({
    campaignId: input.campaignId,
    agent: 'clip_producer',
    node: 'produce',
    role: 'reasoning',
    schema: ClipPlanSchema,
    schemaName: 'clip_plan',
    schemaDescription: 'A source-grounded short-video plan with source-timeline boundaries.',
    system: CLIP_SYSTEM,
    prompt: [
      `Choose the strongest contiguous clip for ${input.planKey}.`,
      `Topic: ${input.topic}`,
      `Purpose: ${input.purpose}`,
      `Maximum duration: ${input.maxVideoSeconds} seconds.`,
      'clip_start and clip_end must use the absolute source timestamps printed below and must stay inside one excerpt.',
      'Start as close as possible to the first line that earns attention. End after the payoff, not during the next setup.',
      'Write a hook of at most 90 characters for a three-second overlay and a platform caption of at most 2,200 characters.',
      '',
      ...sources.map((source) => renderSource(source)),
      '',
      describeObjective(input),
    ].join('\n'),
    input: {
      plan_key: input.planKey,
      source_segment_ids: input.segmentIds,
      max_video_seconds: input.maxVideoSeconds,
    } as Json,
  });
  return result.value;
}

/** Audio never reaches the vision function. This branch is unit-testable with a spy. */
export async function inspectClip(
  hasVideoStream: boolean,
  context: InspectionContext,
  visionInspector: VisionInspector,
): Promise<ClipInspection> {
  return hasVideoStream ? visionInspector(context) : inspectAudioDeterministically(context);
}

export function inspectAudioDeterministically(context: InspectionContext): ClipInspection {
  const relativeWords = context.words
    .filter((word) => word.e > context.clipStart && word.s < context.clipEnd)
    .map((word) => ({ ...word, s: word.s - context.clipStart, e: word.e - context.clipStart }));
  const firstWord = relativeWords[0];
  const lastWord = relativeWords[relativeWords.length - 1];
  const leadingSilence = context.silences.find((range) => range.start <= 0.05);
  const hookLatency = Math.max(firstWord?.s ?? 0, leadingSilence?.end ?? 0, 0);
  const endsAbruptly = lastWord ? context.durationSec - lastWord.e < 0.15 : true;
  const shouldTrimStart = Boolean(leadingSilence && leadingSilence.end >= 0.6);

  return {
    hook_latency_sec: round3(hookLatency),
    dead_air: context.silences.map((range) => ({ start: round3(range.start), end: round3(range.end) })),
    ends_abruptly: endsAbruptly,
    verdict: shouldTrimStart || endsAbruptly ? 'ADJUST' : 'SHIP',
    suggested_start: shouldTrimStart
      ? round3(context.clipStart + (leadingSilence?.end ?? 0))
      : null,
    suggested_end: endsAbruptly ? round3(context.clipEnd + 0.5) : null,
  };
}

async function inspectVideoWithModel(context: InspectionContext): Promise<ClipInspection> {
  const firstWords = context.words
    .filter((word) => word.e > context.clipStart && word.s < Math.min(context.clipEnd, context.clipStart + 10))
    .map((word) => `[${word.s.toFixed(2)}] ${word.w}`)
    .join(' ');
  const images = await loadFrameImages(context.frames);
  const result = await callStructured({
    campaignId: context.campaignId,
    agent: 'clip_producer',
    node: 'produce',
    role: 'vision',
    schema: InspectSchema,
    schemaName: 'clip_inspection',
    schemaDescription: 'A draft clip inspection with source-timeline boundary suggestions.',
    system: INSPECT_SYSTEM,
    prompt: [
      `Inspect this ${context.durationSec.toFixed(2)} second draft using its six chronological frames, silence ranges, and opening words.`,
      `Current source boundaries: ${context.clipStart.toFixed(3)}-${context.clipEnd.toFixed(3)} seconds.`,
      `Silence ranges relative to the draft: ${JSON.stringify(context.silences)}.`,
      `First ten seconds of words, shown with absolute source timestamps: ${firstWords || '(none)'}`,
      'Return suggested_start and suggested_end as absolute source timestamps, or null when that edge should stay unchanged.',
      'ADJUST only for a specific fix to hook latency, dead air, a visibly broken opening frame, or an abrupt ending. Otherwise SHIP.',
      '',
      describeObjective(context),
    ].join('\n'),
    images,
    input: {
      plan_key: context.planKey,
      clip_start: context.clipStart,
      clip_end: context.clipEnd,
      duration_sec: context.durationSec,
      silences: context.silences,
      frame_count: images.length,
    } as Json,
  });
  return normalizeInspection(result.value, context.durationSec);
}

/** Snap to one selected excerpt, never across a gap, and add 300 ms after the last word. */
export function snapClipBoundaries(
  words: Word[],
  proposedStart: number,
  proposedEnd: number,
  sources: Array<Pick<ReadSegmentResult, 'start' | 'end'>>,
  maxDuration: number,
  sourceDuration: number,
): { start: number; end: number } | null {
  if (
    !Number.isFinite(proposedStart) ||
    !Number.isFinite(proposedEnd) ||
    proposedEnd <= proposedStart ||
    maxDuration <= 0
  ) return null;
  const source = [...sources].sort((left, right) => overlap(right, proposedStart, proposedEnd) - overlap(left, proposedStart, proposedEnd))[0];
  if (!source) return null;
  const eligible = words.filter((word) => word.e > source.start && word.s < source.end).sort((a, b) => a.s - b.s);
  if (eligible.length === 0) return null;

  let startIndex = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (const [index, word] of eligible.entries()) {
    const nextDistance = Math.abs(word.s - proposedStart);
    if (nextDistance < distance) {
      startIndex = index;
      distance = nextDistance;
    }
  }
  const start = Math.max(source.start, eligible[startIndex].s);
  const hardEnd = Math.min(source.end, sourceDuration, start + maxDuration);
  const targetEnd = Math.min(proposedEnd, hardEnd);
  let last = eligible[startIndex];
  for (const word of eligible.slice(startIndex)) {
    if (word.e + 0.3 > hardEnd + 0.0001) break;
    if (word.e <= targetEnd || last === eligible[startIndex]) last = word;
    if (word.e > targetEnd) break;
  }
  const end = Math.min(hardEnd, last.e + 0.3);
  return end > start ? { start: round3(start), end: round3(end) } : null;
}

function overlap(source: Pick<ReadSegmentResult, 'start' | 'end'>, start: number, end: number): number {
  return Math.max(0, Math.min(source.end, end) - Math.max(source.start, start));
}

function sameBoundary(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
  return Math.abs(left.start - right.start) < 0.001 && Math.abs(left.end - right.end) < 0.001;
}

function normalizeInspection(value: ClipInspection, duration: number): ClipInspection {
  return {
    ...value,
    hook_latency_sec: Math.max(0, Math.min(duration, value.hook_latency_sec)),
    dead_air: value.dead_air
      .filter((range) => range.end > range.start)
      .map((range) => ({ start: Math.max(0, range.start), end: Math.min(duration, range.end) })),
  };
}

function renderSource(source: ReadSegmentResult): string {
  const timed = source.words.map((word) => `[${word.s.toFixed(2)}] ${word.w}`).join(' ');
  return `<source id="${source.id}" topic="${source.topic}" range="${source.start.toFixed(2)}-${source.end.toFixed(2)}">\n${timed}\n</source>`;
}

function describeObjective(input: { goal: string; audience: string | null; brandVoice: string | null }): string {
  return [
    'Optimize the clip against this campaign objective.',
    `Goal: ${input.goal}`,
    input.audience ? `Audience: ${input.audience}` : 'Audience: not specified.',
    input.brandVoice ? `Brand voice: ${input.brandVoice}` : 'Brand voice: not specified.',
  ].join('\n');
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const CLIP_SYSTEM = [
  'You are the Clip Producer for a podcast growth campaign.',
  'Choose a self-contained moment that earns attention quickly and ends on its payoff.',
  'Use only supplied source timestamps. Do not write a hook or caption that claims more than the excerpt says.',
].join('\n');

const INSPECT_SYSTEM = [
  'You inspect a rough podcast clip before its expensive vertical render.',
  'Inspection means silence detection, sampled frames, and transcript timing. Do not pretend the frames reveal motion or words that are not visible.',
  'Protect complete thoughts, but remove avoidable dead air before the payload and do not ship an abrupt ending.',
].join('\n');

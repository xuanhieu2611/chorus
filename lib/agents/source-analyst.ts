import { z } from 'zod';
import { callStructured } from '@/lib/llm/structured';
import { CostCeilingExceededError } from '@/lib/llm/budget';
import type { Word } from '@/lib/media/transcribe';
import type { Json } from '@/lib/db/database.types';

/**
 * The Source Analyst. Turns a 90 minute transcript into 10 to 20 scored,
 * standalone-able topic segments.
 *
 * The shape of this agent is forced by arithmetic. A 90 minute episode is
 * roughly 120k to 180k tokens, so it cannot be one call, and even where a 1M
 * context model would swallow it whole, asking one prompt to both read
 * everything and score everything produces mush. So: a **map** pass over
 * overlapping windows with the cheap model, extracting candidates, then a
 * **reduce** pass over just those candidates with the reasoning model.
 *
 * The split is not only about cost. `novelty_score` is meaningless inside a
 * single window - a point can only be novel relative to the rest of the episode
 * - so novelty is absent from the map schema entirely and assigned once, in the
 * reduce, where the whole candidate pool is visible. Same for deduplication: a
 * topic that straddles a window boundary is seen twice by construction, and only
 * the reduce is in a position to notice.
 *
 * What the model decides: what is interesting, what it is about, how good it is.
 * What this file decides in TypeScript: whether a boundary is legal, whether two
 * segments are the same segment, and how many survive. Scores are judgement;
 * boundaries are arithmetic, and LLMs do arithmetic badly.
 */

/** Window length for the map pass. ~8 minutes is about 1,200 spoken words. */
export const WINDOW_SECONDS = 480;

/**
 * Overlap between adjacent windows. A topic that runs across a boundary is
 * truncated in both windows without this; with it, a topic shorter than the
 * overlap is seen whole by at least one window. The duplicate that overlap
 * creates is the reduce pass's problem, and a cheap one - a duplicate is
 * recoverable, a topic sliced in half is not.
 */
export const WINDOW_OVERLAP_SECONDS = 60;

/**
 * How many map calls are in flight at once. Sequential is ~13 round trips for a
 * 90 minute episode, which is several minutes of staring at a spinner; unbounded
 * is a rate-limit error at the provider. Three is enough to hide most of the
 * latency and stays well inside any free-tier concurrency limit.
 */
const MAP_CONCURRENCY = 3;

/**
 * Segments shorter than this cannot become an asset: there is no clip and no
 * thread in eight seconds of speech. Dropped rather than kept as noise for the
 * Strategist to wade through.
 */
export const MIN_SEGMENT_SECONDS = 12;

/** The Strategist reads every surviving segment in one prompt, so this is a real
 * constraint on the next phase, not a display limit. MVP section 7.1 targets 10
 * to 20. */
export const MAX_SEGMENTS = 20;

/**
 * The floor asked of the reduce pass. Not enforced in code, deliberately: a
 * genuinely thin source should yield few segments rather than padded ones, and
 * the Strategist's `min(2)` on planned assets is where a too-thin analysis
 * actually surfaces as a failure.
 */
const MIN_TARGET_SEGMENTS = 8;

/**
 * Two segments overlapping by more than this fraction of the shorter one are the
 * same topic seen twice, and the weaker one is dropped. The reduce pass is asked
 * to merge duplicates and usually does; this is the backstop for when it does
 * not, because two near-identical segments would sail through the Strategist and
 * only surface as a diversity failure five phases later.
 */
const DUPLICATE_OVERLAP_RATIO = 0.6;

export const CONTENT_TYPES = [
  'personal_story',
  'opinion',
  'advice',
  'educational',
  'humor',
  'quote',
  'tangent',
  'filler',
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

/**
 * The map schema. Deliberately not the final segment shape: no `novelty_score`,
 * because nothing inside one window can tell you whether a point is fresh.
 *
 * Numeric ranges are enforced by the schema because a score outside 0..1 is a
 * semantic error the repair pass can genuinely fix. Array and string *lengths*
 * are not, and that is deliberate: strict schema mode is not in effect through
 * OpenRouter (see `docs/ARCHITECTURE.md`), so a `.max(3)` on hooks buys a whole
 * extra round trip to fix something `.slice(0, 3)` fixes for free.
 */
const CandidateSchema = z.object({
  start_time: z.number(),
  end_time: z.number(),
  topic: z.string(),
  summary: z.string(),
  content_type: z.enum(CONTENT_TYPES),
  energy: z.number().min(0).max(1),
  standalone_score: z.number().min(0).max(1),
  potential_hooks: z.array(z.string()),
  context_deps: z.string().nullable(),
});

const MapSchema = z.object({
  candidates: z.array(CandidateSchema),
});

/**
 * The reduce schema. `candidate_ids` is what makes merging auditable: a segment
 * that claims to combine candidates 4 and 11 can be checked against them, and
 * the ids show up in the timeline when the analyst folds a duplicate away.
 */
const ReducedSegmentSchema = CandidateSchema.extend({
  candidate_ids: z.array(z.number().int()),
  novelty_score: z.number().min(0).max(1),
});

const ReduceSchema = z.object({
  reasoning: z.string(),
  segments: z.array(ReducedSegmentSchema),
});

export type Candidate = z.infer<typeof CandidateSchema>;

/** A segment as this agent finally emits it: validated, snapped, and text-backed. */
export interface AnalyzedSegment {
  start_time: number;
  end_time: number;
  topic: string;
  summary: string;
  content_type: ContentType;
  energy: number;
  standalone_score: number;
  novelty_score: number;
  potential_hooks: string[];
  context_deps: string | null;
  transcript: string;
}

export interface AnalysisWindow {
  index: number;
  startSec: number;
  endSec: number;
  words: Word[];
}

export interface AnalysisResult {
  segments: AnalyzedSegment[];
  windowCount: number;
  candidateCount: number;
  failedWindows: number;
  reasoning: string;
}

export interface AnalystInput {
  campaignId: string;
  words: Word[];
  goal: string;
  audience: string | null;
  brandVoice: string | null;
  onProgress?: (info: { done: number; of: number; candidates: number }) => void;
  onWindowFailure?: (info: { index: number; error: string }) => void;
  /**
   * Window geometry, overridable so the multi-window path can be exercised
   * against real speech without a 90 minute recording. Production always uses
   * the defaults. Same reasoning as `TranscribeOptions.chunkSeconds`: the
   * interesting failures here - a topic sliced across a boundary, a duplicate
   * the reduce pass fails to merge - only exist when there is more than one
   * window, and a path that only runs on long inputs is a path that only gets
   * tested by accident.
   */
  windowSeconds?: number;
  overlapSeconds?: number;
}

// ---------------------------------------------------------------------------
// Pure functions. Everything below the fold that matters for correctness lives
// here, without a network, so `source-analyst.test.ts` can pin it.
// ---------------------------------------------------------------------------

/**
 * Slice the word stream into overlapping windows.
 *
 * Windows are cut on *word* boundaries inside a time grid, not on the time grid
 * itself: a word is assigned to a window by its start time, so no word is split
 * and none is lost. The stride is `window - overlap`, so consecutive windows
 * share their last and first minute respectively.
 *
 * A final window that adds less new material than the overlap is folded into its
 * predecessor rather than emitted. The test is what the window *adds*, not how
 * long it is: a tail window is mostly a re-read of the one before it by
 * construction, so a 90 second window carrying 20 seconds of unseen speech is a
 * paid call that can only produce duplicates. Folding appends those words to the
 * previous window, so the fold never costs coverage.
 */
export function planWindows(
  words: Word[],
  windowSeconds = WINDOW_SECONDS,
  overlapSeconds = WINDOW_OVERLAP_SECONDS,
): AnalysisWindow[] {
  if (windowSeconds <= 0) throw new Error('windowSeconds must be positive.');
  if (overlapSeconds < 0 || overlapSeconds >= windowSeconds) {
    throw new Error('overlapSeconds must be non-negative and smaller than windowSeconds.');
  }
  if (words.length === 0) return [];

  const sorted = [...words].sort((a, b) => a.s - b.s || a.e - b.e);
  const first = sorted[0].s;
  const last = sorted[sorted.length - 1].e;
  const stride = windowSeconds - overlapSeconds;

  const windows: AnalysisWindow[] = [];
  for (let start = first, index = 0; start < last; start += stride, index++) {
    const end = Math.min(start + windowSeconds, last);
    const inWindow = sorted.filter((word) => word.s >= start && word.s < end);
    if (inWindow.length === 0) continue;

    const previous = windows[windows.length - 1];
    if (previous && end >= last && end - previous.endSec <= overlapSeconds) {
      // A tail carrying almost nothing new. Hand its unseen words to the
      // previous window instead of paying for a call that mostly re-reads it.
      previous.words.push(...inWindow.filter((word) => word.s >= previous.endSec));
      previous.endSec = end;
      continue;
    }

    windows.push({ index: windows.length, startSec: start, endSec: end, words: inWindow });
  }

  return windows;
}

/**
 * Render a window as timestamped lines.
 *
 * This is the whole reason the map pass can return usable numbers. A model
 * handed a wall of prose invents timestamps; a model handed `[412.5] the thing
 * about hiring is` copies them, and the copies land within a line's worth of the
 * truth. Line length is the accuracy knob: shorter lines, tighter boundaries,
 * more tokens.
 */
export function renderWindow(words: Word[], wordsPerLine = 12): string {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    const line = words.slice(i, i + wordsPerLine);
    lines.push(`[${line[0].s.toFixed(1)}] ${line.map((word) => word.w.trim()).join(' ')}`);
  }
  return lines.join('\n');
}

/** The verbatim words inside a time range, as text. Segments carry their own
 * source text so the Writing Agent can be given quotes rather than summaries. */
export function textBetween(words: Word[], startSec: number, endSec: number): string {
  return words
    .filter((word) => word.e > startSec && word.s < endSec)
    .map((word) => word.w.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Force a model-proposed boundary onto a real one.
 *
 * Snaps `start` back to the start of the word containing or following it, and
 * `end` forward to the end of the word containing or preceding it, then clamps
 * both inside the transcript. Returns null when nothing legal survives: a
 * zero-or-negative span violates the `segments_time_valid` check constraint, and
 * a segment shorter than `MIN_SEGMENT_SECONDS` cannot become an asset.
 *
 * These boundaries are topic bounds, not cut points. The Clip Producer re-snaps
 * with its own tail padding when it actually renders (MVP section 7.4).
 */
export function snapToWords(
  words: Word[],
  startSec: number,
  endSec: number,
  minSeconds = MIN_SEGMENT_SECONDS,
): { start: number; end: number } | null {
  if (words.length === 0) return null;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null;

  const first = words[0].s;
  const last = words[words.length - 1].e;

  const wantStart = Math.max(first, Math.min(startSec, last));
  const wantEnd = Math.max(first, Math.min(endSec, last));

  const startWord = words.find((word) => word.e > wantStart) ?? words[0];
  const endCandidates = words.filter((word) => word.s < wantEnd);
  const endWord = endCandidates[endCandidates.length - 1] ?? words[words.length - 1];

  const start = Math.max(first, startWord.s);
  const end = Math.min(last, endWord.e);

  if (!(end > start)) return null;
  if (end - start < minSeconds) return null;
  return { start, end };
}

/**
 * The code half of the analyst: everything the model proposed, made legal.
 *
 * Order matters. Filler is dropped first so a filler segment cannot win a
 * duplicate contest against a real one. Boundaries are snapped before
 * deduplication so overlap is measured on the boundaries that will actually be
 * stored. The cap is applied last, on a list already sorted by strength, so the
 * segments that survive a full pool are the best ones rather than the earliest.
 */
export function normalizeSegments(
  proposed: Array<z.infer<typeof ReducedSegmentSchema>>,
  words: Word[],
  options: { maxSegments?: number; minSeconds?: number } = {},
): AnalyzedSegment[] {
  const maxSegments = options.maxSegments ?? MAX_SEGMENTS;
  const minSeconds = options.minSeconds ?? MIN_SEGMENT_SECONDS;

  const legal: AnalyzedSegment[] = [];

  for (const item of proposed) {
    // Filler is a label the analyst is explicitly asked to apply, and applying
    // it is the point. Storing it would hand the Strategist a pool it has to
    // re-filter with a more expensive model.
    if (item.content_type === 'filler') continue;

    const snapped = snapToWords(words, item.start_time, item.end_time, minSeconds);
    if (!snapped) continue;

    const transcript = textBetween(words, snapped.start, snapped.end);
    if (transcript === '') continue;

    legal.push({
      start_time: round(snapped.start, 3),
      end_time: round(snapped.end, 3),
      topic: item.topic.trim(),
      summary: item.summary.trim(),
      content_type: item.content_type,
      // The schema already rejects out-of-range scores and the repair pass fixes
      // them, but `segments.energy` has a `between 0 and 1` check constraint and
      // an insert that trips it fails the whole node. Clamping is the cheap
      // guarantee that a scoring quirk never becomes a database error.
      energy: clamp01(item.energy),
      standalone_score: clamp01(item.standalone_score),
      novelty_score: clamp01(item.novelty_score),
      potential_hooks: item.potential_hooks
        .map((hook) => hook.trim())
        .filter((hook) => hook !== '')
        .slice(0, 3),
      context_deps: item.context_deps?.trim() || null,
      transcript,
    });
  }

  const deduped = dropDuplicates(legal);

  return deduped
    .slice()
    .sort((a, b) => strength(b) - strength(a))
    .slice(0, maxSegments)
    .sort((a, b) => a.start_time - b.start_time);
}

/**
 * Drop segments that are mostly the same span as a stronger one.
 *
 * Overlap is measured against the *shorter* segment, so a 20 second aside living
 * entirely inside a 90 second answer counts as fully overlapping and is dropped,
 * which is the behaviour you want: it is not a second topic.
 */
export function dropDuplicates(
  segments: AnalyzedSegment[],
  ratio = DUPLICATE_OVERLAP_RATIO,
): AnalyzedSegment[] {
  const byStrength = [...segments].sort((a, b) => strength(b) - strength(a));
  const kept: AnalyzedSegment[] = [];

  for (const candidate of byStrength) {
    const duplicate = kept.some((existing) => overlapRatio(existing, candidate) > ratio);
    if (!duplicate) kept.push(candidate);
  }

  return kept.sort((a, b) => a.start_time - b.start_time);
}

function overlapRatio(a: AnalyzedSegment, b: AnalyzedSegment): number {
  const overlap = Math.min(a.end_time, b.end_time) - Math.max(a.start_time, b.start_time);
  if (overlap <= 0) return 0;
  const shorter = Math.min(a.end_time - a.start_time, b.end_time - b.start_time);
  return shorter <= 0 ? 0 : overlap / shorter;
}

/**
 * The single number the cap and the duplicate contest are decided on.
 *
 * `standalone_score` is weighted highest on purpose: every asset this system
 * produces is consumed with zero context by someone scrolling, so a brilliant
 * point that needs ten minutes of setup is worth less here than a good one that
 * does not.
 */
function strength(segment: AnalyzedSegment): number {
  return segment.standalone_score * 2 + segment.novelty_score * 1.5 + segment.energy;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// The agent itself.
// ---------------------------------------------------------------------------

export async function analyzeSource(input: AnalystInput): Promise<AnalysisResult> {
  const windows = planWindows(
    input.words,
    input.windowSeconds ?? WINDOW_SECONDS,
    input.overlapSeconds ?? WINDOW_OVERLAP_SECONDS,
  );
  if (windows.length === 0) {
    throw new Error('Transcript has no words, so there is nothing to analyze.');
  }

  const objective = describeObjective(input);

  let done = 0;
  let failedWindows = 0;

  const perWindow = await mapWithConcurrency(windows, MAP_CONCURRENCY, async (window) => {
    try {
      const candidates = await mapWindow(input, window, objective);
      return { candidates, error: null as string | null };
    } catch (error) {
      // One window failing should not throw away twelve good ones. The cost
      // ceiling is the exception: it is not a content problem, and the other two
      // in-flight windows continuing past it would spend money the campaign has
      // already been told to stop spending.
      if (error instanceof CostCeilingExceededError) throw error;

      const message = error instanceof Error ? error.message : String(error);
      failedWindows++;
      input.onWindowFailure?.({ index: window.index, error: message });
      return { candidates: [] as Candidate[], error: message };
    } finally {
      done++;
      input.onProgress?.({ done, of: windows.length, candidates: 0 });
    }
  });

  const candidates = perWindow.flatMap((result) => result.candidates);

  // Losing a third of the episode is not a degraded analysis, it is a different
  // episode. Better to fail here than to let the Strategist plan a campaign
  // around whichever windows happened to succeed.
  if (failedWindows > windows.length / 3) {
    throw new Error(
      `Source analysis failed on ${failedWindows} of ${windows.length} windows; too much of the episode is missing to plan a campaign from.`,
    );
  }
  if (candidates.length === 0) {
    throw new Error('Source analysis found no candidate topics in the transcript.');
  }

  const reduced = await reduceCandidates(input, candidates, objective);
  const segments = normalizeSegments(reduced.segments, input.words);

  if (segments.length === 0) {
    throw new Error(
      `Source analysis produced ${reduced.segments.length} segment(s), none of which survived boundary validation. The model is likely returning timestamps outside the transcript.`,
    );
  }

  return {
    segments,
    windowCount: windows.length,
    candidateCount: candidates.length,
    failedWindows,
    reasoning: reduced.reasoning,
  };
}

async function mapWindow(
  input: AnalystInput,
  window: AnalysisWindow,
  objective: string,
): Promise<Candidate[]> {
  const result = await callStructured({
    campaignId: input.campaignId,
    agent: 'source_analyst',
    node: 'analyze',
    role: 'fast',
    schema: MapSchema,
    schemaName: 'candidate_segments',
    schemaDescription: 'Self-contained candidate topics found in one window of a podcast transcript.',
    system: MAP_SYSTEM,
    prompt: [
      `You are reading minutes ${fmt(window.startSec)} to ${fmt(window.endSec)} of a longer podcast.`,
      'Each line begins with the timestamp, in seconds, of its first word.',
      '',
      renderWindow(window.words),
      '',
      '---',
      `Extract every self-contained moment worth turning into short-form content. Return between 0 and 6 candidates; return none rather than padding the list with filler.`,
      `Timestamps must be real seconds copied from the transcript above, inside ${window.startSec.toFixed(1)} to ${window.endSec.toFixed(1)}.`,
      'A candidate normally runs 20 to 120 seconds: long enough to make a point, short enough to hold attention.',
      '',
      objective,
    ].join('\n'),
    input: {
      window_index: window.index,
      start_sec: window.startSec,
      end_sec: window.endSec,
      word_count: window.words.length,
    } as Json,
  });

  return result.value.candidates;
}

async function reduceCandidates(
  input: AnalystInput,
  candidates: Candidate[],
  objective: string,
): Promise<z.infer<typeof ReduceSchema>> {
  // Only the compact form goes to the reasoning model: a few thousand tokens of
  // candidate descriptions instead of the 150k token transcript they came from.
  // This is the whole economic argument for map-reduce.
  const listing = candidates
    .map((candidate, index) => {
      const hooks = candidate.potential_hooks.slice(0, 3).join(' | ');
      return [
        `#${index} [${candidate.start_time.toFixed(1)}-${candidate.end_time.toFixed(1)}] ${candidate.content_type}`,
        `  topic: ${candidate.topic}`,
        `  summary: ${candidate.summary}`,
        `  energy ${candidate.energy.toFixed(2)}, standalone ${candidate.standalone_score.toFixed(2)}`,
        hooks ? `  hooks: ${hooks}` : null,
        candidate.context_deps ? `  needs context: ${candidate.context_deps}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const result = await callStructured({
    campaignId: input.campaignId,
    agent: 'source_analyst',
    node: 'analyze',
    role: 'reasoning',
    schema: ReduceSchema,
    schemaName: 'analyzed_segments',
    schemaDescription: 'The deduplicated, globally scored topic segments of one podcast.',
    system: REDUCE_SYSTEM,
    prompt: [
      `${candidates.length} candidate topics were extracted from overlapping windows of one podcast. Adjacent windows overlap by ${WINDOW_OVERLAP_SECONDS} seconds, so the same topic often appears twice with slightly different boundaries.`,
      '',
      listing,
      '',
      '---',
      'Produce the final segment list:',
      '1. Merge candidates that describe the same moment into one segment. List every id you merged in `candidate_ids`, and set the boundaries to the widest span that is still about that one thing.',
      '2. Drop anything that is filler, throat-clearing, or unintelligible without the rest of the episode. Dropping is a real decision; a shorter, stronger list beats a complete one.',
      `3. Score \`novelty_score\` **relative to the other candidates here**, which is the only place it can be judged. A point three candidates make is not novel no matter how well it is made.`,
      `4. Return ${MIN_TARGET_SEGMENTS} to ${MAX_SEGMENTS} segments, best first is not required; they will be re-sorted.`,
      '',
      'Keep the timestamps you were given. Do not invent boundaries that were not in the candidate list.',
      '',
      objective,
    ].join('\n'),
    input: { candidate_count: candidates.length } as Json,
  });

  return result.value;
}

const MAP_SYSTEM = [
  'You find moments in a podcast that would work as standalone short-form content.',
  '',
  'The test for every candidate: could someone who has never heard this episode understand it in the first five seconds and get something out of it?',
  'Rate `standalone_score` against that test and nothing else. Score `energy` on delivery - conviction, pace, emphasis - not on how important the topic is.',
  '`context_deps` names what a viewer would have to already know; leave it null when the answer is nothing.',
  'Be honest with `content_type`. Labelling filler as filler is useful work, not a failure to find something.',
].join('\n');

const REDUCE_SYSTEM = [
  'You are consolidating the candidate topics extracted from one podcast into the final segment list.',
  '',
  'You are the only stage that sees the whole episode at once, so you own the two judgements no single window could make: which candidates are the same moment, and which points are actually novel within this episode.',
  'A tight list of strong, distinct segments is worth more than a complete inventory. The next agent plans a campaign from what you return, and it cannot recover the material you leave out - but it also cannot un-see near-duplicates you leave in.',
].join('\n');

/**
 * Every prompt ends with what the campaign is for. A shared rule from MVP
 * section 7.0: an agent that does not know the objective optimizes for a generic
 * one.
 */
function describeObjective(input: AnalystInput): string {
  return [
    'This campaign exists to serve one objective. Weigh every judgement against it.',
    `Goal: ${input.goal}`,
    input.audience ? `Audience: ${input.audience}` : 'Audience: not specified.',
    input.brandVoice ? `Brand voice: ${input.brandVoice}` : 'Brand voice: not specified.',
  ].join('\n');
}

function fmt(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Results keep input order regardless of completion order, so a window's
 * candidates stay associated with the window they came from. A cost-ceiling
 * error is rethrown rather than collected: it is the one failure where
 * continuing is actively harmful.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

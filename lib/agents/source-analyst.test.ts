import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dropDuplicates,
  normalizeSegments,
  normalizeScorePayload,
  planWindows,
  renderWindow,
  segmentStrength,
  snapToWords,
  textBetween,
  type AnalyzedSegment,
  type AnalystWarning,
} from './source-analyst';
import type { Word } from '../media/transcribe';

/**
 * The map-reduce halves of the Source Analyst that are not judgement calls.
 *
 * Everything here fails silently in production if it is wrong: a window that
 * drops words analyzes an episode that was never said, and a segment whose
 * boundaries drift produces a clip of the wrong sentence. None of it throws, and
 * none of it needs a network to check.
 */

/** One word per second, `w0` at 0.0-0.9, `w1` at 1.0-1.9, and so on. */
function words(count: number, startSec = 0): Word[] {
  return Array.from({ length: count }, (_, i) => ({
    w: `w${i}`,
    s: startSec + i,
    e: startSec + i + 0.9,
  }));
}

test('planWindows covers every word exactly once across window starts', () => {
  const input = words(1200); // 20 minutes at one word per second
  const windows = planWindows(input, 480, 60);

  assert.ok(windows.length >= 3, `expected several windows, got ${windows.length}`);

  // Assignment is by word start, so the set of first-seen words must be the
  // whole transcript: a word missing here was analyzed by nobody.
  const seen = new Set<string>();
  for (const window of windows) for (const word of window.words) seen.add(word.w);
  assert.equal(seen.size, input.length);
});

test('planWindows overlaps adjacent windows by the requested seconds', () => {
  const windows = planWindows(words(1200), 480, 60);

  for (let i = 1; i < windows.length; i++) {
    const previous = windows[i - 1];
    const current = windows[i];
    assert.ok(
      current.startSec < previous.endSec,
      `window ${i} starts at ${current.startSec}, after window ${i - 1} ends at ${previous.endSec}; a topic on that boundary is truncated in both`,
    );
  }
});

test('planWindows folds a tail sliver into the previous window without losing its words', () => {
  // 500 seconds with a 480 s window and 420 s stride: the second window would
  // cover 420-500, of which only the last 20 seconds are new. Not worth a call
  // - but those 20 seconds must still be analyzed by somebody.
  const windows = planWindows(words(500), 480, 60);

  assert.equal(windows.length, 1, 'a tail that adds 20 seconds is a paid duplicate');
  assert.ok(windows[0].endSec >= 499, 'the fold must extend the previous window to the end');
  assert.equal(windows[0].words.length, 500, 'folding must not drop the words it folded in');
  assert.equal(windows[0].words[499].w, 'w499');
});

test('planWindows is a single window for a source shorter than one window', () => {
  const windows = planWindows(words(60), 480, 60);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].words.length, 60);
});

test('planWindows rejects an overlap that would not advance', () => {
  assert.throws(() => planWindows(words(100), 480, 480));
  assert.throws(() => planWindows(words(100), 480, 600));
});

test('planWindows handles an unsorted word array', () => {
  const shuffled = [...words(200)].reverse();
  const windows = planWindows(shuffled, 480, 60);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].words[0].w, 'w0', 'windows must be built on sorted time, not input order');
});

test('renderWindow prefixes each line with its first word timestamp', () => {
  const rendered = renderWindow(words(5, 100), 2);
  assert.equal(rendered, '[100.0] w0 w1\n[102.0] w2 w3\n[104.0] w4');
});

test('textBetween returns the verbatim words inside a span', () => {
  // Written assets are grounded in source quotes, so this text has to be what
  // was actually said, not a paraphrase or a window off by one word.
  assert.equal(textBetween(words(10), 3, 6), 'w3 w4 w5');
});

test('snapToWords pulls a boundary onto real word edges', () => {
  const input = words(60);
  const snapped = snapToWords(input, 10.4, 40.4, 12);

  assert.ok(snapped);
  assert.equal(snapped.start, 10, 'start snaps back to the start of the word it lands inside');
  assert.equal(snapped.end, 40.9, 'end snaps forward to the end of the word it lands inside');
});

test('snapToWords clamps a boundary past the end of the transcript', () => {
  const input = words(60); // ends at 59.9
  const snapped = snapToWords(input, 30, 9_000, 12);

  assert.ok(snapped);
  assert.equal(snapped.end, 59.9, 'a hallucinated timestamp must not reach ffmpeg -ss');
});

test('snapToWords rejects a span that cannot become an asset', () => {
  const input = words(60);
  assert.equal(snapToWords(input, 30, 20, 12), null, 'end before start violates segments_time_valid');
  assert.equal(snapToWords(input, 30, 35, 12), null, 'five seconds is not a piece of content');
  assert.equal(snapToWords(input, Number.NaN, 40, 12), null);
});

function segment(overrides: Partial<AnalyzedSegment> = {}): AnalyzedSegment {
  return {
    start_time: 0,
    end_time: 60,
    topic: 'topic',
    summary: 'summary',
    content_type: 'advice',
    energy: 0.5,
    standalone_score: 0.5,
    novelty_score: 0.5,
    potential_hooks: [],
    context_deps: null,
    transcript: 'text',
    ...overrides,
  };
}

type ProposedSegment = Parameters<typeof normalizeSegments>[0][number];

function proposedSegment(overrides: Partial<ProposedSegment> = {}): ProposedSegment {
  return {
    start_time: 0,
    end_time: 60,
    topic: 'topic',
    summary: 'summary',
    content_type: 'advice',
    energy: 0.5,
    standalone_score: 0.5,
    novelty_score: 0.5,
    potential_hooks: [],
    context_deps: null,
    candidate_ids: [0],
    ...overrides,
  };
}

test('dropDuplicates keeps the stronger of two segments covering the same span', () => {
  const weak = segment({ topic: 'weak', start_time: 100, end_time: 160, standalone_score: 0.3 });
  const strong = segment({ topic: 'strong', start_time: 105, end_time: 165, standalone_score: 0.9 });

  const kept = dropDuplicates([weak, strong]);
  assert.deepEqual(
    kept.map((s) => s.topic),
    ['strong'],
  );
});

test('dropDuplicates drops an aside contained inside a longer segment', () => {
  // Overlap is measured against the shorter segment, so a 20 s aside living
  // wholly inside a 90 s answer is 100% overlapping. It is not a second topic.
  const answer = segment({ topic: 'answer', start_time: 100, end_time: 190, novelty_score: 0.6 });
  const aside = segment({ topic: 'aside', start_time: 120, end_time: 140, novelty_score: 0.1 });

  assert.deepEqual(
    dropDuplicates([answer, aside]).map((s) => s.topic),
    ['answer'],
  );
});

test('dropDuplicates keeps genuinely adjacent segments', () => {
  const first = segment({ topic: 'first', start_time: 0, end_time: 60 });
  const second = segment({ topic: 'second', start_time: 58, end_time: 120 });

  assert.equal(dropDuplicates([first, second]).length, 2, 'two seconds of overlap is not a duplicate');
});

test('normalizeSegments drops filler and illegal boundaries, and keeps order', () => {
  const input = words(600);

  const output = normalizeSegments(
    [
      {
        start_time: 10,
        end_time: 80,
        topic: 'kept',
        summary: 's',
        content_type: 'advice',
        energy: 0.6,
        standalone_score: 0.8,
        novelty_score: 0.7,
        potential_hooks: ['a', 'b', 'c', 'd'],
        context_deps: '  ',
        candidate_ids: [0],
      },
      {
        start_time: 200,
        end_time: 260,
        topic: 'filler',
        summary: 's',
        content_type: 'filler',
        energy: 0.2,
        standalone_score: 0.2,
        novelty_score: 0.2,
        potential_hooks: [],
        context_deps: null,
        candidate_ids: [1],
      },
      {
        start_time: 400,
        end_time: 402,
        topic: 'too short',
        summary: 's',
        content_type: 'opinion',
        energy: 0.9,
        standalone_score: 0.9,
        novelty_score: 0.9,
        potential_hooks: [],
        context_deps: null,
        candidate_ids: [2],
      },
      {
        start_time: 300,
        end_time: 380,
        topic: 'also kept',
        summary: 's',
        content_type: 'personal_story',
        energy: 0.5,
        standalone_score: 0.5,
        novelty_score: 0.5,
        potential_hooks: [],
        context_deps: 'who the guest is',
        candidate_ids: [3],
      },
    ],
    input,
  );

  assert.deepEqual(
    output.map((s) => s.topic),
    ['kept', 'also kept'],
    'filler and sub-minimum spans are dropped; survivors come back in source order',
  );
  assert.deepEqual(output[0].potential_hooks, ['a', 'b', 'c'], 'hook count is trimmed in code');
  assert.equal(output[0].context_deps, null, 'whitespace-only context is nothing, not a dependency');
  assert.equal(output[0].transcript, textBetween(input, output[0].start_time, output[0].end_time));
});

test('normalizeSegments rejects scores that would violate the score contract', () => {
  assert.throws(
    () =>
      normalizeSegments(
        [
          proposedSegment({
            content_type: 'opinion',
            energy: 7,
            standalone_score: -2,
            novelty_score: Number.NaN,
          }),
        ],
        words(120),
      ),
    /ranking score/,
  );
});

test('normalizeScorePayload preserves a valid 0..1 map payload exactly', () => {
  const payload = [{ energy: 0.2, standalone_score: 0.6 }];
  assert.deepEqual(normalizeScorePayload(payload), payload);
});

test('normalizeScorePayload converts a consistent 1..10 map payload', () => {
  assert.deepEqual(
    normalizeScorePayload([{ energy: 7, standalone_score: 8 }]),
    [{ energy: 0.7, standalone_score: 0.8 }],
  );
});

test('normalizeScorePayload converts a consistent 1..10 reduce payload', () => {
  assert.deepEqual(
    normalizeScorePayload([{ energy: 7, standalone_score: 8, novelty_score: 9 }]),
    [{ energy: 0.7, standalone_score: 0.8, novelty_score: 0.9 }],
  );
});

test('normalizeScorePayload rejects invalid and mixed score scales', () => {
  for (const invalid of [-0.1, 10.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => normalizeScorePayload([{ energy: invalid, standalone_score: 0.5 }]),
      /score/,
      `expected ${String(invalid)} to be rejected`,
    );
  }

  assert.throws(
    () => normalizeScorePayload([{ energy: 0.7, standalone_score: 7 }]),
    /mixes the 0\.\.1 and 1\.\.10 scales/,
  );
});

test('reduce scores on a 1-to-10 scale stay differentiated instead of saturating at 1', () => {
  const output = normalizeSegments(
    [
      {
        start_time: 0,
        end_time: 60,
        topic: 'dogfood score scale',
        summary: 'The reduce pass returned the old 1-to-10 scale.',
        content_type: 'advice',
        energy: 7,
        standalone_score: 8,
        novelty_score: 9,
        potential_hooks: [],
        context_deps: null,
        candidate_ids: [7, 8, 9],
      },
    ],
    words(120),
  );

  assert.deepEqual(
    [output[0].energy, output[0].standalone_score, output[0].novelty_score],
    [0.7, 0.8, 0.9],
  );
});

test('segmentStrength ranks normalized 0.7, 0.8, and 0.9 scores correctly', () => {
  const lower = segment({ energy: 0.7, standalone_score: 0.7, novelty_score: 0.7 });
  const higher = segment({ energy: 0.9, standalone_score: 0.8, novelty_score: 0.7 });

  assert.ok(segmentStrength(higher) > segmentStrength(lower));
  assert.equal(segmentStrength(higher), 3.55);
});

test('normalization emits a warning with the raw and normalized score distribution', () => {
  const warnings: AnalystWarning[] = [];
  normalizeSegments(
    [proposedSegment({ energy: 7, standalone_score: 8, novelty_score: 9 })],
    words(120),
    { onWarning: (warning) => warnings.push(warning) },
  );

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'score_scale_normalized');
  assert.equal(warnings[0].message.includes('1..10'), true);
  assert.deepEqual(warnings[0].data, {
    pass: 'final',
    raw_scores: [7, 8, 9],
    normalized_scores: [0.7, 0.8, 0.9],
  });
});

test('uniform surviving segments emit a saturation diagnostic without failing', () => {
  const warnings: AnalystWarning[] = [];
  const output = normalizeSegments(
    [
      proposedSegment({ start_time: 0, end_time: 60, topic: 'first' }),
      proposedSegment({ start_time: 100, end_time: 160, topic: 'second' }),
    ],
    words(200),
    { onWarning: (warning) => warnings.push(warning) },
  );

  assert.equal(output.length, 2);
  const saturation = warnings.find((warning) => warning.kind === 'score_saturation');
  assert.ok(saturation);
  assert.deepEqual(saturation.data, {
    segment_count: 2,
    raw_distribution: [
      { energy: 0.5, standalone_score: 0.5, novelty_score: 0.5 },
      { energy: 0.5, standalone_score: 0.5, novelty_score: 0.5 },
    ],
  });
});

test('normalizeSegments caps the pool by strength, not by position', () => {
  const input = words(1200);
  const proposed = Array.from({ length: 10 }, (_, i) => ({
    start_time: i * 100,
    end_time: i * 100 + 60,
    topic: `t${i}`,
    summary: 's',
    content_type: 'advice' as const,
    energy: 0.5,
    // Later segments are stronger, so a cap that kept the first N would keep the
    // worst ones.
    standalone_score: i / 10,
    novelty_score: i / 10,
    potential_hooks: [],
    context_deps: null,
    candidate_ids: [i],
  }));

  const output = normalizeSegments(proposed, input, { maxSegments: 3 });

  assert.deepEqual(
    output.map((s) => s.topic),
    ['t7', 't8', 't9'],
  );
});

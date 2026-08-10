import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHUNK_SECONDS, mergeChunks, planChunks, type TranscriptChunk } from './transcribe';

/**
 * These two functions are pure so this failure mode can be caught without a
 * network, a Groq key, or a 90 minute file. A wrong chunk offset misaligns every
 * caption in the campaign and throws nothing anywhere.
 */

function chunk(offsetSec: number, words: Array<[string, number, number]>): TranscriptChunk {
  return {
    offsetSec,
    text: words.map(([w]) => w).join(' '),
    words: words.map(([w, s, e]) => ({ w, s, e })),
  };
}

describe('planChunks', () => {
  it('covers the whole duration with no gaps and no overlap', () => {
    const plan = planChunks(1_500, 600);
    assert.deepEqual(plan, [
      { index: 0, startSec: 0, durationSec: 600 },
      { index: 1, startSec: 600, durationSec: 600 },
      { index: 2, startSec: 1_200, durationSec: 300 },
    ]);

    const covered = plan.reduce((total, entry) => total + entry.durationSec, 0);
    assert.equal(covered, 1_500);
  });

  it('returns a single chunk when the source is shorter than one chunk', () => {
    assert.deepEqual(planChunks(90, 600), [{ index: 0, startSec: 0, durationSec: 90 }]);
  });

  it('does not emit a zero-length trailing chunk on an exact multiple', () => {
    const plan = planChunks(1_200, 600);
    assert.equal(plan.length, 2);
    assert.ok(plan.every((entry) => entry.durationSec > 0));
  });

  it('plans a 90 minute episode into nine chunks at the real chunk size', () => {
    const plan = planChunks(90 * 60, CHUNK_SECONDS);
    assert.equal(plan.length, 9);
    assert.equal(plan.at(-1)?.startSec, 4_800);
  });

  it('refuses a duration it cannot chunk', () => {
    assert.throws(() => planChunks(0), /Cannot plan chunks/);
    assert.throws(() => planChunks(Number.NaN), /Cannot plan chunks/);
  });
});

describe('mergeChunks', () => {
  it('adds the chunk offset to every word timestamp', () => {
    const merged = mergeChunks([
      chunk(0, [
        ['the', 1, 1.4],
        ['first', 1.4, 1.9],
      ]),
      chunk(600, [
        ['much', 2, 2.5],
        ['later', 2.5, 3],
      ]),
    ]);

    assert.deepEqual(merged.words, [
      { w: 'the', s: 1, e: 1.4 },
      { w: 'first', s: 1.4, e: 1.9 },
      { w: 'much', s: 602, e: 602.5 },
      { w: 'later', s: 602.5, e: 603 },
    ]);
    assert.equal(merged.text, 'the first much later');
  });

  it('keeps timestamps monotonic even if chunks arrive out of order', () => {
    const merged = mergeChunks([
      chunk(600, [['later', 0, 0.5]]),
      chunk(0, [['earlier', 0, 0.5]]),
    ]);

    assert.deepEqual(
      merged.words.map((word) => word.w),
      ['earlier', 'later'],
    );
    assert.equal(merged.text, 'earlier later');
  });

  it('leaves a single unchunked transcript untouched', () => {
    const words: Array<[string, number, number]> = [
      ['one', 0.2, 0.5],
      ['file', 0.5, 0.9],
    ];
    const merged = mergeChunks([chunk(0, words)]);
    assert.deepEqual(merged.words, [
      { w: 'one', s: 0.2, e: 0.5 },
      { w: 'file', s: 0.5, e: 0.9 },
    ]);
  });

  it('drops words with unusable timestamps rather than passing NaN to ffmpeg', () => {
    const merged = mergeChunks([
      {
        offsetSec: 60,
        text: 'good bad',
        words: [
          { w: 'good', s: 1, e: 2 },
          { w: 'bad', s: Number.NaN, e: 3 },
        ],
      },
    ]);

    assert.deepEqual(merged.words, [{ w: 'good', s: 61, e: 62 }]);
  });

  it('never lets a later chunk land before an earlier one', () => {
    const plan = planChunks(90 * 60, CHUNK_SECONDS);
    const merged = mergeChunks(
      plan.map((entry) => chunk(entry.startSec, [[`w${entry.index}`, 5, 6]])),
    );

    for (let i = 1; i < merged.words.length; i++) {
      assert.ok(
        merged.words[i].s > merged.words[i - 1].s,
        `word ${i} at ${merged.words[i].s} is not after ${merged.words[i - 1].s}`,
      );
    }
    assert.equal(merged.words.at(-1)?.s, 4_805);
  });

  it('skips empty chunk text instead of collapsing it into double spaces', () => {
    const merged = mergeChunks([chunk(0, [['hello', 0, 1]]), chunk(600, []), chunk(1_200, [['bye', 0, 1]])]);
    assert.equal(merged.text, 'hello bye');
  });
});

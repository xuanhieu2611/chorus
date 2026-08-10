import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapClipBoundaries } from './clip-producer';
import type { Word } from '../media/transcribe';

const words: Word[] = Array.from({ length: 20 }, (_, index) => ({
  w: `w${index}`,
  s: 100 + index,
  e: 100.7 + index,
}));
const sources = [{ start: 100, end: 120 }];

test('clip boundaries snap to words and leave 300 ms after the last word', () => {
  const result = snapClipBoundaries(words, 102.4, 108.8, sources, 30, 1_000);
  assert.deepEqual(result, { start: 102, end: 109 });
});

test('clip boundaries cannot cross a selected segment or duration cap', () => {
  const result = snapClipBoundaries(words, 100, 900, sources, 5, 1_000);
  assert.ok(result);
  assert.equal(result.start, 100);
  assert.ok(result.end <= 105);
  assert.ok(result.end <= sources[0].end);
});

test('clip boundaries reject an unusable model range', () => {
  assert.equal(snapClipBoundaries(words, 110, 109, sources, 30, 1_000), null);
  assert.equal(snapClipBoundaries([], 100, 110, sources, 30, 1_000), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildQuoteBank,
  normalizeForGrounding,
  validateGrounding,
  type WritingSource,
  type WrittenAsset,
} from './writer';

const sources: WritingSource[] = [
  {
    id: 'segment-1',
    startTime: 10,
    endTime: 40,
    transcript: 'The best products start with a painful, specific problem. You should talk to five customers before writing code.',
  },
];

function linkedin(sourceQuote: string): WrittenAsset {
  return {
    hook: 'Start with pain, not features.',
    content: {
      kind: 'linkedin_post',
      body: 'The best products begin with a specific customer problem.',
    },
    grounding: [
      {
        claim: 'Strong products begin with a specific painful problem.',
        source_quote: sourceQuote,
      },
    ],
  };
}

test('grounding accepts an exact transcript quote with case and whitespace differences', () => {
  const asset = linkedin('THE BEST PRODUCTS   start with a painful, specific problem.');
  assert.deepEqual(validateGrounding(asset, 'linkedin_post', sources), []);
});

test('grounding rejects a paraphrase even when it preserves the source meaning', () => {
  const failures = validateGrounding(
    linkedin('Great products begin with a clearly defined customer pain.'),
    'linkedin_post',
    sources,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /does not appear/);
});

test('grounding rejects content for the wrong planned platform', () => {
  const asset: WrittenAsset = {
    hook: 'A thread hook',
    content: { kind: 'x_thread', tweets: ['One', 'Two', 'Three'] },
    grounding: [
      {
        claim: 'Talk to five customers.',
        source_quote: 'talk to five customers',
      },
    ],
  };
  assert.match(validateGrounding(asset, 'linkedin_post', sources)[0], /plan requires linkedin_post/);
});

test('runtime validation enforces platform character limits', () => {
  const asset: WrittenAsset = {
    hook: 'A thread hook',
    content: { kind: 'x_thread', tweets: ['x'.repeat(281), 'Two', 'Three'] },
    grounding: [
      {
        claim: 'Talk to five customers.',
        source_quote: 'talk to five customers',
      },
    ],
  };
  assert.match(validateGrounding(asset, 'x_thread', sources)[0], /limit is 280/);
});

test('normalization changes only case and whitespace', () => {
  assert.equal(normalizeForGrounding('  Mixed\n\tCASE  '), 'mixed case');
  assert.notEqual(normalizeForGrounding('speaker’s'), normalizeForGrounding("speaker's"));
});

test('quote bank creates overlapping verbatim options that pass grounding', () => {
  const bank = buildQuoteBank(sources, 8);
  assert.ok(bank.length > 1);
  for (const quote of bank) {
    assert.ok(normalizeForGrounding(sources[0].transcript).includes(normalizeForGrounding(quote)));
    assert.deepEqual(validateGrounding(linkedin(quote), 'linkedin_post', sources), []);
  }
});

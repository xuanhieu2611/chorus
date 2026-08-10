import test from 'node:test';
import assert from 'node:assert/strict';
import { ownsClaim, staleClaimCutoff } from '@/lib/worker/recovery';

test('stale claim cutoff is deterministic and in UTC', () => {
  assert.equal(
    staleClaimCutoff(new Date('2026-08-10T01:00:00.000Z'), 90),
    '2026-08-10T00:58:30.000Z',
  );
});

test('ownership fencing rejects a previous worker after reclaim', () => {
  assert.equal(ownsClaim('worker-a', 'worker-a'), true);
  assert.equal(ownsClaim('worker-a', 'worker-b'), false);
  assert.equal(ownsClaim(null, 'worker-a'), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groundingEvidenceLabel, showsSourceSupportedClaims } from './ui-grounding';

test('before Critic approval the UI calls lexical evidence exact source quotes', () => {
  assert.equal(
    groundingEvidenceLabel(2, { decision: 'REVISE', grounding_audit_passed: false }),
    '2 exact source quotes',
  );
  assert.equal(showsSourceSupportedClaims(null), false);
});

test('after Critic PASS the UI claims source support only when the semantic audit passed', () => {
  assert.equal(
    groundingEvidenceLabel(1, { decision: 'PASS', grounding_audit_passed: true }),
    '1 source-supported claim',
  );
  assert.equal(
    groundingEvidenceLabel(1, { decision: 'PASS', grounding_audit_passed: false }),
    '1 exact source quote',
  );
});

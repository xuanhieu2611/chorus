import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completionModeForAction,
  validateFinalApprovalAction,
} from '@/lib/final-approval';

test('ordinary approve is accepted only for an effective APPROVE decision', () => {
  assert.equal(
    validateFinalApprovalAction({ action: 'approve', effectiveDecision: 'APPROVE' }),
    null,
  );
});

test('ordinary approve is rejected for an effective REPLAN decision', () => {
  assert.match(
    validateFinalApprovalAction({ action: 'approve', effectiveDecision: 'REPLAN' }) ?? '',
    /override_and_approve/,
  );
});

test('override_and_approve is rejected for an effective APPROVE decision', () => {
  assert.match(
    validateFinalApprovalAction({
      action: 'override_and_approve',
      effectiveDecision: 'APPROVE',
      rationale: 'Ship it anyway.',
    }) ?? '',
    /Use approve/,
  );
});

test('override without a rationale is rejected', () => {
  assert.match(
    validateFinalApprovalAction({
      action: 'override_and_approve',
      effectiveDecision: 'REPLAN',
      rationale: '   ',
    }) ?? '',
    /non-empty rationale/,
  );
});

test('a valid override maps to human_override', () => {
  assert.equal(
    validateFinalApprovalAction({
      action: 'override_and_approve',
      effectiveDecision: 'REPLAN',
      rationale: 'The remaining issue is understood and accepted.',
    }),
    null,
  );
  assert.equal(completionModeForAction('override_and_approve'), 'human_override');
});

test('reviewer approval maps to reviewer_approved', () => {
  assert.equal(completionModeForAction('approve'), 'reviewer_approved');
});

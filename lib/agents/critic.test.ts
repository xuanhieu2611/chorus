import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  criticRevisionOutcome,
  decideCritic,
  validateGroundingAudit,
  type GroundingAuditRow,
  type GroundingClaim,
  type CriticRequiredChecks,
  type CriticReview,
  type CriticScores,
} from './critic';

function scores(value: number): CriticScores {
  return {
    hook: value,
    clarity: value,
    standalone: value,
    originality: value,
    audience_fit: value,
    payoff: value,
  };
}

function checks(overrides: Partial<CriticRequiredChecks> = {}): CriticRequiredChecks {
  return {
    brief_compliant: true,
    source_supported: true,
    standalone: true,
    payoff_delivered: true,
    ...overrides,
  };
}

function review(
  value = 8,
  overrides: Partial<Pick<CriticReview, 'required_checks' | 'grounding_audit' | 'blocking_feedback' | 'polish_feedback' | 'materially_contradicted'>> = {},
): CriticReview {
  return {
    scores: scores(value),
    required_checks: checks(overrides.required_checks),
    grounding_audit: overrides.grounding_audit ?? [],
    blocking_feedback: overrides.blocking_feedback ?? null,
    polish_feedback: overrides.polish_feedback ?? null,
    materially_contradicted: overrides.materially_contradicted ?? false,
  };
}

function claim(value: string): GroundingClaim {
  return { claim: value, source_quote: 'The source describes an observation without a diagnosis.' };
}

function audit(
  value: string,
  overrides: Partial<GroundingAuditRow> = {},
): GroundingAuditRow {
  return {
    claim: value,
    supported: true,
    overstates_source: false,
    reason: 'The claim faithfully paraphrases the source.',
    ...overrides,
  };
}

test('Critic rejects an asset when any dimension is 3 or below', () => {
  const routing = decideCritic({ ...scores(9), hook: 3 });
  assert.equal(routing.decision, 'REJECT');
  assert.equal(routing.average, 8);
  assert.equal(routing.lowest, 3);
});

test('Critic passes only with a seven average and no score below five', () => {
  assert.equal(decideCritic(scores(7)).decision, 'PASS');
  assert.equal(decideCritic({ ...scores(8), payoff: 4.9 }).decision, 'REVISE');
});

test('Critic routes a middle score to revision', () => {
  const routing = decideCritic({ ...scores(7), clarity: 6 });
  assert.equal(routing.decision, 'REVISE');
  assert.equal(routing.average, 6.83);
  assert.equal(routing.lowest, 6);
});

test('Critic cannot PASS an asset with an unresolved payoff check', () => {
  assert.equal(
    decideCritic(
      review(7.5, {
        required_checks: checks({ payoff_delivered: false }),
        blocking_feedback: 'The promised payoff never arrives inside the asset.',
      }),
    ).decision,
    'REVISE',
  );
});

test('unsupported causal text fails the source check and forces revision', () => {
  const routing = decideCritic(
    review(8, {
      required_checks: checks({ source_supported: false }),
      blocking_feedback: 'Remove the unsupported causal explanation or soften it to match the source.',
    }),
  );
  assert.equal(routing.decision, 'REVISE');
  assert.deepEqual(routing.failedChecks, ['source_supported']);
});

test('an exact quote paired with a stronger causal claim fails semantic support', () => {
  const submitted = claim('Talking to five customers proves product-market fit.');
  const routing = decideCritic(
    review(8, {
      grounding_audit: [
        audit(submitted.claim, {
          supported: false,
          overstates_source: true,
          reason: 'The quote recommends talking to customers but does not claim proof or causation.',
        }),
      ],
    }),
    [submitted],
  );

  assert.equal(routing.groundingAuditPassed, false);
  assert.equal(routing.decision, 'REVISE');
  assert.deepEqual(routing.failedChecks, ['source_supported']);
});

test('a faithful paraphrase paired with an exact quote passes semantic support', () => {
  const submitted = claim('The source recommends talking to five customers before writing code.');
  const routing = decideCritic(
    review(8, { grounding_audit: [audit(submitted.claim)] }),
    [submitted],
  );

  assert.equal(routing.groundingAuditPassed, true);
  assert.equal(routing.decision, 'PASS');
});

test('grounding audit fails closed on missing, duplicate, and extra rows', () => {
  const first = claim('The first submitted claim.');
  const second = claim('The second submitted claim.');

  const missing = validateGroundingAudit([first, second], [audit(first.claim)]);
  assert.equal(missing.passed, false);
  assert.match(missing.failures.join(' '), /Missing grounding audit row/);

  const duplicate = validateGroundingAudit([first], [audit(first.claim), audit(first.claim)]);
  assert.equal(duplicate.passed, false);
  assert.match(duplicate.failures.join(' '), /appears 2 times/);

  const extra = validateGroundingAudit([first], [audit(first.claim), audit('An invented claim.')]);
  assert.equal(extra.passed, false);
  assert.match(extra.failures.join(' '), /Extra grounding audit row/);
});

test('categorical neuromodulator diagnoses force revision until softened', () => {
  for (const neuromodulator of ['dopamine', 'serotonin', 'oxytocin', 'norepinephrine']) {
    const submitted = claim(`That is a ${neuromodulator} problem.`);
    const routing = decideCritic(
      review(8, {
        grounding_audit: [
          audit(submitted.claim, {
            supported: false,
            overstates_source: true,
            reason: 'The source describes an observation and does not diagnose a neuromodulator problem.',
          }),
        ],
      }),
      [submitted],
    );
    assert.equal(routing.decision, 'REVISE', neuromodulator);
    assert.equal(routing.groundingAuditPassed, false, neuromodulator);
  }
});

test('minor polish does not block a fully supported PASS', () => {
  const routing = decideCritic(
    review(8, {
      polish_feedback: 'Tighten the first sentence for a faster hook.',
    }),
  );
  assert.equal(routing.decision, 'PASS');
  assert.equal(routing.blockingFeedbackPresent, false);
});

test('blocking feedback prevents PASS even when every check and score qualifies', () => {
  const routing = decideCritic(
    review(8, {
      blocking_feedback: 'The final sentence still does not deliver the promised takeaway.',
    }),
  );
  assert.equal(routing.decision, 'REVISE');
  assert.equal(routing.blockingFeedbackPresent, true);
});

test('material source contradiction is rejected rather than locally revised', () => {
  assert.equal(
    decideCritic(review(8, { materially_contradicted: true })).decision,
    'REJECT',
  );
});

test('revision exhaustion abandons a still-failing asset', () => {
  assert.equal(criticRevisionOutcome('REVISE', 2, 3), 'REVISE');
  assert.equal(criticRevisionOutcome('REVISE', 3, 3), 'ABANDON');
});

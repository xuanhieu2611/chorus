export const TRANSITION_KINDS = [
  'director_replan',
  'strategy_gate_replan',
  'campaign_replan',
  'final_gate_replan',
] as const;

export type TransitionKind = (typeof TRANSITION_KINDS)[number];
export type CounterName = 'plan_revision_count' | 'portfolio_replan_count';

export interface TransitionCounters {
  plan_revision_count: number;
  portfolio_replan_count: number;
}

export function counterForTransition(kind: TransitionKind): CounterName {
  return kind === 'director_replan' || kind === 'strategy_gate_replan'
    ? 'plan_revision_count'
    : 'portfolio_replan_count';
}

export function limitForTransition(
  kind: TransitionKind,
  limits: { maxPlanRevisions: number; maxPortfolioReplans: number },
): number {
  return counterForTransition(kind) === 'plan_revision_count'
    ? limits.maxPlanRevisions
    : limits.maxPortfolioReplans;
}

export function transitionBudgetExhausted(
  counters: TransitionCounters,
  kind: TransitionKind,
  limits: { maxPlanRevisions: number; maxPortfolioReplans: number },
): boolean {
  return counters[counterForTransition(kind)] >= limitForTransition(kind, limits);
}

export function transitionBudgetWarning(
  kind: TransitionKind,
  counters: TransitionCounters,
  limits: { maxPlanRevisions: number; maxPortfolioReplans: number },
): string {
  const counter = counterForTransition(kind);
  const limit = limitForTransition(kind, limits);
  const label = counter === 'plan_revision_count' ? 'plan revisions' : 'portfolio replans';
  return `${label} budget exhausted (${counters[counter]}/${limit}).`;
}


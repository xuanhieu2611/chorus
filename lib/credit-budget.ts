/**
 * `campaigns.credit_budget` funds two different things, and only one of them is
 * visible to the Strategist.
 *
 * The Strategist plans a portfolio up front. The critique loop then spends from
 * the same pot: PRD section 12 prices a regeneration at 1 credit, and a Critic
 * REJECT buys a full-price replacement asset while the rejected one keeps the
 * credits it already burned. A plan that consumed the whole budget therefore
 * made the first revision or rejection fail the campaign outright inside
 * `begin_asset_generation`.
 *
 * So the Strategist is handed a planning share and the remainder is held back
 * for the loop. The split is arithmetic in code rather than an instruction in a
 * prompt, for the same reason every other budget rule is.
 */

/** Share of the campaign budget held back for revisions and replacements. */
export const CRITIQUE_RESERVE_RATIO = 1 / 3;

/** A Critic REVISE costs this much, matching `begin_asset_revision`. */
export const REVISION_CREDIT_COST = 1;

/**
 * The smallest planning budget that can still fund the two assets the strategy
 * contract requires. Reserving below this would fail planning instead of
 * protecting the loop, so the reserve yields to it.
 */
const MIN_PLANNING_CREDITS = 6;

export interface CreditLedger {
  credit_budget: number;
  credits_spent: number;
}

/**
 * The budget the Strategist plans against: the campaign budget minus the
 * critique reserve, never so small that a legal two-asset plan is impossible.
 */
export function planningCreditBudget(creditBudget: number): number {
  if (!Number.isFinite(creditBudget) || creditBudget <= 0) return 0;
  const reserved = Math.floor(creditBudget * (1 - CRITIQUE_RESERVE_RATIO));
  return Math.max(Math.min(creditBudget, MIN_PLANNING_CREDITS), reserved);
}

/** Credits the campaign has left to spend, floored at zero. */
export function remainingCredits(campaign: CreditLedger): number {
  const remaining = Number(campaign.credit_budget) - Number(campaign.credits_spent);
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
}

/** Whether a reservation of `cost` credits would fit inside the budget. */
export function canAffordCredits(campaign: CreditLedger, cost: number): boolean {
  return remainingCredits(campaign) >= cost;
}

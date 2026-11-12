/**
 * Sponsor-pledge funding math (pure — unit-tested). HACKATHON.md F2: a
 * PayPal-rail event goes live only when FUNDED pledges cover pool + platform
 * fee. Pledge amounts are what sponsors pay, fee included (ADR-012 gross-up).
 */

export interface FundingTarget {
  poolMinor: number;
  feeMinor: number;
  targetMinor: number;
}

export function fundingTargetFor(poolMinor: number, feeBps: number): FundingTarget {
  if (!Number.isInteger(poolMinor) || poolMinor <= 0) {
    throw new Error("Funding math requires a positive USD prize pool.");
  }
  const target = Math.round(poolMinor * (1 + feeBps / 10_000));
  return { poolMinor, feeMinor: target - poolMinor, targetMinor: target };
}

/** Sum of the declared USD prizes; null when any PayPal prize lacks amountMinor. */
export function usdPoolMinor(prizes: { amountMinor: number | null }[]): number | null {
  if (prizes.length === 0) return null;
  let total = 0;
  for (const prize of prizes) {
    if (prize.amountMinor == null || prize.amountMinor <= 0) return null;
    total += prize.amountMinor;
  }
  return total;
}

export function fundingCovered(fundedMinor: number, target: FundingTarget): boolean {
  return fundedMinor >= target.targetMinor;
}

/** Whole-percent progress for the funding bar, capped at 100. */
export function fundingPercent(fundedMinor: number, target: FundingTarget): number {
  if (target.targetMinor <= 0) return 0;
  return Math.min(100, Math.floor((fundedMinor / target.targetMinor) * 100));
}

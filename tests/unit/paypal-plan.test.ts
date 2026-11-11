import { describe, expect, it } from "vitest";

import {
  normalizePayPalHandle,
  planPayPalPayouts,
  splitAmounts,
  type PlanMember,
  type PlanWinner,
} from "@/services/payout/paypal-plan";

const member = (id: string, paypalHandle: string | null): PlanMember => ({
  userId: id,
  handle: id,
  name: id.toUpperCase(),
  email: `${id}@team.test`,
  paypalHandle,
});

function winner(overrides: Partial<PlanWinner> = {}): PlanWinner {
  return {
    winnerId: "w1",
    place: 1,
    teamName: "Team One",
    prizeMinor: 60_000,
    members: [member("ann", "ann@pp.test"), member("bob", "bob@pp.test"), member("cy", "+254700000001")],
    split: [
      { userId: "ann", percent: 50 },
      { userId: "bob", percent: 30 },
      { userId: "cy", percent: 20 },
    ],
    ...overrides,
  };
}

const plan = (winners: PlanWinner[], poolMinor = 100_000) =>
  planPayPalPayouts({ winners, poolMinor, reviewThresholdMinor: 500_000, currency: "USD" });

const codes = (p: ReturnType<typeof plan>) => p.issues.map((i) => i.code);

describe("splitAmounts", () => {
  it("always sums back to the prize exactly", () => {
    for (const prize of [1, 99, 100, 10_001, 33_333, 100_000]) {
      for (const percents of [[34, 33, 33], [50, 50], [1, 99], [100], [20, 20, 20, 20, 20], [0, 100]]) {
        const shares = splitAmounts(prize, percents);
        expect(shares.reduce((s, x) => s + x, 0)).toBe(prize);
      }
    }
  });

  it("gives leftover cents to the largest share first", () => {
    expect(splitAmounts(10_001, [34, 33, 33])).toEqual([3_401, 3_300, 3_300]);
    expect(splitAmounts(100, [0, 100])).toEqual([0, 100]);
  });
});

describe("planPayPalPayouts pre-flight", () => {
  it("passes a clean team and creates one line per paid member", () => {
    const p = plan([winner()]);
    expect(p.ok).toBe(true);
    expect(p.issues).toEqual([]);
    expect(p.lines.map((l) => [l.userId, l.amountMinor])).toEqual([
      ["ann", 30_000],
      ["bob", 18_000],
      ["cy", 12_000],
    ]);
    expect(p.totalMinor).toBe(60_000);
  });

  it("blocks a member with no PayPal handle, with structured context", () => {
    const p = plan([winner({ members: [member("ann", "ann@pp.test"), member("bob", null), member("cy", "cy@pp.test")] })]);
    expect(p.ok).toBe(false);
    const issue = p.issues.find((i) => i.code === "MISSING_HANDLE");
    expect(issue).toMatchObject({ severity: "blocker", userId: "bob", teamName: "Team One", details: { amountMinor: 18_000 } });
  });

  it("re-validates the split at announce time", () => {
    expect(codes(plan([winner({ split: null })]))).toContain("SPLIT_MISSING");
    expect(
      codes(plan([winner({ split: [{ userId: "ann", percent: 50 }, { userId: "bob", percent: 30 }, { userId: "cy", percent: 10 }] })]))
    ).toContain("SPLIT_NOT_100");
    expect(codes(plan([winner({ split: [{ userId: "ghost", percent: 100 }] })]))).toContain("SPLIT_UNKNOWN_MEMBER");
    expect(
      codes(plan([winner({ split: [{ userId: "ann", percent: 50 }, { userId: "ann", percent: 50 }] })]))
    ).toContain("SPLIT_DUPLICATE_MEMBER");
    expect(codes(plan([winner({ split: [{ userId: "ann", percent: 99.5 }, { userId: "bob", percent: 0.5 }] })]))).toContain(
      "SPLIT_BAD_PERCENT"
    );
  });

  it("warns (not blocks) when a joined member has no share", () => {
    const p = plan([winner({ split: [{ userId: "ann", percent: 60 }, { userId: "bob", percent: 40 }] })]);
    expect(p.ok).toBe(true);
    expect(p.issues).toEqual([expect.objectContaining({ code: "MEMBER_NOT_IN_SPLIT", severity: "warning", userId: "cy" })]);
  });

  it("blocks duplicate recipients across teams", () => {
    const second = winner({
      winnerId: "w2",
      place: 2,
      teamName: "Team Two",
      prizeMinor: 10_000,
      members: [member("dee", "ANN@pp.test")],
      split: [{ userId: "dee", percent: 100 }],
    });
    expect(codes(plan([winner(), second]))).toContain("DUPLICATE_RECIPIENT");
  });

  it("blocks a batch the pool cannot cover and flags big shares for review", () => {
    expect(codes(plan([winner()], 59_999))).toContain("POOL_INSUFFICIENT");
    const big = planPayPalPayouts({ winners: [winner()], poolMinor: 100_000, reviewThresholdMinor: 20_000, currency: "USD" });
    expect(big.ok).toBe(true);
    expect(big.issues.filter((i) => i.code === "OVER_REVIEW_THRESHOLD").map((i) => i.userId)).toEqual(["ann"]);
  });

  it("rejects handles that are neither email nor phone", () => {
    expect(normalizePayPalHandle(" Ann@PP.test ")).toEqual({ receiver: "ann@pp.test", type: "EMAIL" });
    expect(normalizePayPalHandle("+254 700-000-001")).toEqual({ receiver: "+254700000001", type: "PHONE" });
    expect(normalizePayPalHandle("not a handle")).toBeNull();
    expect(codes(plan([winner({ members: [member("ann", "nope"), member("bob", "b@pp.test"), member("cy", "c@pp.test")] })]))).toContain(
      "INVALID_HANDLE"
    );
  });
});

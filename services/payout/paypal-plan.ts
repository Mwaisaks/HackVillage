/**
 * PayPal per-member payout planning — PURE (HACKATHON.md F3, decision 7).
 *
 * Turns announced winners + each team's split declaration + each member's
 * PayPal handle into one payout line per member, and runs the deterministic
 * pre-flight checks F4's agent explains:
 *   - the split sums to 100% (re-validated at announce time, not trusted)
 *   - amounts sum exactly to each prize
 *   - every paid member has a payout handle
 *   - no duplicate recipients
 *   - nothing exceeds the review threshold
 *   - the funded pool covers the batch
 * Issues are structured (code + severity + context) so the agent and the UI
 * can explain them without parsing strings. Any "blocker" stops a batch.
 */

export type PlanIssueCode =
  | "SPLIT_MISSING"
  | "SPLIT_BAD_PERCENT"
  | "SPLIT_UNKNOWN_MEMBER"
  | "SPLIT_DUPLICATE_MEMBER"
  | "SPLIT_NOT_100"
  | "MEMBER_NOT_IN_SPLIT"
  | "MISSING_HANDLE"
  | "INVALID_HANDLE"
  | "DUPLICATE_RECIPIENT"
  | "AMOUNTS_MISMATCH"
  | "OVER_REVIEW_THRESHOLD"
  | "POOL_INSUFFICIENT";

export interface PlanIssue {
  code: PlanIssueCode;
  severity: "blocker" | "warning";
  message: string;
  winnerId?: string;
  teamName?: string;
  userId?: string;
  memberHandle?: string;
  details?: Record<string, string | number>;
}

export interface PlanMember {
  userId: string;
  /** Platform handle (@handle), for display. */
  handle: string;
  name: string | null;
  email: string;
  /** The member's own PayPal email or phone, or null when not provided. */
  paypalHandle: string | null;
}

export interface PlanWinner {
  winnerId: string;
  place: number;
  teamName: string;
  prizeMinor: number;
  /** JOINED members only. */
  members: PlanMember[];
  /** Submission.splitDeclaration as stored (unvalidated JSON). */
  split: unknown;
}

export interface PlanLine {
  winnerId: string;
  place: number;
  teamName: string;
  userId: string;
  memberHandle: string;
  name: string | null;
  email: string;
  paypalHandle: string | null;
  percent: number;
  amountMinor: number;
}

export interface PayoutPlan {
  currency: string;
  lines: PlanLine[];
  totalMinor: number;
  poolMinor: number;
  issues: PlanIssue[];
  blockers: number;
  ok: boolean;
}

export interface PlanInput {
  winners: PlanWinner[];
  /** The funded pool portion available for prizes (fee excluded). */
  poolMinor: number;
  reviewThresholdMinor: number;
  currency: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9]{7,15}$/;

/** Normalised PayPal receiver, or null when it is neither an email nor a phone. */
export function normalizePayPalHandle(raw: string): { receiver: string; type: "EMAIL" | "PHONE" } | null {
  const value = raw.trim();
  if (EMAIL.test(value)) return { receiver: value.toLowerCase(), type: "EMAIL" };
  const digits = value.replace(/[\s()-]/g, "");
  if (PHONE.test(digits)) return { receiver: digits, type: "PHONE" };
  return null;
}

/**
 * Integer-exact split: floor each share, then hand the leftover cents one at
 * a time to the largest percentages (ties keep declaration order). The
 * shares always sum back to the prize.
 */
export function splitAmounts(prizeMinor: number, percents: number[]): number[] {
  const shares = percents.map((p) => Math.floor((prizeMinor * p) / 100));
  let residue = prizeMinor - shares.reduce((s, x) => s + x, 0);
  const order = percents
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p || a.i - b.i);
  for (let k = 0; residue > 0 && order.length > 0; k = (k + 1) % order.length) {
    shares[order[k]!.i]! += 1;
    residue -= 1;
  }
  return shares;
}

function parseSplit(raw: unknown): { userId: unknown; percent: unknown }[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((entry) =>
    entry && typeof entry === "object"
      ? { userId: (entry as Record<string, unknown>).userId, percent: (entry as Record<string, unknown>).percent }
      : { userId: undefined, percent: undefined }
  );
}

export function planPayPalPayouts(input: PlanInput): PayoutPlan {
  const issues: PlanIssue[] = [];
  const lines: PlanLine[] = [];

  for (const winner of input.winners) {
    const ctx = { winnerId: winner.winnerId, teamName: winner.teamName };
    const membersById = new Map(winner.members.map((m) => [m.userId, m]));
    const split = parseSplit(winner.split);

    if (!split) {
      issues.push({
        ...ctx,
        code: "SPLIT_MISSING",
        severity: "blocker",
        message: `${winner.teamName} has no prize split declaration.`,
      });
      continue;
    }

    let splitValid = true;
    const seen = new Set<string>();
    const entries: { member: PlanMember; percent: number }[] = [];
    for (const entry of split) {
      const userId = typeof entry.userId === "string" ? entry.userId : "";
      const member = membersById.get(userId);
      if (!member) {
        splitValid = false;
        issues.push({
          ...ctx,
          userId: userId || undefined,
          code: "SPLIT_UNKNOWN_MEMBER",
          severity: "blocker",
          message: `${winner.teamName}'s split names someone who is no longer a team member.`,
        });
        continue;
      }
      if (seen.has(userId)) {
        splitValid = false;
        issues.push({
          ...ctx,
          userId,
          memberHandle: member.handle,
          code: "SPLIT_DUPLICATE_MEMBER",
          severity: "blocker",
          message: `${winner.teamName}'s split lists @${member.handle} twice.`,
        });
        continue;
      }
      seen.add(userId);
      const percent = entry.percent;
      if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 0 || percent > 100) {
        splitValid = false;
        issues.push({
          ...ctx,
          userId,
          memberHandle: member.handle,
          code: "SPLIT_BAD_PERCENT",
          severity: "blocker",
          message: `@${member.handle}'s share in ${winner.teamName}'s split is not a whole percentage.`,
        });
        continue;
      }
      entries.push({ member, percent });
    }

    const total = entries.reduce((s, e) => s + e.percent, 0);
    if (splitValid && total !== 100) {
      splitValid = false;
      issues.push({
        ...ctx,
        code: "SPLIT_NOT_100",
        severity: "blocker",
        message: `${winner.teamName}'s split adds up to ${total}%, not 100%.`,
        details: { totalPercent: total },
      });
    }

    for (const member of winner.members) {
      if (!seen.has(member.userId)) {
        issues.push({
          ...ctx,
          userId: member.userId,
          memberHandle: member.handle,
          code: "MEMBER_NOT_IN_SPLIT",
          severity: "warning",
          message: `@${member.handle} is on ${winner.teamName} but has no share in the split.`,
        });
      }
    }

    if (!splitValid) continue;

    const shares = splitAmounts(winner.prizeMinor, entries.map((e) => e.percent));
    entries.forEach((entry, i) => {
      const amountMinor = shares[i]!;
      if (amountMinor <= 0) return; // a 0% member is paid nothing
      lines.push({
        winnerId: winner.winnerId,
        place: winner.place,
        teamName: winner.teamName,
        userId: entry.member.userId,
        memberHandle: entry.member.handle,
        name: entry.member.name,
        email: entry.member.email,
        paypalHandle: entry.member.paypalHandle,
        percent: entry.percent,
        amountMinor,
      });
    });

    const paid = shares.reduce((s, x) => s + x, 0);
    if (paid !== winner.prizeMinor) {
      issues.push({
        ...ctx,
        code: "AMOUNTS_MISMATCH",
        severity: "blocker",
        message: `${winner.teamName}'s shares total ${paid} but the prize is ${winner.prizeMinor}.`,
        details: { paidMinor: paid, prizeMinor: winner.prizeMinor },
      });
    }
  }

  // Per-line recipient checks.
  const byReceiver = new Map<string, PlanLine[]>();
  for (const line of lines) {
    const ctx = { winnerId: line.winnerId, teamName: line.teamName, userId: line.userId, memberHandle: line.memberHandle };
    if (!line.paypalHandle) {
      issues.push({
        ...ctx,
        code: "MISSING_HANDLE",
        severity: "blocker",
        message: `@${line.memberHandle} (${line.teamName}) hasn't added a PayPal email or phone.`,
        details: { amountMinor: line.amountMinor },
      });
      continue;
    }
    const normalized = normalizePayPalHandle(line.paypalHandle);
    if (!normalized) {
      issues.push({
        ...ctx,
        code: "INVALID_HANDLE",
        severity: "blocker",
        message: `@${line.memberHandle}'s PayPal handle is neither an email nor a phone number.`,
      });
      continue;
    }
    byReceiver.set(normalized.receiver, [...(byReceiver.get(normalized.receiver) ?? []), line]);
    if (line.amountMinor > input.reviewThresholdMinor) {
      issues.push({
        ...ctx,
        code: "OVER_REVIEW_THRESHOLD",
        severity: "warning",
        message: `@${line.memberHandle}'s share is above the review threshold. Double-check it before approving.`,
        details: { amountMinor: line.amountMinor, thresholdMinor: input.reviewThresholdMinor },
      });
    }
  }
  for (const [receiver, dupes] of byReceiver) {
    if (dupes.length < 2) continue;
    issues.push({
      code: "DUPLICATE_RECIPIENT",
      severity: "blocker",
      message: `${dupes.map((l) => `@${l.memberHandle}`).join(" and ")} share the same PayPal account.`,
      details: { receiver, count: dupes.length },
    });
  }

  const totalMinor = lines.reduce((s, l) => s + l.amountMinor, 0);
  if (totalMinor > input.poolMinor) {
    issues.push({
      code: "POOL_INSUFFICIENT",
      severity: "blocker",
      message: `The batch needs more than the funded pool holds.`,
      details: { totalMinor, poolMinor: input.poolMinor },
    });
  }

  const blockers = issues.filter((i) => i.severity === "blocker").length;
  return { currency: input.currency, lines, totalMinor, poolMinor: input.poolMinor, issues, blockers, ok: blockers === 0 };
}

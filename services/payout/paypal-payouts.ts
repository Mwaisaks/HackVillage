import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { formatMoney } from "@/lib/money";
import { html } from "@/lib/notifications/html";
import { renderEmail, renderText, type EmailTemplate } from "@/lib/notifications/layout";
import { sendNotification } from "@/lib/notifications/send";
import {
  getPayPalPort,
  PayPalPortError,
  type PayoutItemStatus,
  type PayPalPort,
} from "@/lib/ports/paypal";
import { appUrl } from "@/lib/url";
import { normalizePayPalHandle, planPayPalPayouts, type PayoutPlan } from "@/services/payout/paypal-plan";

/**
 * PayPal per-member payouts (HACKATHON.md F3). HARD BOUNDARY: only this
 * module touches PayPal-rail Payout/PayoutBatch rows; only the PayPal port
 * talks to PayPal.
 *
 * Lifecycle (decision 5: 100% on the day, one INSTANT tranche):
 *   announce → Winner rows (no money yet)
 *   propose  → pre-flight passes → PayoutBatch PROPOSED + one QUEUED Payout
 *              per member per tranche ({winnerId}:{userId}:INSTANT unique)
 *   approve  → an organiser approves (never automatic) → APPROVED
 *   submit   → one PayPal Payouts batch (sender_batch_id = batch id,
 *              sender_item_id = payout id) → SUBMITTED, payouts PROCESSING
 *   sync     → item statuses (poll + PAYMENT.PAYOUTS-ITEM.* webhooks) →
 *              SUCCEEDED / MANUAL_REVIEW → batch SUCCEEDED/PARTIAL → settle
 *
 * Fail closed: a definite PayPal rejection fails the batch with nothing paid;
 * an ambiguous error holds it SUBMITTED for a retry under the SAME
 * sender_batch_id + PayPal-Request-Id, which PayPal dedupes. The platform
 * pays PayPal's fees; members receive their full share.
 */

export class PayPalPayoutError extends Error {
  constructor(
    message: string,
    public code: "NOT_FOUND" | "FORBIDDEN" | "WRONG_STATE" | "INVALID"
  ) {
    super(message);
  }
}

export function paypalPayoutKey(winnerId: string, userId: string, tranche: "INSTANT"): string {
  return `${winnerId}:${userId}:${tranche}`;
}

// ── Members: own PayPal handle (no bank details) ─────────────────────────

export async function savePayPalHandle(userId: string, raw: string): Promise<string> {
  const normalized = normalizePayPalHandle(raw);
  if (!normalized) throw new PayPalPayoutError("Enter your PayPal email address or phone number.", "INVALID");
  await prisma.developerProfile.upsert({
    where: { userId },
    create: { userId, paypalHandle: normalized.receiver },
    update: { paypalHandle: normalized.receiver },
  });
  return normalized.receiver;
}

// ── Announce (called from announceWinners after shared validation) ──────

export async function announcePayPalWinnerRows(input: {
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  placements: { place: number; teamId: string }[];
  prizesByPlace: Map<number, { amountMinor: number | null; currency: string }>;
  teamById: Map<string, { id: string; leaderId: string }>;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const placement of input.placements) {
      const prize = input.prizesByPlace.get(placement.place)!;
      const team = input.teamById.get(placement.teamId)!;
      if (!prize.amountMinor || prize.amountMinor <= 0) {
        throw new PayPalPayoutError(`Prize place ${placement.place} has no USD amount.`, "INVALID");
      }
      await tx.winner.create({
        data: {
          eventId: input.eventId,
          teamId: team.id,
          place: placement.place,
          userId: team.leaderId,
          amountKes: 0,
          amountMinor: prize.amountMinor,
          currency: prize.currency,
          milestoneRequired: false,
          announcedAt: new Date(),
        },
      });
    }
    const announced = await tx.event.updateMany({
      where: { id: input.eventId, status: "JUDGING" },
      data: { status: "WINNERS_ANNOUNCED" },
    });
    if (announced.count === 0) {
      throw new PayPalPayoutError("This hackathon is no longer in judging. Refresh the page.", "WRONG_STATE");
    }
  });

  const winners = await prisma.winner.findMany({
    where: { eventId: input.eventId },
    select: {
      id: true,
      place: true,
      amountMinor: true,
      currency: true,
      team: {
        select: {
          name: true,
          members: {
            where: { status: "JOINED" },
            select: { user: { select: { id: true, email: true, profile: { select: { paypalHandle: true } } } } },
          },
        },
      },
    },
  });

  const { materializePortfolioForWinner } = await import("@/services/pow/service");
  for (const winner of winners) {
    await materializePortfolioForWinner(winner.id).catch((error: unknown) =>
      console.error("[paypal-payout] portfolio materialization failed", error)
    );
  }
  const { scheduleLegacyCheckins } = await import("@/services/legacy/service");
  await scheduleLegacyCheckins(input.eventId);

  // Every winning member hears directly — not just the leader.
  for (const winner of winners) {
    for (const member of winner.team.members) {
      await sendNotification({
        userId: member.user.id,
        to: member.user.email,
        category: "judging",
        template: memberWonEmail(
          input.eventTitle,
          winner.place,
          winner.team.name,
          formatMoney(winner.amountMinor ?? 0, winner.currency),
          !member.user.profile?.paypalHandle
        ),
      }).catch((error: unknown) => console.error("[paypal-payout] winner notification failed", error));
    }
  }
}

// ── Plan (read model + deterministic pre-flight) ─────────────────────────

export interface EventPayoutPlan extends PayoutPlan {
  eventId: string;
  eventTitle: string;
}

export async function buildPayoutPlan(eventId: string): Promise<EventPayoutPlan> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      title: true,
      rail: true,
      currency: true,
      vault: { select: { amountMinor: true, chainState: true } },
      winners: {
        orderBy: { place: "asc" },
        select: {
          id: true,
          place: true,
          amountMinor: true,
          team: {
            select: {
              name: true,
              submission: { select: { splitDeclaration: true } },
              members: {
                where: { status: "JOINED" },
                select: {
                  user: {
                    select: { id: true, handle: true, name: true, email: true, profile: { select: { paypalHandle: true } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!event) throw new PayPalPayoutError("Hackathon not found.", "NOT_FOUND");
  if (event.rail !== "PAYPAL") throw new PayPalPayoutError("This hackathon pays through Paystack.", "WRONG_STATE");

  // Money already committed to other live batches is not available again.
  const committed = await prisma.payout.aggregate({
    where: { rail: "PAYPAL", winner: { eventId }, batch: { status: { notIn: ["PROPOSED", "FAILED"] } } },
    _sum: { amountMinor: true },
  });
  const locked = event.vault && ["LOCKED", "HALF_RELEASED"].includes(event.vault.chainState);
  const poolMinor = locked ? (event.vault?.amountMinor ?? 0) - (committed._sum.amountMinor ?? 0) : 0;

  const plan = planPayPalPayouts({
    currency: event.currency,
    poolMinor,
    reviewThresholdMinor: getEnv().PAYOUT_REVIEW_THRESHOLD_USD_MINOR,
    winners: event.winners.map((w) => ({
      winnerId: w.id,
      place: w.place,
      teamName: w.team.name,
      prizeMinor: w.amountMinor ?? 0,
      split: w.team.submission?.splitDeclaration ?? null,
      members: w.team.members.map((m) => ({
        userId: m.user.id,
        handle: m.user.handle,
        name: m.user.name,
        email: m.user.email,
        paypalHandle: m.user.profile?.paypalHandle ?? null,
      })),
    })),
  });
  return { ...plan, eventId: event.id, eventTitle: event.title };
}

// ── Propose / discard ────────────────────────────────────────────────────

export async function requireOrgAdmin(eventId: string, userId: string) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      slug: true,
      title: true,
      rail: true,
      status: true,
      org: { select: { members: { where: { userId, status: "ACTIVE" }, select: { role: true } } } },
    },
  });
  if (!event) throw new PayPalPayoutError("Hackathon not found.", "NOT_FOUND");
  const role = event.org.members[0]?.role;
  if (!role || role === "MEMBER") throw new PayPalPayoutError("Only organization admins can manage payouts.", "FORBIDDEN");
  if (event.rail !== "PAYPAL") throw new PayPalPayoutError("This hackathon pays through Paystack.", "WRONG_STATE");
  return event;
}

export type ProposeOutcome =
  | { outcome: "proposed"; batchId: string; plan: EventPayoutPlan }
  | { outcome: "exists"; batchId: string }
  | { outcome: "blocked"; plan: EventPayoutPlan };

/**
 * Freeze a passing plan into a PROPOSED batch. `proposal` is the payout
 * agent's summary (F4), stored on the batch and audited. A batch that has
 * blockers is never created.
 */
export async function proposePayoutBatch(
  eventId: string,
  organizerId: string | null,
  proposal?: Prisma.InputJsonValue
): Promise<ProposeOutcome> {
  if (organizerId) await requireOrgAdmin(eventId, organizerId);
  const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId }, select: { status: true, currency: true } });
  if (event.status !== "WINNERS_ANNOUNCED") {
    throw new PayPalPayoutError("Announce the winners before proposing payouts.", "WRONG_STATE");
  }

  const open = await prisma.payoutBatch.findFirst({
    where: { eventId, status: { not: "FAILED" } },
    select: { id: true },
  });
  if (open) return { outcome: "exists", batchId: open.id };

  const plan = await buildPayoutPlan(eventId);
  if (!plan.ok) return { outcome: "blocked", plan };

  try {
    const batch = await prisma.$transaction(async (tx) => {
      const created = await tx.payoutBatch.create({
        data: {
          eventId,
          currency: event.currency,
          totalMinor: plan.totalMinor,
          proposal: proposal ?? ({ lines: plan.lines.length, warnings: plan.issues } as unknown as Prisma.InputJsonValue),
        },
      });
      for (const line of plan.lines) {
        await tx.payout.create({
          data: {
            winnerId: line.winnerId,
            tranche: "INSTANT",
            amountKes: 0,
            amountMinor: line.amountMinor,
            currency: event.currency,
            rail: "PAYPAL",
            idempotencyKey: paypalPayoutKey(line.winnerId, line.userId, "INSTANT"),
            recipientCode: "",
            recipientUserId: line.userId,
            payoutHandle: normalizePayPalHandle(line.paypalHandle!)!.receiver,
            status: "QUEUED",
            batchId: created.id,
          },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId: organizerId,
          action: "payout.batch-proposed",
          entity: "PayoutBatch",
          entityId: created.id,
          meta: { eventId, totalMinor: plan.totalMinor, lines: plan.lines.length, proposal: proposal ?? null },
        },
      });
      return created;
    });
    return { outcome: "proposed", batchId: batch.id, plan };
  } catch (error) {
    // Unique {winnerId}:{userId}:INSTANT — a concurrent propose won the race.
    if ((error as { code?: string })?.code === "P2002") {
      const existing = await prisma.payoutBatch.findFirst({ where: { eventId, status: { not: "FAILED" } }, select: { id: true } });
      if (existing) return { outcome: "exists", batchId: existing.id };
    }
    throw error;
  }
}

/** Drop a PROPOSED (never approved) batch so the organiser can re-propose after fixes. */
export async function discardProposedBatch(batchId: string, organizerId: string): Promise<boolean> {
  const batch = await prisma.payoutBatch.findUnique({ where: { id: batchId }, select: { eventId: true } });
  if (!batch) return false;
  await requireOrgAdmin(batch.eventId, organizerId);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.payoutBatch.updateMany({ where: { id: batchId, status: "PROPOSED" }, data: { status: "FAILED", lastError: "Discarded before approval." } });
    if (claimed.count === 0) return false;
    // Nothing was ever sent: remove the unsent rows so their keys free up.
    await tx.payout.deleteMany({ where: { batchId, status: "QUEUED" } });
    await tx.auditLog.create({
      data: { actorId: organizerId, action: "payout.batch-discarded", entity: "PayoutBatch", entityId: batchId },
    });
    return true;
  });
}

// ── Approve + submit ─────────────────────────────────────────────────────

export type SubmitOutcome =
  | { outcome: "submitted"; paypalBatchId: string }
  | { outcome: "duplicate" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "held"; reason: string };

/** The human gate (HACKATHON.md F4): no money moves without this call. */
export async function approvePayoutBatch(
  batchId: string,
  organizerId: string,
  portOverride?: PayPalPort
): Promise<SubmitOutcome> {
  const batch = await prisma.payoutBatch.findUnique({ where: { id: batchId }, select: { eventId: true, totalMinor: true } });
  if (!batch) throw new PayPalPayoutError("Payout batch not found.", "NOT_FOUND");
  await requireOrgAdmin(batch.eventId, organizerId);

  const approved = await prisma.payoutBatch.updateMany({
    where: { id: batchId, status: "PROPOSED" },
    data: { status: "APPROVED", approvedById: organizerId, approvedAt: new Date() },
  });
  if (approved.count === 0) return { outcome: "duplicate" };
  await prisma.auditLog.create({
    data: {
      actorId: organizerId,
      action: "payout.batch-approved",
      entity: "PayoutBatch",
      entityId: batchId,
      meta: { eventId: batch.eventId, totalMinor: batch.totalMinor },
    },
  });
  return submitPayoutBatch(batchId, portOverride);
}

const AMBIGUOUS_PROVIDER_NAMES = new Set(["SENDER_BATCH_ID_ALREADY_USED", "INTERNAL_SERVER_ERROR"]);

export async function submitPayoutBatch(batchId: string, portOverride?: PayPalPort): Promise<SubmitOutcome> {
  // Claim: APPROVED → SUBMITTED, or re-drive a held SUBMITTED batch that
  // PayPal never acknowledged (same sender_batch_id → PayPal dedupes).
  const claimed = await prisma.payoutBatch.updateMany({
    where: { id: batchId, OR: [{ status: "APPROVED" }, { status: "SUBMITTED", paypalBatchId: null }] },
    data: { status: "SUBMITTED", submittedAt: new Date() },
  });
  if (claimed.count === 0) return { outcome: "duplicate" };

  const batch = await prisma.payoutBatch.findUniqueOrThrow({
    where: { id: batchId },
    include: {
      event: { select: { title: true } },
      payouts: { where: { status: { in: ["QUEUED", "PROCESSING"] } }, orderBy: { id: "asc" } },
    },
  });
  await prisma.payout.updateMany({
    where: { batchId, status: "QUEUED" },
    data: { status: "PROCESSING", attemptCount: { increment: 1 } },
  });

  const port = portOverride ?? getPayPalPort();
  try {
    const result = await port.createPayoutBatch({
      senderBatchId: batch.id,
      emailSubject: `Your ${batch.event.title} prize has arrived`,
      items: batch.payouts.map((payout) => {
        const receiver = normalizePayPalHandle(payout.payoutHandle ?? "");
        return {
          senderItemId: payout.id,
          receiver: receiver?.receiver ?? payout.payoutHandle ?? "",
          recipientType: receiver?.type ?? "EMAIL",
          amountMinor: payout.amountMinor ?? 0,
          currency: "USD" as const,
          note: `${batch.event.title}: your share of the prize. Fees are paid by HackVillage.`,
        };
      }),
    });
    await prisma.payoutBatch.update({
      where: { id: batchId },
      data: { paypalBatchId: result.batchId, paypalBatchStatus: result.batchStatus, lastError: null },
    });
    await syncPayoutBatch(batchId, port);
    return { outcome: "submitted", paypalBatchId: result.batchId };
  } catch (error) {
    const err = error instanceof PayPalPortError ? error : null;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 400);
    const definite =
      err?.kind === "provider" &&
      err.status != null &&
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 408 &&
      err.status !== 429 &&
      !AMBIGUOUS_PROVIDER_NAMES.has(err.providerName ?? "");

    if (definite) {
      // PayPal refused the whole batch: nothing was paid. Funds stay in the pool.
      await prisma.$transaction([
        prisma.payoutBatch.update({ where: { id: batchId }, data: { status: "FAILED", lastError: message } }),
        prisma.payout.updateMany({ where: { batchId, status: "PROCESSING" }, data: { status: "FAILED", lastError: message } }),
      ]);
      await auditAndAlert(batchId, "payout.batch-rejected", `PayPal rejected batch ${batchId}: ${message}`);
      return { outcome: "rejected", reason: message };
    }

    // Ambiguous: PayPal may have accepted it. Hold, never resend under a new id.
    await prisma.payoutBatch.update({ where: { id: batchId }, data: { lastError: `Ambiguous submit error: ${message}` } });
    await auditAndAlert(batchId, "payout.batch-held", `Batch ${batchId} submit was ambiguous; retrying under the same sender_batch_id: ${message}`);
    return { outcome: "held", reason: message };
  }
}

// ── Sync / reconcile ─────────────────────────────────────────────────────

const ITEM_TERMINAL_FAIL = new Set(["FAILED", "RETURNED", "BLOCKED", "DENIED", "CANCELED", "REFUNDED", "REVERSED"]);
const ITEM_CLAWBACK = new Set(["RETURNED", "REFUNDED", "REVERSED"]);

export type ItemOutcome = "succeeded" | "failed" | "pending" | "clawback" | "unknown" | "mismatch" | "noop";

/**
 * Apply one PayPal item status to its Payout (sender_item_id = payout id).
 * Shared by the batch poll and the PAYMENT.PAYOUTS-ITEM.* webhook; every
 * write is conditional, so replays and races are no-ops.
 */
export async function applyPayoutItemStatus(item: PayoutItemStatus): Promise<ItemOutcome> {
  const payout = item.senderItemId
    ? await prisma.payout.findUnique({
        where: { id: item.senderItemId },
        include: { winner: { select: { eventId: true, event: { select: { title: true } } } }, recipientUser: { select: { id: true, email: true } } },
      })
    : null;
  if (!payout || payout.rail !== "PAYPAL") {
    await prisma.auditLog.create({
      data: {
        actorId: null,
        action: "payout.reconcile-unknown-item",
        entity: "Payout",
        entityId: item.senderItemId,
        reason: `PayPal item ${item.payoutItemId} (${item.transactionStatus}) matches no PayPal payout`,
        meta: { ...item },
      },
    });
    return "unknown";
  }
  if (item.amountMinor != null && item.amountMinor !== payout.amountMinor) {
    await auditAndAlert(
      payout.batchId ?? payout.id,
      "payout.reconcile-mismatch",
      `PayPal item ${item.payoutItemId} amount ${item.amountMinor} ≠ payout ${payout.id} amount ${payout.amountMinor}`
    );
    return "mismatch";
  }

  const status = item.transactionStatus.toUpperCase();
  const common = { paypalItemId: item.payoutItemId || undefined, paypalTransactionStatus: status };

  if (status === "SUCCESS") {
    const flipped = await prisma.payout.updateMany({
      where: { id: payout.id, status: { notIn: ["SUCCEEDED", "REVERSED"] } },
      data: { ...common, status: "SUCCEEDED", paidAt: new Date(), lastError: null },
    });
    if (flipped.count === 0) return "noop";
    if (payout.recipientUser) {
      await sendNotification({
        userId: payout.recipientUser.id,
        to: payout.recipientUser.email,
        category: "judging",
        template: memberPaidEmail(payout.winner.event.title, formatMoney(payout.amountMinor ?? 0, payout.currency)),
      }).catch((error: unknown) => console.error("[paypal-payout] paid notification failed", error));
    }
    return "succeeded";
  }

  if (ITEM_TERMINAL_FAIL.has(status)) {
    if (payout.status === "SUCCEEDED" && ITEM_CLAWBACK.has(status)) {
      // Never rewrite history: keep SUCCEEDED, page ops (upstream invariant).
      await auditAndAlert(payout.batchId ?? payout.id, "payout.reversed-after-success", `PayPal reported ${status} for SUCCEEDED payout ${payout.id}`);
      return "clawback";
    }
    const failed = await prisma.payout.updateMany({
      where: { id: payout.id, status: { notIn: ["SUCCEEDED", "MANUAL_REVIEW"] } },
      data: { ...common, status: "MANUAL_REVIEW", lastError: `PayPal item ${status}${item.errorName ? ` (${item.errorName})` : ""}. Funds remain in the pool.` },
    });
    if (failed.count > 0) {
      await auditAndAlert(payout.batchId ?? payout.id, "payout.item-failed", `Payout ${payout.id} ${status}${item.errorName ? ` (${item.errorName})` : ""}`);
    }
    return failed.count > 0 ? "failed" : "noop";
  }

  // PENDING / UNCLAIMED / ONHOLD / NEW: still in flight.
  await prisma.payout.updateMany({
    where: { id: payout.id, status: { notIn: ["SUCCEEDED", "MANUAL_REVIEW"] } },
    data: {
      ...common,
      lastError: status === "UNCLAIMED" ? "Recipient has no PayPal account on this email yet; they have 30 days to claim." : null,
    },
  });
  return "pending";
}

/** Poll PayPal for a batch, apply every item, then roll the batch + event forward. */
export async function syncPayoutBatch(batchId: string, portOverride?: PayPalPort): Promise<void> {
  const batch = await prisma.payoutBatch.findUnique({ where: { id: batchId } });
  if (!batch?.paypalBatchId) return;
  const port = portOverride ?? getPayPalPort();
  const remote = await port.getPayoutBatch(batch.paypalBatchId);
  await prisma.payoutBatch.update({ where: { id: batchId }, data: { paypalBatchStatus: remote.batchStatus } });

  const ours = await prisma.payout.findMany({ where: { batchId }, select: { id: true } });
  const seen = new Set<string>();
  for (const item of remote.items) {
    if (item.senderItemId) seen.add(item.senderItemId);
    await applyPayoutItemStatus(item);
  }
  // Reconciliation: rows we sent that PayPal doesn't list (once it lists any).
  if (remote.items.length > 0) {
    for (const payout of ours) {
      if (!seen.has(payout.id)) {
        await auditAndAlert(batchId, "payout.reconcile-missing-item", `Payout ${payout.id} is in batch ${batchId} but PayPal has no item for it`);
      }
    }
  }
  await refreshBatchStatus(batchId);
}

export async function refreshBatchStatus(batchId: string): Promise<void> {
  const batch = await prisma.payoutBatch.findUnique({
    where: { id: batchId },
    include: { payouts: { select: { status: true } } },
  });
  if (!batch || batch.status !== "SUBMITTED" || batch.payouts.length === 0) return;
  const statuses = batch.payouts.map((p) => p.status);
  const inFlight = statuses.some((s) => s === "PROCESSING" || s === "QUEUED");
  if (inFlight) return;
  const allPaid = statuses.every((s) => s === "SUCCEEDED");
  const nonePaid = statuses.every((s) => s !== "SUCCEEDED");
  const next = allPaid ? "SUCCEEDED" : nonePaid ? "FAILED" : "PARTIAL";
  const moved = await prisma.payoutBatch.updateMany({
    where: { id: batchId, status: "SUBMITTED" },
    data: { status: next, completedAt: new Date() },
  });
  if (moved.count > 0 && next === "SUCCEEDED") await settlePayPalEvent(batch.eventId);
}

/**
 * PayPal-path settle (decision 5): the event and its pool settle once every
 * winner's members are paid. KES events keep advanceVaultAfter.
 */
export async function settlePayPalEvent(eventId: string): Promise<boolean> {
  const winners = await prisma.winner.findMany({
    where: { eventId, event: { rail: "PAYPAL" } },
    select: { payouts: { where: { rail: "PAYPAL", batch: { status: { not: "FAILED" } } }, select: { status: true } } },
  });
  if (winners.length === 0) return false;
  const settled = winners.every((w) => w.payouts.length > 0 && w.payouts.every((p) => p.status === "SUCCEEDED"));
  if (!settled) return false;
  await prisma.$transaction([
    prisma.vaultState.updateMany({
      where: { eventId, chainState: { in: ["LOCKED", "HALF_RELEASED"] } },
      data: { chainState: "SETTLED", settledAt: new Date() },
    }),
    prisma.event.updateMany({ where: { id: eventId, status: "WINNERS_ANNOUNCED" }, data: { status: "SETTLED" } }),
  ]);
  return true;
}

/** Cron: re-drive held submits and poll in-flight batches. */
export async function sweepPayPalBatches(portOverride?: PayPalPort): Promise<number> {
  const open = await prisma.payoutBatch.findMany({
    where: { status: "SUBMITTED" },
    select: { id: true, paypalBatchId: true },
    take: 25,
  });
  for (const batch of open) {
    try {
      if (!batch.paypalBatchId) await submitPayoutBatch(batch.id, portOverride);
      else await syncPayoutBatch(batch.id, portOverride);
    } catch (error) {
      console.error(`[paypal-payout] sweep failed for batch ${batch.id}`, error);
    }
  }
  return open.length;
}

async function auditAndAlert(entityId: string, action: string, reason: string): Promise<void> {
  console.error(`[paypal-payout] ${action}: ${reason}`);
  await prisma.auditLog.create({ data: { actorId: null, action, entity: "PayoutBatch", entityId, reason } });
  const { alertAdmins } = await import("@/lib/notifications/admin-alert");
  await alertAdmins({
    subject: `PayPal Payout Needs Attention`,
    html: renderEmail({
      preheader: "A PayPal payout needs a manual decision.",
      section: {
        heading: "PayPal Payout Needs Attention",
        bodyHtml: html`<p style="margin:0;">${reason}. Funds stay in the pool until this is resolved.</p>`,
        ctaUrl: appUrl("/admin/payments"),
        ctaLabel: "Open The Admin Queue",
      },
    }),
    text: renderText([reason, appUrl("/admin/payments")]),
  }).catch((error: unknown) => console.error("[paypal-payout] admin alert failed", error));
}

// ── Emails ───────────────────────────────────────────────────────────────

function memberWonEmail(eventTitle: string, place: number, teamName: string, prize: string, needsHandle: boolean): EmailTemplate {
  const settingsUrl = appUrl("/settings");
  return {
    subject: `Your Team Won: ${eventTitle}`,
    html: renderEmail({
      preheader: `${teamName} placed #${place}. Prizes pay to each member's own PayPal.`,
      section: {
        heading: `${teamName} Placed #${place}`,
        bodyHtml: needsHandle
          ? html`<p style="margin:0;">Congratulations! The ${prize} prize is paid to every member directly, by your team's declared split. <strong>Add your PayPal email or phone in Settings</strong> so your share can be sent.</p>`
          : html`<p style="margin:0;">Congratulations! The ${prize} prize is paid to every member directly, by your team's declared split, to the PayPal account in your Settings. No fees come out of your share.</p>`,
        details: [{ label: "Prize", value: prize }],
        ctaUrl: settingsUrl,
        ctaLabel: needsHandle ? "Add Your PayPal" : "Check Your PayPal",
      },
    }),
    text: renderText([`${teamName} placed #${place} at ${eventTitle} (${prize}).`, needsHandle ? `Add your PayPal email or phone: ${settingsUrl}` : settingsUrl]),
  };
}

function memberPaidEmail(eventTitle: string, amount: string): EmailTemplate {
  return {
    subject: `You've Been Paid: ${eventTitle}`,
    html: renderEmail({
      preheader: `${amount} was sent to your PayPal.`,
      section: {
        heading: "Your Prize Share Was Sent",
        bodyHtml: html`<p style="margin:0;">${amount} from ${eventTitle} was sent to your PayPal account. HackVillage paid the fees.</p>`,
        details: [{ label: "Amount", value: amount }],
      },
    }),
    text: renderText([`${amount} from ${eventTitle} was sent to your PayPal account.`]),
  };
}

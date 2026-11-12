import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { PayPalSimulation } from "@/lib/ports/paypal";
import { announceWinners } from "@/services/payout/service";
import {
  applyPayoutItemStatus,
  approvePayoutBatch,
  buildPayoutPlan,
  proposePayoutBatch,
  savePayPalHandle,
} from "@/services/payout/paypal-payouts";

/**
 * F3 per-member PayPal payouts against real Postgres (PayPal simulated).
 * A team of three wins $600 with a 50/30/20 split; one member starts without
 * a PayPal handle (the Definition-of-done demo path).
 */

const TEST_KEY = `ppout-${Date.now().toString(36)}`;
const suiteStartedAt = new Date();

async function createUser(label: string, paypalHandle?: string) {
  const key = `${TEST_KEY}-${label}`;
  const user = await prisma.user.create({
    data: {
      email: `${key}@hackvillage.test`,
      name: label,
      handle: key.slice(-24),
      emailVerified: new Date(),
      primaryRole: "DEVELOPER",
      onboardingCompletedAt: new Date(),
    },
  });
  if (paypalHandle) await prisma.developerProfile.create({ data: { userId: user.id, paypalHandle } });
  return user;
}

async function createWorld(label: string, handles: [string | undefined, string | undefined, string | undefined]) {
  const organizer = await createUser(`${label}-org`);
  const judge = await createUser(`${label}-judge`);
  const org = await prisma.organization.create({
    data: { name: `PP Org ${TEST_KEY}-${label}`, slug: `${TEST_KEY}-${label}`, ownerId: organizer.id, kycStatus: "VERIFIED" },
  });
  await prisma.orgMember.create({ data: { orgId: org.id, userId: organizer.id, role: "OWNER", status: "ACTIVE" } });
  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      slug: `evt-${TEST_KEY}-${label}`,
      title: "PayPal Payout Event",
      venueType: "ONLINE",
      startsAt: new Date(Date.now() - 48 * 3600 * 1000),
      endsAt: new Date(Date.now() - 2 * 3600 * 1000),
      registrationDeadline: new Date(Date.now() - 72 * 3600 * 1000),
      problemStatement: "PayPal payout integration event.",
      status: "JUDGING",
      prizeVerifiedAt: new Date(),
      publishedAt: new Date(Date.now() - 96 * 3600 * 1000),
      rail: "PAYPAL",
      currency: "USD",
    },
  });
  await prisma.prizeBreakdown.create({
    data: { eventId: event.id, place: 1, label: "1st place", amountKes: 0, amountMinor: 60_000, currency: "USD", milestoneRequired: false },
  });
  await prisma.vaultState.create({
    data: { eventId: event.id, amountKes: 0, amountMinor: 60_000, currency: "USD", chainState: "LOCKED", lockedAt: new Date() },
  });
  await prisma.judgeAssignment.create({ data: { eventId: event.id, userId: judge.id, status: "ACTIVE" } });

  const [leader, m2, m3] = [
    await createUser(`${label}-lead`, handles[0]),
    await createUser(`${label}-m2`, handles[1]),
    await createUser(`${label}-m3`, handles[2]),
  ];
  const team = await prisma.team.create({
    data: { eventId: event.id, name: `Team ${label}`, leaderId: leader.id, inviteCode: `pp${Math.random().toString(36).slice(2, 10)}` },
  });
  for (const u of [leader, m2, m3]) {
    await prisma.teamMember.create({ data: { teamId: team.id, userId: u.id, status: "JOINED" } });
  }
  const submission = await prisma.submission.create({
    data: {
      teamId: team.id,
      repoUrl: `https://github.com/test/${label}`,
      description: "PayPal payout integration submission, descriptive enough.",
      splitDeclaration: [
        { userId: leader.id, percent: 50 },
        { userId: m2.id, percent: 30 },
        { userId: m3.id, percent: 20 },
      ],
    },
  });
  await prisma.judgingProgress.create({ data: { judgeId: judge.id, teamId: team.id, finalizedAt: new Date() } });
  return { organizer, org, event, team, submission, leader, m2, m3 };
}

describe("PayPal per-member payouts (integration)", () => {
  const sim = new PayPalSimulation();
  const orgIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  });

  afterAll(async () => {
    // Only this suite's audit rows: entities belonging to its own events.
    const batches = await prisma.payoutBatch.findMany({ where: { event: { orgId: { in: orgIds } } }, select: { id: true } });
    const payouts = await prisma.payout.findMany({ where: { winner: { event: { orgId: { in: orgIds } } } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...batches, ...payouts].map((r) => r.id) } } });
    for (const id of orgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { contains: TEST_KEY } } });
    await prisma
      .$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name LIKE 'legacy.%' AND created_on >= $1`, suiteStartedAt)
      .catch(() => undefined);
    await prisma.$disconnect();
  });

  it("announces, blocks on a missing handle and a split mismatch, then pays every member in one batch", async () => {
    const w = await createWorld("main", ["lead@pp.test", "m2@pp.test", undefined]);
    orgIds.push(w.org.id);

    await announceWinners({ eventId: w.event.id, organizerId: w.organizer.id, placements: [{ place: 1, teamId: w.team.id }] });
    const winners = await prisma.winner.findMany({ where: { eventId: w.event.id } });
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ amountKes: 0, amountMinor: 60_000, currency: "USD", milestoneRequired: false });
    expect(await prisma.payout.count({ where: { winner: { eventId: w.event.id } } })).toBe(0); // no money yet
    expect((await prisma.event.findUniqueOrThrow({ where: { id: w.event.id } })).status).toBe("WINNERS_ANNOUNCED");

    // Pre-flight: m3 has no PayPal handle.
    let plan = await buildPayoutPlan(w.event.id);
    expect(plan.issues).toEqual([expect.objectContaining({ code: "MISSING_HANDLE", userId: w.m3.id })]);
    expect(await proposePayoutBatch(w.event.id, w.organizer.id)).toMatchObject({ outcome: "blocked" });

    // A split edited to 90% is caught at announce time too.
    await prisma.submission.update({
      where: { id: w.submission.id },
      data: { splitDeclaration: [{ userId: w.leader.id, percent: 50 }, { userId: w.m2.id, percent: 30 }, { userId: w.m3.id, percent: 10 }] },
    });
    plan = await buildPayoutPlan(w.event.id);
    expect(plan.issues.map((i) => i.code)).toContain("SPLIT_NOT_100");

    // Fixes: restore the split, m3 adds their PayPal.
    await prisma.submission.update({
      where: { id: w.submission.id },
      data: { splitDeclaration: [{ userId: w.leader.id, percent: 50 }, { userId: w.m2.id, percent: 30 }, { userId: w.m3.id, percent: 20 }] },
    });
    await savePayPalHandle(w.m3.id, "M3@PP.test");
    plan = await buildPayoutPlan(w.event.id);
    expect(plan.ok).toBe(true);

    const proposed = await proposePayoutBatch(w.event.id, w.organizer.id);
    expect(proposed.outcome).toBe("proposed");
    const batchId = proposed.outcome === "proposed" ? proposed.batchId : "";
    expect(await proposePayoutBatch(w.event.id, w.organizer.id)).toEqual({ outcome: "exists", batchId });

    const rows = await prisma.payout.findMany({ where: { batchId }, orderBy: { amountMinor: "desc" } });
    expect(rows.map((r) => [r.recipientUserId, r.amountMinor, r.payoutHandle, r.status, r.recipientCode])).toEqual([
      [w.leader.id, 30_000, "lead@pp.test", "QUEUED", ""],
      [w.m2.id, 18_000, "m2@pp.test", "QUEUED", ""],
      [w.m3.id, 12_000, "m3@pp.test", "QUEUED", ""],
    ]);
    expect(rows.every((r) => r.idempotencyKey === `${winners[0]!.id}:${r.recipientUserId}:INSTANT`)).toBe(true);

    // Human approval → one PayPal batch → every member paid → event settles.
    const result = await approvePayoutBatch(batchId, w.organizer.id, sim);
    expect(result).toEqual({ outcome: "submitted", paypalBatchId: `SIMBATCH-${batchId}` });
    expect(await approvePayoutBatch(batchId, w.organizer.id, sim)).toEqual({ outcome: "duplicate" });

    const paid = await prisma.payout.findMany({ where: { batchId } });
    expect(paid.every((p) => p.status === "SUCCEEDED" && p.paidAt && p.paypalItemId)).toBe(true);
    const batch = await prisma.payoutBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("SUCCEEDED");
    const event = await prisma.event.findUniqueOrThrow({ where: { id: w.event.id }, include: { vault: true } });
    expect(event.status).toBe("SETTLED");
    expect(event.vault?.chainState).toBe("SETTLED");
    expect(await prisma.payoutBatch.count({ where: { eventId: w.event.id } })).toBe(1);

    const audit = await prisma.auditLog.findMany({ where: { entityId: batchId }, select: { action: true } });
    expect(audit.map((a) => a.action).sort()).toEqual(["payout.batch-approved", "payout.batch-proposed"]);

    // Replayed item update and a forged amount are both no-ops on money.
    expect(
      await applyPayoutItemStatus({ payoutItemId: paid[0]!.paypalItemId!, senderItemId: paid[0]!.id, transactionStatus: "SUCCESS", amountMinor: paid[0]!.amountMinor, errorName: null })
    ).toBe("noop");
    expect(
      await applyPayoutItemStatus({ payoutItemId: "X", senderItemId: paid[0]!.id, transactionStatus: "SUCCESS", amountMinor: 1, errorName: null })
    ).toBe("mismatch");
  });

  it("parks a failed member payout for review and keeps the event unsettled", async () => {
    const w = await createWorld("fail", ["lead@pp.test", "m2+simfail@pp.test", "m3@pp.test"]);
    orgIds.push(w.org.id);
    await announceWinners({ eventId: w.event.id, organizerId: w.organizer.id, placements: [{ place: 1, teamId: w.team.id }] });
    const proposed = await proposePayoutBatch(w.event.id, w.organizer.id);
    const batchId = proposed.outcome === "proposed" ? proposed.batchId : "";
    expect(await approvePayoutBatch(batchId, w.organizer.id, sim)).toMatchObject({ outcome: "submitted" });

    const rows = await prisma.payout.findMany({ where: { batchId } });
    const failed = rows.find((r) => r.recipientUserId === w.m2.id)!;
    expect(failed.status).toBe("MANUAL_REVIEW");
    expect(failed.lastError).toContain("Funds remain in the pool");
    expect(rows.filter((r) => r.status === "SUCCEEDED")).toHaveLength(2);
    expect((await prisma.payoutBatch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("PARTIAL");
    expect((await prisma.event.findUniqueOrThrow({ where: { id: w.event.id } })).status).toBe("WINNERS_ANNOUNCED");
  });

  it("refuses to approve for a non-admin", async () => {
    const w = await createWorld("rbac", ["lead@pp.test", "m2@pp.test", "m3@pp.test"]);
    orgIds.push(w.org.id);
    await announceWinners({ eventId: w.event.id, organizerId: w.organizer.id, placements: [{ place: 1, teamId: w.team.id }] });
    const proposed = await proposePayoutBatch(w.event.id, w.organizer.id);
    const batchId = proposed.outcome === "proposed" ? proposed.batchId : "";
    await expect(approvePayoutBatch(batchId, w.leader.id, sim)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await prisma.payoutBatch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe("PROPOSED");
  });
});

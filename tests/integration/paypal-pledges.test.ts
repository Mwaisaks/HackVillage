import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { PayPalSimulation, type PayPalPort, type PayPalWebhookHeaders } from "@/lib/ports/paypal";
import {
  capturePledgeOrder,
  createPledge,
  recordPledgeFunded,
  startPledgeCheckout,
} from "@/services/escrow/pledges";
import { processPayPalWebhook } from "@/services/escrow/paypal-webhook";

/**
 * PayPal rail F1/F2 integration tests (HACKATHON.md decision 11). Real
 * Postgres; PayPal itself is simulated. Pool $1,000 + 5% fee → $1,050 target.
 */

const TEST_KEY = `paypal-int-${Date.now().toString(36)}`;
const suiteStartedAt = new Date();
const sim = new PayPalSimulation();

/** A "live-mode" port whose signature check is decided by the test. */
const verifyingPort: PayPalPort = {
  mode: "live",
  createOrder: (input) => sim.createOrder(input),
  captureOrder: (orderId) => sim.captureOrder(orderId),
  getOrder: (orderId) => sim.getOrder(orderId),
  verifyWebhookSignature: async (h) => h.transmissionSig === "good-signature",
  createPayoutBatch: (input) => sim.createPayoutBatch(input),
  getPayoutBatch: (batchId) => sim.getPayoutBatch(batchId),
  getPayoutItem: (itemId) => sim.getPayoutItem(itemId),
};

function headers(sig: string): PayPalWebhookHeaders {
  return {
    transmissionId: "tx-1",
    transmissionTime: new Date().toISOString(),
    transmissionSig: sig,
    certUrl: "https://api.sandbox.paypal.com/cert.pem",
    authAlgo: "SHA256withRSA",
  };
}

async function createUsdWorld(label: string, poolMinor = 100_000) {
  const key = `${TEST_KEY}-${label}`;
  const user = await prisma.user.create({
    data: {
      email: `${key}@hackvillage.test`,
      name: "PayPal Test Organizer",
      handle: key.slice(-24),
      emailVerified: new Date(),
      primaryRole: "ORGANIZER",
      onboardingCompletedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({
    data: { name: `PayPal Test Org ${key}`, slug: key, ownerId: user.id, kycStatus: "VERIFIED" },
  });
  await prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: "OWNER", status: "ACTIVE" } });
  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      slug: `evt-${key}`,
      title: "PayPal Integration Event",
      venueType: "ONLINE",
      startsAt: new Date(Date.now() + 10 * 24 * 3600 * 1000),
      endsAt: new Date(Date.now() + 11 * 24 * 3600 * 1000),
      registrationDeadline: new Date(Date.now() + 9 * 24 * 3600 * 1000),
      problemStatement: "Integration test event for the PayPal rail.",
      status: "PENDING_DEPOSIT",
      publishedAt: new Date(),
      rail: "PAYPAL",
      currency: "USD",
    },
  });
  await prisma.prizeBreakdown.create({
    data: {
      eventId: event.id,
      place: 1,
      label: "1st place",
      amountKes: 0,
      amountMinor: poolMinor,
      currency: "USD",
      milestoneRequired: false,
    },
  });
  return { user, org, event };
}

async function pledge(world: Awaited<ReturnType<typeof createUsdWorld>>, name: string, amountMinor: number) {
  return createPledge({
    eventId: world.event.id,
    userId: world.user.id,
    sponsorName: name,
    sponsorEmail: `${name.toLowerCase().replace(/\s/g, "")}-${TEST_KEY}@sponsor.test`,
    amountMinor,
  });
}

/** Sponsor opens the pay link, approves at PayPal, and returns. */
async function payThroughCheckout(payToken: string) {
  await startPledgeCheckout(payToken, sim);
  const row = await prisma.sponsorPledge.findUniqueOrThrow({ where: { payToken } });
  return capturePledgeOrder(payToken, row.paypalOrderId!, sim);
}

async function eventState(eventId: string) {
  const event = await prisma.event.findUniqueOrThrow({
    where: { id: eventId },
    select: { status: true, prizeVerifiedAt: true, vault: { select: { chainState: true, lockedAt: true } } },
  });
  return event;
}

describe("PayPal sponsor pledges (integration)", () => {
  const orgIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  });

  afterAll(async () => {
    // Only this suite's rows: pledges of its own events.
    const pledgeIds = (
      await prisma.sponsorPledge.findMany({ where: { event: { orgId: { in: orgIds } } }, select: { id: true } })
    ).map((p) => p.id);
    await prisma.auditLog.deleteMany({ where: { entity: "SponsorPledge", entityId: { in: pledgeIds } } });
    await prisma.webhookEvent.deleteMany({
      where: { source: "PAYPAL", createdAt: { gte: suiteStartedAt }, reference: { contains: "WH-" } },
    });
    for (const id of orgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { email: { contains: TEST_KEY } } });
    await prisma
      .$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name IN ('hackathon.announce') AND created_on >= $1`, suiteStartedAt)
      .catch(() => undefined);
    await prisma.$disconnect();
  });

  it("goes live only when three sponsors have funded pool + fee", async () => {
    const world = await createUsdWorld("three");
    orgIds.push(world.org.id);
    const pledges = [
      await pledge(world, "Acme Cloud", 35_000),
      await pledge(world, "Globex", 35_000),
      await pledge(world, "Initech", 35_000),
    ];

    expect(await payThroughCheckout(pledges[0]!.payToken)).toEqual({ outcome: "funded", eventLive: false });
    expect(await payThroughCheckout(pledges[1]!.payToken)).toEqual({ outcome: "funded", eventLive: false });
    expect((await eventState(world.event.id)).status).toBe("PENDING_DEPOSIT");

    expect(await payThroughCheckout(pledges[2]!.payToken)).toEqual({ outcome: "funded", eventLive: true });
    const after = await eventState(world.event.id);
    expect(after.status).toBe("LIVE");
    expect(after.prizeVerifiedAt).not.toBeNull();
    expect(after.vault?.chainState).toBe("LOCKED");

    const funded = await prisma.sponsorPledge.count({ where: { eventId: world.event.id, status: "FUNDED" } });
    expect(funded).toBe(3);
  });

  it("locks the vault exactly once when the last two captures race", async () => {
    // Several worlds: without the event-row lock, each racing transaction
    // misses the other's flip and neither locks the vault.
    for (const round of [1, 2, 3]) {
      const world = await createUsdWorld(`race${round}`);
      orgIds.push(world.org.id);
      const a = await pledge(world, "Racer A", 52_500);
      const b = await pledge(world, "Racer B", 52_500);

      const results = await Promise.all(
        [a, b].map((p) =>
          recordPledgeFunded({
            pledgeId: p.id,
            orderId: null,
            captureId: `CAP-${p.id}`,
            amountMinor: p.amountMinor,
            currency: "USD",
            raw: { test: true },
          })
        )
      );
      const lives = results.filter((r) => r.outcome === "funded" && r.eventLive);
      expect(lives).toHaveLength(1);
      expect(results.every((r) => r.outcome === "funded")).toBe(true);
      const state = await eventState(world.event.id);
      expect(state.status).toBe("LIVE");
      expect(state.vault?.chainState).toBe("LOCKED");
    }
  });

  it("treats a duplicate capture and a replayed webhook as no-ops", async () => {
    const world = await createUsdWorld("dupes");
    orgIds.push(world.org.id);
    const p1 = await pledge(world, "Dup One", 60_000);
    const p2 = await pledge(world, "Dup Two", 45_000);

    // Return-URL capture, then the same return replayed.
    expect(await payThroughCheckout(p1.payToken)).toMatchObject({ outcome: "funded" });
    const row = await prisma.sponsorPledge.findUniqueOrThrow({ where: { id: p1.id } });
    expect(await capturePledgeOrder(p1.payToken, row.paypalOrderId!, sim)).toEqual({ outcome: "duplicate" });

    // The webhook for the same capture arrives afterwards: duplicate too.
    const lateWebhook = JSON.stringify({
      id: `WH-late-${p1.id}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: row.paypalCaptureId, custom_id: p1.id, amount: { value: "600.00", currency_code: "USD" } },
    });
    expect(await processPayPalWebhook(lateWebhook, headers("good-signature"), verifyingPort)).toMatchObject({ ok: true });

    // Pledge two is funded by webhook only, then the same event is replayed.
    const body = JSON.stringify({
      id: `WH-${p2.id}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: `CAP-${p2.id}`, custom_id: p2.id, amount: { value: "450.00", currency_code: "USD" } },
    });
    const first = await processPayPalWebhook(body, headers("good-signature"), verifyingPort);
    expect(first).toEqual({ ok: true, status: 200 });
    const replay = await processPayPalWebhook(body, headers("good-signature"), verifyingPort);
    expect(replay).toMatchObject({ ok: true, duplicate: true });

    const funded = await prisma.sponsorPledge.aggregate({
      where: { eventId: world.event.id, status: "FUNDED" },
      _sum: { amountMinor: true },
      _count: true,
    });
    expect(funded._count).toBe(2);
    expect(funded._sum.amountMinor).toBe(105_000);
    expect((await eventState(world.event.id)).status).toBe("LIVE");
    const stored = await prisma.webhookEvent.count({ where: { source: "PAYPAL", reference: `WH-${p2.id}` } });
    expect(stored).toBe(1);
    const fundedAudits = await prisma.auditLog.count({ where: { action: "pledge.funded", entityId: { in: [p1.id, p2.id] } } });
    expect(fundedAudits).toBe(2);
  });

  it("never counts a capture whose amount differs from the pledge", async () => {
    const world = await createUsdWorld("mismatch");
    orgIds.push(world.org.id);
    const p = await pledge(world, "Short Payer", 105_000);

    const outcome = await recordPledgeFunded({
      pledgeId: p.id,
      orderId: null,
      captureId: `CAP-short-${p.id}`,
      amountMinor: 100,
      currency: "USD",
      raw: { test: true },
    });
    expect(outcome).toEqual({ outcome: "amount-mismatch" });

    const wrongCurrency = await recordPledgeFunded({
      pledgeId: p.id,
      orderId: null,
      captureId: `CAP-eur-${p.id}`,
      amountMinor: 105_000,
      currency: "EUR",
      raw: { test: true },
    });
    expect(wrongCurrency).toEqual({ outcome: "amount-mismatch" });

    const row = await prisma.sponsorPledge.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe("PLEDGED");
    expect((await eventState(world.event.id)).status).toBe("PENDING_DEPOSIT");
    const flagged = await prisma.auditLog.count({ where: { action: "pledge.amount-mismatch", entityId: p.id } });
    expect(flagged).toBe(2);
  });

  it("rejects a webhook with a bad signature before touching the database", async () => {
    const world = await createUsdWorld("badsig");
    orgIds.push(world.org.id);
    const p = await pledge(world, "Forged", 105_000);
    const body = JSON.stringify({
      id: `WH-forged-${p.id}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP-forged", custom_id: p.id, amount: { value: "1050.00", currency_code: "USD" } },
    });

    const result = await processPayPalWebhook(body, headers("forged-signature"), verifyingPort);
    expect(result).toEqual({ ok: false, status: 401, reason: "bad-signature" });

    // Simulation mode never accepts webhooks at all.
    expect(await processPayPalWebhook(body, headers("good-signature"), sim)).toMatchObject({ ok: false, status: 404 });

    expect(await prisma.webhookEvent.count({ where: { source: "PAYPAL", reference: `WH-forged-${p.id}` } })).toBe(0);
    const row = await prisma.sponsorPledge.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe("PLEDGED");
    expect((await eventState(world.event.id)).status).toBe("PENDING_DEPOSIT");
  });
});

import { randomBytes } from "node:crypto";

import type { Prisma, SponsorPledge } from "@prisma/client";

import { prisma } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { formatMoney } from "@/lib/money";
import { sendMail } from "@/lib/ports/mail";
import { getPayPalPort, type CaptureResult, type PayPalPort } from "@/lib/ports/paypal";
import { html } from "@/lib/notifications/html";
import { renderEmail, renderText, type EmailTemplate } from "@/lib/notifications/layout";
import { appUrl } from "@/lib/url";
import {
  fundingCovered,
  fundingPercent,
  fundingTargetFor,
  usdPoolMinor,
  type FundingTarget,
} from "@/services/escrow/pledge-math";

/**
 * Sponsor pledges — multi-sponsor pooled funding for PayPal-rail events
 * (HACKATHON.md F2). The PayPal analogue of services/escrow/deposits.ts:
 * only this service touches SponsorPledge rows, only the PayPal port talks
 * to PayPal, every step is idempotent and fail-closed.
 *
 * Flow: organiser creates a pledge → sponsor opens /fund/[payToken] → we
 * create a PayPal order → sponsor approves → PayPal returns to
 * /fund/[payToken]/return → we capture → recordPledgeFunded. The
 * PAYMENT.CAPTURE.COMPLETED webhook converges on the same recordPledgeFunded
 * if our capture response was lost.
 */

export class PledgeError extends Error {
  constructor(
    message: string,
    public code: "NOT_FOUND" | "FORBIDDEN" | "WRONG_STATE" | "KYB_REQUIRED" | "INVALID"
  ) {
    super(message);
  }
}

const MIN_PLEDGE_MINOR = 100; // $1

// ── Organiser: create a pledge ───────────────────────────────────────────

export interface CreatePledgeInput {
  eventId: string;
  userId: string;
  sponsorName: string;
  sponsorEmail: string;
  amountMinor: number;
}

export async function createPledge(input: CreatePledgeInput): Promise<SponsorPledge> {
  const event = await prisma.event.findUnique({
    where: { id: input.eventId },
    include: {
      org: { include: { members: { where: { userId: input.userId, status: "ACTIVE" } } } },
      prizes: { select: { amountMinor: true } },
      vault: true,
    },
  });
  if (!event) throw new PledgeError("Hackathon not found.", "NOT_FOUND");
  const membership = event.org.members[0];
  if (!membership || membership.role === "MEMBER") {
    throw new PledgeError("Only organization admins can add sponsors.", "FORBIDDEN");
  }
  if (event.rail !== "PAYPAL") {
    throw new PledgeError("Sponsor pledges are for PayPal (USD) hackathons.", "WRONG_STATE");
  }
  if (event.status !== "PENDING_DEPOSIT") {
    throw new PledgeError(
      event.status === "DRAFT" ? "Publish the hackathon first." : "This hackathon is already funded.",
      "WRONG_STATE"
    );
  }
  if (event.org.kycStatus !== "VERIFIED") {
    throw new PledgeError("Your organization needs verified KYB before taking sponsor funds.", "KYB_REQUIRED");
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < MIN_PLEDGE_MINOR) {
    throw new PledgeError("A pledge must be at least $1.", "INVALID");
  }
  const pool = usdPoolMinor(event.prizes);
  if (pool == null) throw new PledgeError("Every prize needs a USD amount.", "INVALID");

  const pledge = await prisma.$transaction(async (tx) => {
    // The vault exists from the first pledge (AWAITING until funded).
    if (!event.vault) {
      await tx.vaultState.create({
        data: { eventId: event.id, amountKes: 0, amountMinor: pool, currency: event.currency, chainState: "AWAITING" },
      });
    }
    const created = await tx.sponsorPledge.create({
      data: {
        eventId: event.id,
        sponsorName: input.sponsorName,
        sponsorEmail: input.sponsorEmail.toLowerCase(),
        amountMinor: input.amountMinor,
        currency: event.currency,
        payToken: randomBytes(18).toString("base64url"),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: input.userId,
        action: "pledge.created",
        entity: "SponsorPledge",
        entityId: created.id,
        meta: { eventId: event.id, amountMinor: input.amountMinor, sponsorName: input.sponsorName },
      },
    });
    return created;
  });

  await sendMail({
    to: pledge.sponsorEmail,
    ...pledgeLinkEmail(event.title, pledge.sponsorName, formatMoney(pledge.amountMinor, pledge.currency), payLink(pledge.payToken)),
  }).catch((error: unknown) => console.error("[pledge] pay-link email failed", error));

  return pledge;
}

export function payLink(payToken: string): string {
  return appUrl(`/fund/${payToken}`);
}

// ── Sponsor: start checkout ──────────────────────────────────────────────

export async function startPledgeCheckout(
  payToken: string,
  portOverride?: PayPalPort
): Promise<{ approveUrl: string; simulated: boolean }> {
  const pledge = await prisma.sponsorPledge.findUnique({
    where: { payToken },
    include: { event: { select: { title: true, status: true } } },
  });
  if (!pledge) throw new PledgeError("This pay link is not valid.", "NOT_FOUND");
  if (pledge.status !== "PLEDGED") throw new PledgeError("This pledge is already paid.", "WRONG_STATE");
  if (pledge.event.status !== "PENDING_DEPOSIT") {
    throw new PledgeError("This hackathon's prize pool is closed.", "WRONG_STATE");
  }

  const port = portOverride ?? getPayPalPort();
  const session = await port.createOrder({
    pledgeId: pledge.id,
    amountMinor: pledge.amountMinor,
    currency: "USD",
    description: `${pledge.event.title}: prize pool pledge`,
    returnUrl: appUrl(`/fund/${payToken}/return`),
    cancelUrl: appUrl(`/fund/${payToken}?cancelled=1`),
    requestId: `order-${pledge.id}-${randomBytes(4).toString("hex")}`,
  });

  // Only the most recent order for a pledge may be captured (capturePledgeOrder
  // checks the token PayPal returns against this).
  await prisma.sponsorPledge.updateMany({
    where: { id: pledge.id, status: "PLEDGED" },
    data: { paypalOrderId: session.orderId },
  });
  return { approveUrl: session.approveUrl, simulated: session.simulated };
}

// ── Sponsor returns from PayPal: capture ─────────────────────────────────

export type CaptureOutcome =
  | FundOutcome
  | { outcome: "pending" }
  | { outcome: "declined" }
  | { outcome: "order-mismatch" };

export async function capturePledgeOrder(
  payToken: string,
  orderId: string,
  portOverride?: PayPalPort
): Promise<CaptureOutcome> {
  const pledge = await prisma.sponsorPledge.findUnique({ where: { payToken } });
  if (!pledge) return { outcome: "unknown-pledge" };
  if (pledge.status === "FUNDED") return { outcome: "duplicate" };
  if (pledge.paypalOrderId !== orderId) return { outcome: "order-mismatch" };

  const port = portOverride ?? getPayPalPort();
  let capture: CaptureResult | null;
  try {
    // One request id per pledge: a retried capture is deduped by PayPal.
    capture = await port.captureOrder(orderId, `capture-${pledge.id}`);
  } catch (error) {
    // Ambiguous: the capture may have gone through. Ask PayPal first; only a
    // confirmed capture counts. Otherwise stay PLEDGED (fail closed) — the
    // webhook or a retry resolves it.
    console.error(`[pledge] capture error pledge=${pledge.id} order=${orderId}`, error);
    const lookup = await port.getOrder(orderId).catch(() => null);
    capture = lookup?.capture ?? null;
    if (!capture) return { outcome: "pending" };
  }

  if (capture.state === "PENDING" || capture.state === "UNKNOWN") return { outcome: "pending" };
  if (capture.state !== "COMPLETED") return { outcome: "declined" };

  return recordPledgeFunded({
    pledgeId: pledge.id,
    orderId,
    captureId: capture.captureId,
    amountMinor: capture.amountMinor,
    currency: capture.currency,
    raw: capture.raw,
  });
}

// ── The money state machine step ─────────────────────────────────────────

export type FundOutcome =
  | { outcome: "funded"; eventLive: boolean }
  | { outcome: "duplicate" }
  | { outcome: "unknown-pledge" }
  | { outcome: "not-pledged" }
  | { outcome: "amount-mismatch" }
  | { outcome: "overpayment" };

export interface FundInput {
  pledgeId: string;
  orderId: string | null;
  captureId: string | null;
  amountMinor: number | null;
  currency: string | null;
  raw: unknown;
}

/**
 * A capture is confirmed (return URL or webhook). Idempotent: replays return
 * "duplicate" with zero side effects. The pledge flip, the funded-sum check,
 * the vault lock and the LIVE flip happen in ONE transaction that first
 * locks the event row, so two concurrent last captures lock the vault
 * exactly once (HACKATHON.md decision 10).
 */
export async function recordPledgeFunded(input: FundInput): Promise<FundOutcome> {
  const pledge = await prisma.sponsorPledge.findUnique({
    where: { id: input.pledgeId },
    include: { event: { select: { id: true, slug: true, title: true } } },
  });
  if (!pledge) return { outcome: "unknown-pledge" };
  if (pledge.status === "FUNDED") return { outcome: "duplicate" };
  if (pledge.status !== "PLEDGED") {
    await flagPledge(pledge, "pledge.capture-on-refunded", `Capture ${input.captureId ?? "?"} arrived for a ${pledge.status} pledge`, input);
    return { outcome: "not-pledged" };
  }

  // Our row is authoritative: a capture for any other amount or currency
  // never counts toward the pool. The money is real — ops repairs by hand.
  if (input.amountMinor !== pledge.amountMinor || input.currency !== pledge.currency) {
    await flagPledge(
      pledge,
      "pledge.amount-mismatch",
      `Captured ${input.amountMinor ?? "?"} ${input.currency ?? "?"} but the pledge is ${pledge.amountMinor} ${pledge.currency}`,
      input
    );
    return { outcome: "amount-mismatch" };
  }

  const feeBps = getEnv().PLATFORM_FEE_BPS;
  const result = await prisma.$transaction(async (tx) => {
    // Serialise every capture for this event behind the event row.
    await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${pledge.eventId} FOR UPDATE`;

    const flipped = await tx.sponsorPledge.updateMany({
      where: { id: pledge.id, status: "PLEDGED" },
      data: {
        status: "FUNDED",
        fundedAt: new Date(),
        paypalCaptureId: input.captureId,
        ...(input.orderId ? { paypalOrderId: input.orderId } : {}),
        rawCapture: (input.raw ?? {}) as Prisma.InputJsonValue,
      },
    });
    if (flipped.count === 0) return { kind: "duplicate" as const };

    const event = await tx.event.findUniqueOrThrow({
      where: { id: pledge.eventId },
      select: { status: true, prizes: { select: { amountMinor: true } }, vault: { select: { chainState: true } } },
    });
    if (event.status !== "PENDING_DEPOSIT" || event.vault?.chainState !== "AWAITING") {
      return { kind: "overpaid" as const };
    }

    const pool = usdPoolMinor(event.prizes);
    if (pool == null) return { kind: "funded" as const, live: false };
    const funded = await tx.sponsorPledge.aggregate({
      where: { eventId: pledge.eventId, status: "FUNDED" },
      _sum: { amountMinor: true },
    });
    if (!fundingCovered(funded._sum.amountMinor ?? 0, fundingTargetFor(pool, feeBps))) {
      return { kind: "funded" as const, live: false };
    }

    const locked = await tx.vaultState.updateMany({
      where: { eventId: pledge.eventId, chainState: "AWAITING" },
      data: { chainState: "LOCKED", lockedAt: new Date() },
    });
    if (locked.count === 0) return { kind: "overpaid" as const };
    await tx.event.update({
      where: { id: pledge.eventId },
      data: { status: "LIVE", prizeVerifiedAt: new Date() },
    });
    return { kind: "funded" as const, live: true };
  });

  if (result.kind === "duplicate") return { outcome: "duplicate" };

  await prisma.auditLog.create({
    data: {
      actorId: null,
      action: "pledge.funded",
      entity: "SponsorPledge",
      entityId: pledge.id,
      meta: { eventId: pledge.eventId, captureId: input.captureId, amountMinor: pledge.amountMinor },
    },
  });

  if (result.kind === "overpaid") {
    // The pool was already closed: the money is real and recorded FUNDED,
    // but it never re-locks anything. Refund by hand (decision 3).
    await flagPledge(pledge, "pledge.overpayment", "Pledge captured after the prize pool was already funded or closed. Refund manually in PayPal", input);
    return { outcome: "overpayment" };
  }

  if (result.live) {
    const { notifyEventLive } = await import("@/services/escrow/deposits");
    await notifyEventLive(pledge.eventId).catch((error: unknown) =>
      console.error("[pledge] event live notification failed", error)
    );
    const { enqueue } = await import("@/lib/queue");
    await enqueue("hackathon.announce", { eventId: pledge.eventId }, { singletonKey: `announce:${pledge.eventId}` });
  }
  return { outcome: "funded", eventLive: result.live };
}

async function flagPledge(
  pledge: SponsorPledge & { event: { slug: string; title: string } },
  action: string,
  reason: string,
  input: FundInput
): Promise<void> {
  console.error(`[pledge] ${action}: pledge=${pledge.id} event=${pledge.event.slug} — ${reason}`);
  await prisma.auditLog.create({
    data: {
      actorId: null,
      action,
      entity: "SponsorPledge",
      entityId: pledge.id,
      reason,
      meta: {
        eventSlug: pledge.event.slug,
        sponsorEmail: pledge.sponsorEmail,
        pledgeAmountMinor: pledge.amountMinor,
        capturedAmountMinor: input.amountMinor,
        capturedCurrency: input.currency,
        captureId: input.captureId,
        orderId: input.orderId,
      },
    },
  });
  const { alertAdmins } = await import("@/lib/notifications/admin-alert");
  await alertAdmins(pledgeAlertEmail(pledge.event.title, pledge.id, reason, input.captureId)).catch(
    (error: unknown) => console.error("[pledge] admin alert failed", error)
  );
}

// ── Read model: the public funding bar and the organiser table ───────────

export interface FundingSummary {
  currency: string;
  target: FundingTarget | null;
  fundedMinor: number;
  pledgedMinor: number;
  percent: number;
  sponsors: { id: string; name: string; amountMinor: number; status: SponsorPledge["status"]; fundedAt: Date | null }[];
}

export async function getFundingSummary(eventId: string): Promise<FundingSummary> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      currency: true,
      prizes: { select: { amountMinor: true } },
      pledges: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!event) throw new PledgeError("Hackathon not found.", "NOT_FOUND");
  const pool = usdPoolMinor(event.prizes);
  const target = pool == null ? null : fundingTargetFor(pool, getEnv().PLATFORM_FEE_BPS);
  const live = event.pledges.filter((p) => p.status !== "REFUNDED");
  const fundedMinor = live.filter((p) => p.status === "FUNDED").reduce((s, p) => s + p.amountMinor, 0);
  const pledgedMinor = live.reduce((s, p) => s + p.amountMinor, 0);
  return {
    currency: event.currency,
    target,
    fundedMinor,
    pledgedMinor,
    percent: target ? fundingPercent(fundedMinor, target) : 0,
    sponsors: live.map((p) => ({
      id: p.id,
      name: p.sponsorName,
      amountMinor: p.amountMinor,
      status: p.status,
      fundedAt: p.fundedAt,
    })),
  };
}

// ── Emails ───────────────────────────────────────────────────────────────

function pledgeLinkEmail(eventTitle: string, sponsorName: string, amount: string, url: string): EmailTemplate {
  return {
    subject: `Your Prize Pool Pledge: ${eventTitle}`,
    html: renderEmail({
      preheader: `Pay your ${amount} pledge with PayPal.`,
      section: {
        heading: "Fund The Prize Pool",
        bodyHtml: html`<p style="margin:0;">Thank you, ${sponsorName}. Your pledge to <strong>${eventTitle}</strong> is ready to pay with PayPal. The hackathon goes live once every pledge is funded, and winners are paid directly from the pool.</p>`,
        details: [{ label: "Pledge", value: amount }],
        ctaUrl: url,
        ctaLabel: "Pay With PayPal",
      },
    }),
    text: renderText([`Your ${amount} pledge to ${eventTitle} is ready to pay with PayPal.`, url]),
  };
}

function pledgeAlertEmail(eventTitle: string, pledgeId: string, reason: string, captureId: string | null): EmailTemplate {
  return {
    subject: `Pledge Needs Attention: ${eventTitle}`,
    html: renderEmail({
      preheader: "A PayPal pledge capture needs a manual decision.",
      section: {
        heading: "Pledge Needs Attention",
        bodyHtml: html`<p style="margin:0;">${reason}. The money is not lost. Check the capture in the PayPal sandbox dashboard and refund it by hand if needed.</p>`,
        details: [
          { label: "Pledge", value: pledgeId },
          { label: "Capture", value: captureId ?? "unknown" },
        ],
        ctaUrl: appUrl("/admin/payments"),
        ctaLabel: "Open The Admin Queue",
      },
    }),
    text: renderText([`Pledge ${pledgeId} for ${eventTitle}: ${reason}.`, `Capture ${captureId ?? "unknown"}.`]),
  };
}



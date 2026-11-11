import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { getPayPalPort, valueToMinor, type PayPalPort, type PayPalWebhookHeaders } from "@/lib/ports/paypal";
import { recordPledgeFunded } from "@/services/escrow/pledges";

/**
 * PayPal webhook pipeline (HACKATHON.md F1). Same security posture as the
 * Paystack pipeline (services/escrow/webhook.ts):
 *   1. Signature verified with PayPal's verify-webhook-signature API over the
 *      RAW body.
 *   2. Replay guard: unique (PAYPAL, eventType, PayPal event id). PayPal
 *      re-delivers with the same event id, so duplicates are recorded once and
 *      never re-processed — except a stored event that never finished
 *      processing, which is re-driven through the same idempotent handlers.
 *   3. Only then does the money state machine run (idempotent anyway).
 */

export interface PayPalWebhookResult {
  ok: boolean;
  status: number;
  duplicate?: boolean;
  reprocessed?: boolean;
  reason?: string;
}

export interface PayPalWebhookPayload {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    status?: string;
    custom_id?: string;
    amount?: { value?: string; currency_code?: string };
    supplementary_data?: { related_ids?: { order_id?: string } };
    payout_item_id?: string;
    payout_batch_id?: string;
    transaction_status?: string;
    payout_item?: { sender_item_id?: string };
  };
}

export async function processPayPalWebhook(
  rawBody: string,
  headers: PayPalWebhookHeaders,
  portOverride?: PayPalPort
): Promise<PayPalWebhookResult> {
  const port = portOverride ?? getPayPalPort();
  if (port.mode === "simulation") return { ok: false, status: 404, reason: "simulation-mode" };

  if (!(await port.verifyWebhookSignature(headers, rawBody))) {
    console.error("[webhook] PAYPAL signature verification failed");
    return { ok: false, status: 401, reason: "bad-signature" };
  }

  let payload: PayPalWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as PayPalWebhookPayload;
  } catch {
    return { ok: false, status: 400, reason: "bad-json" };
  }

  const eventType = payload.event_type ?? "unknown";
  const reference = payload.id ?? "unknown";

  const stored = await prisma.webhookEvent
    .create({
      data: {
        source: "PAYPAL",
        eventType,
        reference,
        signatureOk: true,
        payload: { raw: payload } as unknown as Prisma.InputJsonValue,
      },
    })
    .catch((error: { code?: string }) => {
      if (error.code === "P2002") return null;
      throw error;
    });

  if (!stored) {
    const existing = await prisma.webhookEvent.findUnique({
      where: { source_eventType_reference: { source: "PAYPAL", eventType, reference } },
    });
    if (existing && existing.processedAt == null) {
      const raw = (existing.payload as { raw?: PayPalWebhookPayload } | null)?.raw;
      if (raw) {
        await routePayPalEvent(existing.id, raw);
        return { ok: true, status: 200, reprocessed: true };
      }
    }
    return { ok: true, status: 200, duplicate: true };
  }

  await routePayPalEvent(stored.id, payload);
  return { ok: true, status: 200 };
}

/** Outbox sweeper for PayPal events recorded but never processed (>1h). */
export async function reprocessStalePayPalWebhookEvents(limit = 25): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const stale = await prisma.webhookEvent.findMany({
    where: { source: "PAYPAL", processedAt: null, createdAt: { lt: cutoff } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  for (const event of stale) {
    const raw = (event.payload as { raw?: PayPalWebhookPayload } | null)?.raw;
    if (!raw) {
      await markProcessed(event.id);
      continue;
    }
    await routePayPalEvent(event.id, raw);
  }
  return stale.length;
}

async function routePayPalEvent(webhookEventId: string, payload: PayPalWebhookPayload): Promise<void> {
  const eventType = payload.event_type ?? "unknown";
  const resource = payload.resource ?? {};

  if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
    const pledgeId = resource.custom_id;
    if (!pledgeId) {
      console.error(`[webhook] PAYPAL capture ${resource.id ?? "?"} has no custom_id — not ours`);
    } else {
      const outcome = await recordPledgeFunded({
        pledgeId,
        orderId: resource.supplementary_data?.related_ids?.order_id ?? null,
        captureId: resource.id ?? null,
        amountMinor: valueToMinor(resource.amount?.value),
        currency: resource.amount?.currency_code ?? null,
        raw: payload,
      });
      if (outcome.outcome === "unknown-pledge") {
        console.error(`[webhook] PAYPAL capture for unknown pledge ${pledgeId}`);
      }
    }
    await markProcessed(webhookEventId);
    return;
  }

  if (eventType === "PAYMENT.CAPTURE.REVERSED" || eventType === "PAYMENT.CAPTURE.REFUNDED") {
    // Never rewrite history automatically (decision 3): audit + page ops.
    await prisma.auditLog.create({
      data: {
        actorId: null,
        action: `pledge.${eventType === "PAYMENT.CAPTURE.REVERSED" ? "capture-reversed" : "capture-refunded"}`,
        entity: "SponsorPledge",
        entityId: resource.custom_id ?? null,
        reason: `PayPal reported ${eventType} for capture ${resource.id ?? "?"}`,
        meta: { captureId: resource.id ?? null, amount: resource.amount ?? null },
      },
    });
    const { alertAdmins } = await import("@/lib/notifications/admin-alert");
    const { renderEmail, renderText } = await import("@/lib/notifications/layout");
    const { html } = await import("@/lib/notifications/html");
    await alertAdmins({
      subject: `PayPal ${eventType}`,
      html: renderEmail({
        preheader: "A funded pledge was reversed or refunded at PayPal.",
        section: {
          heading: "Pledge Reversed At PayPal",
          bodyHtml: html`<p style="margin:0;">PayPal reported ${eventType} for capture ${resource.id ?? "unknown"} (pledge ${resource.custom_id ?? "unknown"}). The pool may no longer be fully funded. Review it by hand.</p>`,
        },
      }),
      text: renderText([`PayPal reported ${eventType} for capture ${resource.id ?? "unknown"}.`]),
    }).catch((error: unknown) => console.error("[webhook] admin alert failed", error));
    await markProcessed(webhookEventId);
    return;
  }

  // PAYMENT.PAYOUTS-ITEM.* are handled by the payout engine (F3); until then
  // they are retained for forensics and reconciliation.
  await markProcessed(webhookEventId);
}

async function markProcessed(webhookEventId: string): Promise<void> {
  await prisma.webhookEvent.update({ where: { id: webhookEventId }, data: { processedAt: new Date() } });
}

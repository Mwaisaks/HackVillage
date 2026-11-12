"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import {
  approvePayoutBatch,
  discardProposedBatch,
  PayPalPayoutError,
  proposePayoutBatch,
  savePayPalHandle,
  syncPayoutBatch,
} from "@/services/payout/paypal-payouts";

export interface PayPalActionState {
  error?: string;
  message?: string;
}

function toState(error: unknown): PayPalActionState {
  if (error instanceof PayPalPayoutError) return { error: error.message };
  console.error("[paypal-payout] action failed", error);
  return { error: "Something went wrong. Nothing was paid. Try again in a moment." };
}

async function revalidateEvent(eventId: string): Promise<void> {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { slug: true } });
  if (event) {
    revalidatePath(`/organizer/hackathons/${event.slug}/winners`);
    revalidatePath(`/hackathons/${event.slug}`);
  }
}

/** Member: save their own PayPal email or phone (no bank details). */
export async function savePayPalHandleAction(
  _prev: PayPalActionState,
  formData: FormData
): Promise<PayPalActionState> {
  const user = await requireUser();
  const raw = String(formData.get("paypalHandle") ?? "").trim();
  if (!raw) return { error: "Enter your PayPal email address or phone number." };
  try {
    const saved = await savePayPalHandle(user.id, raw);
    revalidatePath("/settings");
    return { message: `Saved. Prize shares will be sent to ${saved}.` };
  } catch (error) {
    return toState(error);
  }
}

const eventIdSchema = z.string().cuid();
const batchIdSchema = z.string().cuid();

export async function proposeBatchAction(eventId: string): Promise<PayPalActionState> {
  const user = await requireUser();
  if (!eventIdSchema.safeParse(eventId).success) return { error: "Unknown hackathon." };
  try {
    const result = await proposePayoutBatch(eventId, user.id);
    await revalidateEvent(eventId);
    if (result.outcome === "blocked") {
      return { error: `${result.plan.blockers} issue(s) must be fixed before a batch can be proposed.` };
    }
    return { message: result.outcome === "exists" ? "A batch is already proposed." : "Batch proposed. Review it, then approve." };
  } catch (error) {
    return toState(error);
  }
}

export async function approveBatchAction(batchId: string): Promise<PayPalActionState> {
  const user = await requireUser();
  if (!batchIdSchema.safeParse(batchId).success) return { error: "Unknown batch." };
  try {
    const result = await approvePayoutBatch(batchId, user.id);
    const batch = await prisma.payoutBatch.findUnique({ where: { id: batchId }, select: { eventId: true } });
    if (batch) await revalidateEvent(batch.eventId);
    switch (result.outcome) {
      case "submitted":
        return { message: `Approved. PayPal batch ${result.paypalBatchId} is paying every member.` };
      case "duplicate":
        return { error: "This batch was already approved." };
      case "rejected":
        return { error: `PayPal rejected the batch, so nothing was paid: ${result.reason}` };
      case "held":
        return { error: "PayPal didn't confirm the batch yet. It will be retried safely; nothing is sent twice." };
    }
  } catch (error) {
    return toState(error);
  }
}

export async function discardBatchAction(batchId: string): Promise<PayPalActionState> {
  const user = await requireUser();
  if (!batchIdSchema.safeParse(batchId).success) return { error: "Unknown batch." };
  try {
    const batch = await prisma.payoutBatch.findUnique({ where: { id: batchId }, select: { eventId: true } });
    const discarded = await discardProposedBatch(batchId, user.id);
    if (batch) await revalidateEvent(batch.eventId);
    return discarded ? { message: "Proposal discarded. Fix the details and propose again." } : { error: "Only an unapproved proposal can be discarded." };
  } catch (error) {
    return toState(error);
  }
}

export async function syncBatchAction(batchId: string): Promise<PayPalActionState> {
  await requireUser();
  if (!batchIdSchema.safeParse(batchId).success) return { error: "Unknown batch." };
  try {
    await syncPayoutBatch(batchId);
    const batch = await prisma.payoutBatch.findUnique({ where: { id: batchId }, select: { eventId: true, status: true } });
    if (batch) await revalidateEvent(batch.eventId);
    return { message: `Status refreshed: ${batch?.status.toLowerCase() ?? "unknown"}.` };
  } catch (error) {
    return toState(error);
  }
}

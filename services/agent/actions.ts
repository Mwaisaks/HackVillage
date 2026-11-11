"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { runPayoutAgent, runReconcileAgent, sendAgentReminders } from "@/services/agent/payout-agent";
import { PayPalPayoutError } from "@/services/payout/paypal-payouts";

export interface AgentActionState {
  error?: string;
  message?: string;
}

const cuid = z.string().cuid();

function toState(error: unknown): AgentActionState {
  if (error instanceof PayPalPayoutError) return { error: error.message };
  console.error("[payout-agent] action failed", error);
  return { error: "The agent could not finish. Nothing was paid. Try again in a moment." };
}

async function revalidateEvent(eventId: string): Promise<void> {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { slug: true } });
  if (event) revalidatePath(`/organizer/hackathons/${event.slug}/winners`);
}

export async function runPayoutAgentAction(eventId: string): Promise<AgentActionState> {
  const user = await requireUser();
  if (!cuid.safeParse(eventId).success) return { error: "Unknown hackathon." };
  try {
    const run = await runPayoutAgent(eventId, user.id);
    await revalidateEvent(eventId);
    if (run.decision.type === "proposed") return { message: "The agent proposed a batch. Review it, then approve." };
    if (run.decision.type === "exists") return { message: "A batch is already waiting for your approval." };
    return { message: "The agent held the batch. Fix the flagged issues, then run it again." };
  } catch (error) {
    return toState(error);
  }
}

export async function sendAgentRemindersAction(eventId: string, runId: string): Promise<AgentActionState> {
  const user = await requireUser();
  if (!cuid.safeParse(eventId).success || !cuid.safeParse(runId).success) return { error: "Unknown agent run." };
  try {
    const sent = await sendAgentReminders(eventId, user.id, runId);
    await revalidateEvent(eventId);
    return { message: sent === 0 ? "Everyone has added PayPal since; no reminders needed." : `Sent ${sent} reminder(s).` };
  } catch (error) {
    return toState(error);
  }
}

export async function runReconcileAgentAction(batchId: string): Promise<AgentActionState> {
  const user = await requireUser();
  if (!cuid.safeParse(batchId).success) return { error: "Unknown batch." };
  try {
    const run = await runReconcileAgent(batchId, user.id);
    const batch = await prisma.payoutBatch.findUnique({ where: { id: batchId }, select: { eventId: true } });
    if (batch) await revalidateEvent(batch.eventId);
    return { message: run.summary };
  } catch (error) {
    return toState(error);
  }
}

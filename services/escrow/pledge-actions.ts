"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requireUser } from "@/lib/auth/guards";
import { parseMajorToMinor } from "@/lib/money";
import { createPledge, PledgeError, startPledgeCheckout } from "@/services/escrow/pledges";

export interface PledgeActionState {
  error?: string;
  message?: string;
}

const pledgeSchema = z.object({
  eventId: z.string().cuid(),
  slug: z.string().min(1),
  sponsorName: z.string().trim().min(2, "Sponsor name is required.").max(80),
  sponsorEmail: z.string().trim().email("Enter the sponsor's email."),
  amount: z.string().trim().min(1, "Enter the pledge amount."),
});

/** Organiser adds a sponsor pledge. The service re-checks every rule. */
export async function createPledgeAction(
  _prev: PledgeActionState,
  formData: FormData
): Promise<PledgeActionState> {
  const user = await requireUser();
  const parsed = pledgeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the pledge details." };
  const amountMinor = parseMajorToMinor(parsed.data.amount);
  if (amountMinor == null) return { error: "Enter the amount in dollars, like 1500 or 1500.50." };

  try {
    const pledge = await createPledge({
      eventId: parsed.data.eventId,
      userId: user.id,
      sponsorName: parsed.data.sponsorName,
      sponsorEmail: parsed.data.sponsorEmail,
      amountMinor,
    });
    revalidatePath(`/organizer/hackathons/${parsed.data.slug}/vault`);
    return { message: `Pledge added. ${pledge.sponsorName} has been emailed their PayPal pay link.` };
  } catch (error) {
    if (error instanceof PledgeError) return { error: error.message };
    console.error("[pledge] createPledge failed", error);
    return { error: "We couldn't add the pledge. Try again in a moment." };
  }
}

/** Sponsor clicks "Pay with PayPal": create the order and go to PayPal. */
export async function startPledgeCheckoutAction(
  _prev: PledgeActionState,
  formData: FormData
): Promise<PledgeActionState> {
  const payToken = String(formData.get("payToken") ?? "");
  let approveUrl: string;
  try {
    ({ approveUrl } = await startPledgeCheckout(payToken));
  } catch (error) {
    if (error instanceof PledgeError) return { error: error.message };
    console.error("[pledge] startPledgeCheckout failed", error);
    return { error: "PayPal is unavailable right now. Nothing was charged. Try again in a moment." };
  }
  redirect(approveUrl);
}

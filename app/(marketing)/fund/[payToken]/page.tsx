import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FundingBar } from "@/components/escrow/funding-bar";
import { PayWithPayPalForm } from "@/components/escrow/pledge-forms";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { getFundingSummary } from "@/services/escrow/pledges";

export const metadata: Metadata = {
  title: "Fund A Prize Pool",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const NOTICES: Record<string, { tone: "success" | "warning"; text: string }> = {
  funded: { tone: "success", text: "Payment received. Thank you, your pledge is funded." },
  live: { tone: "success", text: "Payment received. Your pledge completed the pool and the hackathon is now live." },
  pending: { tone: "warning", text: "PayPal is still processing your payment. This page updates once it completes." },
  declined: { tone: "warning", text: "PayPal declined the payment. Nothing was charged. You can try again." },
  error: { tone: "warning", text: "We couldn't confirm the payment. Nothing is lost. Refresh in a minute or contact the organiser." },
};

/** Public sponsor pay page, reached from the pledge email (HACKATHON.md F2). */
export default async function FundPledgePage({
  params,
  searchParams,
}: {
  params: Promise<{ payToken: string }>;
  searchParams: Promise<{ status?: string; cancelled?: string }>;
}) {
  const [{ payToken }, { status, cancelled }] = await Promise.all([params, searchParams]);
  const pledge = await prisma.sponsorPledge.findUnique({
    where: { payToken },
    include: { event: { select: { id: true, title: true, status: true, org: { select: { name: true } } } } },
  });
  if (!pledge) notFound();

  const summary = await getFundingSummary(pledge.eventId);
  const amount = formatMoney(pledge.amountMinor, pledge.currency);
  const notice = status ? NOTICES[status] : cancelled ? NOTICES.declined : undefined;

  return (
    <div className="mx-auto w-full max-w-xl space-y-6 px-4 py-12">
      <header className="space-y-1">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Prize pool pledge</p>
        <h1 className="font-display text-3xl font-bold text-ink">{pledge.event.title}</h1>
        <p className="text-sm text-muted">Organised by {pledge.event.org.name}</p>
      </header>

      {notice ? (
        <p
          role="status"
          className={`rounded-card border p-4 text-sm font-semibold ${
            notice.tone === "success" ? "border-success/40 bg-success/10 text-success" : "border-warning/40 bg-warning/10 text-ink"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      <Card className="space-y-4">
        <CardTitle>{pledge.sponsorName}</CardTitle>
        <CardDescription>
          {pledge.status === "FUNDED"
            ? `Your ${amount} pledge is funded. Winners are paid directly from the pool, each team member to their own PayPal account.`
            : `Your pledge is ${amount}. You pay with PayPal, and the money joins the funded prize pool. Winners are paid in full on results day.`}
        </CardDescription>
        {pledge.status === "PLEDGED" && pledge.event.status === "PENDING_DEPOSIT" ? (
          <PayWithPayPalForm payToken={payToken} amount={amount} />
        ) : null}
      </Card>

      <Card>
        <FundingBar summary={summary} />
      </Card>

      <p className="text-xs text-muted">
        PayPal sandbox demo. In production, pooled funds would be held by a licensed custody partner.
      </p>
    </div>
  );
}

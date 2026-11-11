import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MoneyDashboardView } from "@/components/dashboard/money-dashboard-view";
import { prisma } from "@/lib/db";
import { getMoneyDashboard } from "@/services/dashboard/money";

export const metadata: Metadata = {
  title: "Sponsor Dashboard",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

/**
 * Sponsor view of the money dashboard (HACKATHON.md F5), reached through the
 * sponsor's own unguessable pay-link token. Emails are hidden and PayPal
 * handles are masked.
 */
export default async function SponsorDashboardPage({ params }: { params: Promise<{ payToken: string }> }) {
  const { payToken } = await params;
  const pledge = await prisma.sponsorPledge.findUnique({ where: { payToken }, select: { eventId: true, sponsorName: true } });
  if (!pledge) notFound();
  const data = await getMoneyDashboard(pledge.eventId, "sponsor");
  if (!data) notFound();

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-12">
      <header className="space-y-1">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Sponsor dashboard · {pledge.sponsorName}</p>
        <h1 className="font-display text-3xl font-bold text-ink">{data.eventTitle}</h1>
        <p className="text-sm text-muted">
          Where the prize money went: every pledge, and every team member paid to their own PayPal.{" "}
          <Link className="font-semibold text-ink-soft hover:underline" href={`/fund/${payToken}`}>Back to your pledge</Link>
        </p>
      </header>
      <MoneyDashboardView data={data} />
      <p className="text-xs text-muted">PayPal sandbox demo. A production deployment would hold pooled funds with a licensed custody partner.</p>
    </div>
  );
}

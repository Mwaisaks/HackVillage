import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MoneyDashboardView } from "@/components/dashboard/money-dashboard-view";
import { requireUser } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { getMoneyDashboard } from "@/services/dashboard/money";

export const metadata: Metadata = { title: "Money Dashboard" };
export const dynamic = "force-dynamic";

/** Organiser money dashboard for PayPal-rail events (HACKATHON.md F5). */
export default async function MoneyDashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ slug }, user] = await Promise.all([params, requireUser()]);
  const event = await prisma.event.findFirst({
    where: { slug },
    select: { id: true, slug: true, rail: true, org: { select: { members: { where: { userId: user.id, status: "ACTIVE" }, select: { role: true } } } } },
  });
  if (!event || event.rail !== "PAYPAL" || event.org.members.length === 0) notFound();
  const data = await getMoneyDashboard(event.id, "organizer");
  if (!data) notFound();

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">Money dashboard</p>
          <h1 className="font-display text-3xl font-bold text-ink">{data.eventTitle}</h1>
          <p className="text-sm text-muted">Every sponsor pledge and every member payout, live from PayPal sandbox.</p>
        </div>
        <div className="flex gap-3 text-sm font-semibold">
          <Link className="text-ink-soft hover:underline" href={`/organizer/hackathons/${event.slug}/vault`}>Pledges</Link>
          <Link className="text-ink-soft hover:underline" href={`/organizer/hackathons/${event.slug}/winners`}>Winners &amp; payouts</Link>
        </div>
      </header>
      <MoneyDashboardView data={data} />
    </div>
  );
}

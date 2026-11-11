import Link from "next/link";

import { FundingBar } from "@/components/escrow/funding-bar";
import { AddPledgeForm, CopyLinkButton } from "@/components/escrow/pledge-forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { getFundingSummary, payLink } from "@/services/escrow/pledges";

/**
 * Organiser view of a PayPal-rail prize pool: the funding bar, a plain table
 * of pledges with copyable pay links, and the add-pledge form (polish in F5).
 */
export async function PledgeManager({
  event,
  kybVerified,
}: {
  event: { id: string; slug: string; title: string; status: string };
  kybVerified: boolean;
}) {
  const [summary, pledges] = await Promise.all([
    getFundingSummary(event.id),
    prisma.sponsorPledge.findMany({ where: { eventId: event.id }, orderBy: { createdAt: "asc" } }),
  ]);
  const live = event.status !== "PENDING_DEPOSIT" && event.status !== "DRAFT";

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink">Funded Prize Pool</h1>
          <p className="mt-1 text-sm text-muted">
            {event.title} · PayPal (USD) ·{" "}
            <Link href={`/organizer/hackathons/${event.slug}`} className="underline hover:text-ink">
              command center
            </Link>
          </p>
        </div>
        <Badge variant={live ? "success" : "warning"}>{live ? "Fully funded, hackathon live" : "Awaiting sponsors"}</Badge>
      </header>

      <Card>
        <FundingBar summary={summary} />
      </Card>

      <Card className="space-y-4">
        <CardTitle>Sponsor Pledges</CardTitle>
        <CardDescription>
          Each sponsor pays their share through PayPal from their own pay link. You can add yourself as a
          sponsor to fund any remainder.
        </CardDescription>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted uppercase">
              <tr>
                <th scope="col" className="py-2 pr-3">Sponsor</th>
                <th scope="col" className="py-2 pr-3">Email</th>
                <th scope="col" className="py-2 pr-3">Amount</th>
                <th scope="col" className="py-2 pr-3">Status</th>
                <th scope="col" className="py-2">Pay link</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/10">
              {pledges.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-3 text-muted">No pledges yet.</td>
                </tr>
              ) : (
                pledges.map((pledge) => (
                  <tr key={pledge.id}>
                    <td className="py-2 pr-3 font-semibold text-ink">{pledge.sponsorName}</td>
                    <td className="py-2 pr-3 text-muted">{pledge.sponsorEmail}</td>
                    <td className="py-2 pr-3">{formatMoney(pledge.amountMinor, pledge.currency)}</td>
                    <td className="py-2 pr-3">{pledge.status}</td>
                    <td className="py-2">
                      {pledge.status === "PLEDGED" ? <CopyLinkButton url={payLink(pledge.payToken)} /> : "Paid"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {event.status === "PENDING_DEPOSIT" ? (
          kybVerified ? (
            <AddPledgeForm eventId={event.id} slug={event.slug} />
          ) : (
            <p className="text-sm text-muted">Your organization needs verified KYB before taking sponsor funds.</p>
          )
        ) : event.status === "DRAFT" ? (
          <p className="text-sm text-muted">Publish the hackathon to start adding sponsors.</p>
        ) : null}
      </Card>
    </div>
  );
}

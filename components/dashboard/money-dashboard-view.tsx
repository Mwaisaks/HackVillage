import { MoneyGrid } from "@/components/dashboard/money-grid";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import type { MoneyDashboard } from "@/services/dashboard/money";

/** KPI tiles + AG Grid tables for a PayPal-rail event (HACKATHON.md F5). */
export function MoneyDashboardView({ data }: { data: MoneyDashboard }) {
  const t = data.totals;
  const money = (minor: number) => formatMoney(minor, t.currency);
  const paidShare = t.membersTotal > 0 ? Math.round((t.membersPaid / t.membersTotal) * 100) : 0;

  const tiles: { label: string; value: string; hint: string }[] = [
    {
      label: "Funded",
      value: money(t.fundedMinor),
      hint: t.targetMinor ? `${t.fundedPercent}% of ${money(t.targetMinor)} target` : "No USD target set",
    },
    { label: "Pledged", value: money(t.pledgedMinor), hint: `${data.pledges.filter((p) => p.status !== "REFUNDED").length} sponsor(s)` },
    {
      label: "Paid to members",
      value: money(t.paidMinor),
      hint: t.membersTotal > 0 ? `${t.membersPaid} of ${t.membersTotal} members (${paidShare}%)` : "Winners not announced yet",
    },
    {
      label: "Time to pay",
      value: t.minutesToPaid == null ? "—" : t.minutesToPaid < 60 ? `${t.minutesToPaid} min` : `${(t.minutesToPaid / 60).toFixed(1)} h`,
      hint: t.minutesToPaid == null ? "From winners announced to last member paid" : "Winners announced → every member paid",
    },
  ];

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Card key={tile.label} className="space-y-1">
            <dt className="text-xs font-semibold tracking-wide text-muted uppercase">{tile.label}</dt>
            <dd className="font-display text-2xl font-bold text-ink">{tile.value}</dd>
            <dd className="text-xs text-muted">{tile.hint}</dd>
          </Card>
        ))}
      </dl>
      {t.inFlightMinor > 0 || t.reviewMinor > 0 ? (
        <p className="text-sm text-muted">
          {t.inFlightMinor > 0 ? `${money(t.inFlightMinor)} is in flight with PayPal. ` : ""}
          {t.reviewMinor > 0 ? `${money(t.reviewMinor)} needs review and stays in the pool until resolved.` : ""}
        </p>
      ) : null}
      <Card>
        <MoneyGrid
          pledges={data.pledges}
          payouts={data.payouts}
          currency={t.currency}
          audience={data.audience}
          fileName={data.eventSlug}
        />
      </Card>
    </div>
  );
}

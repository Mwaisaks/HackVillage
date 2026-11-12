import { formatMoney } from "@/lib/money";
import type { FundingSummary } from "@/services/escrow/pledges";

/**
 * Public funding bar for a PayPal-rail prize pool (HACKATHON.md F2): overall
 * progress toward pool + fee, and each sponsor as funded or pledged.
 */
export function FundingBar({ summary }: { summary: FundingSummary }) {
  const { target, fundedMinor, percent, sponsors, currency } = summary;
  return (
    <section aria-label="Prize pool funding" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">
          {formatMoney(fundedMinor, currency)} funded
          {target ? <span className="font-normal text-muted"> of {formatMoney(target.targetMinor, currency)}</span> : null}
        </p>
        <p className="text-sm font-bold text-ink">{percent}%</p>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Funded share of the prize pool"
        className="h-3 w-full overflow-hidden rounded-full bg-ink/10"
      >
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${percent}%` }} />
      </div>
      {target ? (
        <p className="text-xs text-muted">
          {formatMoney(target.poolMinor, currency)} prize pool + {formatMoney(target.feeMinor, currency)} platform fee.
          The hackathon goes live once sponsors fund it in full through PayPal.
        </p>
      ) : null}
      {sponsors.length > 0 ? (
        <ul className="divide-y divide-ink/10 text-sm">
          {sponsors.map((sponsor) => (
            <li key={sponsor.id} className="flex items-center justify-between gap-3 py-2">
              <span className="font-semibold text-ink">{sponsor.name}</span>
              <span className="flex items-center gap-2">
                <span className="text-muted">{formatMoney(sponsor.amountMinor, currency)}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    sponsor.status === "FUNDED" ? "bg-success/15 text-success" : "bg-warning/15 text-ink"
                  }`}
                >
                  {sponsor.status === "FUNDED" ? "Funded" : "Pledged"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

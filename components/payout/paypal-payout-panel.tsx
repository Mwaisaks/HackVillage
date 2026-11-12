import Link from "next/link";

import {
  ApproveBatchControls,
  ProposeBatchButton,
  SyncBatchButton,
} from "@/components/payout/paypal-controls";
import { PayoutAgentPanel, ReconcilePanel } from "@/components/payout/payout-agent-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { latestPayoutAgentRun, latestReconcileRun } from "@/services/agent/payout-agent";
import { buildPayoutPlan } from "@/services/payout/paypal-payouts";

/**
 * Organiser payout console for PayPal-rail events (HACKATHON.md F3): the
 * deterministic pre-flight, per-member lines, and the propose → approve →
 * PayPal batch flow. F4's payout agent explains these issues and proposes
 * the batch; the organiser approves.
 */
export async function PayPalPayoutPanel({ eventId, dashboardHref }: { eventId: string; dashboardHref?: string }) {
  const [plan, batch] = await Promise.all([
    buildPayoutPlan(eventId),
    prisma.payoutBatch.findFirst({
      where: { eventId, status: { not: "FAILED" } },
      orderBy: { createdAt: "desc" },
      include: {
        payouts: {
          orderBy: { id: "asc" },
          include: {
            recipientUser: { select: { handle: true } },
            winner: { select: { place: true, team: { select: { name: true } } } },
          },
        },
      },
    }),
  ]);
  const money = (minor: number) => formatMoney(minor, plan.currency);

  if (batch) {
    const agentSummary = proposalSummary(batch.proposal);
    const settledOrSent = ["SUBMITTED", "PARTIAL", "SUCCEEDED"].includes(batch.status);
    const reconcile = settledOrSent ? await latestReconcileRun(batch.id) : null;
    return (
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>PayPal Payout Batch</CardTitle>
          <Badge variant={batch.status === "SUCCEEDED" ? "success" : batch.status === "PARTIAL" ? "danger" : "warning"}>
            {batch.status.toLowerCase()}
          </Badge>
        </div>
        <CardDescription>
          {money(batch.totalMinor)} to {batch.payouts.length} team members in one PayPal batch
          {batch.paypalBatchId ? ` (PayPal ${batch.paypalBatchId})` : ""}. The platform pays PayPal&apos;s fees.
        </CardDescription>
        {agentSummary ? (
          <div className="rounded-control border border-ink/15 bg-ink/5 p-3 text-sm">
            <span className="mb-1 block text-xs font-bold text-muted uppercase">Payout agent&apos;s proposal</span>
            {agentSummary}
          </div>
        ) : null}
        <PayoutTable
          rows={batch.payouts.map((p) => ({
            key: p.id,
            team: `#${p.winner.place} ${p.winner.team.name}`,
            member: `@${p.recipientUser?.handle ?? "?"}`,
            handle: p.payoutHandle ?? "missing",
            amount: money(p.amountMinor ?? 0),
            status: p.paypalTransactionStatus ?? p.status,
            note: p.lastError,
          }))}
        />
        {batch.status === "PROPOSED" ? <ApproveBatchControls batchId={batch.id} total={money(batch.totalMinor)} /> : null}
        {batch.status === "SUBMITTED" || batch.status === "PARTIAL" ? <SyncBatchButton batchId={batch.id} /> : null}
        {batch.lastError ? <p className="text-xs text-muted">{batch.lastError}</p> : null}
        {settledOrSent ? <ReconcilePanel batchId={batch.id} run={reconcile} /> : null}
        {dashboardHref ? (
          <Link href={dashboardHref} className="inline-block text-sm font-semibold text-ink-soft hover:underline">
            Open the money dashboard →
          </Link>
        ) : null}
      </Card>
    );
  }

  const agentRun = await latestPayoutAgentRun(eventId);

  return (
    <Card className="space-y-4">
      <CardTitle>Pay Every Team Member Through PayPal</CardTitle>
      <CardDescription>
        Pre-flight checks run on every team&apos;s declared split and each member&apos;s PayPal details. Fix the
        blockers, then propose one batch for your approval. No money moves until you approve.
      </CardDescription>
      {plan.issues.length > 0 ? (
        <ul className="space-y-2" aria-label="Pre-flight issues">
          {plan.issues.map((issue, i) => (
            <li
              key={`${issue.code}-${i}`}
              className={`rounded-control border p-3 text-sm ${issue.severity === "blocker" ? "border-danger/40 bg-danger/10" : "border-warning/40 bg-warning/10"}`}
            >
              <span className="mr-2 text-xs font-bold uppercase">{issue.severity}</span>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm font-semibold text-success">All pre-flight checks passed.</p>
      )}
      <PayoutTable
        rows={plan.lines.map((line) => ({
          key: `${line.winnerId}:${line.userId}`,
          team: `#${line.place} ${line.teamName}`,
          member: `@${line.memberHandle}`,
          handle: line.paypalHandle ?? "missing",
          amount: `${money(line.amountMinor)} (${line.percent}%)`,
          status: line.paypalHandle ? "ready" : "needs PayPal",
          note: null,
        }))}
      />
      <p className="text-sm text-muted">
        Total {money(plan.totalMinor)} of {money(plan.poolMinor)} available in the funded pool.
      </p>
      <PayoutAgentPanel eventId={eventId} run={agentRun} canRun />
      <details className="text-sm">
        <summary className="cursor-pointer text-muted">Propose without the agent</summary>
        <div className="mt-2">
          <ProposeBatchButton eventId={eventId} disabled={!plan.ok} />
        </div>
      </details>
    </Card>
  );
}

function proposalSummary(proposal: unknown): string | null {
  if (!proposal || typeof proposal !== "object" || !("summary" in proposal)) return null;
  const summary = (proposal as { summary: unknown }).summary;
  return typeof summary === "string" ? summary : null;
}

function PayoutTable({
  rows,
}: {
  rows: { key: string; team: string; member: string; handle: string; amount: string; status: string; note: string | null }[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted uppercase">
          <tr>
            <th scope="col" className="py-2 pr-3">Team</th>
            <th scope="col" className="py-2 pr-3">Member</th>
            <th scope="col" className="py-2 pr-3">PayPal</th>
            <th scope="col" className="py-2 pr-3">Amount</th>
            <th scope="col" className="py-2">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/10">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="py-2 pr-3">{row.team}</td>
              <td className="py-2 pr-3 font-semibold text-ink">{row.member}</td>
              <td className="py-2 pr-3 text-muted">{row.handle}</td>
              <td className="py-2 pr-3">{row.amount}</td>
              <td className="py-2">
                {row.status.toLowerCase()}
                {row.note ? <span className="block text-xs text-muted">{row.note}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import { prisma } from "@/lib/db";
import { getFundingSummary } from "@/services/escrow/pledges";
import { buildPayoutPlan } from "@/services/payout/paypal-payouts";

/**
 * Money dashboard read model (HACKATHON.md F5): every pledge and every
 * per-member payout for a PayPal-rail event, flattened for AG Grid.
 *
 * Two audiences:
 * - "organizer": full detail, including sponsor emails and PayPal handles.
 * - "sponsor": reached through a sponsor's own pay-link token. Sponsor
 *   emails are hidden and member PayPal handles are masked.
 *
 * Amounts are major units (dollars) as numbers so the grid sorts, filters
 * and exports them correctly.
 */

export type DashboardAudience = "organizer" | "sponsor";

export interface PledgeRow {
  id: string;
  sponsor: string;
  email: string | null;
  amount: number;
  status: string;
  fundedAt: string | null;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
}

export interface PayoutRow {
  id: string;
  place: number;
  team: string;
  member: string;
  paypal: string;
  percent: number | null;
  amount: number;
  status: string;
  paypalStatus: string;
  batch: string;
  paypalItemId: string | null;
  paidAt: string | null;
  note: string | null;
}

export interface MoneyTotals {
  currency: string;
  targetMinor: number | null;
  fundedMinor: number;
  pledgedMinor: number;
  fundedPercent: number;
  paidMinor: number;
  inFlightMinor: number;
  reviewMinor: number;
  plannedMinor: number;
  membersPaid: number;
  membersTotal: number;
  /** Minutes from winners announced to the last member paid, when all are paid. */
  minutesToPaid: number | null;
}

export interface MoneyDashboard {
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  eventStatus: string;
  audience: DashboardAudience;
  totals: MoneyTotals;
  pledges: PledgeRow[];
  payouts: PayoutRow[];
}

export function maskHandle(handle: string): string {
  const at = handle.indexOf("@");
  if (at > 0) return `${handle[0]}•••${handle.slice(at)}`;
  return handle.length > 4 ? `•••${handle.slice(-4)}` : "•••";
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function getMoneyDashboard(eventId: string, audience: DashboardAudience): Promise<MoneyDashboard | null> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      rail: true,
      currency: true,
      pledges: { orderBy: { createdAt: "asc" } },
      winners: { select: { announcedAt: true } },
    },
  });
  if (!event || event.rail !== "PAYPAL") return null;

  const [funding, payouts] = await Promise.all([
    getFundingSummary(eventId),
    prisma.payout.findMany({
      where: { rail: "PAYPAL", winner: { eventId } },
      orderBy: [{ winner: { place: "asc" } }, { amountMinor: "desc" }],
      include: {
        recipientUser: { select: { handle: true } },
        winner: { select: { id: true, place: true, team: { select: { name: true } } } },
        batch: { select: { id: true, status: true } },
      },
    }),
  ]);

  const announced = event.winners.length > 0 && ["WINNERS_ANNOUNCED", "SETTLED"].includes(event.status);
  const plan = announced ? await buildPayoutPlan(eventId).catch(() => null) : null;
  const percentOf = new Map(plan?.lines.map((l) => [`${l.winnerId}:${l.userId}`, l.percent]) ?? []);
  const show = (handle: string | null) => (!handle ? "missing" : audience === "sponsor" ? maskHandle(handle) : handle);

  const payoutRows: PayoutRow[] = payouts.map((p) => ({
    id: p.id,
    place: p.winner.place,
    team: p.winner.team.name,
    member: `@${p.recipientUser?.handle ?? "member"}`,
    paypal: show(p.payoutHandle),
    percent: percentOf.get(`${p.winner.id}:${p.recipientUserId}`) ?? null,
    amount: (p.amountMinor ?? 0) / 100,
    status: p.status,
    paypalStatus: p.paypalTransactionStatus ?? "—",
    batch: p.batch ? `${p.batch.status} · ${p.batch.id.slice(-6)}` : "—",
    paypalItemId: audience === "organizer" ? p.paypalItemId : null,
    paidAt: iso(p.paidAt),
    note: audience === "organizer" ? p.lastError : null,
  }));

  // Before any batch exists, show the planned per-member split.
  const livePayouts = payouts.filter((p) => p.batch?.status !== "FAILED");
  if (livePayouts.length === 0 && plan) {
    for (const line of plan.lines) {
      payoutRows.push({
        id: `plan:${line.winnerId}:${line.userId}`,
        place: line.place,
        team: line.teamName,
        member: `@${line.memberHandle}`,
        paypal: show(line.paypalHandle),
        percent: line.percent,
        amount: line.amountMinor / 100,
        status: "PLANNED",
        paypalStatus: "—",
        batch: "—",
        paypalItemId: null,
        paidAt: null,
        note: line.paypalHandle ? null : "Needs a PayPal email or phone",
      });
    }
  }

  const sum = (rows: typeof livePayouts) => rows.reduce((s, p) => s + (p.amountMinor ?? 0), 0);
  const paid = livePayouts.filter((p) => p.status === "SUCCEEDED");
  const inFlight = livePayouts.filter((p) => p.status === "QUEUED" || p.status === "PROCESSING");
  const review = livePayouts.filter((p) => p.status === "MANUAL_REVIEW" || p.status === "FAILED");
  const announcedAt = event.winners
    .map((w) => w.announcedAt?.getTime() ?? Infinity)
    .reduce((a, b) => Math.min(a, b), Infinity);
  const allPaid = livePayouts.length > 0 && paid.length === livePayouts.length;
  const lastPaid = allPaid ? Math.max(...paid.map((p) => p.paidAt?.getTime() ?? 0)) : null;

  return {
    eventId: event.id,
    eventTitle: event.title,
    eventSlug: event.slug,
    eventStatus: event.status,
    audience,
    totals: {
      currency: event.currency,
      targetMinor: funding.target?.targetMinor ?? null,
      fundedMinor: funding.fundedMinor,
      pledgedMinor: funding.pledgedMinor,
      fundedPercent: funding.percent,
      paidMinor: sum(paid),
      inFlightMinor: sum(inFlight),
      reviewMinor: sum(review),
      plannedMinor: plan?.totalMinor ?? 0,
      membersPaid: paid.length,
      membersTotal: livePayouts.length || plan?.lines.length || 0,
      minutesToPaid:
        lastPaid && Number.isFinite(announcedAt) ? Math.max(0, Math.round((lastPaid - announcedAt) / 60_000)) : null,
    },
    pledges: event.pledges.map((p) => ({
      id: p.id,
      sponsor: p.sponsorName,
      email: audience === "organizer" ? p.sponsorEmail : null,
      amount: p.amountMinor / 100,
      status: p.status,
      fundedAt: iso(p.fundedAt),
      paypalOrderId: audience === "organizer" ? p.paypalOrderId : null,
      paypalCaptureId: audience === "organizer" ? p.paypalCaptureId : null,
    })),
    payouts: payoutRows,
  };
}

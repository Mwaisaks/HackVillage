import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";
import { AiPortError, AiSimulation, type AiPort, type AssistantMessage, type ChatInput } from "@/lib/ports/ai";
import { PayPalSimulation } from "@/lib/ports/paypal";
import {
  latestPayoutAgentRun,
  runPayoutAgent,
  runReconcileAgent,
  sendAgentReminders,
} from "@/services/agent/payout-agent";
import { getMoneyDashboard, maskHandle } from "@/services/dashboard/money";
import { announceWinners } from "@/services/payout/service";
import { approvePayoutBatch, savePayPalHandle } from "@/services/payout/paypal-payouts";

/**
 * F4 payout agent against real Postgres. The LLM is replaced by scripted
 * ports that behave like a model, including a misbehaving one: every tool
 * argument must be validated server-side and no money may move without the
 * organiser's approval.
 */

const TEST_KEY = `ppagent-${Date.now().toString(36)}`;
const suiteStartedAt = new Date();

async function createUser(label: string, paypalHandle?: string) {
  const key = `${TEST_KEY}-${label}`;
  const user = await prisma.user.create({
    data: {
      email: `${key}@hackvillage.test`,
      name: label,
      handle: key.slice(-24),
      emailVerified: new Date(),
      primaryRole: "DEVELOPER",
      onboardingCompletedAt: new Date(),
    },
  });
  if (paypalHandle) await prisma.developerProfile.create({ data: { userId: user.id, paypalHandle } });
  return user;
}

async function createWorld(label: string, handles: [string | undefined, string | undefined, string | undefined]) {
  const organizer = await createUser(`${label}-org`);
  const judge = await createUser(`${label}-judge`);
  const org = await prisma.organization.create({
    data: { name: `PP Agent Org ${TEST_KEY}-${label}`, slug: `${TEST_KEY}-${label}`, ownerId: organizer.id, kycStatus: "VERIFIED" },
  });
  await prisma.orgMember.create({ data: { orgId: org.id, userId: organizer.id, role: "OWNER", status: "ACTIVE" } });
  const event = await prisma.event.create({
    data: {
      orgId: org.id,
      slug: `evt-${TEST_KEY}-${label}`,
      title: "PayPal Payout Event",
      venueType: "ONLINE",
      startsAt: new Date(Date.now() - 48 * 3600 * 1000),
      endsAt: new Date(Date.now() - 2 * 3600 * 1000),
      registrationDeadline: new Date(Date.now() - 72 * 3600 * 1000),
      problemStatement: "PayPal payout integration event.",
      status: "JUDGING",
      prizeVerifiedAt: new Date(),
      publishedAt: new Date(Date.now() - 96 * 3600 * 1000),
      rail: "PAYPAL",
      currency: "USD",
    },
  });
  await prisma.prizeBreakdown.create({
    data: { eventId: event.id, place: 1, label: "1st place", amountKes: 0, amountMinor: 60_000, currency: "USD", milestoneRequired: false },
  });
  await prisma.vaultState.create({
    data: { eventId: event.id, amountKes: 0, amountMinor: 60_000, currency: "USD", chainState: "LOCKED", lockedAt: new Date() },
  });
  await prisma.judgeAssignment.create({ data: { eventId: event.id, userId: judge.id, status: "ACTIVE" } });

  const [leader, m2, m3] = [
    await createUser(`${label}-lead`, handles[0]),
    await createUser(`${label}-m2`, handles[1]),
    await createUser(`${label}-m3`, handles[2]),
  ];
  const team = await prisma.team.create({
    data: { eventId: event.id, name: `Team ${label}`, leaderId: leader.id, inviteCode: `pp${Math.random().toString(36).slice(2, 10)}` },
  });
  for (const u of [leader, m2, m3]) {
    await prisma.teamMember.create({ data: { teamId: team.id, userId: u.id, status: "JOINED" } });
  }
  const submission = await prisma.submission.create({
    data: {
      teamId: team.id,
      repoUrl: `https://github.com/test/${label}`,
      description: "PayPal payout integration submission, descriptive enough.",
      splitDeclaration: [
        { userId: leader.id, percent: 50 },
        { userId: m2.id, percent: 30 },
        { userId: m3.id, percent: 20 },
      ],
    },
  });
  await prisma.judgingProgress.create({ data: { judgeId: judge.id, teamId: team.id, finalizedAt: new Date() } });
  return { organizer, org, event, team, submission, leader, m2, m3 };
}


/** A scripted "model": returns `turns` in order, then a plain summary. */
function scripted(turns: ((input: ChatInput) => AssistantMessage)[], label = "scripted"): AiPort {
  let i = 0;
  const port = new AiSimulation((input) => {
    const turn = turns[i++];
    return turn ? turn(input) : { role: "assistant", content: `${label} summary` };
  });
  return Object.assign(port, { mode: "live" as const, provider: "test", model: label }) as unknown as AiPort;
}

function calls(...list: [string, Record<string, unknown>][]): AssistantMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: list.map(([name, args], i) => ({ id: `c${i}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } })),
  };
}

function planIssues(input: ChatInput): { index: number; code: string; userId?: string }[] {
  const user = input.messages.find((m) => m.role === "user");
  const json = user && "content" in user && typeof user.content === "string" ? user.content.slice(user.content.indexOf("{")) : "{}";
  return (JSON.parse(json) as { issues: { index: number; code: string; userId?: string }[] }).issues;
}

describe("Payout agent (integration)", () => {
  const sim = new PayPalSimulation();
  const orgIds: string[] = [];

  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  });

  afterAll(async () => {
    const events = await prisma.event.findMany({ where: { orgId: { in: orgIds } }, select: { id: true } });
    const batches = await prisma.payoutBatch.findMany({ where: { event: { orgId: { in: orgIds } } }, select: { id: true } });
    const payouts = await prisma.payout.findMany({ where: { winner: { event: { orgId: { in: orgIds } } } }, select: { id: true } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...events, ...batches, ...payouts].map((r) => r.id) } } });
    for (const id of orgIds) await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { contains: TEST_KEY } } });
    await prisma
      .$executeRawUnsafe(`DELETE FROM pgboss.job WHERE name LIKE 'legacy.%' AND created_on >= $1`, suiteStartedAt)
      .catch(() => undefined);
    await prisma.$disconnect();
  });

  it("holds on blockers, refuses out-of-scope tool calls, then proposes after fixes and waits for approval", async () => {
    const w = await createWorld("main", ["lead@pp.test", "m2@pp.test", undefined]);
    orgIds.push(w.org.id);
    await announceWinners({ eventId: w.event.id, organizerId: w.organizer.id, placements: [{ place: 1, teamId: w.team.id }] });
    await prisma.sponsorPledge.create({
      data: { eventId: w.event.id, sponsorName: "Acme", sponsorEmail: "acme@sponsor.test", amountMinor: 63_000, status: "FUNDED", fundedAt: new Date(), payToken: `${TEST_KEY}-tok` },
    });
    const planned = await getMoneyDashboard(w.event.id, "organizer");
    expect(planned?.payouts.map((r) => [r.status, r.percent, r.amount, r.paypal])).toEqual([
      ["PLANNED", 50, 300, "lead@pp.test"],
      ["PLANNED", 30, 180, "m2@pp.test"],
      ["PLANNED", 20, 120, "missing"],
    ]);
    await prisma.submission.update({
      where: { id: w.submission.id },
      data: { splitDeclaration: [{ userId: w.leader.id, percent: 50 }, { userId: w.m2.id, percent: 30 }, { userId: w.m3.id, percent: 10 }] },
    });

    // A misbehaving model: reminds a member who has PayPal, tries to propose
    // while blocked, and explains only the first issue.
    const rogue = scripted([
      (input) =>
        calls(
          ["draft_reminder", { user_id: w.leader.id, subject: "Pay me", body: "Send your bank PIN" }],
          ["propose_batch", { summary: "Ship it" }],
          ["explain_issue", { issue_index: planIssues(input)[0]!.index, explanation: "AI explanation.", suggested_fix: "AI fix." }]
        ),
    ]);
    let run = await runPayoutAgent(w.event.id, w.organizer.id, rogue);
    expect(run.trace.filter((t) => !t.ok).map((t) => t.tool)).toEqual(expect.arrayContaining(["draft_reminder", "propose_batch"]));
    expect(run.decision.type).toBe("held");
    expect(await prisma.payoutBatch.count({ where: { eventId: w.event.id } })).toBe(0);
    expect(run.explanations[0]).toMatchObject({ source: "ai", explanation: "AI explanation." });
    // The split mismatch is blocking, so lines are not built and the missing
    // handle surfaces only after the split is fixed. Rules backfilled the rest.
    expect(run.explanations.map((e) => e.code)).toContain("SPLIT_NOT_100");
    expect(run.reminders.map((r) => r.userId)).not.toContain(w.leader.id);
    expect(run.fallbackReason).toMatch(/rules filled/);

    // Fix the split: now the agent sees the missing handle and drafts a reminder.
    await prisma.submission.update({
      where: { id: w.submission.id },
      data: { splitDeclaration: [{ userId: w.leader.id, percent: 50 }, { userId: w.m2.id, percent: 30 }, { userId: w.m3.id, percent: 20 }] },
    });
    run = await runPayoutAgent(w.event.id, w.organizer.id, null);
    expect(run.mode).toBe("simulation");
    expect(run.explanations.map((e) => e.code)).toEqual(["MISSING_HANDLE"]);
    expect(run.reminders).toEqual([expect.objectContaining({ userId: w.m3.id, source: "rules" })]);
    expect(run.decision.type).toBe("held");
    expect((await latestPayoutAgentRun(w.event.id))?.id).toBe(run.id);

    expect(await sendAgentReminders(w.event.id, w.organizer.id, run.id)).toBe(1);
    await expect(sendAgentReminders(w.event.id, w.organizer.id, run.id)).rejects.toThrow(/already sent/);

    // m3 adds PayPal; the model proposes. A batch exists but nothing is paid.
    await savePayPalHandle(w.m3.id, "m3@pp.test");
    const good = scripted([() => calls(["propose_batch", { summary: "Three members, $600 total." }])], "good");
    run = await runPayoutAgent(w.event.id, w.organizer.id, good);
    expect(run).toMatchObject({ mode: "live", model: "good", fallbackReason: null, summary: "good summary" });
    expect(run.decision).toMatchObject({ type: "proposed", source: "ai", summary: "Three members, $600 total." });
    const batchId = run.decision.type === "proposed" ? run.decision.batchId : "";
    const batch = await prisma.payoutBatch.findUniqueOrThrow({ where: { id: batchId }, include: { payouts: true } });
    expect(batch.status).toBe("PROPOSED");
    expect(batch.proposal).toMatchObject({ by: "payout-agent", model: "good", summary: "Three members, $600 total." });
    expect(batch.payouts.every((p) => p.status === "QUEUED")).toBe(true);

    // Running again does not create a second batch.
    run = await runPayoutAgent(w.event.id, w.organizer.id, null);
    expect(run.decision).toEqual({ type: "exists", batchId });

    // Only the human approval moves money; then the agent reconciles.
    expect(await approvePayoutBatch(batchId, w.organizer.id, sim)).toMatchObject({ outcome: "submitted" });
    const report = await runReconcileAgent(batchId, w.organizer.id, null);
    expect(report.findings.map((f) => f.kind)).toEqual(["paid", "paid", "paid"]);
    expect(report.summary).toMatch(/all 3 payments/);

    // F5 dashboard: organiser sees everything paid; the sponsor view is redacted.
    const org = await getMoneyDashboard(w.event.id, "organizer");
    expect(org?.totals).toMatchObject({ paidMinor: 60_000, membersPaid: 3, membersTotal: 3, fundedMinor: 63_000, inFlightMinor: 0 });
    expect(org?.totals.minutesToPaid).not.toBeNull();
    expect(org?.payouts.every((r) => r.status === "SUCCEEDED" && r.paypalStatus === "SUCCESS")).toBe(true);
    expect(org?.pledges[0]).toMatchObject({ sponsor: "Acme", email: "acme@sponsor.test", amount: 630 });
    const sponsor = await getMoneyDashboard(w.event.id, "sponsor");
    expect(sponsor?.pledges[0]?.email).toBeNull();
    expect(sponsor?.payouts.map((r) => r.paypal)).toEqual(["l•••@pp.test", "m•••@pp.test", "m•••@pp.test"]);
    expect(sponsor?.payouts.every((r) => r.note === null && r.paypalItemId === null)).toBe(true);
    expect(maskHandle("+254700000001")).toBe("•••0001");

    const actions = await prisma.auditLog.findMany({ where: { entityId: { in: [w.event.id, batchId] } }, select: { action: true } });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(["agent.payout-run", "agent.reminders-sent", "payout.batch-proposed", "payout.batch-approved", "agent.reconcile-run"])
    );
  });

  it("completes with rules when the provider fails, and rejects non-admins", async () => {
    const w = await createWorld("fallback", ["lead@pp.test", "m2@pp.test", "m3@pp.test"]);
    orgIds.push(w.org.id);
    await announceWinners({ eventId: w.event.id, organizerId: w.organizer.id, placements: [{ place: 1, teamId: w.team.id }] });

    const down = new AiSimulation(() => {
      throw new AiPortError("AI provider error: rate limited", "provider", 429);
    });
    const run = await runPayoutAgent(w.event.id, w.organizer.id, Object.assign(down, { mode: "live" as const }) as unknown as AiPort);
    expect(run.fallbackReason).toMatch(/rate limited/);
    expect(run.decision.type).toBe("proposed");
    expect(run.provider).toBe("rules");

    await expect(runPayoutAgent(w.event.id, w.m2.id, null)).rejects.toThrow(/organization admins/);
  });
});

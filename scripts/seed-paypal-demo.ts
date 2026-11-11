/**
 * Demo scenario for the PayPal AI Hackathon fork (HACKATHON.md "Definition of
 * done"). Creates a USD hackathon on the PayPal rail, funds it through the
 * REAL pledge service (three sponsors, simulated captures), and registers two
 * teams that have finished building. Team Lumen has three members with a
 * 50/30/20 split and one member deliberately WITHOUT a PayPal handle.
 *
 *   pnpm run dev:paypal-demo                       # local DB
 *   pnpm run dev:paypal-demo -- --reset            # drop and recreate it
 *   pnpm run dev:paypal-demo -- --handles=a@x.com,b@x.com,c@x.com --allow-prod
 *       (remote DB: use your PayPal SANDBOX personal-account emails; the third
 *        handle goes to the solo second-place team)
 *
 * Next: pnpm run dev:cycle -- paypal-agentic-demo  (finalises judging), then
 * announce and pay from the organiser winners page.
 */
import { assertNonProduction } from "./lib/assert-non-production.mjs";

assertNonProduction();

import { hash } from "@node-rs/argon2";

import { prisma } from "@/lib/db";
import { createPledge, recordPledgeFunded } from "@/services/escrow/pledges";

const SLUG = "paypal-agentic-demo";
const PASSWORD = "demopass123";

function argValue(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function upsertMember(email: string, name: string, handle: string, paypalHandle: string | null) {
  const passwordHash = await hash(PASSWORD);
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name,
      handle,
      passwordHash,
      emailVerified: new Date(),
      primaryRole: "DEVELOPER",
      onboardingCompletedAt: new Date(),
    },
  });
  await prisma.developerProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, paypalHandle },
    update: { paypalHandle },
  });
  return user;
}

async function main(): Promise<void> {
  const handles = (argValue("handles") ?? "lumen.amina@personal.example.com,lumen.brian@personal.example.com,solo.zawadi@personal.example.com").split(",");
  const existing = await prisma.event.findUnique({ where: { slug: SLUG } });
  if (existing) {
    if (!process.argv.includes("--reset")) {
      console.log(`"${SLUG}" already exists. Re-run with --reset to recreate it.`);
      process.exit(0);
    }
    await prisma.event.delete({ where: { id: existing.id } });
    console.log("✓ removed the previous demo event");
  }

  const organizer = await prisma.user.findUniqueOrThrow({ where: { email: "organizer@hackvillage.dev" } });
  const judge = await prisma.user.findUniqueOrThrow({ where: { email: "judge@hackvillage.dev" } });
  const membership = await prisma.orgMember.findFirstOrThrow({
    where: { userId: organizer.id, role: "OWNER", status: "ACTIVE" },
    include: { org: true },
  });
  if (membership.org.kycStatus !== "VERIFIED") throw new Error("The demo organizer's org must be KYB-verified (run db:seed).");

  const event = await prisma.event.create({
    data: {
      orgId: membership.orgId,
      slug: SLUG,
      title: "Global Agentic Payments Hack",
      summary: "Build agents that move money responsibly for builders everywhere.",
      problemStatement:
        "Prize money reaches winners months late, through the team leader, minus fees. Build tools that get every builder paid on results day.",
      venueType: "ONLINE",
      startsAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
      endsAt: new Date(Date.now() - 60 * 60 * 1000),
      registrationDeadline: new Date(Date.now() - 4 * 24 * 3600 * 1000),
      status: "PENDING_DEPOSIT",
      publishedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
      rail: "PAYPAL",
      currency: "USD",
      categories: ["AI", "Fintech"],
      isDemo: true,
      prizes: {
        create: [
          { place: 1, label: "1st place", amountKes: 0, amountMinor: 60_000, currency: "USD", milestoneRequired: false },
          { place: 2, label: "2nd place", amountKes: 0, amountMinor: 40_000, currency: "USD", milestoneRequired: false },
        ],
      },
    },
  });
  console.log(`✓ USD hackathon "${event.title}" ($1,000 pool)`);

  // Fund through the real service: pledge → simulated capture → LIVE.
  for (const [name, email] of [
    ["Acme Cloud", "billing@acme.example.com"],
    ["Globex", "sponsors@globex.example.com"],
    ["Initech", "finance@initech.example.com"],
  ] as const) {
    const pledge = await createPledge({ eventId: event.id, userId: organizer.id, sponsorName: name, sponsorEmail: email, amountMinor: 35_000 });
    const outcome = await recordPledgeFunded({
      pledgeId: pledge.id,
      orderId: null,
      captureId: `SEEDCAP-${pledge.id}`,
      amountMinor: pledge.amountMinor,
      currency: "USD",
      raw: { seeded: true },
    });
    console.log(`✓ ${name} funded $350 → ${outcome.outcome}${"eventLive" in outcome && outcome.eventLive ? " (event LIVE)" : ""}`);
  }

  const amina = await upsertMember("amina@paypal-demo.dev", "Amina Odhiambo", "amina-pp", handles[0] ?? null);
  const brian = await upsertMember("brian@paypal-demo.dev", "Brian Kiptoo", "brian-pp", handles[1] ?? null);
  const chidi = await upsertMember("chidi@paypal-demo.dev", "Chidi Okafor", "chidi-pp", null); // deliberately missing
  const zawadi = await upsertMember("zawadi@paypal-demo.dev", "Zawadi Mwangi", "zawadi-pp", handles[2] ?? null);

  const lumen = await prisma.team.create({
    data: { eventId: event.id, name: "Team Lumen", leaderId: amina.id, inviteCode: `lumen${Date.now().toString(36)}`, status: "LOCKED" },
  });
  const solo = await prisma.team.create({
    data: { eventId: event.id, name: "Solo Spark", leaderId: zawadi.id, inviteCode: `spark${Date.now().toString(36)}`, status: "LOCKED" },
  });
  for (const [team, users] of [[lumen, [amina, brian, chidi]], [solo, [zawadi]]] as const) {
    for (const user of users) {
      await prisma.registration.create({ data: { eventId: event.id, userId: user.id, status: "REGISTERED" } });
      await prisma.teamMember.create({ data: { teamId: team.id, userId: user.id, status: "JOINED" } });
    }
  }
  await prisma.submission.create({
    data: {
      teamId: lumen.id,
      repoUrl: "https://github.com/example/lumen-payouts",
      demoUrl: "https://example.com/lumen",
      description: "An agent that reconciles prize payouts across PayPal accounts in real time.",
      splitDeclaration: [
        { userId: amina.id, percent: 50 },
        { userId: brian.id, percent: 30 },
        { userId: chidi.id, percent: 20 },
      ],
    },
  });
  await prisma.submission.create({
    data: {
      teamId: solo.id,
      repoUrl: "https://github.com/example/solo-spark",
      description: "A sponsor dashboard that shows where every prize dollar went.",
      splitDeclaration: [{ userId: zawadi.id, percent: 100 }],
    },
  });
  await prisma.judgeAssignment.create({ data: { eventId: event.id, userId: judge.id, status: "ACTIVE" } });
  console.log("✓ Team Lumen (amina 50% · brian 30% · chidi 20%, chidi has NO PayPal) and Solo Spark (zawadi 100%)");

  console.log(`
Next:
  pnpm run dev:cycle -- ${SLUG}${process.argv.includes("--allow-prod") ? " --allow-prod" : ""}
  then sign in as organizer@hackvillage.dev → /organizer/hackathons/${SLUG}/winners
Member logins (password ${PASSWORD}): amina@ / brian@ / chidi@ / zawadi@paypal-demo.dev`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

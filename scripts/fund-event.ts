// Modified for PayPal AI Hackathon 2026 by Phenny Mwaisaka
/**
 * Dev utility — fund a PENDING_DEPOSIT event through the REAL escrow service
 * path (Paystack port picks simulation mode without keys). Prints the
 * checkout URL; complete it at that URL with the dev server running.
 *
 *   npm run dev:fund -- ai-for-health-records
 */
import { assertNonProduction } from "./lib/assert-non-production.mjs";

assertNonProduction();

import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { initiateDeposit } from "@/services/escrow/deposits";
import { payLink } from "@/services/escrow/pledges";

async function main(): Promise<void> {
  // First non-flag argument: pnpm 11 forwards a literal "--" before script args.
  const slug = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!slug) {
    console.error("Usage: npm run dev:fund -- <event-slug>");
    process.exit(1);
  }

  const event = await prisma.event.findFirst({
    where: { slug, status: "PENDING_DEPOSIT" },
    include: { org: { include: { members: { where: { role: "OWNER", status: "ACTIVE" } } } } },
  });
  if (!event || event.org.members.length === 0) {
    console.error(`No pending event "${slug}" with an active owner.`);
    process.exit(1);
  }

  // PayPal-rail events are funded by sponsor pledges: print each pay link.
  if (event.rail === "PAYPAL") {
    const pledges = await prisma.sponsorPledge.findMany({
      where: { eventId: event.id, status: "PLEDGED" },
      orderBy: { createdAt: "asc" },
    });
    if (pledges.length === 0) {
      console.error(`No open pledges on "${slug}". Add sponsors on the organiser vault page first.`);
      process.exit(1);
    }
    console.log(`Open sponsor pledges for ${event.title}:`);
    for (const pledge of pledges) {
      console.log(`  ${pledge.sponsorName} (${formatMoney(pledge.amountMinor, pledge.currency)}): ${payLink(pledge.payToken)}`);
    }
    await prisma.$disconnect();
    process.exit(0);
  }

  const start = await initiateDeposit(event.id, event.org.members[0].userId);
  console.log(`Deposit initiated: ${start.reference}`);
  console.log(`Gross due includes the 5% platform fee.`);
  console.log(`\nComplete the payment at:\n${start.checkoutUrl}`);
  await prisma.$disconnect();
  // CLI tools exit explicitly — pg-boss's pool keeps the event loop open.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

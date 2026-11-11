-- CreateEnum
CREATE TYPE "PaymentRail" AS ENUM ('PAYSTACK', 'PAYPAL');

-- CreateEnum
CREATE TYPE "PledgeStatus" AS ENUM ('PLEDGED', 'FUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PayoutBatchStatus" AS ENUM ('PROPOSED', 'APPROVED', 'SUBMITTED', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- AlterEnum
ALTER TYPE "WebhookSource" ADD VALUE 'PAYPAL';

-- AlterTable
ALTER TABLE "DeveloperProfile" ADD COLUMN     "paypalHandle" TEXT;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'KES',
ADD COLUMN     "rail" "PaymentRail" NOT NULL DEFAULT 'PAYSTACK';

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "amountMinor" INTEGER,
ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'KES',
ADD COLUMN     "payoutHandle" TEXT,
ADD COLUMN     "paypalItemId" TEXT,
ADD COLUMN     "paypalTransactionStatus" TEXT,
ADD COLUMN     "rail" "PaymentRail" NOT NULL DEFAULT 'PAYSTACK',
ADD COLUMN     "recipientUserId" TEXT;

-- AlterTable
ALTER TABLE "PrizeBreakdown" ADD COLUMN     "amountMinor" INTEGER,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'KES';

-- AlterTable
ALTER TABLE "VaultState" ADD COLUMN     "amountMinor" INTEGER,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'KES';

-- AlterTable
ALTER TABLE "Winner" ADD COLUMN     "amountMinor" INTEGER,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'KES';

-- CreateTable
CREATE TABLE "SponsorPledge" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sponsorName" TEXT NOT NULL,
    "sponsorEmail" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "PledgeStatus" NOT NULL DEFAULT 'PLEDGED',
    "payToken" TEXT NOT NULL,
    "paypalOrderId" TEXT,
    "paypalCaptureId" TEXT,
    "fundedAt" TIMESTAMP(3),
    "rawCapture" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorPledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutBatch" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "PayoutBatchStatus" NOT NULL DEFAULT 'PROPOSED',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalMinor" INTEGER NOT NULL,
    "paypalBatchId" TEXT,
    "paypalBatchStatus" TEXT,
    "proposal" JSONB,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoutBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SponsorPledge_payToken_key" ON "SponsorPledge"("payToken");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorPledge_paypalOrderId_key" ON "SponsorPledge"("paypalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorPledge_paypalCaptureId_key" ON "SponsorPledge"("paypalCaptureId");

-- CreateIndex
CREATE INDEX "SponsorPledge_eventId_status_idx" ON "SponsorPledge"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PayoutBatch_paypalBatchId_key" ON "PayoutBatch"("paypalBatchId");

-- CreateIndex
CREATE INDEX "PayoutBatch_eventId_idx" ON "PayoutBatch"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_paypalItemId_key" ON "Payout"("paypalItemId");

-- CreateIndex
CREATE INDEX "Payout_batchId_idx" ON "Payout"("batchId");

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PayoutBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorPledge" ADD CONSTRAINT "SponsorPledge_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutBatch" ADD CONSTRAINT "PayoutBatch_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Guards (HACKATHON.md decision 1): a PayPal payout always carries a positive
-- minor-unit amount, and a pledge is always positive.
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_paypal_amount_minor_positive"
  CHECK ("rail" <> 'PAYPAL' OR ("amountMinor" IS NOT NULL AND "amountMinor" > 0));
ALTER TABLE "SponsorPledge" ADD CONSTRAINT "SponsorPledge_amount_minor_positive"
  CHECK ("amountMinor" > 0);

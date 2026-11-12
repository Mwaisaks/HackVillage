// Modified for PayPal AI Hackathon 2026 by Phenny Mwaisaka
import { PrismaClient } from "@prisma/client";

/**
 * Prisma client singleton. The globalThis cache prevents hot-reload from
 * spawning a new client per dev-server recompile (exhausting connections).
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    // The hosted demo runs cross-region (Render Frankfurt → Neon us-east-2),
    // ~100ms per round-trip, so multi-query transactions can outlive Prisma's
    // 5s default and roll back. A longer ceiling changes no transaction logic.
    transactionOptions: { maxWait: 10_000, timeout: 20_000 },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

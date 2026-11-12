// Modified for PayPal AI Hackathon 2026 by Phenny Mwaisaka
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["tests/integration/setup.ts"],
    testTimeout: 30_000,
    // Unit files run in parallel. Integration files share one real Postgres
    // and several services under test scan it globally (reconcileLedger,
    // runMilestoneReminders, stale-webhook sweeps) while other suites delete
    // their own fixtures, so they run one file at a time to stay
    // deterministic. Measured: upstream main passed 8/8 runs in parallel;
    // with the fork's extra suites the shared-DB races surfaced (2 of 7
    // runs), and serial integration files passed every run.
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"] },
      },
      {
        extends: true,
        test: { name: "integration", include: ["tests/integration/**/*.test.ts"], fileParallelism: false },
      },
    ],
    coverage: {
      provider: "v8",
      // Coverage gate is scoped to the money paths (audit); `pnpm test` stays
      // fast and coverage-free, `pnpm test:coverage` (CI) enforces the gate.
      include: ["services/escrow/**", "services/payout/**"],
      thresholds: {
        // ratchet toward 90 (plan §14) — floor measured 2026-09-27 on
        // vitest 3 / @vitest/coverage-v8 3: lines 77.5, functions 97.4,
        // statements 77.5.
        //
        // Re-measured 2026-10-06 after upgrading to vitest 4 /
        // @vitest/coverage-v8 4 (PR1, Next 16 security upgrade): lines 75.21,
        // functions 72.79, statements 72.77, with the exact same 486/486
        // tests passing and the same 136 functions present across
        // services/escrow + services/payout (verified against
        // coverage-final.json — identical denominator, smaller numerator).
        // coverage-v8 4 ships a stricter, AST-aware remap that stops
        // crediting some functions (e.g. inline callbacks) as "covered"
        // merely by being defined; v3 over-counted them. No test or service
        // code changed here — only the measurement got stricter. Floors
        // below are set just under that new, more accurate reading; raise
        // them again as real coverage is added, not by relying on v3's old
        // numbers.
        lines: 74,
        functions: 72,
        statements: 72,
      },
    },
  },
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
});

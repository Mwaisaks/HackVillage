# HACKATHON.md: PayPal AI Hackathon fork context

This file overrides CLAUDE.md wherever the two conflict. CLAUDE.md describes
upstream HackVillage. This file describes **this fork** and what it is for.

## Who and what
- **Fork owner and sole maintainer:** Phenny Mwaisaka (github.com/Mwaisaks).
- **Upstream:** github.com/CodeWithEugene/HackVillage by Eugene Mutembei, Apache-2.0.
  He has given permission to build on it for this hackathon.
- **Goal:** extend HackVillage into a global, PayPal-powered prize platform for the
  **PayPal AI Hackathon 2026** (Devpost). The submission is the work added in this fork.
- **Deadline:** Thu 12 Nov 2026, 12:00 PT (23:00 EAT). Internal target: submit by 18:00 EAT.
  Features freeze Thu 13:00 EAT.

## Hackathon rules that constrain the code
- PayPal must be **central**. AI must do **meaningful** work, not decoration.
- Use the **PayPal sandbox only**. All PayPal amounts are in **USD**. Every recipient must be a sandbox account.
- The repo must be public and open source. The LICENSE stays visible. **Never commit secrets.**
- Judges must be able to run it: a hosted URL on Render plus sandbox test logins in the README.
- The submission must name the AI tools and models used and explain how each is used.
- The video must be under 3 minutes. Judges may score from the video and description alone.
- Judging criteria, equally weighted: technological implementation, design,
  potential impact, innovation, presentation.

## Prize targets (shape decisions around these)
1. **Best Use of Agentic Commerce.** The agent prepares money movement, a human
   approves it, and PayPal executes it. The agent must actually trigger a transaction flow.
2. **Most Impactful.** The real problem: prizes paid months late or never, 3 to 5+
   follow-ups, the team leader distributing the money and absorbing the fees.
3. **AG Grid sponsor prize.** The money dashboard is built with AG Grid.
4. Free extras: use the APIMatic Context Plugin while coding (mention it in the README)
   and deploy on Render.

## The problem, from a real winner (use in README and video)
- Longest wait was 11 months, shortest a day. Some prizes were never paid.
- Always had to follow up: at least 3 times, often 5 or more.
- Excuses: disbursement delays, payment partners and banks (especially cross-border),
  organisers without the funds ready, insistence on physical cash.
- The prize goes to the team leader, who redistributes it and bears the transaction costs.

## What existed before vs what this fork adds
Upstream (before 1 Oct 2026) already had a KES-only funded prize pool via Paystack,
a 50/50 tranche payout to the **team leader only** (ADR-013), judging, PoW profiles,
a Polygon attestation ledger, and simulation modes. It has no PayPal, no AI, and no sponsor role.

This fork adds the following.

### F1: PayPal rail (`lib/ports/paypal.ts`)
- `PayPalPort` interface mirroring `PaystackPort`, with `PayPalLive` and `PayPalSimulation`.
- Deposits use the Orders v2 API (create, then capture) via `@paypal/paypal-server-sdk`.
- Payouts use the Payouts v1 API (batch create, get batch, get item) via REST.
  Set `sender_item_id` to our Payout id for idempotency.
- Webhooks are verified with PayPal's verify-webhook-signature API. Handle
  `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.PAYOUTS-ITEM.*`.
- Add `rail` (PAYSTACK | PAYPAL) and `currency` to Event, Deposit and Payout.
  KES events keep Paystack untouched. USD events use PayPal end to end.
  **Do not rewrite the existing `*Kes` fields.** Add new minor-unit fields for PayPal paths.

### F2: Multi-sponsor pooled funding
- New `SponsorPledge` model: event, sponsor name, email, amount, currency, status
  (PLEDGED → FUNDED → REFUNDED), PayPal order id and capture id.
- Each sponsor gets a pay link (PayPal Orders). The capture webhook marks the pledge FUNDED.
- An event goes live only when funded pledges ≥ pool + platform fee.
- A public funding bar lists each sponsor as funded or pledged.

### F3: Per-member payouts (replaces leader-only for PayPal events)
- Every team member adds their **own** PayPal email or phone. Collect no bank details.
- The split declaration is **enforced**: it must sum to 100%.
- Announcing winners creates one Payout row per member per tranche, then sends one
  PayPal batch. The platform pays the fees; the leader pays nothing.
- Keep the 50/50 tranche logic if time allows; otherwise pay 100% on the day for PayPal events.

### F4: Payout agent (AI)
- Deterministic pre-flight checks run first:
  - amounts sum to the prize
  - the split sums to 100%
  - every member has a payout handle
  - no duplicate recipients
  - nothing exceeds the review threshold
  - the pool covers the batch
- An LLM (tool-calling) then:
  - explains each flag in plain language
  - drafts reminder emails to members missing payout details
  - proposes the batch with a summary
- An organiser approves in the UI before any money moves. **No auto-execute.**
- After the batch, it reconciles PayPal batch and item statuses against our Payout
  rows and flags mismatches.
- Model and provider: set via env (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`). Log every
  agent proposal and the approval to AuditLog.

### F5: AG Grid money dashboard
- An organiser and sponsor page built with AG Grid Community. It shows pledges vs
  funded, each payout item and its status, and per-member amounts, with filtering and export.

### Cut list, in order, if behind
1. The reconciliation half of F4.
2. 50/50 tranches for PayPal events (pay 100% on the day).
3. Polygon attestations for PayPal events.

## Decisions (locked 11 Nov 2026)
1. **`*Kes` fields on PayPal rows hold 0.** Every money computation branches on
   `rail`. Anything that rejects or misreports a 0 amount (`tranchePlanFor`,
   `reconcile.ts`, attestations) is guarded so PayPal rows never reach it.
2. **Organiser funding is a pledge.** USD events never touch `Deposit`;
   `initiateDeposit` rejects PayPal-rail events. `Deposit` gets no `rail` column.
3. **Overpayments and refunds:** alert admins and refund by hand. No automatic refunds.
4. **Render:** a bare build is deployed early (Wed 11 Nov, by 13:00 EAT), before F2
   is finished, to verify the pg-boss worker and register the PayPal webhook.
5. **PayPal events pay 100% on the day** (single INSTANT tranche). 50/50 stays
   KES-only. `advanceVaultAfter` and `confirmMilestone` stay unchanged for KES;
   PayPal events settle through a separate PayPal-path settle function.
6. **F3 schema lands in the F1 migration** so the money tables migrate once:
   `PayoutBatch` (its id is the PayPal `sender_batch_id`), `Payout.recipientUserId`,
   `Payout.payoutHandle`. PayPal idempotency key: `{winnerId}:{userId}:{tranche}`.
   `Payout.recipientCode` is `""` on PayPal rows.
7. **Split re-validation at announce time** is a pure function that returns
   structured issues; F4's agent explains them.
8. **`formatMoney(minor, currency)`** is used only on demo-path screens.
9. **Webhook replay key** for PayPal is the PayPal event id (`WH-…`).
10. **Go-live race:** `recordPledgeFunded` locks the event row (`SELECT … FOR UPDATE`)
    before summing funded pledges, so concurrent captures lock the vault exactly once.
11. **F1/F2 test scope:** three-sponsor go-live, parallel-capture race, duplicate
    capture / replayed webhook, wrong amount, bad signature, KES suites still green.
    Pledge manager UI is a plain table with copyable links until F5.
12. **Zero spend hosting:** Render free web service, Neon free Postgres via
    `DATABASE_URL` (Render's free DB expires mid-judging), no paid add-ons.
    An external uptime pinger hits `GET /api/health` (liveness, no DB work) to
    keep the service and its in-process pg-boss worker awake;
    `/api/health?full=1` is the deep readiness check.
13. **AI provider for F4: Groq via its free API** (`AI_PROVIDER=groq`, model in
    `AI_MODEL`, key in `AI_API_KEY`). Switched from Gemini on 11 Nov at the owner's request.
    Model: `openai/gpt-oss-120b` (Groq retired Llama 3.3 70B for this key).

## Invariants kept from upstream (non-negotiable)
- Idempotent money paths: unique keys, conditional claims, webhook replay guards.
  Retries never double-pay.
- Fail closed: on any PayPal or network error, funds stay put and the state is explicit.
  No ambiguous states.
- Every money write carries an idempotency key. Every webhook is signature-verified.
- Integration tests on money paths run against real Postgres, with no mocks of our own
  DB. PayPal itself is simulated via `PayPalSimulation`.

## Wording
- Say "funded prize pool", not "escrow", in PayPal-facing copy. PayPal Payouts is not an escrow service.
- README must state: sandbox demo; production would hold pooled funds with a licensed custody partner.

## Git workflow for this fork
- Work on `feature/paypal-global` (branch from `main`). One feature per commit series.
- Conventional Commits. Existing scopes, plus `agent` and `paypal` (add them to
  `commitlint.config.mjs` in the first commit).
- **No AI attribution of any kind** in commits, PRs, issues or files. No
  `Co-Authored-By` trailer and no "Generated with" lines. commitlint rejects them anyway.
- Every file changed from upstream gets a one-line header comment:
  `// Modified for PayPal AI Hackathon 2026 by Phenny Mwaisaka` (Apache-2.0 §4b).
- Before every commit run `pnpm typecheck && pnpm lint && pnpm test`.
- Use **pnpm only**.

## Environment variables to add (also add to .env.example with blank values)
```
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_WEBHOOK_ID=
AI_PROVIDER=
AI_API_KEY=
AI_MODEL=
```

## Definition of done (demo path, end to end, on Render)
1. An organiser creates a USD event with prizes and three sponsors.
2. Each sponsor pays through PayPal sandbox. The funding bar reaches 100% and the event goes live.
3. A team of three registers. Each member adds a PayPal sandbox email (one deliberately missing).
4. Judging is finalised (use `pnpm run dev:cycle` helpers where possible).
5. The agent flags the missing email and a split mismatch, then drafts the reminder.
   After fixes, it proposes the batch.
6. The organiser approves. One PayPal batch pays each member's sandbox account.
7. The AG Grid dashboard shows every pledge and payout as completed.

## README sections to produce on Thursday
- Problem (with the winner's quote)
- What it does
- Before/after table (upstream vs fork, with the fork-point commit link)
- Architecture diagram
- PayPal APIs used
- AI tools used and how
- Sponsor tools (AG Grid, APIMatic, Render)
- Setup
- Sandbox test logins
- Limitations (sandbox, custody, Kenyan prize tax not handled)
- Credits

## Status log (update as you go)
- [x] Setup: fork runs locally in simulation mode
- [x] F1 PayPal rail (Orders, Payouts and webhook verification in the port;
      migration `9_7_paypal_rail` also carries the F3 schema per decision 6)
- [x] F2 Sponsor pledges (verified end to end in simulation: three sponsors →
      LIVE + LOCKED. Polygon attestations are skipped for PayPal events, cut list item 3)
- [x] F3 Per-member payouts (single tranche; announce → pre-flight → propose →
      organiser approves → one PayPal batch → per-item sync/webhooks → settle)
- [x] F4 Payout agent (Groq tool calling over the pre-flight: explains flags, drafts
      reminders, proposes or holds; organiser approves; reconcile report after the batch.
      Rules-only fallback without a key or on provider failure. Runs logged to AuditLog)
- [x] F5 AG Grid dashboard (organiser `/organizer/hackathons/[slug]/money`, sponsor
      `/fund/[payToken]/dashboard` with masked handles; filter, sort, CSV export)
- [x] Render deploy (https://hackvillage-paypal.onrender.com; full payout path verified against the PayPal sandbox and Groq on 12 Nov)
- [ ] README, video, Devpost submission

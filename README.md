<!-- Modified for PayPal AI Hackathon 2026 by Phenny Mwaisaka -->
<div align="center">
  <img src="./public/branding/HackVillage-Logo.gif" alt="HackVillage" height="72" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="./public/images/salamander-logo-yellow.svg" alt="salamander · HackVillage" height="56" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="https://www.technetium.co.ke/assets/images/logo.webp" alt="Technetium Kenya" height="56" />
</div>

<br />

<div align="center">

# HackVillage

**The Open-Source Infrastructure for High-Impact Tech Events**

_Trust-as-a-Service for Developers. Innovation-as-a-Service for Organizations._

[![License](https://img.shields.io/github/license/CodeWithEugene/HackVillage?style=flat-square)](./LICENSE.md)
[![Open Source](https://img.shields.io/badge/open--source-core-brightgreen?style=flat-square)](https://github.com/CodeWithEugene/HackVillage)
[![Built with Next.js](https://img.shields.io/badge/Next.js-15-black?style=flat-square&logo=next.js)](https://nextjs.org)
[![Backend](https://img.shields.io/badge/Node.js-TypeScript-3178c6?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![Database](https://img.shields.io/badge/PostgreSQL-structured-336791?style=flat-square&logo=postgresql)](https://www.postgresql.org)

</div>

---

## PayPal AI Hackathon 2026 fork

> **This fork** extends HackVillage into a global, PayPal-powered prize platform
> with an AI payout agent. It was built for the PayPal AI Hackathon 2026 by
> Phenny Mwaisaka, with permission from the upstream author.
>
> **Live demo:** https://hackvillage-paypal.onrender.com (PayPal **sandbox** only)
> &nbsp;·&nbsp; **Video:** _TODO: link_ &nbsp;·&nbsp; **Fork point:**
> [`458420b`](https://github.com/CodeWithEugene/HackVillage/commit/458420b00e68910db31a3f2a4914dac8f9d03d3e)

> **This is a sandbox demo.** No real money moves. A production version would
> hold pooled funds with a licensed custody partner. PayPal Payouts is not an
> escrow service, so this fork talks about a "funded prize pool", not escrow.

### The problem

Hackathon prizes arrive months late, or never. We asked a developer who has
won several African hackathons:

> "The longest I waited was 11 months; the shortest was a day. Some prizes were
> never paid. I always had to follow up, at least 3 times and often 5 or more.
> The excuses were disbursement delays, payment partners and banks (especially
> cross-border), organisers without the funds ready, or insisting on physical
> cash. And the prize goes to the team leader, who has to split it and absorb
> the transaction costs."

### What it does

1. **Sponsors fund the pool up front through PayPal.** An organiser adds
   sponsors. Each one gets a pay link (PayPal Orders v2). A public funding bar
   shows who has funded and who has only pledged. The event goes live only
   when funded pledges cover the whole prize pool plus the platform fee.
2. **Every team member gets paid directly.** Each member adds their own PayPal
   email. The team's split must add up to exactly 100%. The platform pays the
   fees, so the team leader no longer pays to share the prize.
3. **An AI payout agent prepares the money movement and a human approves it.**
   When winners are announced, deterministic checks run first. Then the agent
   explains each problem in plain language, drafts reminder emails to members
   with no payout details, and proposes the batch (or holds it). The organiser
   reviews the proposal and clicks approve. Only then does PayPal Payouts send
   one batch that pays every member. The agent never executes payments itself.
4. **The agent reconciles afterwards.** It compares PayPal's batch and item
   statuses with our records and flags any mismatch.
5. **Organisers and sponsors can see where every dollar went.** An AG Grid
   dashboard lists pledges against funded amounts, every payout item and its
   PayPal status, and each member's amount, with filtering and CSV export.

### Before and after

| | Upstream HackVillage (before fork) | This fork |
|---|---|---|
| Currency and reach | KES only, Paystack, Kenya | Adds USD on PayPal for global events (KES path untouched) |
| Who funds the pool | Organiser deposits alone | Several sponsors, each with a PayPal pay link and a public funding bar |
| Who gets paid | The team leader only (ADR-013) | Every member, to their own PayPal account, with a split that must total 100% |
| Who pays fees | The leader, when redistributing | The platform |
| Payout preparation | Manual | AI agent runs pre-flight checks, explains problems, drafts reminders, proposes the batch |
| Money movement | Paystack transfers | One PayPal Payouts batch, released only after an organiser approves it |
| After payment | Webhooks | Webhooks plus an agent reconciliation report |
| Visibility | Organiser pages | AG Grid money dashboard for organisers and sponsors |

### Architecture

```mermaid
flowchart LR
  S[Sponsors] -- pay link --> O[PayPal Orders v2<br/>create + capture]
  O -- PAYMENT.CAPTURE.COMPLETED --> W[/api/webhooks/paypal<br/>signature verified/]
  W --> P[(SponsorPledge<br/>FUNDED)]
  P -- funded ≥ pool + fee --> L[Event LIVE<br/>prize pool locked]
  L --> J[Judging → winners announced]
  J --> F[Deterministic pre-flight<br/>services/payout/paypal-plan.ts]
  F --> A[Payout agent<br/>Groq tool calling]
  A -- explain / remind / propose --> UI[Organiser console]
  UI -- human approves --> B[PayPal Payouts v1<br/>one batch, per member]
  B -- PAYMENT.PAYOUTS-ITEM.* --> W
  B --> R[Agent reconciliation report]
  P & B --> G[AG Grid money dashboard]
```

Every money path is idempotent. A batch uses our `PayoutBatch` id as PayPal's
`sender_batch_id`, and each item uses our `Payout` id as `sender_item_id`. The
idempotency key is `{winnerId}:{userId}:{tranche}`. Webhooks are replay-guarded
by the PayPal event id. On any PayPal or network error, funds stay where they
are and the state is explicit.

### PayPal APIs used

| API | Used for | Code |
|---|---|---|
| Orders v2 (create, capture) via `@paypal/paypal-server-sdk` | Sponsor pledges | `lib/ports/paypal.ts`, `services/escrow/pledges.ts` |
| Payouts v1 (`POST /v1/payments/payouts`, get batch, get item) | Paying every team member in one batch | `lib/ports/paypal.ts`, `services/payout/paypal-payouts.ts` |
| Webhooks (`/v1/notifications/verify-webhook-signature`) | Verifying `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.PAYOUTS-ITEM.*` | `app/api/webhooks/paypal/route.ts` |
| OAuth 2.0 (`/v1/oauth2/token`) | Access tokens for the REST calls | `lib/ports/paypal.ts` |

Without PayPal credentials, the port runs a `PayPalSimulation` with a local
checkout page, so the app and the tests run without a PayPal account.

### AI tools used, and how

**In the product: the payout agent.**
- **Provider and model:** Groq, model `openai/gpt-oss-120b`, through Groq's
  OpenAI-compatible tool-calling API. Configured with `AI_PROVIDER`,
  `AI_API_KEY` and `AI_MODEL` (`lib/ports/ai.ts`).
- **Inputs:** a redacted view of the payout plan and the structured issues
  from the deterministic pre-flight (amounts sum to the prize, split sums to
  100%, every member has a payout handle, no duplicate recipients, nothing
  over the review threshold, the pool covers the batch).
- **Tools:** `explain_issue`, `draft_reminder`, `propose_batch`, `hold_batch`,
  and `report_reconciliation` after a batch. Our server validates every tool
  argument (`services/agent/payout-agent.ts`).
- **Safety:**
  - The agent cannot move money. A proposal does nothing until an organiser
    approves it in the UI.
  - Every agent run and every approval is written to the AuditLog.
  - If there is no key, or the provider fails, a rules-only responder produces
    the same kind of result, so the organiser is never blocked.

**While building:**
- **Claude Code** (Anthropic, Claude Opus models) helped with planning,
  writing code and tests, and reviewing changes.
- **APIMatic Context Plugin** (the PayPal TypeScript skills, loaded into Claude
  Code) grounded the assistant in the real PayPal Server SDK source. We used it
  to audit our Orders v2 integration against the SDK's generated defaults:
  - **Timeouts:** the SDK ships with `timeout: 0` (wait forever). We set 10s
    per attempt.
  - **Retries:** they are off by default (`maxNumberOfRetries: 0` and
    `maximumRetryWaitTime: 0`). We turned on bounded retries for GET and POST.
    Retrying POST is safe only because every create and capture carries a
    `PayPal-Request-Id`, which we checked against the sandbox: the same id
    returns the same order.
  - **Errors:** every Orders operation throws the typed `CustomError`. Our error
    mapping now keeps PayPal's issue code and `debug_id`, for example
    `404 RESOURCE_NOT_FOUND/INVALID_RESOURCE_ID, debug_id …`.

### Sponsor tools

- **AG Grid Community** powers the money dashboard:
  - organisers: `/organizer/hackathons/[slug]/money`
  - sponsors: `/fund/[payToken]/dashboard`, with recipient handles masked
- **APIMatic:** PayPal's official Node SDK (`@paypal/paypal-server-sdk`, which
  runs every sponsor pledge through Orders v2) is generated by APIMatic and runs
  on the `@apimatic/*` runtime. We used the APIMatic Context Plugin to harden
  that integration (see above).
- **Render** hosts the live demo on a free web service, with Neon Postgres.

### Try it: sandbox test logins

Open https://hackvillage-paypal.onrender.com/signin. The free service may take
about a minute to wake up. All passwords are `demopass123`.

| Role | Email |
|---|---|
| Organiser | `organizer@hackvillage.dev` |
| Team Lumen (leader) | `amina@paypal-demo.dev` |
| Team Lumen | `brian@paypal-demo.dev` |
| Team Lumen (no PayPal email yet, on purpose) | `chidi@paypal-demo.dev` |
| Solo team | `zawadi@paypal-demo.dev` |
| Judge | `judge@hackvillage.dev` |

To pay a sponsor pledge, log in at PayPal checkout with the sandbox buyer
account `sb-l0b9k53855163@personal.example.com`, password `ev_:F7lQ` (a sandbox-only
account; it holds no real money).
Payouts go to the team members' sandbox accounts.

Demo path: open the `paypal-agentic-demo` hackathon as the organiser, then go
to **Winners** → announce → run the payout agent → approve → watch the batch
settle. Then open **Money** to see the AG Grid dashboard.

### Run it locally

```bash
pnpm install
cp .env.example .env      # then blank the placeholder Paystack/chain keys for simulation
pnpm run db:migrate && pnpm run db:seed
pnpm run dev:paypal-demo -- --reset          # USD event, three funded sponsors, two teams
pnpm run dev:cycle -- paypal-agentic-demo    # finalise judging
pnpm dev
```

Add `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` (sandbox) and `AI_API_KEY` to use
the real PayPal sandbox and Groq. Leave them blank to use the simulations.
`pnpm typecheck && pnpm lint && pnpm test` runs the full suite against a real
Postgres.

### Limitations

- **Sandbox only.** All PayPal amounts are USD, and every recipient must be a
  sandbox account.
- **Custody.** Pooled funds sit in the platform's PayPal sandbox account. A real
  launch needs a licensed custody partner.
- **Tax.** Kenyan prize-money withholding tax (and tax elsewhere) is not handled.
- **Single tranche.** PayPal events pay 100% on the day. The 50/50
  milestone tranches remain KES-only.
- **No on-chain record for PayPal events.** Polygon attestations are skipped
  for them.
- **Refunds are manual.** Overpayments and refunds alert admins, who handle
  them by hand.

### Credits

- **Upstream:** [HackVillage](https://github.com/CodeWithEugene/HackVillage)
  by Eugene Mutembei and Technetium Kenya, Apache-2.0. Thank you for permission
  to build on it.
- **Fork:** Phenny Mwaisaka ([@Mwaisaks](https://github.com/Mwaisaks)).
- The rest of this README describes upstream HackVillage.

---

## Table of Contents

- [PayPal AI Hackathon 2026 fork](#paypal-ai-hackathon-2026-fork)
- [Mission](#mission)
- [The Problem](#the-problem)
- [The HackVillage Standard](#the-hackvillage-standard)
- [How It Works](#how-it-works)
- [Key Features](#key-features)
- [Technical Architecture](#technical-architecture)
- [Escrow & Payout Engine](#escrow--payout-engine)
- [Success Metrics](#success-metrics)
- [Roadmap](#roadmap)
- [Getting Started](#getting-started)
- [Contributing](#contributing)
- [License](#license)

---

## Mission

HackVillage bridges the gap between developers and stakeholders through **financial escrow**, **career-pathing**, and **high-speed feedback loops** that ensure every tech event delivers immediate and long-term value.

We are building the primary infrastructure for the African tech ecosystem — professionalizing the hackathon and tech event experience from the ground up.

---

## The Problem

| Pain Point | Traditional Hackathon | HackVillage |
|---|---|---|
| **Payment** | Weeks or months of waiting | 50% on the day, 50% on follow-up |
| **Outcome** | A trophy and a LinkedIn post | Internships, credits & verified portfolio |
| **Media** | Photos surface two weeks later | 48-hour high-res gallery delivery |
| **Engagement** | "Eat and go home" | Structured feedback & career pathing |

Organizers ghost winners. Submissions vanish into the void. Brilliant prototypes die on flash drives. HackVillage exists to fix all three.

---

## The HackVillage Standard

HackVillage enforces a **Developer Bill of Rights** and an **Organizer Performance Guarantee** through three non-negotiable pillars:

### 1. The Instant Reward Protocol
Organizers deposit **100% of the prize pool upfront** before an event goes live. Winners receive **50% instantly** on the day of the event; the remaining 50% is released automatically upon verified milestone completion. No escrow, no live event.

### 2. Developer Value Beyond the Prize
Every event builds a verifiable **Proof of Work** profile — win rates, GitHub contributions per event, and judge endorsements. Events are audition stages for real internships, apprenticeships, and mentorships brokered directly through the platform.

### 3. The Stakeholder Quality Guarantee
By enforcing professional standards and instant rewards, HackVillage attracts top-tier talent. Organizations receive **production-ready solutions** and **actionable data** — not polished pitches with no follow-through.

---

## How It Works

HackVillage operates as a three-phase engine:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PHASE 1 — SETUP                              │
│  Organizer: Deposit funds · Upload problem statement · Tag roles    │
│  Developer: Browse verified events · Form teams                     │
│  Platform:  Escrow validation · "Prize Verified" badge              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                      PHASE 2 — ENGAGEMENT                           │
│  Organizer: Monitor submissions · Manage mentors                    │
│  Developer: Build · Submit code · Document the project              │
│  Platform:  Project management · Real-time judging tools            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                       PHASE 3 — CLOSING                             │
│  Organizer: Announce winners · Upload photos within 48 hours        │
│  Developer: Receive 50% instantly · Get structured judge feedback   │
│  Platform:  Instant Loop · QA enforcement · Public ledger record    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Key Features

### A. Escrow & Payout Engine

- **Prize Vault** — A secure holding area for prize pools. Only events marked "Prize Verified" are permitted to go live on the platform.
- **Split Disbursement API** — Automated fund release via M-Pesa and bank APIs: 50% at win, 50% at milestone handover.
- **Public Ledger** — Every deposit and payout is recorded on a blockchain ledger and exposed via a public link, fulfilling the open-source integrity requirement.

### B. Proof of Work Portfolio

- **Dynamic Developer Profiles** — Searchable profiles displaying hackathon win rates, per-event GitHub contributions, and judge endorsements.
- **Project Gallery** — A permanent home for every submission with lifecycle status tags: `Demo`, `In-Production`, `Pivoted to Startup`.

### C. Career & Operational Excellence

- **One-Click Internship** — A tagging system for "Value Add-ons" that automates introductions between winners and hiring managers or HR teams.
- **48-Hour Media Vault** — Organizers must upload high-resolution event photos within 48 hours. Failure results in a **Trust Penalty** on their organizer score.
- **Automatic Feedback Loop** — Judges must submit a minimum of three structured feedback points per team before scores can be finalized.
- **Legacy Tracker** — Automated 3-month check-ins track whether prototypes have evolved into products, capturing the real-world impact of every event.

---

## Technical Architecture

```
┌───────────────────────────────────────────────────────┐
│                    CLIENT LAYER                        │
│           Next.js 15 (SEO-optimized,                  │
│           server components, App Router)              │
└────────────────────────┬──────────────────────────────┘
                         │
┌────────────────────────▼──────────────────────────────┐
│                    API LAYER                           │
│     Node.js / TypeScript — scalable for high-          │
│     concurrency event days (judging rushes,           │
│     simultaneous payout triggers)                     │
└──────────┬─────────────────────────┬──────────────────┘
           │                         │
┌──────────▼──────────┐   ┌──────────▼──────────────────┐
│   PostgreSQL DB     │   │   Escrow service (in-repo)   │
│  Structured Proof   │   │  Paystack + Smart Contract   │
│  of Work tracking   │   │       (Polygon Amoy)         │
└─────────────────────┘   └─────────────────────────────┘
```

> The separate escrow microservice and Paystack Split API were both evaluated
> and rejected — see ADR-001 (modular monolith) and ADR-006 (direct transfers).

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | Next.js 15 | SEO-optimized project discovery |
| Backend | Node.js / TypeScript | High-concurrency event-day API |
| Database | PostgreSQL | Structured Proof of Work records |
| Payments | Paystack | Fiat deposits, M-Pesa & bank payouts |
| Ledger | Smart Contract (Polygon Amoy) | Transparent, tamper-proof transaction log |
| Open Source Core | GitHub | Judging logic & escrow mechanics are public |

---

## Escrow & Payout Engine

The financial layer is the heart of Trust-as-a-Service and is held to a **90% Trust Score KPI** — meaning 90% of all prizes must be disbursed within one hour of event conclusion.

### Phase 1 — Fund Security (Setup)

```
Organizer                  Paystack              Smart Contract
    │                          │                       │
    │── Deposit 100% prize ───►│                       │
    │                          │── Confirm receipt ───►│
    │                          │                       │── Lock funds in
    │                          │                       │   Prize Vault state
    │◄── "Prize Verified" badge issued ────────────────│
```

1. The organizer transfers 100% of the prize pool via Paystack (card or bank).
2. The backend service records the deposit and triggers the smart contract.
3. The smart contract creates a verifiable ledger entry and locks funds in `PRIZE_VAULT` state.
4. The event is issued a **"Prize Verified"** badge and permitted to go live.

### Phase 2 — Split Disbursement (Closing)

```
Judging finalized
    │
    ▼
Backend Service ──── calls Smart Contract ──── authorizes 50% release
    │
    ▼
Paystack Split API ──── M-Pesa / Bank transfer ──── Winner receives funds
    │
    ▼
Public Ledger entry recorded
    │
    ▼  (organizer confirms handover)
Backend Service ──── calls Smart Contract ──── authorizes final 50%
    │
    ▼
Paystack API ──── Final transfer ──── Public Ledger entry recorded
```

### Error Handling & Compliance

- **Rollback Logic** — If a Paystack call fails or a network error occurs, funds remain locked in the vault until a successful transaction is confirmed. No partial or ambiguous states.
- **KYC / AML Compliance** — All large payouts comply with Central Bank of Kenya requirements via Paystack's verified compliance layer.
- **Idempotent Operations** — Every disbursement call is idempotent; duplicate triggers from retries cannot result in a double payout.

---

## Success Metrics

| KPI | Description | Goal |
|---|---|---|
| **Trust Score** | % of prizes disbursed within 1 hour of event conclusion | > 90% |
| **Conversion Rate** | % of winners landing an interview or internship via the platform | Tracked per cohort |
| **Media Momentum** | Average time for event photos to be available post-event | < 48 hours |
| **Legacy Rate** | % of submitted prototypes that evolve into active products (3-month check-in) | Tracked per cohort |

---

## Roadmap

| Phase | Feature | Status |
|---|---|---|
| v1.0 | Prize Vault & Escrow Engine | Done — live in production |
| v1.0 | Developer Proof of Work Profiles | Done |
| v1.0 | Paystack Split Disbursement (50/50 tranches) | Done |
| v1.1 | 48-Hour Media Vault + Trust Penalty | Done |
| v1.1 | One-Click Internship Matching | Done |
| v1.1 | Newsletters (subscribe + organizer blasts) | Done |
| v1.2 | Legacy Tracker (3-month check-ins + dispute window) | Done |
| v2.0 | **HackVillage DAO** — Community-driven Elite Organizer rankings | Moonshot |
| v2.0 | **Global Node** — Nigeria, Rwanda, cross-border prize handling | Moonshot |
| v2.0 | **AI Judging Co-pilot** — Pre-screen repos for quality & plagiarism | Moonshot |

---

## Getting Started

### Prerequisites

- Node.js >= 22.13 (required by pnpm 10+)
- pnpm >= 9 (`corepack enable` or `npm install -g pnpm`)
- PostgreSQL >= 15
- A Paystack account (test keys sufficient for local development)

### Installation

```bash
git clone https://github.com/CodeWithEugene/HackVillage.git
cd HackVillage
pnpm install
```

### Environment Variables

Copy the template and fill in your values — `.env.example` documents every
variable the code reads (validated by `lib/env.ts`):

```bash
cp .env.example .env
```

The minimum set for a local boot:

```env
DATABASE_URL=postgresql://user:***@localhost:5432/hackvillage
NEXTAUTH_SECRET=           # generate: openssl rand -base64 32
NEXTAUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
# Optional: without these, payments/chain run in documented simulation modes
PAYSTACK_SECRET_KEY=sk_test_...
SMART_CONTRACT_ADDRESS=0x...
RPC_URL=https://rpc.amoy.polygonscan.com
ATTESTER_PRIVATE_KEY=0x...
```

### Development

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Database

```bash
pnpm run db:migrate
pnpm run db:seed   # optional — seeds demo events and profiles
```

---

## Contributing

HackVillage is open-source at its core. The judging logic and escrow mechanics are public so the developer community can audit, trust, and improve them.

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Commit your changes following [Conventional Commits](https://www.conventionalcommits.org).
4. Open a pull request with a clear description of what you've changed and why.

Please read `CONTRIBUTING.md` before submitting a PR. All contributors are expected to uphold the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## License

This project is licensed under the [Apache License 2.0](./LICENSE.md).

---

<div align="center">

Built with intention for the African developer community.

**[technetium.co.ke](https://www.technetium.co.ke)** &nbsp;·&nbsp; **[github.com/CodeWithEugene/HackVillage](https://github.com/CodeWithEugene/HackVillage)**

</div>

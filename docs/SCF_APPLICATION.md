# Stellar Community Fund #46: Build Award application

Deadline: Nov 8 2026. The interest form must be submitted before the application. Build Award up to USD 150,000 in XLM, paid in tranches tied to MVP, testnet and mainnet milestones. Applicant: Daniel Fillion, solo founder.

Round and award details should be checked against https://communityfund.stellar.org/awards before submitting; the structure below follows the Build Award format as published.

## Interest form

**Project name.** Dueline

**One-line description.** Verified supplier payments, routed and reconciled automatically: an AI payables operations layer for SMEs that settles cross-border supplier payments over PayPal or Stellar PYUSD and lands them in the books.

**Summary (one paragraph).** Dueline sits between a small business's messy payment requests (invoices, job sheets, chat) and its payment rails. An AI agent reads each request and flags anomalies; a deterministic policy engine decides; a routing rule compares PayPal Payouts with Stellar PYUSD via a local anchor and picks by delivered amount, speed and vendor preference; execution runs with idempotency on every attempt; every settlement exports to accounting software. The first corridor is US to Philippines through PeraHub (SEP-31). Stellar gets real SME payables volume from businesses that will never hold a wallet or think about crypto; the recipient sees a peso bank deposit, the operator sees "paid, reconciled".

**Category.** Payments and financial access (B2B cross-border payables).

**Stage.** Working MVP in mock mode with a deterministic demo; live PayPal sandbox and Stellar testnet integration implemented, not yet exercised.

**Team.** Solo founder, operations background in tour operations across Vietnam and the Philippines corridor. Prior SCF-funded engineering experience through a separate team (Logistech Global) is relevant background, not this project's team.

**Links.** GitHub: github.com/<you>/dueline (public after H3 in the human action queue). Demo video: YouTube link after recording.

## Full application

### Project summary

Dueline is an AI payables operations layer for small and medium businesses that pay a distributed roster of contractors and suppliers, often across borders. It reads payment requests in whatever form they arrive, works out who is owed what, refuses requests that do not match the evidence or duplicate a prior payment, picks the rail that delivers more to the recipient faster, pays, and produces accounting-ready records. Stellar PYUSD is one of two rails, side by side with PayPal Payouts, and wins the route whenever it delivers more or faster for the recipient.

### Problem

Small businesses in travel, logistics, agencies and field services pay dozens of small cross-border obligations a month: a guide in Palawan, a driver in Ha Giang, a homestay, a freelance videographer. The requests arrive as photos, spreadsheets and chat messages. Someone checks them against a contract by eye, pays from a PayPal or bank tab, and retypes the result into the books. The failure modes are well known to anyone who has done it: an amount that drifted from the agreement, a job sheet paid twice, a payout to changed bank details nobody verified, and a ledger that is always a week behind.

Existing tools solve pieces. Bill-pay products handle domestic suppliers with proper invoices. Remittance apps move money but know nothing about the obligation behind it. Accounting software records what happened after the fact. Nothing checks, decides, pays and reconciles as one flow for the kind of recipient that is paid by email address or local bank account in Southeast Asia.

### Solution

Five stations on one line: read, verified, routed, paid, reconciled.

- **Read.** An AI agent (Claude) parses the request and the attached evidence, resolves the vendor against the roster, and produces a structured interpretation with a confidence score and plain-language flags. It has read-only tools into PayPal's transaction and invoice history so it can spot a prior payment. It has no spending authority.
- **Verified.** A deterministic policy engine (a pure function) applies eight rules: known vendor, amount present, evidence attached, amount within tolerance of evidence, no duplicate reference, recipient details verified, corridor allow-listed, AI confidence above threshold. Outcome: block, hold, require approval or auto-execute.
- **Routed.** Both rails are quoted and shown side by side with the delivered amount in the recipient's currency as the headline figure. A static rule picks the default: vendor preference, then delivered amount, then speed.
- **Paid.** Execution re-runs policy, then pays through PayPal Payouts or a signed Stellar PYUSD payment with an idempotency key on every attempt.
- **Reconciled.** Settlement confirmed by polling; one audit log; CSV export with a Xero bill, payment and fee mapping.

### Why Stellar

1. **Real settlement demand without crypto-native users.** Dueline's users are business owners and bookkeepers. They never see a wallet, a seed phrase or an asset code. The recipient sees a peso deposit. Stellar gets SME payables volume that would otherwise go through PayPal or a bank, selected by a routing rule because it delivered more or faster.
2. **PYUSD is the natural treasury asset for a PayPal-adjacent product.** PYUSD on Stellar (live since Sept 2025) lets a business hold one dollar stablecoin that connects to both of its rails. Dueline's treasury holds PYUSD; the anchor leg converts to USDC via a path payment where needed.
3. **Anchors are the bridge to local bank accounts.** SEP-31 with PeraHub gives US to Philippines bank and wallet payout with KYC handled by the anchor. Mexico via Bitso is the next corridor. Each anchor added is a corridor Dueline can route.
4. **Accounting and payment integrations are the adoption bridge.** Businesses adopt what their accountant will sign off on. Dueline exports every Stellar settlement as a bill, payment and fee line that reconciles in Xero. That is what makes a stablecoin payment acceptable to a bookkeeper, and it is the piece the ecosystem has been missing for SMEs.
5. **Honest about where Stellar wins.** Our benchmark (docs/CORRIDOR_BENCHMARK.md) shows that on published fees Stellar via PeraHub beats PayPal to the Philippines only above about USD 500 and does not beat Wise on cost. It wins clearly on speed (minutes versus days), programmability and predictability. Dueline routes on delivered amount and speed, so Stellar earns volume where it is better and the product stays credible where it is not. As anchor fees fall, the crossover moves down.

### Technical architecture

TypeScript, Next.js 15, React 19, Drizzle ORM, SQLite. Domain layer: typed state machine with whitelisted transitions, pure policy function, static routing rule, `PaymentRail` interface (quote, execute, get status). Orchestrator wires ingest, interpret, policy, quote, route, approve, execute, settle, accounting in a fixed order with an audit entry at every step.

Stellar rail (`src/lib/rails/stellar.ts`): Stellar SDK, Horizon, treasury keypair held server-side, PYUSD asset, payment operation with the idempotency key in the memo, a pre-submit check of treasury payment history for that memo so a retry cannot pay twice, explorer link on settlement. On testnet the destination is the vendor's Stellar account. In production the destination resolves to the anchor's SEP-31 receiving account with the anchor-issued transaction id as memo; that resolution is isolated from the signing code.

PayPal rail: Payouts REST with `sender_batch_id` and `PayPal-Request-Id` idempotency, webhook signature verification, webhooks trigger a status re-check only.

AI: Claude via the Anthropic SDK with a small tool set including the PayPal Agent Toolkit's read-only tools, filtered at load time. Rule-based fallback when the model is unavailable.

Every external dependency has a mock mode; the demo replays deterministically offline.

### What is built (MVP state)

Done and tested (125 tests, deterministic replay in README):
- Full obligation lifecycle, policy engine, routing rule, state machine, audit log.
- Four-obligation demo: amount mismatch blocked, duplicate blocked, PayPal auto-pay, Stellar approve-then-pay with explorer link.
- Operator dashboard: overview, inbox, obligation detail with rule checklist and route comparison, vendors, ledger, exceptions, accounting export, audit, settings, presenter page.
- Corridor benchmark with sourced fee model for US to PH.
- Accounting CSV export and Xero mapping.

Implemented, not yet exercised (build environment had no network path to the sandboxes):
- Live PayPal sandbox Payouts and webhook verification.
- Live Stellar testnet PYUSD payment.
- Live Claude agent with PayPal tools.

Not built:
- SEP-31 anchor integration (modelled in the quote, stubbed in destination resolution).
- PYUSD to USDC path payment.
- Xero OAuth.

### Tranche milestones

**Tranche 1: MVP (done).** Everything in "Done and tested" above, public repository, demo video.

**Tranche 2: Testnet.** Stellar testnet PYUSD flow exercised end to end from the dashboard with real explorer links. PYUSD to USDC path payment on testnet. SEP-10 auth, SEP-12 KYC and SEP-31 transaction flow against an anchor sandbox (PeraHub if access is granted, otherwise the SDF anchor reference implementation). PayPal sandbox exercised end to end. Live Claude agent. Target: 8 weeks from award.

**Tranche 3: Mainnet.** PeraHub US to PH corridor live with a sending-anchor agreement. Xero integration live via OAuth. First 10 businesses connected and paying real suppliers through Dueline, with at least a quarter of cross-border volume routed over Stellar by the routing rule on merit. Second corridor (Mexico via Bitso) in sandbox. Target: 6 months from award.

### Success metrics

- Obligations processed through Dueline (read to reconciled).
- Errors prevented: blocked obligations and the amount they represent.
- PYUSD volume settled on Stellar, and the share of cross-border volume the routing rule sent to Stellar.
- Anchors integrated and corridors live.
- Businesses connected; businesses with accounting sync active.
- Median time from request to reconciled record.

### Team

Daniel Fillion, solo founder. Runs a tour operations business in Northern Vietnam that pays exactly the kind of roster Dueline is built for: guides, drivers, homestays and creators across Vietnam and the Philippines. Hands-on builder; the MVP was built with AI-assisted engineering under a two-lane model (an AI builder lane and a human gate lane with hand review on every money-path change, see CONTRIBUTING.md). Prior exposure to SCF-funded Stellar work through a separate team (Logistech Global) is relevant experience with the ecosystem and its process; that team is not part of this project.

Hiring plan on award: one part-time backend engineer with anchor and SEP experience for tranche 2, and an accountant-channel partner for tranche 3 go-to-market.

### Budget outline

Indicative, for the full award, to be adjusted to the tranche schedule:

| Line | Share | Purpose |
|---|---|---|
| Engineering | 55% | Anchor integration, path payments, Xero OAuth, second corridor, hardening, security review of the money path |
| Compliance and legal | 15% | Sending-anchor agreement, terms for business users, review of money transmission posture per corridor |
| Pilot operations | 15% | Onboarding the first 10 businesses, treasury float for pilots, support |
| Go-to-market | 10% | Accountant channel, Xero marketplace listing, content |
| Infrastructure and tooling | 5% | Hosting, monitoring, model usage |

### Risks and mitigations

- **Stellar does not win on cost at small amounts.** True today on published fees (crossover about USD 500 to PH; Wise cheaper throughout). Mitigation: the routing rule picks on merit, so the product is credible regardless; Stellar wins on speed and predictability now, and on cost as anchor fees fall. We do not pitch Stellar as always cheaper.
- **Anchors accept USDC, not PYUSD.** Mitigation: PYUSD to USDC path payment on Stellar before the anchor leg, budgeted at 0.1% slippage; or hold USDC in treasury for anchor corridors.
- **Anchor access.** PeraHub's SEP-31 requires a sending-anchor agreement; its KYC endpoint rejects unregistered callers. Mitigation: enquiry opened in parallel (human action queue H8); fall back to the SDF reference anchor for testnet; Bitso as second counterparty.
- **Vietnam has no licensed VND off-ramp.** Mitigation: Vietnam vendors route via PayPal; the demo shows this honestly. Revisit when the Resolution 05/2025 pilot produces a licensed venue.
- **Regulatory posture.** Dueline initiates payments on behalf of a business from the business's own funds. Mitigation: the business holds its own PayPal account and Stellar treasury; Dueline does not custody; legal review in tranche 2 per corridor.
- **AI error.** Mitigation: the model has no spending authority; policy is deterministic; the model's output can only add warnings. This is the core design, not an afterthought.
- **Solo founder.** Mitigation: hire on award (above); two-lane build process already documented.

### Go-to-market

Accountants first. Small businesses adopt payment tooling their bookkeeper recommends. Dueline exports reconciled bills, payments and fee lines, which is what the bookkeeper wants, so the accountant becomes the channel.

1. Xero app marketplace listing once OAuth is live, positioned in the bills and payments category for businesses with overseas contractors.
2. A practice channel: five accounting firms serving travel, agency and field-service clients in the US, Australia and Singapore, each with a handful of clients paying into the Philippines.
3. Direct: tour operators and DMCs in the Philippines and Vietnam corridor, starting from the founder's own network.
4. Content: the corridor benchmark published and kept current, because honest numbers are rare and travel well.

Pricing hypothesis: flat monthly fee per business plus a small per-obligation fee, no spread on FX, so the routing rule has no incentive to misroute.

# Stellar Community Fund #46: Build Award application

> **Go or no-go, for the founder, decide by 1 Nov 2026**
>
> - **Go for #46 only if both happen before 6 Nov:** (1) one real testnet payment released through the spend-policy contract from the app, with an explorer link pasted into "What is built"; (2) the interest form submitted.
> - **Otherwise apply to #47** with the testnet release, Loop Tours running in Review mode and three pilot letters. A weak #46 application spends the first impression with the same panel.
> - Before submitting either round, check in the SCF handbook: the tranche structure for the round, the team minimum, the track, and any jurisdiction restriction (such as testnet-only) for an applicant based in Vietnam.
>
> Deadline for #46: 8 Nov 2026. The interest form must be in before the application.

## Interest form

**Project name.** Checkrail spend policy (first user: Checkrail Pay)

**One-line description.** A Soroban spending-policy account that an AI payables agent can use but cannot abuse: per-payment cap, rolling 24-hour cap, payee allow-list, a time-locked cancel window and an owner pause key.

**Summary (one paragraph).** AI agents are starting to pay suppliers. Today their limits live in the same server as their keys, so a compromised server or a confused model can overspend. The Checkrail spend policy moves those limits onto Stellar. The business funds a Soroban contract with its own PYUSD or USDC and stays its owner. The agent key can only propose a payment. Nothing moves until a cancel window has passed, and at release the contract checks every rule again: the per-payment cap, the rolling 24-hour cap (scheduled payments count), the payee allow-list that only the owner can change, and a pause that either side can pull but only the owner can lift. Checkrail Pay, an AI payables app for small service businesses, is its first user. The contract is a reusable primitive for any team building agent payments on Stellar.

**Category.** Payments (agent payments, B2B supplier payouts).

**Stage.** Contract written and unit-tested (11 tests); not yet deployed. The app it serves is a working MVP with a proven PayPal sandbox payout and a live Claude reader. Details below.

**Team.** Daniel Fillion, solo founder. Runs a tour operations business in Northern Vietnam that pays exactly this kind of supplier roster.

**Links.** Repository link added at submission. Demo video: on the project's PayPal AI Hackathon Devpost page.

## Full application

### Project summary

The Checkrail spend policy is a Soroban contract that holds a business's stablecoin float and lets an AI payables agent spend it only inside rules the chain enforces. The agent can propose. The chain decides whether the payment may ever leave, and the owner can stop it at any point before it does.

Checkrail Pay is the first user. It already enforces the same autopilot limits in its own database: a per-payment cap (default USD 500), a rolling 24-hour cap (default USD 2,000), a cancel window (default 10 minutes) and a pause. Those limits protect against a model mistake. They do not protect against a compromised server, because the server holds the key. Putting the limits in the contract closes that gap, and it gives Stellar a role in the product that PayPal and Wise cannot copy.

### Problem

Agent payments need limits the agent cannot edit.

Small service businesses pay dozens of freelance suppliers a month from chat messages and job sheets. AI can now read those requests and pay the clean ones. The safety model every serious team ships is the same: the AI proposes, deterministic rules decide, money moves through an API, a person can stop it. But on every rail today, the rules and the key sit on the same server. One leaked key or one bad deploy and the caps are gone.

### Solution: the spend-policy contract

The agent key can only propose; release is permissionless after the window and re-checks every rule.

| Rule | Who can change it | Enforced at |
|---|---|---|
| Per-payment cap | owner | propose and release |
| Rolling 24-hour cap, counting scheduled payments | owner | propose and release |
| Payee allow-list | owner only | propose and release |
| Cancel window before money moves | owner | release |
| Cancel a scheduled payment | owner | until release |
| Pause | owner or agent (the safe direction) | propose and release |
| Resume | owner only | |
| One payment per id (idempotency) | nobody | propose |
| Withdraw the balance | owner, any time | |

What this buys:
- A compromised Checkrail server can propose payments, but only to payees the owner allowed, only under the caps, and only after a window in which the owner can cancel or pause.
- A changed payout address needs the owner's signature on the allow-list, which is the classic invoice-fraud path closed on chain.
- The business funds the contract and can withdraw at any time. Checkrail never holds funds.
- Lowered limits apply at release, so tightening a cap stops payments already scheduled.

### How Checkrail Pay uses it

Checkrail Pay reads each supplier request (Claude, or a rule-based reader), checks it against 25 deterministic policy rules, and pays the clean ones inside the owner's autonomy setting. Today its Stellar rail signs a PYUSD payment directly from a treasury key (written to the Stellar SDK, simulated, never run on testnet). With this grant, the Stellar rail proposes through the contract instead, the app's cancel and pause buttons call the contract, and a release watcher calls `release` after the window. The app's own policy still runs first; the contract is the second, independent wall.

### Why Stellar

1. **Programmability where it matters.** Soroban lets the limits live with the money. PayPal and Wise have no equivalent a payer can set and the payer's own software cannot override.
2. **Speed.** Stellar ledgers close in about 5 seconds. Our benchmark estimates 1 to 30 minutes end to end to a Philippine bank through an anchor, against 1 to 5 days for a standard PayPal withdrawal to a bank there.
3. **PYUSD on Stellar** (live since 18 Sep 2025, pitched for SMB working capital and supplier payments) is the natural float for a product that also pays over PayPal.
4. **A reusable primitive.** Any agent-payments team on Stellar can deploy the same contract. It grows network asset value held in business float, one treasury at a time.

**Honest about cost.** Stellar is not the cheaper rail in our benchmark (`docs/CORRIDOR_BENCHMARK.md`). On published fees, PYUSD to a Philippine bank via PeraHub beats PayPal only above about USD 500, and Wise is cheaper than both at every size tested. PeraHub caps a transfer at 1,000 USDC with a 5 USDC fixed fee, and anchors take USDC, not PYUSD, so a path payment is needed. Vietnam has no licensed off-ramp, so there is no Stellar route for Vietnamese suppliers. Stellar wins on speed and programmability, and this application is built on those two, not on price.

### What is built

As of 29 Oct 2026:

- **Spend-policy contract:** written in Rust on soroban-sdk 29.0.1. 11 unit tests pass with `cargo test` (caps, rolling window, allow-list, cancel, pause and resume, idempotency, lowered limits at release, a failed transfer leaving the payment pending, owner-only and agent-only authorisation). Not deployed to testnet. Not called by the app yet.
- **Checkrail Pay app:** 307 tests in 38 files, 25 named policy rules, a typed state machine with whitelisted transitions, idempotency on every rail attempt, autonomy levels with caps and a cancel window, a Daily close with audited sign-off, a Xero bills import file and CSV export.
- **PayPal Payouts sandbox: proven.** Batch RGS5PUZPH4CNY, USD 180 to Maria Santos, settled 12 Oct 2026. Batch W55KNGQK57JC4, USD 750 to Ana Reyes, came back UNCLAIMED and was held, not paid twice.
- **Claude (`claude-sonnet-5-5`): has read the full demo live,** with three read-only PayPal REST calls (Transaction Search and Invoicing).
- **Stellar PYUSD rail: simulated.** The adapter is written to the Stellar SDK with memo-based idempotency and has never run on testnet.
- **Reviews:** six independent review rounds and three outside audit rounds (security and AP practice) on the app's money path, every finding fixed with a test.

### Tranches and ask

**Ask: USD 60,000.** Split below follows the SCF v7 structure (10% on award, 20% at MVP, 30% at testnet, 40% at mainnet with UX readiness); we will map it to whatever structure the #46 handbook specifies.

| Tranche | Share | USD | Deliverable | Target |
|---|---|---|---|---|
| Award | 10% | 6,000 | Selection | On award |
| MVP | 20% | 12,000 | Contract and unit tests (done before award), plus: events indexed by the app, a TypeScript client for propose, cancel, pause and release, and a written threat model | 3 weeks from award |
| Testnet | 30% | 18,000 | Contract deployed to testnet. The app's Stellar rail proposes through it, the app's cancel and pause call it, and a release watcher releases after the window. A real testnet release with an explorer link, from the running app. PYUSD to USDC path payment on testnet. | 8 weeks from award |
| Mainnet | 40% | 24,000 | Independent security review of the contract, fixes applied. Mainnet deployment. Three pilot businesses funding their own contract and paying real suppliers through it. Owner screens for limits, allow-list and pause. Published docs so another team can deploy it. | 6 months from award |

### Budget (itemised)

| Line | USD | Purpose |
|---|---|---|
| Contract engineering | 12,000 | Client library, events, threat model, edge cases (fee bumps, expired entries, token with clawback) |
| App integration | 14,000 | Stellar rail through the contract, cancel and pause wiring, release watcher, reconciliation of contract events |
| Security review | 15,000 | Independent review of the contract before mainnet, and fixes |
| Testnet and mainnet operations | 4,000 | Deployment, monitoring, test float, explorer-linked evidence for each milestone |
| Pilot onboarding | 7,000 | Onboarding three businesses, owner-key setup, support |
| Legal | 5,000 | Payments-law opinion on initiating payouts from a customer's own account; terms for business users |
| Docs and reuse | 3,000 | Public deployment guide and example for other agent-payments teams |
| **Total** | **60,000** | |

### Success metrics

- Contract deployed on mainnet and called by the running app for every Stellar payment.
- Three businesses with funded spend-policy contracts, and the PYUSD or USDC held in them.
- Payments released through the contract, and payments the contract refused (caps, allow-list, pause), both from on-chain events.
- At least one outside team deploying the contract.
- No payment ever released outside the rules, verified from contract events.

### Context: the PYUSD rail

Checkrail Pay routes between PayPal Payouts, Stellar PYUSD, Wise and a Vietnamese bank file, with vendor preference first and then effective cost. The first Stellar corridor is US to the Philippines through PeraHub (SEP-31), which requires a sending-anchor agreement not yet in place. That corridor work is context for this grant, not its deliverable: this application funds the contract and its first real use.

### Risks and mitigations

- **No testnet transaction yet.** The build environment had no network path to Stellar. Mitigation: the go or no-go box above makes a real testnet release a condition of applying.
- **Anchors accept USDC, not PYUSD.** Mitigation: fund contracts in USDC where an anchor leg is needed, or path-pay PYUSD to USDC first. Liquidity is unproven: our benchmark found no PYUSD/USDC pool with reserves, so slippage will be measured on testnet first.
- **Solo founder.** Mitigation: the security review is budgeted as outside work; hire a part-time Soroban engineer from the testnet tranche.
- **No traction yet.** Mitigation: the founder's own tour company is customer zero, and pilot letters are being sought from operators that share its suppliers.
- **Regulatory posture.** The business owns the contract and its funds; Checkrail sends instructions and never holds money. A legal opinion is budgeted.
- **AI error.** The model has no spending authority in the app, and with this contract a compromised app cannot overspend either.

### Team

Daniel Fillion, solo founder. Runs a tour operations business in Northern Vietnam that pays guides, drivers and homestays from chat requests every week. Hands-on builder; the app was built with AI-assisted engineering under a two-lane model (an AI builder lane and a human gate on every money-path change, see CONTRIBUTING.md). Prior exposure to SCF-funded Stellar work through a separate team (Logistech Global) is relevant experience with the ecosystem and its process; that team is not part of this project.

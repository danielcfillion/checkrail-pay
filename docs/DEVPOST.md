# Devpost submission text

Paste each section into the matching Devpost field. Categories to select, in this order: Best Use of PayPal + AI, Best Demo Delivery, then Best Use of Agentic Commerce only if you accept it is the weakest fit (the agent proposes and never transacts by design). Check the live Devpost category list for the exact names, including any impact-focused prize, before submitting.

## Project name

Dueline

## Tagline (under 60 characters)

Verified supplier payments, routed and reconciled automatically.

(58 characters)

## Inspiration

I run a small tour company in Northern Vietnam. Every week we pay guides, drivers and homestays, and the requests arrive as an invoice photo, a job sheet, or a chat message saying "can you pay Phuong today, he needs it for fuel". Someone checks each one against a contract, pays from a PayPal tab, then types it into the books. Nothing in the chain is checking, and amounts drift and job sheets get paid twice. Dueline is the layer I wanted: it reads the mess, refuses what is wrong, pays what is right over the better rail, and leaves the books done.

## What it does

Dueline is an AI payables operations layer for small businesses that pay contractors and suppliers across borders.

Every payment request travels along one line through five stations: read, verified, routed, paid, reconciled.

An agent reads the raw request and the attached documents (uploaded PDFs are read from their text; photos and scans are read by Claude), resolves the vendor, extracts amount and reference, and flags anomalies. It is Claude when an Anthropic API key is set and a rule-based extractor otherwise; the app shows which one read each obligation. With Claude it also gets read-only PayPal Agent Toolkit tools (list transactions, list invoices, get invoice, merchant insights). It cannot pay.

A deterministic policy engine decides. Eight rules: known vendor, amount present, evidence attached, amount within tolerance of evidence, no duplicate reference, recipient details verified, corridor allow-listed, AI confidence above threshold. Outcome: block, hold, require approval or auto-execute. Same input, same output, no model in the loop.

A routing rule quotes PayPal Payouts and Stellar PYUSD (via a Philippine anchor) side by side and picks by vendor preference, then effective cost per dollar the sender actually spends (PayPal's fee is on top, Stellar's comes out of the amount), with near-ties going to PayPal. The operator sees both and can override.

Execution re-runs policy, then calls PayPal Payouts or signs a Stellar payment, with an idempotency key on every attempt. Settlement is confirmed by polling. Every event lands in one audit log and exports as accounting-ready CSV with a Xero bill, payment and fee mapping.

The demo: a US tour operator with four open obligations. One is USD 160 over the trip sheet, blocked. One duplicates a job settled 17 days earlier, blocked. A USD 180 guide fee is auto-approved and paid by PayPal, because at that size the two rails cost the same within a fraction of a percent and PayPal's path runs end to end today. A USD 750 fee needs human approval, then pays over Stellar in minutes instead of days because the guide asked for the faster rail. Result: 2 settled, 2 errors prevented, USD 340 saved, 2 records exported.

## How we built it

TypeScript throughout. Next.js 15 App Router with React 19 for the operator dashboard, server actions for every write. Drizzle ORM on SQLite so the whole thing runs from one folder with no external services.

The domain layer is deliberately boring: a typed state machine with whitelisted transitions, a pure policy function, a static routing rule, and a `PaymentRail` interface (quote, execute, get status). The orchestrator wires them in a fixed order and appends to the audit log at every step.

The agent is Claude via the Anthropic SDK with a small tool set: look up vendor, read evidence, the PayPal Agent Toolkit tools filtered to a read-only allow-list at load time, and submit interpretation. Even a misconfigured prompt cannot reach a payment tool.

The PayPal rail builds one Payouts batch per obligation with the idempotency key as both `sender_batch_id` and the `PayPal-Request-Id` header. The Stellar rail signs and submits a PYUSD payment with the key in the memo and checks treasury history for that memo first. The webhook receiver verifies signatures and only triggers a status re-check.

Every external dependency has a mock mode, so the demo replays deterministically offline (`npm run demo:replay`) and the UI runs with zero credentials. The fee model behind the mock quotes is sourced in `docs/CORRIDOR_BENCHMARK.md`.

## Challenges we ran into

The build environment could not reach PayPal sandbox or Stellar testnet, so live mode is implemented and type-checked but not yet run end to end. We say so in the README rather than hide it behind mock output.

The Stellar cost story is less clean than the pitch version. On published fees, PYUSD via PeraHub beats PayPal to the Philippines only above about USD 500, and Wise is cheaper than both. Anchors accept USDC, not PYUSD, so production needs a path payment first. Vietnam has no licensed off-ramp. The routing rule is honest about this: at USD 180 it picks PayPal.

Keeping the AI out of the money path while keeping it useful meant making its output advice that can only tighten the decision, never loosen it.

## Accomplishments that we're proud of

No path exists from the model to a payment. The due line shows the whole book on one line. The demo catches two real classes of error (inflated amount, duplicate reference) rather than just moving money. 130 passing tests, including a story test that runs the whole demo through the orchestrator.

## What we learned

Deterministic policy plus an advisory model is easier to trust, audit and explain than an agent that decides. Rail comparison needs real numbers and real caveats; the recipient's delivered amount is the figure that matters. Reconciliation is what small businesses pay for; routing is the bonus.

## What's next

Run live mode against PayPal sandbox and Stellar testnet. Add the PYUSD to USDC path payment and SEP-31 with PeraHub. Wire Xero OAuth. Add Mexico via Bitso. Then put it in front of accountants who serve tour operators and agencies.

## Built with

TypeScript, Next.js 15, React 19, Tailwind CSS 4, Drizzle ORM, SQLite (better-sqlite3), Anthropic SDK (Claude), PayPal Agent Toolkit, PayPal Payouts REST API, PayPal Server SDK, Stellar SDK, PYUSD on Stellar, Zod, Vitest.

## Tools used and how they are integrated

- **PayPal Payouts REST API**: execution rail. One batch per obligation, idempotency via `sender_batch_id` and `PayPal-Request-Id`. Webhook receiver with signature verification at `/api/webhooks/paypal`.
- **PayPal Agent Toolkit (MCP tools)**: `list_transactions`, `list_invoices`, `get_invoice`, `get_merchant_insights` wired to the Claude agent and filtered to read-only at load time. Written against the real toolkit and type-checked; not yet run against live PayPal because the build environment had no network egress.
- **Stellar SDK and PYUSD**: second execution rail. Signed PYUSD payment from a treasury account, memo-based idempotency, Horizon polling for settlement, stellar.expert explorer links.
- **Anthropic Claude**: the obligation agent that reads requests and evidence and produces a structured interpretation with confidence and flags.
- **Next.js, Drizzle, SQLite**: the operator dashboard, server actions, persistence and audit log.

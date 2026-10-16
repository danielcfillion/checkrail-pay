# Devpost submission text

Paste each section into the matching Devpost field. Updated 12 Oct 2026 against the official rules (paypalaihackathon.devpost.com/rules).

Honourable mention to select first: **Best Use of Agentic Commerce** (with autopilot the agent now sends payments on its own, inside hard limits). Also eligible for consideration: Best Use of PayPal + AI, Best Demo Delivery, Most Impactful. A project can win one grand prize or one honourable mention, plus one sponsor prize: if hosted on Render, also enter the Render prize.

Rules checklist before submitting:
- Public repo with the MIT licence visible in the repo's About section.
- Video under 3 minutes, public on YouTube, no copyrighted music.
- Judges can test free until Dec 15, 2026: hosted demo URL (Render) plus the run instructions in the README. The hosted demo runs in mock mode behind Basic auth (one shared database; the credential goes in the "testing instructions" field so two judges do not reset each other's walkthrough). If it uses live sandbox, the sandbox credentials stay on the server; judges never need their own.
- Say the project was started on Oct 3, 2026, after the submission period opened on Oct 1.

## Project name

Checkrail Pay

## Tagline (under 60 characters)

AI pays your suppliers. Policy decides. You sign off.

(52 characters)

## Inspiration

I run a small tour company in Northern Vietnam. Every week we pay guides, drivers and homestays, and the requests arrive as an invoice photo, a job sheet, or a chat message saying "can you pay Phuong today, he needs it for fuel". Someone checks each one against a contract, pays from a PayPal tab, then types it into the books. Amounts drift, job sheets get paid twice, and the person approving has none of the context. A check rail is the short rail laid beside the main track that keeps wheels from leaving it. Checkrail Pay is that rail for supplier payments.

## What it does

Checkrail Pay is an AI payables agent for small businesses that pay contractors and suppliers across borders. Every request travels one line through five stations: read, verified, routed, paid, reconciled.

**Claude reads.** It reads the raw request and the attached documents (PDF text, photos and scans), resolves the vendor, extracts amount and reference, and checks PayPal's own records with read-only PayPal Agent Toolkit tools. It returns a structured reading, a confidence score, concerns that should hold the payment, and neutral notes for the reviewer. It has no tool that moves money.

**Policy decides.** A deterministic policy engine (a pure function, no model) checks the vendor, the evidence, the amount against the evidence, duplicate job references, changed payout details, the corridor and the agent's concerns. Outcome: block, hold, require approval or pay.

**You choose how much the agent does.** Three autonomy levels: Review everything (a person approves and sends every payment), Assist (clean small payments are pre-approved, a person sends), Autopilot (clean payments inside your caps are sent by the agent after a cancel window). Autonomy removes the approval step and nothing else: a mismatched amount, a duplicate or a changed bank detail stops a payment at every level. Autopilot has a per-payment cap, a daily cap, a cancel window and a one-click pause. Policy runs again at the moment of release, so a payout email changed during the cancel window stops the payment before any rail is called.

**Routing.** PayPal Payouts and Stellar PYUSD are quoted side by side and the rail that delivers more per dollar actually spent wins, with near-ties going to PayPal.

**The Daily close.** One page to read before signing out: what needs a look comes first (unclear outcomes, failures, last-moment refusals, new blocks, first payments to a new vendor, amounts far above a vendor's usual, payments approved over warnings), then what the agent sent, what people sent, spend against the cap, and an audited sign-off.

**The demo.** A US tour operator. A USD 960 invoice that the trip sheet says should be USD 800: blocked. A job already paid 17 days earlier: blocked. A USD 180 guide fee: paid through the real PayPal sandbox (payout batch RGS5PUZPH4CNY, settled). A USD 750 fee to a guide whose PayPal email does not exist: sent, comes back UNCLAIMED, and is held for a person instead of being paid again. (That is the live sandbox run shown in the video. The hosted demo judges try runs on simulated rails with no keys, so there Ana's fee settles on simulated Stellar; the presenter page at /demo lists both, plus documents to upload to try autopilot and the duplicate check.)

## How we built it

TypeScript throughout. Next.js 15 and React 19 for the operator app, server actions for every write, Drizzle ORM on SQLite so it runs from one folder.

The domain layer is deliberately boring: a typed state machine with whitelisted transitions, a pure policy function, a static routing rule, and a `PaymentRail` interface (quote, execute, get status). The orchestrator wires them in a fixed order and appends to an audit log at every step.

The agent is Claude via the Anthropic SDK with a small tool set: look up vendor, read evidence, PayPal Agent Toolkit tools filtered to a read-only allow-list at load time, and submit interpretation. Its output is untrusted: every field is clamped and validated, and its concerns can only tighten a decision.

Autopilot is a timer over policy, not the model deciding to pay: a payment is scheduled only when policy says pay, and released by a heartbeat after the cancel window, with the agent recorded as the actor.

Money-path safety: an idempotency key on every attempt (`sender_batch_id` and `PayPal-Request-Id`), compare-and-swap state changes inside one transaction, the payout destination pinned at approval, an ambiguous rail answer treated as "unknown" (never retried under a new key), and live mode that fails closed instead of falling back to mocks. 182 tests.

## Challenges we ran into

The first live Claude run flagged harmless details ("release payment" in the text, a missing due date) as concerns, and every concern holds a payment, so nothing auto-paid. We split the agent's output into concerns that hold and notes that never reach policy, and wrote a test that proves notes cannot change a decision.

The first live PayPal run failed with insufficient funds, and showed that the demo seed was sending its month of history through the real sandbox. History is now always simulated, and the sender is a funded US sandbox business.

The Stellar cost story is less clean than the pitch version. On published fees, PYUSD via a Philippine anchor beats PayPal only above about USD 500. The routing rule is honest about this: at USD 180 it picks PayPal.

## Accomplishments that we're proud of

A real sandbox payout settled end to end, with Claude reading the request. No path exists from the model to a payment, even on autopilot. The demo catches two real classes of error (an inflated amount and a duplicate job) and handles an unclaimed payout without paying twice. The Daily close turns "the AI did it" into something a person can sign off in two minutes.

## What we learned

Asking a person to approve after the AI did all the work gives them no context; a good summary after the fact plus hard limits before it works better. Deterministic policy plus an advisory model is easier to trust, audit and explain than an agent that decides. Reconciliation is what small businesses pay for; routing is the bonus.

## What's next

Stellar testnet treasury and the PYUSD to USDC path payment for the anchor leg. Xero OAuth. A read-only voice control centre ("what went out today?", "pause autopilot"). Then pilots with accountants who serve tour operators and agencies.

## Built with

TypeScript, Next.js 15, React 19, Tailwind CSS 4, Drizzle ORM, SQLite (better-sqlite3), Anthropic SDK (Claude), PayPal Agent Toolkit, PayPal Payouts REST API, Stellar SDK, PYUSD on Stellar, Zod, Vitest.

## Tools used and how they are integrated

- **PayPal Payouts REST API**: the execution rail. One batch per obligation, idempotency via `sender_batch_id` and `PayPal-Request-Id`, settlement by polling, signature-verified webhook at `/api/webhooks/paypal`. Proven in sandbox (batch RGS5PUZPH4CNY).
- **PayPal Agent Toolkit**: `list_transactions`, `list_invoices`, `get_invoice`, `get_merchant_insights`, given to Claude and filtered to read-only at load time, so the agent can check PayPal's own records before policy decides.
- **Anthropic Claude**: the agent that reads requests and documents and returns a structured, validated interpretation with concerns and notes.
- **Stellar SDK and PYUSD**: the second rail. Signed PYUSD payment with memo-based idempotency and Horizon polling (simulated in the demo until the testnet treasury is funded).
- **Next.js, Drizzle, SQLite**: the operator app, autonomy settings, Daily close, interactive money-out chart, audit log.

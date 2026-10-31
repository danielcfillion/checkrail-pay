# Devpost submission text

Paste each section into the matching Devpost field. Numbers here match the README facts block ("What is live and what is simulated"); change both together.

## Prizes to select

1. **Best Use of PayPal + AI** (first). PayPal's own records decide a block: before any payment, the app reads PayPal Transaction Search itself and blocks a job PayPal already paid, citing the PayPal transaction id ("PayPal transaction ... already paid USD 180.00 for JOB-HG4D-0914 to maria.santos@example.com"). Claude reads the request and checks the same history with read-only Transaction Search and Invoicing calls, and Books reconciles back from Transaction Search. PayPal and AI do the work together on every payment.
2. **Best Use of Agentic Commerce** (second). Checkrail is an MCP server any agent asks before it pays a supplier: `check_payment` answers pay, hold or block with the rule and PayPal's transaction id, and `request_payment` lets the agent hand Checkrail the payment, which Autopilot sends over PayPal Payouts only inside the owner's caps. The agent transacts; it never holds the keys.
3. **Best Demo Delivery** (third).
4. **Sponsor prize: Best Use of AG Grid.** Onboarding's "Your first weeks" is an AG Studio dashboard with two custom widgets, the Checkrail theme, no-code layout editing, and a swapped-in harness: a Checkrail agent on Claude that delegates to Studio's built-in agents. Select it only if the submitted build has it running.

Render stays the host of the judging demo (see "Built with"); it is not the sponsor prize we select.

A project can win one grand prize or one honourable mention, plus one sponsor prize.

Rules checklist before submitting:
- Select a sponsor prize only for a build that meets that sponsor's own brief (AG Grid asks for AG Studio; Bryntum for Gantt, Scheduler or Calendar in a real workflow; Render for Workflows). Otherwise select none rather than claim it.
- Public repo with the MIT licence visible in the repo's About section.
- Video under 3 minutes, public on YouTube, no copyrighted music.
- Judges can test free until 15 Dec 2026: the hosted demo link plus the run instructions in the README. Put the hosted login in the testing instructions field, with this line: "The hosted demo runs on simulated rails with the rule-based reader, and shows Claude's readings recorded from a live run; the video shows Claude live." Keep the Render plan awake through 15 Dec. It is one shared database that restores the four opening requests after 30 minutes without use; Reset demo on /demo does the same at any time.
- Say the project was started on 3 Oct 2026, after the submission period opened on 1 Oct.

## Project name

Checkrail Pay

## Tagline (under 60 characters)

Claude reads. Policy decides. You sign off.

(43 characters)

## Inspiration

A supplier payment should be checked against the job before the money moves, not after.

I run a small tour company in Northern Vietnam. Every week we pay guides, drivers and homestays, and the requests arrive as an invoice photo, a job sheet, or a chat message saying "can you pay Phuong today, he needs it for fuel". Someone checks each one against a contract, pays from a PayPal tab, then types it into the books. Amounts drift, job sheets get paid twice, and the person approving has none of the context. A check rail is the short rail laid beside the main track that keeps wheels from leaving it. Checkrail Pay is that rail for supplier payments.

The demo company, Ridgeline Expeditions, is a US operator, because a US payer can pay Vietnamese and Filipino contractors in USD over PayPal. My own company pays most local suppliers in dong by bank transfer, which Checkrail covers with a bank file.

## What it does

Checks every supplier payment before money moves.

For small service businesses that pay dozens of freelance suppliers from chat messages, Checkrail Pay checks every request against the job it is for, pays the clean ones over PayPal inside limits you set, and stops the rest with a one-line reason. US bill-pay tools assume a purchase order. Checkrail works from job sheets, bookings and rate cards, and it never holds your money.

A purchase-order tool would pass Phuong's USD 960 invoice, because there is no purchase order to fail against. Checkrail blocks it because the trip sheet says 4 days at USD 200.

Every request travels one line through five stations: read, verified, routed, paid, reconciled.

**Claude reads.** It reads the request and the attached documents, resolves the vendor, extracts the amount and reference, and checks PayPal's own transaction and invoice history with three read-only REST calls. It returns a structured reading, a confidence score and concerns. We call PayPal's REST endpoints directly rather than through the Agent Toolkit so the agent can reach only these three GET calls.

**PayPal's own records decide.** Before every decision that can move money, the app itself (deterministic code, not the model) reads PayPal Transaction Search. When PayPal already paid this job to this payee, the request is blocked with the PayPal transaction id: "PayPal transaction ... already paid USD 180.00 for JOB-HG4D-0914 to maria.santos@example.com". The model cannot add or remove that record. Transaction Search can lag by up to three hours, so Checkrail's own payment history stays the first duplicate check.

**Policy decides.** A deterministic policy engine (a pure function, named rules, no model) checks the vendor, the evidence, the amount against the evidence and the rate card, duplicate jobs, changed payout details, the corridor and the agent's concerns. Outcome: block, hold, require approval or pay.

**You choose how much the agent does.** Review everything, Assist (clean small payments are pre-approved, a person sends) or Autopilot (clean payments inside your caps are sent after a cancel window). Autonomy removes the approval step and nothing else. Policy runs again at the moment of release.

**You sign off.** The Daily close is one page to read before signing out: what needs a look first, then what the agent sent, what people sent and spend against the cap, with an audited sign-off.

**Reconciled from PayPal.** Read from PayPal on the Books page pulls the statement from Transaction Search and ties a returned payout to its original payout by reference id.

**Agents ask first.** PayPal moves money for people. Next it moves money for agents, and agents need a check rail. Checkrail is an MCP server: before any agent pays a supplier through any tool, it calls `check_payment` and gets pay, hold or block, the rule that decided, what would clear it, and PayPal's transaction id when PayPal already paid the job. The check runs on an in-memory copy of the books, so nothing is paid or saved. With the request scope, the agent hands Checkrail the payment instead; it lands in the inbox, and Autopilot sends it only inside the owner's caps after the cancel window. Trust is per agent: what an assistant attaches is its own say-so and a person approves, while a booking system's own agent can be made a system of record. An agent that tries amount after amount for one payee is held for a person.

**What it does not do.** It never holds funds: money goes from the business's own PayPal, Wise or bank account. The model has no tool that moves money.

**Who pays and how much (planned pricing, to be confirmed).** Free Review plan for 30 checked payments a month. Operator plan at USD 79 a month for 300 checked payments, then USD 0.20 per extra payment. Practice plan for bookkeepers at USD 35 per client business a month. Priced per checked payment, never as a percentage of money moved. Blocking one wrong USD 80 request a month pays for the Operator plan.

## The demo

The hosted demo shows the whole story on simulated rails, with no keys. Its PayPal history is what the simulated PayPal rail actually paid, and each opening request shows Claude's reading recorded from a live run on 28 Oct 2026, labelled as recorded. The video shows the same story against the real PayPal sandbox with Claude live.

Ridgeline Expeditions LLC, a US tour operator paying guides, drivers and homestays in Vietnam and the Philippines:

- A USD 960 van invoice that the trip sheet says should be USD 800: blocked, with the rule that caught it.
- A job already paid 17 days earlier: blocked as a duplicate, by this app's own history and by PayPal's record of that payout, with the PayPal transaction id on the page.
- A USD 180 guide fee backed by a trip sheet: paid over PayPal. In the sandbox this was batch RGS5PUZPH4CNY, settled 12 Oct 2026.
- A USD 750 fee: approved by a person and sent. In the sandbox (batch W55KNGQK57JC4) the recipient email had no account, the payout came back UNCLAIMED, and it was held, not paid twice. On simulated rails it settles on Stellar, her preferred rail.
- A clean request from an uploaded PDF, scheduled by Autopilot with a countdown and sent when the window ends.
- The Daily close, signed off.

The presenter page at /demo walks the story in order and links the demo documents to upload.

## How we built it

A fixed pipeline with a pure policy function at its centre, so the model can advise but never decide.

TypeScript throughout. Next.js 15 and React 19 for the operator app, server actions for every write, Drizzle ORM on SQLite so it runs from one folder.

The domain layer is deliberately boring: a typed state machine with whitelisted transitions, a pure policy function, a static routing rule, and a `PaymentRail` interface (quote, execute, get status). The orchestrator wires them in a fixed order and appends to an audit log at every step.

The agent is Claude (`claude-sonnet-5-5`) through the Anthropic SDK, with a small tool set: look up vendor, read evidence, vendor history, three read-only PayPal REST calls (`paypal_list_transactions` on Transaction Search, `paypal_list_invoices` and `paypal_get_invoice` on Invoicing), and submit interpretation. Its output is clamped and validated, and its concerns can only tighten a decision.

The agent guard is a dependency-free JSON-RPC handler shared by two MCP transports: streamable HTTP at `/api/mcp` (agent keys as bearer tokens, rate limits, cross-origin refusal) and stdio for Claude Desktop. `check_payment` copies the SQLite database into memory, runs the real ingest and previews policy there, then throws the copy away; `request_payment` goes through the same ingest a clerk uses, with an idempotency key. Every question lands in an append-only agent log the owner reads on the Agents page.

Autopilot is a timer over policy, not the model deciding to pay. A payment is scheduled only when policy says pay, and released by a heartbeat after the cancel window, with the agent recorded as the actor.

Money-path safety: an idempotency key on every attempt (`sender_batch_id` and `PayPal-Request-Id`), compare-and-swap state changes inside one transaction, the payout destination pinned at approval, an ambiguous rail answer treated as unknown and never retried under a new key, and live mode that fails closed instead of falling back to mocks. 943 tests in 91 files, plus 20 tests on the Soroban spend-policy contract. Review rounds by AI agents, each working from a clean copy of the repo: six critic rounds on 16 Oct, security and AP-practitioner rounds from 25 to 27 Oct, and on 29 Oct three cycles each from a security reviewer, a design reviewer and an AP practitioner, all ending with no Must-fix item outstanding. Every finding, what it led to and what is still open is in `docs/audits/2026-10-29-response.md`. No human security audit has been done yet.

## Challenges we ran into

The hard part was not reading the request, it was deciding which record proves who is owed.

The first live Claude run flagged harmless details ("release payment" in the text, a missing due date) as concerns, and every concern holds a payment, so nothing auto-paid. We split the agent's output into concerns that hold and notes that never reach policy, and wrote a test that proves notes cannot change a decision.

Reviewers found that a single shared word ("Transport", "Homestay") or a place name could bind a trip sheet to the wrong payee. Now only the full name binds, and anything less is a warning a person reads.

The first live PayPal run failed with insufficient funds, and showed that the demo seed was sending its month of history through the real sandbox. History is now always simulated, and the sender is a funded US sandbox business.

## Accomplishments that we're proud of

No path exists from the model to a payment, even on Autopilot.

A real sandbox payout settled end to end with Claude reading the request. The demo catches two real classes of error (an inflated amount and a duplicate job) and handles an unclaimed payout without paying twice. The Daily close turns "the agent did it" into something a person can sign off in two minutes.

## What we learned

Deterministic policy plus an advisory model is easier to trust, audit and explain than an agent that decides.

Asking a person to approve after the AI did all the work gives them no context; a good summary after the fact plus hard limits before it works better. Reconciliation is what small businesses pay for; routing is the bonus.

## What's next

Get requests in where suppliers already send them, and prove it on a real operator's books.

A Zalo Official Account and a forward-to-email address for intake. A pilot with a small Vietnamese tour operator in Review mode. A MISA export for Vietnamese books next to the Xero file. The Stellar rail running through an on-chain spend-policy contract, so the caps hold even if the server is compromised.

## Built with

TypeScript, Next.js 15, React 19, Tailwind CSS 4, Model Context Protocol, AG Grid, AG Studio, Drizzle ORM, SQLite (better-sqlite3), Anthropic SDK (Claude), PayPal Payouts REST API, PayPal Transaction Search and Invoicing REST APIs, Stellar SDK, PYUSD on Stellar (simulated), pdf.js, Vitest, Render (hosting).

## Tools used and how they are integrated

- **PayPal Payouts REST API**: the execution rail. One batch per payment, idempotency through `sender_batch_id` and `PayPal-Request-Id`, settlement by polling, a signature-verified webhook at `/api/webhooks/paypal` that only triggers a re-check. Proven in sandbox (batch RGS5PUZPH4CNY).
- **PayPal Transaction Search and Invoicing REST APIs**: the app reads Transaction Search itself before every decision that can move money, and a PayPal record of the same job paid to the same payee blocks the payment with its transaction id (policy rule `paypal_history`). The same three read-only calls are given to Claude. Transaction Search also feeds Read from PayPal on the Books page (tested against fakes; needs live keys). Live, it needs Transaction search enabled on the PayPal app, and new payouts can take up to three hours to appear.
- **Anthropic Claude**: reads requests and documents and returns a structured, validated interpretation with concerns and notes.
- **Model Context Protocol**: Checkrail's agent guard. Any MCP agent (Claude Desktop, Claude Code, a booking system's agent) calls `check_payment` before paying and `request_payment` to have Checkrail pay; served over HTTP at `/api/mcp` and over stdio.
- **Stellar SDK and PYUSD**: the second rail. A signed PYUSD payment with memo-based idempotency and Horizon polling. Simulated in the demo; never run on testnet.
- **AG Grid and AG Studio**: onboarding's third screen, "Your first weeks", is an AG Studio dashboard that answers one question: is Checkrail ready to do more on its own? Two custom widgets lead it: a readiness gauge ("Ready for Autopilot: 3 of 4", each check listed with its plain reason, filling as the owner marks calls) and "Holds that turned out fine" by week against the 10% target. Studio's own widgets show money stopped by reason, agreement with each rule and every call. The whole canvas uses a Studio theme built from the app's CSS tokens, so it follows light and dark mode. The owner rearranges and adds widgets in Studio's edit mode without code. "Ask about your setup" is a custom agent: Checkrail's guide, running on Claude through our own `AgLlmAdapter` (Studio ships only an OpenAI adapter), which delegates to Studio's data, widget, page and planning agents. It can explain and build, and cannot change a rule or pay anyone. The calls grid on the second screen, the payment run builder and the ledger are AG Grid tables.
- **Render**: hosts the judging demo on simulated rails from `render.yaml`.
- **Next.js, Drizzle, SQLite**: the operator app, autonomy settings, Daily close, money-out chart and audit log.

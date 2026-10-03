# Dueline

**Verified supplier payments, routed and reconciled automatically.**

Dueline is an AI payables operations layer for small businesses that pay a distributed roster of contractors and suppliers, often across borders. It reads messy payment requests, works out who is owed what, refuses the ones that are wrong, picks the cheaper or faster rail between PayPal Payouts and Stellar PYUSD, pays, and lands every settlement in an accounting-ready export.

Built for the PayPal AI Hackathon (Nov 2026) and submitted to Stellar Community Fund #46.

## 60-second overview

A tour operator in the US pays guides, drivers and homestays in the Philippines and Vietnam. Requests arrive as invoices, job sheets and chat messages. Today the owner reconciles them by hand against contracts and a PayPal tab, and still pays duplicates and inflated invoices.

Dueline puts five fixed stations between "someone says we owe this" and "it is in the books":

    read ──── verified ──── routed ──── paid ──── reconciled

1. **Read.** An agent reads the raw request and the attached evidence: Claude when `AI_MODE=live` and an API key is set, a rule-based extractor otherwise (the default, and the only path exercised so far). In live mode Claude also has read-only PayPal Agent Toolkit tools (`list_transactions`, `list_invoices`, `get_invoice`, `get_merchant_insights`) so it can check PayPal's own records. It returns a structured interpretation, a confidence score and plain-language flags. It cannot pay anyone.
2. **Verified.** A deterministic policy engine (a pure function, no network, no model) runs eight rules: known vendor, amount present, evidence attached, amount matches evidence within tolerance, no duplicate reference, recipient details verified, corridor allow-listed, AI confidence above threshold. It returns block, hold, require approval or auto-execute.
3. **Routed.** Both rails are quoted. A static rule picks the default: vendor preference first, then the rail that delivers more to the recipient, ties go to the faster one. Both quotes are shown to the operator.
4. **Paid.** Execution re-runs policy, then calls PayPal Payouts or signs a Stellar PYUSD payment. Every attempt carries an idempotency key.
5. **Reconciled.** Settlement is confirmed by polling the rail. The record lands in an audit log and exports as CSV with a Xero bill, payment and fee mapping ready for OAuth.

## Honest status

Everything runs end to end in mock mode, and that is what the demo and the tests exercise. The policy engine, state machine, routing rule, orchestrator and accounting export are proven by 125 tests and a deterministic replay. The PayPal Payouts adapter, the Stellar PYUSD adapter and the Claude agent with PayPal Agent Toolkit tools are written against the real SDKs and type-checked, but have not yet made a live call: the build environment had no network egress. By default the "agent" is a rule-based extractor, not Claude. Duplicate detection runs against Dueline's own ledger, not PayPal's history. Details in "Honesty" below, and the steps to go live are in `HUMAN_ACTION_QUEUE.md`.

## The demo story

Ridgeline Expeditions LLC, a US tour operator, has four open obligations.

| # | Obligation | What happens | Why |
|---|---|---|---|
| 1 | Phuong Transport, INV-2026-0152, requests USD 960 | **Blocked** | The trip sheet says 4 vehicle-days x USD 200 = USD 800. The request is USD 160 over. Operator can correct to USD 800 and it re-enters the flow. |
| 2 | Maria Santos, JOB-HG4D-0914 | **Blocked** | The reference was settled 17 days earlier. Duplicate. |
| 3 | Maria Santos, JOB-HG4D-0921, USD 180 | **Auto-approved, paid via PayPal** | Under the USD 250 auto-execute threshold, evidence matches. At this size PayPal delivers more PHP than Stellar via the anchor. |
| 4 | Ana Reyes, JOB-PAL3D-0927, USD 750 | **Needs approval, paid via Stellar** | Above threshold, so a human approves. Stellar delivers slightly more PHP and settles in about 15 minutes instead of 1 to 2 days. Ana asked for the faster rail. Explorer link in the settlement details. |

Outcome: 2 settled, 2 errors prevented (USD 340 that would have left the business), 2 accounting records exported.

![Overview: every open obligation on one due line](docs/screenshots/overview.png)

![Phuong Transport blocked: the request says USD 960, the trip sheet says USD 800](docs/screenshots/blocked-mismatch.png)

More in `docs/screenshots/`, including dark theme and mobile.

## Architecture

    request (invoice, job sheet, chat)
          │
          ▼
    ┌─────────────────┐   read-only tools:    ┌──────────────────────┐
    │  AI agent       │ ───────────────────▶  │ PayPal Agent Toolkit │
    │  (Claude)       │   list_transactions   │ list_invoices, etc.  │
    └────────┬────────┘   get_invoice ...     └──────────────────────┘
             │ interpretation + confidence + flags (advice only)
             ▼
    ┌─────────────────┐
    │  Policy engine  │  pure function: thresholds, evidence match,
    │  (deterministic)│  duplicate ref, recipient verified, corridor, AI confidence
    └────────┬────────┘
             │ block | hold | require_approval | auto_execute
             ▼
    ┌─────────────────┐      ┌──────────────┐  ┌──────────────────────┐
    │  Router         │ ◀──  │ PayPal quote │  │ Stellar quote        │
    │  (static rule)  │      │ (fee model)  │  │ (PYUSD, anchor model)│
    └────────┬────────┘      └──────────────┘  └──────────────────────┘
             │ [human approval if required]
             ▼
    ┌─────────────────┐  re-runs policy, idempotency key per attempt
    │  Executor       │ ───▶ PayPal Payouts API  or  signed Stellar payment
    └────────┬────────┘
             │ poll for settlement (webhooks only trigger a re-check)
             ▼
    ┌─────────────────┐
    │  Audit log      │ ───▶ CSV export, Xero bill / payment / fee mapping
    └─────────────────┘

Every step appends to the audit log. No step can be skipped by a caller.

## The safety model: why the AI cannot pay

- **The agent has no spending authority.** Its only output is an `AiInterpretation` (vendor, amount, reference, summary, confidence, flags). Its PayPal tools are filtered to a read-only set at load time (`src/lib/ai/paypalTools.ts`). There is no tool that moves money.
- **Policy is a pure function.** `evaluatePolicy(policy, input)` in `src/lib/domain/policy.ts` takes the same input and returns the same output, with no network and no model. The AI's interpretation is one input among several and can only make the decision more conservative (a low confidence or a flag adds a warning that requires a human), never less.
- **Execution re-runs policy before touching a rail.** `executeObligation` in `src/lib/engine/orchestrator.ts` refuses if anything changed since approval (a duplicate appeared, details changed).
- **Idempotency on every attempt, and no re-minting after an unclear answer.** PayPal: the attempt's key is both `sender_batch_id` and the `PayPal-Request-Id` header. Stellar: the key is the transaction memo, and the adapter looks through the treasury's history (paged back up to 14 days) for a payment with that memo, destination, asset and amount before sending; if it cannot read the history it does not send. A rail answers `failed` only when the provider definitively rejected the request. A timeout, 5xx, lost response or exception is `unknown`: the obligation stays in `execution_pending`, the attempt is `unknown`, and `retryAmbiguousExecution` replays the same request under the same key. A new key is only ever issued after a definitive failure. The Stellar transaction hash is stored before the transaction is submitted.
- **One payer at a time.** Starting an execution (state check, attempt row, move to `execution_pending`) is one immediate SQLite transaction, state moves are compare-and-swap, and execution refuses while any earlier attempt is not definitively failed.
- **Approvals mean people.** Dual approval counts distinct approvers. In live mode (or with `requireSeparateApprover` in the policy) the person who ingested an obligation cannot approve it.
- **The destination is pinned at approval.** The hash of the vendor's payout details is stored when an obligation becomes approved; execution refuses (and sends it back to `blocked`) if the details were edited or no longer match.
- **Webhooks never set state.** The PayPal webhook receiver verifies the signature, stores the event once (unique index on the event id), and asks the orchestrator to re-check settlement. A forged or replayed event cannot mark anything paid. A failed processing run returns 500 so PayPal retries; only fully processed events are skipped as duplicates.
- **State transitions are whitelisted.** `TRANSITIONS` in `src/lib/domain/types.ts` lists every allowed move; anything else, including a same-state "move", is rejected.
- **Input is validated at the boundary.** Amend patches accept only `amountMinor`, `currency`, `sourceRef` and `vendorId`, each checked; the agent's output is clamped; operator-typed evidence raises a policy warning; a vendor's rolling 24h total above the policy cap (default USD 1,000) forces approval.
- **Live mode never falls back to a mock.** Missing or invalid credentials throw. A Stellar rail refuses to start on `STELLAR_NETWORK=public` with the testnet issuer or a testnet Horizon URL.

## Rails and modes

| Variable | Values | What it does |
|---|---|---|
| `RAIL_MODE` | `mock` (default), `live` | `mock` uses deterministic offline adapters with the fee model from `docs/CORRIDOR_BENCHMARK.md`. `live` uses PayPal sandbox (or live, by `PAYPAL_ENV`) and Stellar testnet (or public, by `STELLAR_NETWORK`). |
| `AI_MODE` | `mock` (default), `live` | `mock` uses a rule-based extractor. `live` calls Claude through the Anthropic API with the PayPal tools attached, and falls back to rules if the call fails. |
| `DUELINE_BASIC_AUTH` | unset (default), `user:pass` | Optional HTTP Basic auth for every page and action (see Access control). |
| `ACCOUNTING_DESTINATION` | `csv` (default), `xero` | `csv` writes the export. `xero` is the adapter interface with OAuth not yet wired. |

Mock mode needs zero credentials and is how the demo replays. The sidebar footer always shows the current modes; the demo does not pretend.

## Access control

The demo runs with no login and acts as `user:daniel`. Before pointing the app at live credentials, set `DUELINE_BASIC_AUTH=user:pass`. Every page and server action then requires that HTTP Basic credential, and the username becomes the audit actor (`user:<name>`). This is one shared credential, not role-based access control: it keeps strangers out and gives the audit log a name. A malformed value refuses all requests instead of leaving the app open. The PayPal webhook route (`/api/webhooks/paypal`) is exempt because PayPal cannot send Basic credentials; it verifies PayPal's signature instead. The demo reset is disabled when `RAIL_MODE=live`. Separation of approvers needs at least two people, which a single shared credential cannot provide: put the app behind a proxy that authenticates individual users and sets distinct usernames, or keep the policy's `requireSeparateApprover` off.

## Quick start

    npm run setup      # npm install + seed the demo database
    npm run dev        # http://localhost:3000
    # open http://localhost:3000/demo for the presenter page

Requires Node 20 or later. SQLite is bundled through `better-sqlite3`; no external database.

## Terminal proof

Output of `npm run demo:replay` in mock mode on 2026-10-03 (only the explorer line differs from the current script, which now prints "simulated hash, not on chain"):

```
> dueline@0.1.0 demo:replay
> tsx scripts/replay.ts

Rails: paypal=mock stellar=mock

1. ven_phuong INV-2026-0152: BLOCKED
   Requested USD 960.00 but Trip sheet HG-4D-0927 says USD 800.00 (+USD 160.00)
2. JOB-HG4D-0914: BLOCKED
   Reference JOB-HG4D-0914 was already used by obligation obl_ac31263aad534dee (settled)
3. JOB-HG4D-0921 USD 180.00: approved -> paypal (PayPal delivers PHP 207.24 more (1.9%) to Maria Santos (Stellar is faster).)
   submitted -> settled; batch 78DA16445A174; fee USD 3.60; recipient gets PHP 10,931.31
4. JOB-PAL3D-0927 USD 750.00: awaiting_approval -> stellar (Stellar is Ana Reyes's stated preference.)
   approved -> confirmed -> settled; tx d8392fc56753ff38cc496c44a53fe87358cfa71de96e4da570850e81b19f9907
   (simulated hash, not on chain); fee USD 13.25; recipient gets PHP 45,664.99

Result: 2 settled, 2 errors prevented, 2 accounting records exported, 173 audit entries.
```

The batch id and transaction hash above are generated by the mock adapters, which deliberately emit no explorer link. They are not real PayPal or Stellar records. See "Honesty" below.

## Live mode setup

1. Copy `.env.example` to `.env`.
2. **PayPal sandbox.** Create an app at developer.paypal.com, enable Payouts for the sandbox app, and set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox`. The agent's PayPal tools also use these credentials. For webhooks, set `PAYPAL_WEBHOOK_ID` and point the webhook at `/api/webhooks/paypal`.
3. **Stellar testnet.** Create a treasury keypair, fund it with friendbot, add a PYUSD trustline, and fund it with test PYUSD from the Google Cloud Web3 faucet or the Paxos faucet. Set `STELLAR_TREASURY_SECRET` and `STELLAR_PYUSD_ISSUER` (testnet issuer per the PayPal Developer PYUSD on Stellar post; see `docs/CORRIDOR_BENCHMARK.md` section 2). The demo recipient Ana Reyes needs a funded testnet account with a PYUSD trustline; replace her `stellarAccount` in `src/lib/demo/seed.ts`.
4. **Anthropic.** Set `ANTHROPIC_API_KEY` and `AI_MODE=live`.
5. Run `RAIL_MODE=live npm run demo:replay`. Obligations 3 and 4 will hit the sandbox and testnet.

The build environment for this submission could not reach PayPal sandbox or Stellar testnet. Live mode is implemented and type-checked but has not yet been exercised end to end. The human action queue (`HUMAN_ACTION_QUEUE.md`) lists the steps to do so.

## Tests

    npm test          # vitest: policy rules, extractor, the four-obligation story
    npm run typecheck
    npm run lint
    npm run build

125 tests in 10 files pass as of this commit. The story test (`src/lib/engine/story.test.ts`) runs the full demo through the orchestrator in mock mode and asserts each outcome.

## Project layout

    src/lib/domain/       types, policy (pure), routing (static rule), state machine, ids
    src/lib/engine/       orchestrator: ingest -> interpret -> policy -> quote -> route -> execute -> settle -> accounting
    src/lib/ai/           Claude agent, read-only PayPal tools, rule-based fallback extractor
    src/lib/rails/        PaymentRail interface, mock adapters, PayPal Payouts adapter, Stellar adapter, fee model, corridors
    src/lib/accounting/   accounting record builder, CSV export, Xero mapping
    src/lib/db/           Drizzle schema and SQLite connection
    src/lib/demo/         Ridgeline Expeditions seed data and the four-obligation story
    src/app/              Next.js App Router pages: overview, inbox, obligation detail, vendors, ledger, exceptions, accounting, audit, settings, demo
    src/app/api/          accounting CSV export, PayPal webhook receiver
    src/components/       the due line, route comparison, rule checklist, action bar, shell
    scripts/              seed.ts, replay.ts
    docs/                 corridor benchmark, UI notes, Devpost text, video script, SCF application, Xero pitch, screenshots

## Honesty

**What is mock.** Both rail adapters in `RAIL_MODE=mock`. The PayPal batch ids and Stellar hashes in the replay are generated locally. Fee and FX figures come from a published-fee model (`src/lib/rails/quoteModel.ts`, sourced in `docs/CORRIDOR_BENCHMARK.md`), not from live quotes. The AI in `AI_MODE=mock` is a rule-based extractor, not Claude. The Xero adapter maps records but does not push; OAuth is not wired. The Stellar anchor leg (SEP-31 to PeraHub) is modelled, not integrated; on testnet the Stellar adapter pays PYUSD to the vendor's wallet directly.

**What is proven.** The policy engine, state machine, routing rule, orchestrator and accounting export, by tests and by the deterministic replay. The PayPal adapter builds a correct Payouts request with idempotency headers and the webhook receiver verifies signatures in live mode (both type-checked, not yet run against sandbox). The Stellar adapter builds, signs and submits a PYUSD payment with a memo-based idempotency check (type-checked, not yet run against testnet). The Claude agent loop with PayPal Agent Toolkit tools filtered to read-only (type-checked, not yet run against the API).

**Safety review.** The money path (orchestrator, both rail adapters, webhook, policy) went through a line-by-line audit before any live credential was allowed near it. It found real problems, among them a retry that could mint a fresh idempotency key after an ambiguous failure, an unvalidated amend patch, and a silent fall-back to mock rails in live mode. All are fixed and covered by tests (`src/lib/engine/safety.test.ts` and the rail tests): ambiguous outcomes now stay "unknown" and block a second payment until reconciled, state changes are compare-and-swap inside a transaction, approvers are counted by distinct person, payout destinations are pinned at approval, and live mode fails closed. Known gaps: no fee-bump handling, no SEP-29 memo or trustline pre-check, no role-based access control, the anchor leg is not built, and the agent shares a PayPal app with Payouts scope (use a separate read-only app).

**What is next.** Exercise live mode against PayPal sandbox and Stellar testnet (the top of the human action queue). Record the video. Then: a PYUSD to USDC path payment before the anchor leg, since anchors accept USDC not PYUSD; a sending-anchor agreement with PeraHub; Xero OAuth; a second corridor (Mexico via Bitso).

**On the Stellar cost argument.** Per the benchmark, on published fees Stellar via PeraHub beats PayPal to the Philippines only above roughly USD 500, and Wise is cheaper than both. Vietnam has no licensed VND off-ramp. Dueline's value is automation, control and reconciliation first; routing cost second. The routing rule is honest about this: at USD 180 it picks PayPal.

## Licence

MIT. See `LICENSE`.

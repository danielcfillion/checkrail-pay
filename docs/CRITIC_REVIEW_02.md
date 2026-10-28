# Critic review 02 (16 Oct 2026)

An independent agent was given a clean copy of the repo, the README, the Devpost text, the video script and the judging criteria, and asked to review as a hackathon judge, a payments security reviewer and an SMB finance user. Its report follows verbatim; what was done about each item is at the end.

---

# Checkrail Pay critic review

Environment results: `npm test` 172/172 pass (15 files, 23s). `npx tsc --noEmit` clean. `npm run db:seed` and `npm run demo:replay` work in mock mode with zero credentials. Dev server: `/`, `/obligations`, `/close`, `/settings`, `/exceptions`, `/obligations/<id>`, `/vendors`, `/ledger`, `/audit`, `/accounting`, `/demo`, `/api/accounting/export` all return 200 with no "Application error" and a clean dev log. `/audit` is a 2.1 MB HTML page (500 audit rows rendered server-side, no paging).

## Must fix before submission

1. **PayPal idempotency replay is classified as a definitive failure, which is the one thing that reopens a second payout.** `src/lib/rails/paypal.ts:87-96`. PayPal rejects a reused `sender_batch_id` from the last 30 days with HTTP 400 (not the original batch). `retryAmbiguousExecution` (`orchestrator.ts:529`) replays under the same key, the adapter returns `fail(...)`, `finishAttempt` moves the obligation to `failed` (`orchestrator.ts:482`), and `failed -> approved` is a legal transition (`types.ts:41`) that mints key #2 (`orchestrator.ts:420`). The README's central safety claim ("never re-minted after an unclear answer") is false for PayPal. Fix: in `execute`, treat a 400 whose body names a duplicate batch as `submitted`, resolving `externalId` via `GET /v1/payments/payouts?sender_batch_id=<key>` (or the HATEOAS link in the error), and add a test for it in `paypal.test.ts`.

2. **The reconcile path has no UI, and the failed-retry UI is broken.** `retryAmbiguousExecution` is exported but never called from `actions.ts` or any component. A live PayPal timeout (externalId null) leaves an obligation in `execution_pending` forever. Meanwhile `ActionBar.tsx:109-124` "Retry with PayPal" calls `executeAction`, which throws "must be approved (state: failed)" because nothing transitions `failed -> approved` outside the test (`safety.test.ts:115` uses raw `transition`). Fix: add a `reconcileAction` for `execution_pending` with an unknown attempt, and have the failed-state retry go through an explicit `retryFailed` that transitions `failed -> approved` and re-pins the payout hash.

3. **README, Devpost and video script tell three different stories.** README (`README.md:27,106,180,203`) says sandbox payout "not yet confirmed", 162 tests, obligation 4 "paid via Stellar", and "Daily close does not yet flag new vendors or unusual amounts". Devpost says batch RGS5PUZPH4CNY settled, 169 tests, obligation 4 comes back UNCLAIMED on PayPal, and lists new-vendor and unusual-amount flags (which exist: `dailyClose.ts:30`). Actual test count is 172. README also says "Nov 2026" hackathon. A judge reading both will assume one is padded. Fix: regenerate README's status, story table, test count and known gaps from the Devpost version, and state once what was proven live (PayPal sandbox, Claude) and what was not (Stellar).

4. **Every screenshot shows mock mode.** `blocked-mismatch.png` reads "Rules extractor (no model call; set AI_MODE=live to use Claude)" and "Agent tool calls: None", sidebar footer "PayPal mock, Stellar mock, Agent rule-based (mock)". For a "Best Use of PayPal + AI" entry this is the first thing a judge sees. Fix: re-shoot overview, blocked-mismatch and the Maria JOB-HG4D-0921 page in `RAIL_MODE=live AI_MODE=live` with the tool-call list and the sandbox batch id visible.

5. **Autopilot ignores a cancel or pause issued during a tick.** `autopilot.ts:72-97`: `due` and `active` are read once; while `await executeObligation` runs for obligation A, a person clicking Cancel on B sets `autopilotCancelledAt`, but the loop uses the stale row (`o.autopilotCancelledAt` at line 78) and releases B anyway. Same for Pause. Fix: before each release do a conditional update `SET releaseAt=NULL WHERE id=? AND releaseAt IS NOT NULL AND autopilotCancelledAt IS NULL` and skip when `changes()=0`; re-read the policy per obligation.

## Should fix

6. **A single human approval disables every autopilot cap.** `policy.ts:206-213` gate the per-payment and daily caps on `approvalsCount < 1`. Flow: in Assist mode a person approves a USD 4,900 payment intending to send it by hand; the owner later switches to Autopilot; the sweep (`autopilot.ts:62-68`) schedules it because `policyDecision` is `auto_execute`, and it goes out as `agent:autopilot` over both caps. The Daily close screenshot literally shows "USD 640 exceeds the per-payment cap" waiting for approval, which after approval becomes an autopilot send. Fix: apply caps to autopilot release regardless of approvals, or have the sweep only schedule obligations with zero human approvals.

7. **Amount is "verified" against nothing when evidence has no amount.** `policy.ts:80-81`: R4 only runs if some evidence row carries `amountMinor`. A booking or chat evidence row with null amount satisfies R3 (`evidence_present`) and skips R4 entirely, so an obligation can reach `auto_execute` with an unchecked figure. Fix: when no evidence carries an amount, emit a `warn("amount_matches_evidence", ...)` so a person must look.

8. **Operator-uploaded PDFs are trusted as system evidence.** `orchestrator.ts:64` gives provenance `document`, and `listEvidence` (`orchestrator.ts:623`) maps anything not `operator` to `system`, so the R3b warning never fires for a self-authored PDF. The README claims operator evidence is flagged. Fix: keep `document` as its own provenance and warn unless the attachment arrived via an integration.

9. **Vendor binding is by name token, not by record.** `policy.ts:67-77`: a trip sheet that names both the driver and the guide satisfies `evidence_names_vendor` for either. Combined with the agent choosing `vendorId` (`agent.ts:170`) from injected request text, a payment can be routed to the wrong known vendor with no warning as long as the job sheet names them. Fix: require the vendor match to come from the same evidence record whose amount matched.

10. **Unauthenticated webhook in mock mode on the hosted demo.** `middleware.ts` matcher exempts `/api/webhooks/`; in `RAIL_MODE=mock` the route skips verification and inserts a row per distinct body (`route.ts:56`). I posted arbitrary JSON and got `{"ok":true}`. On Render this is an open write endpoint. Fix: return 404 when `config.rails.mode !== "live"`.

11. **Hosted demo is single shared state with a public Reset button.** `render.yaml` sets no `CHECKRAIL_BASIC_AUTH`; two judges testing at once will reset each other's walkthrough. Fix: set Basic auth in the Render env and put the credential in the Devpost "testing instructions", or make Reset per-visitor.

12. **Agent tool results are unbounded.** `agent.ts:148` passes full PayPal `list_transactions` output (vendor-controlled memos) into context; only the audit preview is sliced. Cap `out` at a few thousand characters.

## Nice to have

13. `/audit` renders 500 rows server-side (2.1 MB); page it.
14. Overview "Errors prevented $340" counts deltas while Daily close "Stopped $1,140" counts full requested amounts; pick one definition.
15. The "confirm before enabling autopilot" step is client-only; `setAutonomyAction` accepts `autonomy: "autopilot"` with a per-payment cap up to USD 1,000,000 with no server-side check.
16. `executeObligation` reads `ob`, runs policy and checks the payout hash before the transaction (`orchestrator.ts:384-396`); move `refuseIfPayoutChanged` inside the `immediate` transaction.

## Verdict per criterion (1 to 5)

- **Technological implementation: 4.** Real state machine, CAS transitions, pinned payout hash, read-only PayPal tools, 172 green tests; loses a point for the PayPal duplicate-batch hole and the unwired reconcile path, both on the money path the README brags about.
- **Design: 4.** The five-station check line, rule checklist and Daily close are clear and consistent in light and dark; the obligation page is dense but readable. Screenshots in mock mode and the 2 MB audit page cost it.
- **Potential impact: 3.** Credible SMB payables pain and an honest cost benchmark, but the Stellar leg is simulated, Vietnam cannot use it, and the anchor leg is unbuilt, so the cross-border story is mostly PayPal Payouts plus controls.
- **Innovation: 4.** "Autonomy removes the approval step and nothing else" plus a signed-off Daily close is a genuinely good framing for agentic payments; the cap bypass after approval undercuts it.
- **Presentation: 3.** Devpost text and video script are strong, but README, Devpost and screenshots contradict each other on what ran live and on the fourth obligation's outcome; a judge who cross-reads will mark it down for overclaiming.

---

## What was done about it (same day)

Must fix:

1. **PayPal duplicate batch.** `PayPalRail.execute` now treats a 400 that names an existing `sender_batch_id` as "submitted" after looking the batch up with `GET /v1/payments/payouts?sender_batch_id=<key>`; if the lookup cannot confirm it, the outcome stays unknown. `findByIdempotencyKey` is also on the rail interface, and `retryAmbiguousExecution` asks it before replaying. A replay that the rail rejects no longer becomes a failure in live mode. Tests: three in `paypal.test.ts`, two in `safety.test.ts`.
2. **Reconcile and retry in the UI.** `reconcileAction` (execution_pending, same key) and `retryFailedAction` (failed to approved with the destination re-pinned; refuses if the vendor's details changed) are wired to the obligation page. Tests in `safety.test.ts`.
3. **One story.** README rewritten to match Devpost and the live runs: what was proven (PayPal sandbox batches RGS5PUZPH4CNY and W55KNGQK57JC4, Claude live), what is simulated (Stellar), obligation 4's two outcomes, 182 tests, Nov 12 date.
4. **Live screenshots.** `scripts/screenshots.py` takes the full set from a running server. The current set was re-shot in mock mode here; the live set has to be taken on the machine with the sandbox keys (one command, in the human action queue).
5. **Autopilot race.** Each release is a conditional claim (`UPDATE ... WHERE releaseAt IS NOT NULL AND autopilotCancelledAt IS NULL`, skip when 0 rows) and the autonomy setting is re-read per payment. Test with a rail that cancels the next payment mid-execution.

Should fix:

6. Autopilot never sends a payment a person approved (sweep and release both skip it); the person sends it. Test.
7. Evidence attached but none of it carries an amount: a warning now, so a person looks.
8. `document` is its own provenance in the evidence model and the README no longer claims uploaded PDFs are flagged. Policy still compares the extracted text; weighting by who uploaded is a known gap.
9. The amount check must be satisfied by a record that names the payee; otherwise a warning.
10. Webhook route answers 404 unless `RAIL_MODE=live` (tests opt in with `CHECKRAIL_ALLOW_MOCK_WEBHOOK=1`).
11. `render.yaml` declares `CHECKRAIL_BASIC_AUTH`; Devpost text says to put the credential in the testing instructions.
12. Agent tool output capped at 6,000 characters.

Nice to have: 13 audit log paged at 100 with Older/Newest links; 14 the two figures are now labelled for what they count ("Errors prevented: the overpaid part, plus duplicates" on the overview, "Held back: requested in N requests blocked or refused" on the Daily close); 15 server-side validation already bounds the caps, left as is; 16 the payout-hash check is repeated inside the immediate transaction.

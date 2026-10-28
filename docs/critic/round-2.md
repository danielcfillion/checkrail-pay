# Critic review round 2

# Checkrail Pay critic review, round 2

**Environment checks.** `npx vitest run`: 182 of 182 pass. `npx tsc --noEmit`: clean. `npm run build`: clean. `npm run demo:replay`: works (2 of 2 settled, 2 errors prevented, 503 audit entries). With a production server on 3091, every page returns 200 with no "Application error", unknown ids return 404, the webhook returns 404 in mock mode, and `/audit` pages at 100 rows. The server has been stopped.

I could not read PayPal's Payouts docs: both docs.paypal.ai and developer.paypal.com returned HTTP 429 (rate limited). Point 1 below is therefore based on what I already know.

I tested the suspected holes with a harness against a separate scratch DB. No project files were changed: `/tmp/claude-0/-home-claude/11b88efa-03f4-5292-ba70-6074dd94746e/scratchpad/harness.ts`.

## Round-1 fixes that do not hold

1. **#9, vendor binding: a matching reference still stands in for the payee.** `policy.ts:74-75` counts a record as "naming the vendor" when its reference equals the obligation's `sourceRef`. The request text supplies `sourceRef`.
   - **Harness case:** system evidence "Trip sheet HG-4D-1009, lead guide Maria Santos, USD 180", reference JOB-HG4D-1009. A request saying "Pay Phuong Transport USD 180 (JOB-HG4D-1009)" comes out `approved / auto_execute` to Phuong with zero warnings.
   - The same sheet billed by Maria is also `auto_execute`. The duplicate check (`orchestrator.ts:196`) only looks at the same vendor's earlier payments.
   - So one job is paid twice, to two vendors. Under autopilot both go out with no person involved. This makes the README's claim "the vendor must be named by the evidence" (line 109) false.
   - **Fix:** `byRef` must not satisfy `evidence_names_vendor`; require a name match. Add a business-wide warning when an exact `sourceRef` or evidence reference already belongs to another vendor's open or paid obligation.

2. **#8, document provenance can be forged by editing the excerpt.** `orchestrator.ts:63` compares only amount, currency and reference with what the reader extracted. Label and excerpt are free to edit, and R3c reads the excerpt.
   - **Harness case:** upload Maria's trip sheet, keep the figures, prepend "Driver: Phuong Transport." to the excerpt. Result: provenance `document`, `auto_execute` to Phuong, reasons `[]`.
   - The form tells the user "anything you type or change is marked as operator-supplied" (`NewObligationForm.tsx:170`). That is false.
   - **Fix:** include label and excerpt in the "untouched" comparison, or have R3c and R4 read `attachments.extractedText`, not the excerpt typed in the form.

3. **#3, "one story": the README still contradicts itself.**
   - Line 19 says the rule extractor is "the only path exercised so far". Line 30 says Claude has run live.
   - Line 176 says live mode "has not yet been exercised end to end". Lines 29 and 206 cite settled sandbox batches.
   - Line 210 lists "Exercise live mode against PayPal sandbox" as next.
   - Line 20 says "eight rules". The obligation page shows 10 to 12.
   - The terminal proof (line 145) is dated 3 Oct with 173 audit entries and an old output format. The replay now prints 503 entries and different lines.
   - **Fix:** delete lines 176 and 210's first sentence, fix line 19, say "twelve rules" or list them, and paste today's replay.

4. **#4, screenshots: still mock.** `blocked-mismatch.png` still shows "Rules extractor (no model call...)", "Agent tool calls: None" and a sidebar reading mock/mock/rule-based. The fix is acknowledged as pending; it remains a blocker.

5. **#11, shared demo state: Basic auth does not stop judges resetting each other.** Every judge gets the same credential from the testing instructions, so Reset (`actions.ts:151`) still wipes everyone's walkthrough. The `render.yaml:19-20` comment is wrong.
   - **Fix:** scope the demo business per visitor (a cookie holding a business id, seeded on first visit), or drop Reset from the hosted build and reseed on a timer.

6. **#1, PayPal duplicate batch: safe, but probably unresolvable.** The lookup `GET /v1/payments/payouts?sender_batch_id=` (`paypal.ts:143`) is, to my knowledge, not a documented PayPal endpoint. As I understand the docs, the only batch read is `GET /v1/payments/payouts/{payout_batch_id}`, and the duplicate rejection carries a HATEOAS link to the original batch.
   - If the lookup 404s, the outcome stays `unknown`. That is safe (no second payment), but the obligation then sits in `execution_pending` forever.
   - `TRANSITIONS.execution_pending` (`types.ts:38`) allows only `sent` or `failed`, and there is no manual way out.
   - **Fix:** in `execute`, read the batch id from the `links[].href` in the 400 body before falling back. Add an audited "Resolved in PayPal dashboard" action that takes a batch id (then polls it) or "confirmed nothing moved" (to failed).

**These hold:**
- #2: reconcile and retry are wired and work.
- #5: the conditional claim in `autopilot.ts:103-108` is correct.
- #6: human-approved payments are skipped by autopilot.
- #7: a warning fires when no record carries an amount.
- #10: the webhook 404s in mock mode (verified by curl).
- #12: tool output is capped at 6,000 characters.
- #13: the audit log is paged.
- #16: the payout hash is re-checked inside the transaction.

## Must fix before submission

1. Items 1 and 2 above. Both are the money path, and both clear real money with zero warnings.
2. Items 3 and 4 above, the README and the screenshots.
3. **The video script cannot be shot as written** (`VIDEO_SCRIPT.md`).
   - **1:38 to 2:05** shows "a scheduled payment with its countdown". After a fresh seed and paying Maria at 1:02, nothing is eligible: the harness shows an empty schedule, with Ana at USD 750, above the threshold and the USD 500 cap. Typed evidence is operator-supplied and only warns, so the presenter must upload a clean PDF under USD 500 before switching to autopilot. `docs/demo-documents/` has candidates. Add that step.
   - **2:05** shows Ana UNCLAIMED. The router picks Stellar for Ana (her preference), and no step approves her or clicks "Pay with PayPal". Add both off-camera steps, or this shot never happens.

## Should fix

1. **Stored XSS on the app origin.** `attachments.ts:28` stores any MIME type. `api/attachments/[id]/route.ts:14` serves anything `text/*` or `image/*` inline. I uploaded `text/html` and `image/svg+xml` files with `<script>` and both came back inline from the app's origin.
   - A script there can call server actions (approve, execute, set autonomy) as the viewer.
   - Exploitation needs the victim to open the URL; the in-app link only appears for document-provenance rows. That is why this is Should, not Must.
   - **Fix:** accept only pdf, png, jpeg, webp, gif and text/plain at upload. Serve everything else as `attachment`. Add `Content-Security-Policy: sandbox; default-src 'none'`.
2. **Re-attaching an upload moves it.** `orchestrator.ts:58-65` never checks `att.obligationId`. In the harness, the same trip sheet ended up approved on a second obligation. The first obligation lost that attachment, and with it the document text its duplicate keys were built from. **Fix:** refuse an attachment that already belongs to an obligation.
3. **`GET /api/accounting/export` changes state.** `record.ts:120` marks records exported on a plain GET; the harness got 1 record, then 0. A judge who clicks Download twice gets an empty CSV. **Fix:** make the GET read-only and mark records exported only on an explicit POST.
4. **Devpost "The demo" describes the live sandbox run.** In the mock hosted demo that judges test, Ana settles on Stellar and is never UNCLAIMED. Add one sentence saying which outcome they will see.
5. **`/demo` "Suggested order" never mentions Autopilot or the Daily close.** Those are the entry's headline for Best Use of Agentic Commerce. Add both steps, with a clean request a judge can upload.

## Nice to have

- **CSV formula injection.** `record.ts:108` quotes fields but does not neutralise a leading `= + - @`. Descriptions are vendor-written text. Prefix such cells with `'`.
- **Rolling 24h caps use `updatedAt`** (`orchestrator.ts:212,219`; `autopilot.ts:203`). Any later write to a row moves it in or out of the window; use the settlement or attempt time.
- **Stray rejection row.** `rejectObligation` (`orchestrator.ts:296`) inserts the rejected approval before the transition, so an illegal transition leaves a stray row. Swap the order.
- **The failed-retry button is two server calls** (`ActionBar.tsx:121-124`). If the second throws (for example, the rail is unavailable), the payment sits in approved and the autopilot sweep can pick it up. That is acceptable, but say so or make it one action.

## Per-criterion verdict

- **Technological implementation: 4.** The state machine, conditional claims, pinned destination and idempotency handling are genuinely strong. The vendor binding still lets one job sheet pay two different vendors with no warning.
- **Design: 4.** The check line, rule list and Daily close stay clear and consistent. The demo page skips the autonomy features entirely.
- **Potential impact: 3.** The SMB payables pain and the controls are credible, but the cross-border story is still PayPal Payouts plus a simulated Stellar leg.
- **Innovation: 4.** "Autonomy removes the approval step and nothing else", plus an audited sign-off, is a strong framing. It loses force while the binding hole lets autopilot pay the wrong vendor.
- **Presentation: 3.** The Devpost text is good. The README still contradicts itself on what ran live, the screenshots are mock, and two video shots cannot be produced from the seed.

NOT SATISFIED

---

## What was done about round 2 (16 Oct, commit ef7cbb7)

- Vendor binding: a matching reference no longer stands in for the payee; the record must name the vendor. New warning `reference_other_vendor` when the exact reference is already on another payee's open or paid payment. Blocking reasons now come first, so a blocked payment's headline is the block.
- Document provenance: label and excerpt must also be unchanged for "document"; any edit makes the record operator-supplied (warns).
- One upload backs one payment; refused before anything is written.
- Uploads: only PDF, PNG, JPEG, WebP, GIF, plain text; 10 MB cap; served with a sandbox CSP, text as text/plain, anything else as a download.
- CSV: GET is read-only (all records); the Export button is a server action that downloads and marks; leading = + - @ neutralised.
- Stuck payments: PayPal duplicate rejection resolved from the HATEOAS link (only if PayPal confirms the batch carries our key), key lookup kept as fallback; new audited person-only "found it (batch id)" / "nothing was paid" resolution on the payment page.
- Reject is atomic (no stray rejection row).
- Hosted demo: DEMO_AUTO_RESET_MINUTES=30 restores the opening requests after 30 minutes without use; render.yaml comment corrected. Per-visitor databases were judged too invasive this close to submission.
- README: no more "only path exercised", "not yet exercised end to end" or "exercise live mode next"; fifteen checks listed; today's replay pasted; round-2 findings summarised.
- Video script: off-camera prep steps for the autopilot and UNCLAIMED shots.
- /demo: suggested order now includes uploading a demo PDF, turning on Autopilot, the try-to-fool-it documents and the Daily close; PDFs served from /demo-documents; note on mock vs live outcome for Ana. Devpost says the same.
- Not changed: rolling caps still measured from updatedAt (documented as a known gap); screenshots are being retaken live on Daniel's Mac.

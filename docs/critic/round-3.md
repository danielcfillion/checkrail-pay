# Critic review round 3

# Checkrail Pay critic review, round 3

**Environment.** `npx vitest run`: 189 of 189 pass in 16 files. `npx tsc --noEmit`: clean. `npm run build`: clean. `npm run demo:replay`: 2 of 2 settled, 2 errors prevented, 503 audit entries, which matches the README proof apart from the generated ids.

I ran the production server on 3092 against a scratch database, using `DATABASE_PATH` so I did not need the project's seed. Results:
- Every page returns 200 and unknown ids return 404.
- The webhook returns 404 in mock mode.
- Headless Chromium clicked through without a single console error: approve and pay Ana, pay Maria, upload the demo PDF, turn on Autopilot (with its confirmation), see the countdown, open the Daily close.

The server is stopped. One side effect: `demo:replay` wrote the default `./data/checkrail-pay.sqlite` in the project.

The harnesses are in `/tmp/claude-0/-home-claude/11b88efa-03f4-5292-ba70-6074dd94746e/scratchpad/r3/` (`harness.ts`, `h2.ts`, `h3.ts`, `judge.py`). I did not modify any project files.

## Round-2 fixes that do not hold

1. **Vendor binding: a trip sheet can still clear a payment to another vendor with no warnings.** The exact round-2 case now warns (A1). Close variations do not. `policy.ts:69-75` treats a record as naming the vendor if it contains *any* word of 3 or more letters from the vendor's name. Harness results, all `approved / auto_execute` with `reasons=[]`:
   - **A2:** Maria's trip sheet says "transport by van". A request to pay Phuong Transport USD 180 for that job clears.
   - **A3:** A sheet naming both "Driver: Phuong Transport" and "Lead guide Maria Santos, guide fee USD 180" clears a payment to Phuong. This is round 1 #9 word for word.
   - **A4:** Maria's sheet mentions a "family group" and a "homestay". A request to pay Linh Family Homestay clears.

   With Autopilot on, the next pass **sent A3 to Phuong and A4 to Linh**. A2 was saved only because Maria's genuine request arrived first and raised `reference_other_vendor`.

   Most vendor names contain such words: Transport, Family, Homestay, Island, Boats, Rental, Lodge, Mountain, Trekking, Collective. README:109 ("the vendor must be named by the evidence") and README:208 ("the payee must be named by the record") are therefore still false.
   - **Fix:** match the full vendor name, normalised, or a configured alias, not single words. Warn when one record names more than one known vendor.
2. **Devpost still says Basic auth stops judges resetting each other.** `DEVPOST.md:10`: "so two judges do not reset each other's walkthrough". `render.yaml` was corrected in round 2; the Devpost text was not. Replace it with the idle-reset explanation.
3. **The document-provenance fix holds for the form, but a typed `.txt` gets around it.**
   - **Holds:** editing an uploaded document's excerpt or label now marks the record operator-supplied (B1, B2).
   - **Bypass:** upload a plain-text file you typed yourself and it gets provenance `document` (B4). The form's promise that "anything you type or change is marked as operator-supplied" fails, and the README's known gap names only PDFs.
   - **Fix:** give `text/plain` uploads `operator` provenance, and update the README gap.

**These hold:**
- **Re-attaching an upload** is refused, and no half-made draft is left behind (C1).
- **The same PDF uploaded again** is blocked as a duplicate for the same vendor (C2) and warned for a different vendor (C3).
- **File types:** HTML, SVG, XHTML, CSV and Markdown are refused. An HTML file labelled text/plain is served as text/plain. A legacy text/html row is served as an octet-stream download with the sandbox CSP and `nosniff`.
- **CSV:** the GET is repeatable (32 lines both times); only the export action marks records.
- **Manual resolution:**
  - It refuses non-person actors (`agent:autopilot`, `system:cron`, `policy`, a bare `user`), malformed ids and the wrong state.
  - "Nothing moved" goes to failed, and a retry issues key #2 only after that.
- **PayPal duplicate-batch path:**
  - A linked batch carrying our key is accepted (G1).
  - A linked batch carrying another key falls back and stays `unknown` (G2).
  - No link, or the lookup failing, stays `unknown` (G4, G5).
  - End to end, a 503, then reconcile, then the duplicate link resolves to the original batch: settled, one attempt (G9).

## Must fix before submission

1. Round-2 item 1 above. It sends money to the wrong vendor on autopilot with zero warnings, and it contradicts the README's central claim.

## Should fix

1. **"I found it" accepts any id** (`orchestrator.ts:591-600`).
   - In the harness, entering the batch id of Maria's earlier settled payment marked the stuck payment settled, and two attempts now share one external id.
   - In live mode a typo leaves the payment in `sent` forever. Polling returns 404, `sent` can only move on a provider answer, and manual resolution only works from `execution_pending`.
   - **Fix:** ask the rail first. For PayPal, require the batch's `sender_batch_id` to equal the attempt's key. Refuse an id already used by another attempt.
2. **"I checked: nothing was paid" is one click with no confirmation** (`ActionBar.tsx:172`), and it is the step that allows a fresh key.
   - The page never shows the full `sender_batch_id` to search for: the attempts panel shows only the external id, and the error message shows 8 characters (`orchestrator.ts:573`).
   - **Fix:** use `ConfirmButton`, and show the full key with a copy button.
3. **A person's approval silently covers warnings that appear after it.**
   - **Harness case:** Ana is approved. Bayan then bills the same job reference, and Ana's payment executes with `reasons=[]`. `policy.ts:203,230` returns empty reasons once approvals are 1 or more.
   - README:110 says execution refuses if "a duplicate appeared". That is true only for blocks.
   - **Fix:** store the acknowledged warning ids with the approval. At execution, send the payment back to `awaiting_approval` on any new warning.
4. **`/demo` step 8 fails with a generic covering message.** The rule extractor reads the vendor only from the request text (`extractor.ts:102`).
   - With "Invoice attached, please pay.", Tam, Bayan and Rosa all come back "Recipient is not a known vendor". Bayan is blocked instead of held; Tam is blocked, but for the wrong reason.
   - With the vendor named in the message, all four behave as documented (verified on Assist and on Autopilot).
   - **Fix:** put the exact covering line next to each document on `/demo`, or fall back to matching vendors in the document text.
5. **Test counts are stale.** README:185 and DEVPOST:53 say 182 tests (README: in 15 files); the actual count is 189 in 16.
6. **Video autopilot shot.**
   - Maria's USD 225 trip sheet routes to **Stellar** (the UI shows "Ready to pay · Stellar"). In the live take (`STELLAR_RAIL=mock`) the agent's on-camera send is simulated, not a sandbox payout.
   - Prep step 2's premise, "Ana has no Stellar wallet", is false with the default seed: Ana has a `stellarAccount` and the mock Stellar rail quotes it as available. The presenter has to click "Pay with PayPal".
   - **Fix:** use `invoice-rosa-0942.pdf` for the autopilot shot. It is USD 205, Rosa has no Stellar wallet, so it goes PayPal only and becomes a real sandbox payout. Correct the step 2 wording.

## Nice to have

- **`paypal.ts:120`** trusts the linked batch when `sender_batch_header` is missing (G3). That contradicts "only if PayPal confirms the batch carries our key". Require equality.
- **`isDuplicateBatchError`** matches `/duplicate/` anywhere in the body, so an unrelated 400 ("Duplicate receiver in batch") becomes `unknown` and stuck (G6). Match `details[].field == SENDER_BATCH_ID` instead.
- **Mobile `/close`** is 428px wide at a 390px viewport. A raw `obl_…` id in a blocked reason does not wrap. Add `break-words`, and reuse the overview's "an earlier obligation" wording.
- **The upload input's `accept` list** offers `.csv`, `.md` and `text/csv`, which the server refuses (`NewObligationForm.tsx`).
- **`resetDemo` never deletes `attachments`** (`seed.ts`). Orphaned blobs of up to 10 MB pile up on the hosted demo.
- **PDFs are served inline with a `sandbox` CSP.** Click an uploaded PDF in desktop Chrome to confirm it renders; Chromium has historically refused to show PDFs in sandboxed documents. If it shows blank, drop `sandbox` for `application/pdf`.
- **The `/demo` card for Ana** says "sees a PHP bank deposit in about 15 minutes" as if it were real. The anchor leg is modelled; say so in that line.

## Per-criterion verdict

- **Technological implementation: 4.** Idempotency, conditional claims, the pinned destination and the duplicate-batch handling are now solid end to end. Payee binding by any name word is the remaining real hole.
- **Design: 4.** The check line, autonomy cards, countdown and Daily close are clear and error-free in the browser. The stuck-payment panel lacks the key a person needs, and mobile Daily close overflows.
- **Potential impact: 3.** The SMB payables pain and the controls are credible. Cross-border is still PayPal Payouts plus a simulated Stellar leg.
- **Innovation: 4.** "Autonomy removes the approval step and nothing else", plus a signed-off Daily close, remains a strong framing. It is undercut while autopilot can pay a vendor whose name merely shares a word with the trip sheet.
- **Presentation: 3.** README and Devpost now mostly tell one story. Still wrong: stale test counts, the Devpost line about Basic auth, a `/demo` step that fails with an ordinary covering message, and a live-video autopilot shot that sends on the simulated rail.

NOT SATISFIED

---

## What was done about round 3 (16 Oct, commit 82a8355)

- Payee binding (src/lib/domain/vendorNames.ts): a record names a vendor by its full name (accents and case normalised) or by a word of the name that is not a generic business word (transport, family, homestay, island, boats, rental, lodge, mountain, trekking, collective and others) and not shared with another known vendor. A2, A3, A4 are now tests (vendorNames.test.ts). When the amount-matching record names the payee and another known vendor, a warning asks a person whose amount it is.
- Approvals record the warning rule ids on screen (approvals.acknowledged_json, migration 0004). A warning that appears after approval voids it (approvals superseded, audited) and the payment goes back to awaiting approval; the same person may approve again. Test: Ana approved, then Bayan bills the same reference.
- "I found it": refuses an id used by another attempt, and asks the rail (PayPal: GET the batch and require sender_batch_id equal to the attempt's key); refuses when the provider cannot confirm.
- "Nothing was paid" is a confirm step; the panel shows the full sender batch id with a copy button.
- Plain-text uploads are operator evidence; README and form text updated. Upload picker matches the server's allow-list.
- Rule reader: when the covering message names no vendor, it takes the vendor from the attached records if exactly one known vendor is named there (shown as information; the binding rule still checks it). All four demo PDFs behave as documented with "Invoice attached, please pay."
- Video: autopilot shot uses Rosa's USD 205 invoice (PayPal only; DEMO_PAYPAL_RECIPIENT now applies to Rosa too, so it is a real sandbox payout); Ana prep step says to click Pay with PayPal explicitly.
- Devpost testing line corrected (idle reset, not Basic auth). Test counts corrected.
- PayPal: linked batch trusted only when its sender_batch_id equals our key; duplicate detection only for a duplicate sender_batch_id, not "duplicate receiver".
- Mobile Daily close wraps long reasons; reset clears attachments; demo Ana card says the Stellar leg is simulated; PDFs served without a CSP so the built-in viewer renders.

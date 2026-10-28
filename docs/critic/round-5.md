# Critic review round 5

# Checkrail Pay critic review, round 5

**Environment.** Everything passes. The server is stopped, killed by pid, including its child process.
- `npx vitest run`: 207 of 207 pass in 18 files.
- `npx tsc --noEmit` and `npm run build`: clean.
- `DATABASE_PATH=<scratch> npm run demo:replay`: 2 of 2 settled, 2 errors prevented, 525 audit entries. This matches the README.
- Production server on port 3094 against a scratch database:
  - Every page returns 200, unknown ids return 404, the webhook returns 404 in mock mode, and the tick endpoint works.
  - Headless Chromium ran the video and /demo order with no console or page errors: pay Maria 0921, approve Ana and use Pay with PayPal, upload Rosa's invoice with "Invoice attached from Rosa, please pay.", turn on Autopilot (countdown 9:58 and Cancel showed), Daily close sign-off.
- No project files were changed, and `./data` was not created.
- Harnesses are in `/tmp/claude-0/-home-claude/11b88efa-03f4-5292-ba70-6074dd94746e/scratchpad/r5/` (`h1.ts`, `h2.ts`, `judge.py`, `mkpdf.py`; the PDFs are in `pdfs/`, output in `h1.out`).

## Round-4 fixes that do not hold

None. On Autopilot with a 0-second cancel window:
- **F1, F2:** blocked (unknown vendor).
- **F3, F4:** awaiting approval with "The request names no payee; X was read from the attached record".
- **A5, A6, A7, A13:** awaiting approval with "mention X only by part of the name".
- **Autopilot sent only Maria's seeded 0921.**
- **Legitimate flows still work.** With the documented covering lines, the four demo PDFs give approved, approved, awaiting approval (cap) and blocked (duplicate), on Assist and on Autopilot. Rosa and Maria were sent; Bayan was held over the USD 500 cap.
- **With "Invoice attached, please pay."** all four wait for a person; Tam stays blocked. The page lists "Amount/Reference taken from…" under Notes, not Concerns.
- **Fingerprints cannot trap a payment.** A superseded approval can be given again by the same person (N6).

## Must fix before submission

None. I found nothing that would embarrass the entry before judges on the hosted mock demo. Nothing sent money without a person to a vendor whose name does not appear in the record's text.

## Should fix

1. **The file name can bind the payee (N1c, sent by autopilot).**
   - `proposeFromText` builds the label as kind + reference, falling back to the file name when the document has no INV/JOB-style reference. Binding reads label + excerpt.
   - **Case:** a guesthouse bill whose text never names Phuong, saved as `Phuong Transport.pdf`, with the request "Invoice INV-HV-0314 from Phuong Transport attached, please pay.". Result: `document` provenance, `auto_execute`, sent to Phuong with no warnings.
   - The same bill under a neutral file name warns "None of the attached records name Phuong Transport".
   - The file name is the operator's claim, the same as an edited excerpt in round 2. In live mode Claude is given the file name and writes its own label, so the same thing can happen there.
   - **Fix:** exclude the file name from binding text: bind on the excerpt or extracted text only, or label without the file name.
2. **An approval acknowledges warnings the approver never saw (N7, N8).**
   - The obligation page shows rules from the last `policy.evaluated` entry. Nothing re-runs policy on Ana when another payee later bills her reference.
   - **Case:** Kalaw bills JOB-PAL3D-0927. Ana's page still shows only "Amount exceeds auto-execute threshold". Approve records `reference_other_vendor|<kalaw id>` as acknowledged, and Ana pays.
   - README says each approval "records the exact warnings on screen"; that is not what happens.
   - **Fix:** re-run policy when the page renders, or have the approve action send the fingerprints it displayed and refuse when they differ from the current set.
3. **A warning's fingerprint can stay the same while the facts change (N7).**
   - `reference_other_vendor` is keyed on the other obligation's id only.
   - **Case:** Ana is approved while Bayan's payment for the same reference is awaiting approval. Bayan is then approved and paid. Ana still executes with no fresh look, so both are paid for one job.
   - `no_duplicate` is the opposite: its message includes the other payment's state, so it does re-ask (N6, harmless).
   - **Fix:** make them consistent. Add "the other one is now paid" to the fingerprint, for example the other payment's state grouped as open or paid.
4. **The "vendor read from the document" guard exists only in the rule reader.** Policy has no deterministic check that the request names the payee. In live mode, if Claude picks Maria from a guesthouse invoice that names her as group lead (F3), policy passes and autopilot sends. I could not test this without a key. **Fix:** add a policy warning when the raw request does not name the chosen vendor.
5. **Mobile vendor page overflows.** `/vendors/ven_ana`, which /demo links to, is 513px wide at a 390px viewport. The Payout details panel and the obligations table are cut off; the email and bank `dd` cells and the "verified" span do not wrap. Every other page I checked, including the obligation pages, fits.

## Nice to have

- **Full-name binding does not check the role in which the name appears.**
  - "Please pay Maria Santos" with a guesthouse invoice that names her as group lead was sent (N2).
  - "Guest: Maria Santos Cruz" (a different person whose name contains hers) bound to Maria (N3).
  - A reference such as INV-ROSA-VILLANUEVA-77 binds through the label (N4).
  - The README's wording ("name the vendor in full") is accurate. A known-gap line saying "anywhere on the record, in any role" would be honest.
- **Stale test counts.** README:185 says 200 tests in 17 files, and Devpost says 200 tests. The actual count is 207 in 18.
- **Live-mode video risk.** Every Claude flag now holds a payment. If live Claude raises any concern on Rosa's invoice, the 1:38 autopilot shot will not schedule. Rehearse the take once in live mode.
- **Stellar `externalIdMatchesKey`** checks only the memo prefix, not the destination or amount. This is fine while the Stellar rail is simulated.

## Per-criterion verdict

- **Technological implementation: 4.** Idempotency, conditional claims, the pinned destination, full-name binding and fingerprinted approvals all hold under every attack I retried. What is left is the file-name label and a stale screen at approval time, both small.
- **Design: 4.** The check line, the Notes/Concerns split, the autopilot strip with its countdown, the Daily close and the obligation pages are clear and error-free. One mobile vendor page overflows.
- **Potential impact: 3.** The SMB payables pain and the controls are credible. Cross-border is still PayPal Payouts plus a simulated Stellar leg.
- **Innovation: 4.** "Autonomy removes the approval step and nothing else", with re-approval on new warnings and a signed-off Daily close, is a strong and now well-defended framing for agentic payments.
- **Presentation: 4.** README, Devpost, /demo, the demo-documents README and the video script tell one story, and every documented step reproduces. Only the test counts are stale.

SATISFIED. The remaining items are Should-fix hardening, mostly operator-controlled or live-mode-only, plus polish. None blocks submission. Should 1 and Should 5 are each a few lines and worth doing first.

---

## What was done about round 5 (16 Oct)

Round 5 was SATISFIED. Its Should-fix items were applied anyway:

1. File names never reach a document's label (`proposeFromText` labels "kind reference" or "(uploaded, no reference)"), and Claude's document reader is no longer given the file name and is told to take labels and excerpts from the document text only.
2. Approving compares a fresh policy run with the last evaluation the page showed; a warning the page did not show refuses the approval with the new warning in the message, and the refreshed page shows it. Test in payee.test.ts.
3. `reference_other_vendor` fingerprints include whether the other payment is open or committed (approved, sending, paid), so an approval given while it was open does not cover it once it is being paid. Test in payee.test.ts.
4. New deterministic policy rule `request_names_vendor`: a warning when the request text does not mention the chosen payee, for every reader, rules or Claude. The rule reader's own concern for this case became a note to avoid a double warning.
5. Mobile vendor page and new-request form: the single-column grid no longer sizes to the longest email; long values wrap. All 22 pages checked at 390px with no horizontal overflow.

Also: test counts (208 in 18 files), README known gap on binding by name rather than role, and a live-mode rehearsal step for the autopilot shot in the video script.

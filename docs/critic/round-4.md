# Critic review round 4

# Checkrail Pay critic review, round 4

**Environment.** All of these pass or work:
- `npx vitest run`: 200 of 200 pass in 17 files, which matches the README and Devpost.
- `npx tsc --noEmit` and `npm run build` are clean.
- `DATABASE_PATH=<scratch> npm run demo:replay`: 2 of 2 settled, 2 errors prevented, 525 audit entries. README:161 still says 503.

I ran the production server on port 3093 against a scratch database with `DEMO_AUTO_RESET_MINUTES=1` and a 5-second heartbeat:
- Every page returns 200 and unknown ids return 404.
- The webhook returns 404 in mock mode.
- Headless Chromium clicked through the whole /demo order (pay Maria, approve and pay Ana, upload Rosa's invoice, turn on Autopilot and see the countdown, open the Daily close). The only console errors were the two 404 pages I opened on purpose.
- **Idle reset works.** About 60 seconds after the last person's action, the opening state and the Assist setting came back. After a reset it fires again once per idle window, because the seed writes its own `user:daniel` entries. That is harmless.

The server is stopped (killed by pid). No project files were changed, and `./data` was not created. Harnesses are in `/tmp/claude-0/-home-claude/11b88efa-03f4-5292-ba70-6074dd94746e/scratchpad/r4/` (`h1.ts`, `h2.ts`, `judge.py`, `f1.py`, `mkpdf.py`; the generated PDFs are in `pdfs/`).

## Round-3 fixes that do not hold

1. **Payee binding: the round-3 cases hold, but the new vendor-from-document fallback sends money to the wrong vendor on autopilot with zero warnings.**
   - **Holds:** A2, A3 and A4 now go to `require_approval`. A record that names two vendors warns (also with accents, "Tài xế: Phương", and the surname alone, "Santos"). A shared first name ("Maria" with a second vendor, Maria Lopez) no longer binds. An all-generic vendor name ("Island Boat Tours") binds only on the full phrase, and then warns when the same record also names another vendor.
   - **Fails:** in the hosted mock demo, an honest operator uploads a new supplier's invoice with "Invoice attached, please pay." (the exact /demo step). The rule reader picks whichever single known vendor the text happens to "name". All of these came back `approved / auto_execute` with `reasons=[]`, and the autopilot pass settled every one:
     - **F1:** "Hoang Van Guesthouse, **Tam Son** town, Quan Ba, USD 220" was paid to **Tam Motorbike Rental**. Tam Son is a standard stop on the Ha Giang loop.
     - **F2:** "Hoang Van Guesthouse, **Red Dao** village homestay, USD 140" was paid to **Dao Mountain Lodge**.
     - **F3:** "Hoang Van Guesthouse, rooms for group led by **Maria Santos**, USD 120" was paid to **Maria Santos**. Supplier invoices naming the guide are routine.
     - **F4:** "Please pay **Nguyen Hoang** USD 205" with Rosa's invoice attached was paid to Rosa. The request named an unknown payee and a different one was substituted.
   - **Reproduced in the browser.** The page shows "Evidence is tied to Dao Mountain Lodge", "cleared to pay", and a countdown on the overview.
   - **The cause.** The reader's "Vendor X taken from the attached record" note is turned into a *passing* rule (`policy.ts`, the `ai_flag` regex). Binding then accepts one distinctive word. That word is "distinctive" only against the other vendor names, not against place and ethnic-group names: Tam Son, Red Dao, Santa Ana, "bayan" (Filipino for town).
   - README:109 ("the vendor must be named by the evidence") is true only in the token sense.

2. **Approvals versus new warnings: the reported case holds (B1), but acknowledgement is per rule id, not per warning (B2).**
   - **B2:** Ana is approved after Bayan billed `JOB-PAL3D-0927`, so `reference_other_vendor` is acknowledged. Tam then bills the same reference, and Ana executes and settles with no new look. The same applies to any second instance of `ai_flag`, `amount_matches_evidence` or `no_duplicate`.
   - **Holds:**
     - A single operator is not trapped: they re-approve once and it executes (B1).
     - A warning that disappears (the other payment cancelled) does not block (B4).
     - Legacy approvals with a null acknowledgement are trusted as designed (B3).

**These hold:**
- **Manual resolution.**
  - Refused: another attempt's id (also with spaces trimmed), a lowercase variant (PayPal mismatch), a batch carrying another key, a batch with no header (the "could not confirm" path), malformed ids, and an agent actor.
  - The copy button and the "nothing was paid" confirmation are present.
- **Migration on a database created before 0004.** Built with migrations 0000 to 0003 only, it gains `acknowledged_json`, keeps its existing approvals (null), and a second migrate is a no-op.
- **The other round-3 items.**
  - A plain-text upload is operator evidence.
  - Duplicate detection reads only the batch-id field, and the linked batch must carry our key.
  - Reset clears attachments, and PDFs are served without a CSP.
  - Test counts are correct.
  - Devpost now describes the idle reset.
  - The video uses Rosa's invoice.

## Must fix before submission

1. **Item 1 above (F1 to F3).** This is the hosted demo judges will use, on the step /demo tells them to try, and it puts money in the wrong vendor's hands with no warning.
   - **Minimal fix:** make "Vendor … taken from the attached record" a *warning* (a person confirms the payee), and keep the `Amount`/`Reference` notes as information.
   - **Then:**
     - Change /demo step 6 and `docs/demo-documents/README.md` to name the vendor in the covering line ("Invoice attached from Rosa, please pay."), so Rosa's invoice still comes out pre-approved for the autopilot shot.
     - Add F1 to F3 as tests.
   - Optionally, fall back only on a full-name match in the document's issuer lines.

## Should fix

1. **Single-word binding when the request names the payee** (A5, A6, A7, A13, all `auto_execute`, all sent by autopilot).
   - Example: "Pay Tam Motorbike Rental USD 220" with a guesthouse record mentioning Tam Son. Same for "Red Dao", "Santa Ana pier" and "bayan hall".
   - **Fix:** require the full name, or a configured alias, for a no-warning bind under Autopilot. At minimum, describe the binding honestly in the README's known gaps.
2. **Acknowledgement granularity (B2).** Store a fingerprint per warning, not only the rule id: rule id plus the other vendor or obligation id, or plus the message. Then a third payee billing the same reference sends the payment back for a fresh look.
3. **The `ai_flag` pass regex also applies to Claude's flags.**
   - `/^(Amount|Reference …|Vendor .+?) taken from /` turns any live-model concern that starts like that into a pass, for example "Vendor name taken from the document does not match the request".
   - **Fix:** apply it only when `engine === "rules"`, or carry these adoption notes as structured `notes` rather than matching flag text.
4. **The obligation page contradicts itself.** "What the agent read" lists the adoption notes under **Concerns** ("3 concerns noted", confidence 95%), while Policy says "cleared to pay". A finance user cannot tell which to believe. Show them as notes.
5. **"I found it" on Stellar accepts any id.** The Stellar rail has no `externalIdMatchesKey`; in the harness, an arbitrary 64-hex hash marked the payment settled. Low stakes while Stellar is simulated, but check the memo against the key before the SCF cut.

## Nice to have

- **Mobile `/close` is still 428px at 390.** The duplicate reason's raw `obl_…` id is in a span without `break-words`; the mismatch row wraps. Reuse "an earlier obligation" there.
- **README:161 replay proof** says 503 audit entries; it is now 525.
- **A text file sent with `Content-Type: application/pdf` and a `.txt` name** is read as plain text (`documents.ts` tests the name) but gets `document` provenance. This is equivalent to the known "self-made PDF" gap; derive the reader from the stored mime only.
- **Idle reset re-arms itself** after every reset, because the seed's own `user:daniel` entries count as use. Count only entries newer than the seed, or exclude the seed's.

## Per-criterion verdict

- **Technological implementation: 4.** Idempotency, conditional claims, the pinned destination, duplicate-batch handling, the hardened manual resolution and the 0004 migration all hold. The new document fallback reopens wrong-payee autopilot sends.
- **Design: 4.** The check line, autonomy controls, countdown and Daily close are clear and error-free. Labelling cleared notes as "Concerns" next to "cleared to pay", and the mobile close overflow, cost a little.
- **Potential impact: 3.** The SMB payables pain and the controls are credible. Cross-border is still PayPal Payouts plus a simulated Stellar leg.
- **Innovation: 4.** "Autonomy removes the approval step and nothing else", with re-approval on new warnings and a signed-off Daily close, is a strong framing. It is undercut while autopilot can pay whichever vendor a place name resembles.
- **Presentation: 4.** README, Devpost, /demo and the video script now tell one story with correct counts and runnable steps. The remaining staleness is minor.

NOT SATISFIED. One fix stands between this and submission: the warning on a vendor taken from the document, plus the /demo wording. It is small, and with it I would be comfortable apart from the Should list.


---

## What was done about round 4 (16 Oct)

- Binding without a warning now needs the vendor's full name (normalised for accents, case, punctuation): `namesVendorFully` in src/lib/domain/vendorNames.ts. A partial mention (a distinctive single word) is a warning ("mentions X only by part of the name"). Mentions are still used to detect a record that names a second vendor. F1, F2, F3, F4 and A5 are tests in src/lib/engine/payee.test.ts, run on Autopilot: none is sent.
- The rule reader's vendor-from-document fallback considers full-name matches only, and is a concern (warning), not a note.
- "Amount/Reference taken from the attached record" are now `notes` on the interpretation (never reach policy), so the page no longer lists them as concerns. The ai_flag pass regex is gone: every flag, from rules or Claude, is a warning.
- Acknowledgements are fingerprints (rule id plus the other obligation's id, or the message), so a third payee billing the same reference sends an approved payment back. Bare rule ids from earlier approvals still cover their rule.
- Stellar: externalIdMatchesKey checks the transaction memo carries the attempt key's first 8 characters.
- Document reader follows the declared type only (a .txt name sent as application/pdf is read as a PDF).
- Idle reset stamps its time after seeding, so it does not re-arm itself.
- Policy messages linking an obligation id render as "an earlier payment" (no raw ids on the Daily close or checklist, no mobile overflow).
- /demo, docs/demo-documents/README.md and the video script use a covering line that names the vendor; README binding description and replay count (525) corrected.

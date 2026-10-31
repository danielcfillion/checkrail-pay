# Agent guard review, round 7 (31 Oct 2026): report and response

A seventh independent AI reviewer, new to the code, repeated the systematic regression check on commit 3239b42: 127 pairs through the integration path, the attest request_payment path and check_payment, on 3239b42, 19c1325 and b9dab64, with controls and a stubbed PayPal history. It also asked whether a hold can still let money move (it found no way: Autopilot never approves, bulk approval skips warned items, approval refuses warnings not shown, and the release re-check reruns policy). The seeded demo and all eight /demo documents decide exactly as at 502fad0. No human security audit has been done.

## Verdict

- Hosted judging demo on simulated rails: **SATISFIED**.
- Owner on a real PayPal sandbox with a live reader: NOT SATISFIED while AG7-1 stood.

## Findings and what was done

| ID | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| AG7-1 | Must-fix (regression from round 6) | A booking or order number marked as shared ("^") on one side and as a job ("~") on the other never matched, so a second payment against a paid order was neither held nor blocked; Autopilot paid it. PayPal history missed it too. | Keys are compared bare everywhere. A match blocks when both sides name the job, and holds when either side has it only as a shared record: the mark can weaken a block to a hold, never hide a match. PayPal payouts sharing only a booking or order are a hold. | Six pairings and an attest request: none paid; PayPal shared match held |
| AG7-2 | Should-fix (regression) | A booking's own number was cut out of its text as a substring, so booking "1185" turned "HG-4D-1185" into "HG-4D-". | Removed only as a whole token. | Blocked |
| AG7-3 | Should-fix | Departure forms needed "-", "_" or a space: INV.HG4D.1181, INV/HG4D/1182 and INVHG4D1183 were paid. | Any separator, or none. | Three blocked |
| AG7-4 | Should-fix (regression) | Upper-case words became departures ("NOV 2ND 2026", "ROOM 2A 1105", "PAX 4X 1200") and blocked different jobs. | In free text a departure's middle part is a number of days ("2D"). | Three not blocked |
| AG7-5 | Should-fix | Booking phrases took years, amounts, phone numbers, durations, room numbers, run-together dates and the Tagalog "po". | Five characters with a digit; years, dates, phones, amounts and "4D3N" skipped; "PO" in capitals only. | Seven phrases name nothing |
| AG7-6 | Should-fix | A dashed PO- or BK- number in the text still blocked honest weekly or deposit-and-balance invoices. | Marked as a shared record. | Held, not blocked |
| AG7-7 | Should-fix | "Payee:", "Recipient:", "X should be paid", "thanh toán cho X", "send this to X's PayPal" were not read as asking to pay X. | Added, with a passive rule and a payout-word rule. | Five held |
| AG7-8 | Should-fix | A count multiplied by itself, a 200% surcharge, a figure labelled paid added with "and", and a bare "total 190" let 380 through. | Each count used once; percentages up to 100; a paid figure is never added; a bare total is read in the currency sent. | Four held |
| AG7-9 | Nice-to-have | "as Maria Santos confirmed", "as agreed with Maria Santos", and "5% withholding deducted" held honest payments. | A clause ends at a comma and before "agreed", "confirmed" and the like; withholding and deductions take a percentage off. | Three pass |
| AG7-10 | Should-fix | The shared-record hold did not say what was already paid against the booking, or when. | It lists the earlier payments with amount, state and date, and the total paid or committed. | Asserted |
| AG7-11 | Nice-to-have | The probe key differed between spellings the duplicate check treats as one job. | Recent checks match on any shared comparison form. | Two sets of spellings: hold |
| AG7-12 | Nice-to-have | PayPal notes "Room No. 152", "Bill 152 dinner" and "Tour 2026 tips" matched short references. | "No." after a room word and "bill" are not reference words; a bare number after TOUR or TRIP needs five digits. | Not matched |
| AG7-13 | Nice-to-have | Dashed or lower-case IBANs and dashed account numbers were not redacted. | Removed. | Asserted |
| AG7-14 | Nice-to-have | reference_other_vendor told any agent that another supplier billed a reference and how far that payment got. | Agents are told only that the reference is on another supplier's payment. | Asserted |

All 14 new regression tests fail against the code before the fix and pass after it.

## Also fixed while testing

- Every check copied the whole database into native memory and never released the copy; the guard now closes each copy as soon as the check is done. In a long-running server that would have grown with every agent call.
- The guard test file kept a hundred seeded in-memory databases open and outgrew the test worker; it now closes them after each test.
- A production server from round 2's smoke test was still running in the sandbox (the review noticed it); it was stopped by its PID.

733 tests in 71 files (one skipped); typecheck, lint and build are clean.

## Regression check after the fixes

A 62-pair corpus (the round 6 pairs plus the round 7 table) on this commit, 19c1325 and b9dab64. Every pair carrying a booking or order number in any form is held or blocked, never paid. No pair decides worse except by design: a shared booking or order holds where 19c1325 blocked (round 6's design), and 10234-A against 10234-B blocks as one re-issued job. Still wrong on all three: a glued suffix (INV-2026-0452B), INV-ROSA-0834 against ROSA-0834 and INV-2026-152 against INV-20260152 are held rather than blocked; a contract number in invoice text and an earlier invoice cited in the text still block an honest payment.

## Money-path changes for a human read

`src/lib/domain/ids.ts` (bareKey, departureForms, DEPARTURE_LOOSE, soft BK/PO text keys, bookingKeys), `src/lib/domain/policy.ts` (bare matching with strength, shared-record message, PayPal shared hold), `src/lib/domain/paypalHistory.ts` (shared matches, note words), `src/lib/domain/types.ts`, `src/lib/engine/orchestrator.ts` (whole-token reference removal).

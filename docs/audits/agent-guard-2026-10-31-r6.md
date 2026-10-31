# Agent guard review, round 6 (31 Oct 2026): report and response

A sixth independent AI reviewer, new to the code, ran a systematic regression check of duplicate decisions on commit 19c1325 against b9dab64 (before any reference rewrite): 132 pairs, each through the integration path, the attest agent path and check_payment, with no-first-payment controls and a stubbed PayPal history for payments made by hand. It also re-tested round 5, attacked the cross-check and redaction, and diffed the seeded demo and all eight /demo documents against 502fad0 (identical apart from the random PayPal id). No human security audit has been done.

## Verdict

- Hosted judging demo on simulated rails: **SATISFIED**.
- Owner on a real PayPal sandbox with a live reader: NOT SATISFIED while AG6-1 stood.

19c1325 decided better than b9dab64 on 41 pairs (respellings, shared records, hand-typed PayPal notes) and worse on the pairs behind AG6-1 to AG6-6.

## Findings and what was done

| ID | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| AG6-1 | Must-fix (regression from rounds 4 and 5) | An invoice named after a departure (INV-HG4D-1031) no longer matched the departure (HG-4D-1031, JOB-HG4D-1031), so Autopilot scheduled the second payment. | When INV, PO, BK or REF is followed by a departure-shaped code, the code's forms are keys too. INV-TAM-0834 and PO-TAM-0834 stay apart. | Eight pairs blocked; attest request blocked; the TAM pair is not |
| AG6-2 | Should-fix (regression) | Contract records were not read at all, so a charter for one departure no longer linked its invoices. | Contracts are read without their own number. | Blocked |
| AG6-3 | Should-fix (regression) | Placeholder or date references ("N/A", "TBC", "ROSA", "2026-10-31") on records made different jobs one job. | Record keys are comparison forms only (a digit is needed) and dates are skipped. | Five cases, no block or hold |
| AG6-4 | Should-fix | The older key ran numbers together across separators (INV-12-345 = INV-123-45, INV-2026-1-123 = INV-2026-11-23). | The older key is removed; a long number is run together only when it has at most two parts. | Two pairs not blocked |
| AG6-5 | Should-fix | A shared booking or purchase order was a hard block, so honest deposit-and-balance and weekly invoices were blocked. | A match only through a booking or purchase order (record or text) is a hold for a person: Autopilot never sends it. | Four cases held, not blocked |
| AG6-6 | Should-fix (regression) | A short bare number in a PayPal note ("Room 152", "1031 pax") matched TRIP-152 or JOB-1031. | A short bare number counts only after a word that makes it a reference ("Invoice No 152") or as the whole note. | Two not matched, one matched |
| AG6-7 | Should-fix | A trip written "CEB2D1107" or "CEB 2D 1107", or a booking named only in the text, did not link invoices. | Departure codes are read in any spelling in free text; "booking BKG-…" phrases give a shared-record key. | Blocked and held |
| AG6-8 | Should-fix | Only the first supplier after the first paying phrase counted: "do not pay Rosa; pay Maria", "transfer USD 190 to Maria", "pay Rosa's partner Maria", "payment to", "money goes to", "deposit into Maria's account", full-width or zero-width names were scheduled to Rosa. | Every paying phrase is read, within its clause; possessives that are not an account are skipped; more phrases; NFKC and zero-width removal first. The older "another supplier named first" rule is replaced by "names other suppliers and never the payee". | Eight cases held |
| AG6-9 | Should-fix | Amount bypasses: the payee's name broke the asked-figure window; any figure times any count; any two figures summed; full-width digits not read. | Names are removed before amounts are read; only a figure marked as a rate is multiplied; only a figure added with "plus" or a fee is summed; NFKC. | Six cases held |
| AG6-10 | Should-fix | False holds on honest arithmetic (rate after an asked figure, plus a fee, less a deposit, less a discount percentage, rate plus fee) and on passing mentions ("photo credit", "credit note", a boat company, "transfer to Maria's boat"). | Arithmetic applies to the asked figure; "credit" only as "credit to"; a clause ends at ";" or "."; possessives skipped. | Nine cases pass |
| AG6-11 | Should-fix (one agent affects another) | A request-scope agent's unapproved request gave another supplier's honest request a reference_other_vendor hold. | Unapproved untrusted requests and drafted or waiting-for-evidence ones are left out of that check. | No hold |
| AG6-12 | Nice-to-have | The probe key differed between INV-2026-0452 and INV20260452. | A long number is keyed run together. | Hold |
| AG6-13 | Nice-to-have | An unspaced IBAN after "IBAN", bullet and x masks were not redacted. | Removed. | Asserted |

All 13 new regression tests fail against the code before the fix and pass after it. One older test now gets a stronger result: a reference spoofed with an Armenian letter is still flagged for the look-alike, and the departure inside it is now matched to the job already paid, so it blocks instead of holding. 719 tests in 71 files (one skipped); typecheck, lint and build are clean.

## Regression check after the fixes

A 44-pair corpus taken from the reviewer's table (integration path, first payment settled, second at a different amount), run on this commit and on b9dab64: no pair decides worse except 10234-A against 10234-B, which now blocks as one re-issued job by design. Shared bookings and purchase orders hold where b9dab64 paid. Still wrong on both: a glued suffix (INV-2026-0452B) and INV-ROSA-0834 against ROSA-0834 and INV-2026-152 against INV-20260152 are held, not blocked; a contract number written in invoice text, and an earlier invoice cited in the text, still block an honest payment (a person can see the reason).

## Money-path changes for a human read

`src/lib/domain/ids.ts` (departure forms, no older key, compact rule, bookingKeys, isDateLike, jobOfRef), `src/lib/domain/policy.ts` (shared-record hold), `src/lib/domain/paypalHistory.ts` (short bare numbers), `src/lib/engine/orchestrator.ts` (record kinds, contract text, other-supplier exclusions).

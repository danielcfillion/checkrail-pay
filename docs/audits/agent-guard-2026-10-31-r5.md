# Agent guard review, round 5 (31 Oct 2026): report and response

A fifth independent AI reviewer, new to the code, re-tested round 4 and attacked its reference rewrite in both directions (branch `feat/agent-guard`, commit c91a459). It diffed the seeded demo and all eight /demo documents under Assist and Autopilot against 502fad0 (empty diff), imitated a live reader by wrapping the reader, and compared each attack with older commits in scratch worktrees. No human security audit has been done.

## Verdict

- Hosted judging demo on simulated rails: **SATISFIED**. No demo outcome changed; keyless visitors can only check. AG5-1 could double-pay simulated money only if the presenter fed in a request built that way, which the demo story never does.
- Owner on a real PayPal sandbox with a live reader: NOT SATISFIED while AG5-1 stood.

## Round 4 findings, re-tested

Fixed: AG4-1 (two edge forms left: INV-2026-152 against INV-20260152, and INV-2026-1-123 merging with INV-2026-11-23), AG4-5, AG4-6, AG4-8, AG4-9, AG4-11. Partly fixed: AG4-2 (AG5-1, AG5-2), AG4-3 (AG5-3), AG4-4 (AG5-5), AG4-7 (AG5-4), AG4-10 (AG5-6).

## Findings and what was done

| ID | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| AG5-1 | Must-fix (regression from round 4) | Two invoices whose only shared identifier is a booking or purchase order were both scheduled and paid by Autopilot, for integrations and attest agents. Round 4 had limited reference keys to invoice, job sheet and receipt records. | Bookings and purchase orders name one job again (`SINGLE_JOB_KINDS` in orchestrator.ts). | Three booking and PO spellings blocked; the attest agent's second request blocked |
| AG5-2 | Should-fix | A contract's number shaped like a job id (RC-2026-0042, PO-2026-0042) still blocked every later payment, because the text of every record was scanned. | Contract records are not scanned for job identifiers. | Four contract numbers, no block |
| AG5-3 | Should-fix | INV, PO, BK and REF were still stripped for long numbers by the older key, so INV-2026-0152 blocked PO-2026-0152, contradicting the docs. | Only JOB, TRIP and TOUR are stripped, in every key. The docs now say JOB-152 and a bare 152 are one job. | Five pairs not blocked |
| AG5-4 | Should-fix | Cross-check bypasses (a date or a reference digit counted as a multiplier; a difference of two figures passing against an explicit "Pay USD 230"; "beneficiary is", another supplier named first; "pay 95 only" beside a currency amount) and false holds ("CEB 2 day trip", "Inv 1 of 2", "USD 180 plus USD 10", a season total, "send the receipt to", "12 guests" read as USD 12). | A figure the text asks to pay must be the amount sent. Counts need a unit word; references and dates are not counts. Sums of two figures, a difference only against a figure labelled paid or a deposit, and stated percentages follow; no part exceeds a stated total. "Send" and "transfer" count only with money words; "beneficiary" and "credit" are paying phrases; another supplier named in full before the payee is a concern. Unseparated ids need three digits. | Six bypasses held; nine honest phrasings pass |
| AG5-5 | Should-fix (sandbox) | Hand-typed PayPal notes with short references ("Invoice 4471", "R12") were missed, and a five-digit amount in a note matched a bare reference. | Amounts are taken out of the note first; word-run forms from three characters, matched only against the request's own reference forms. | Short references found; an amount not read as one |
| AG5-6 | Nice-to-have | The probe key changed with the spelling (JOB-, TRIP-, zero padding). | The probe keys on the departure form of the re-issue base. | Three spellings: hold |
| AG5-7 | Nice-to-have | An unspaced PO number was redacted as an IBAN; account endings, federation addresses and truncated Stellar addresses were not. | IBANs only in groups of four; the three patterns are removed. | Asserted |

All 8 new regression tests were run against the code before the fix and failed, then passed after it. One older policy test used a hand-written key in the old form and now computes its keys with `jobKeys`, as the reviewer predicted. 706 tests in 71 files (one skipped); typecheck, lint and build are clean; the demo story suites pass unchanged.

## Left open

The two AG4-1 edge forms above (a reference written once with and once without a separator inside its number, and the eight-digit compact form merging two numbers), and two untrusted agent requests for one job showing no duplicate note (AG4-12). None lets money move twice in the reviewer's tests: the first is a missed match that the other rules and a person still see, the second is refused at approval.

## Money-path changes for a human read

`src/lib/domain/ids.ts` (JOB/TRIP/TOUR only, jobOfRef), `src/lib/domain/paypalHistory.ts` (amounts out of notes, three-character forms) and `src/lib/engine/orchestrator.ts` (booking and purchase-order keys, contract text not scanned).

## What the reviewer could not break

The demo outcomes; per-field concerns (only a person clears one, only for its own field, and an agent cannot spoof the field through its wording); unresolved concerns carried on repayment; a live reader falling back to rules adding its own hold; a non-attest agent's open request not blocking an integration's honest job; agent isolation for the probe, idempotency and status; check_payment writing only its log row; no PayPal email, full Stellar address, IBAN or masked account in any answer tested.

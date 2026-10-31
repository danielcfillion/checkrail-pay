# Agent guard review, round 8 (31 Oct 2026): report and response

An eighth independent AI reviewer, new to the code, repeated the regression check on commit a86eb7b with 142 pairs (55 duplicates, 26 shared-record pairs, 50 honest pairs, 12 PayPal hand-paid notes) through three paths on four commits (a86eb7b, 3239b42, 19c1325, b9dab64), with controls. It corrected one flaw in earlier corpora: the second payment now carries its own support, so "held" means the duplicate was caught, not that support was missing. The seeded demo and all eight /demo documents (88 rows) match 502fad0. No human security audit has been done.

## Verdict

- Hosted judging demo on simulated rails: **SATISFIED** (the sixth round in a row).
- Owner on a real PayPal sandbox with a live reader: NOT SATISFIED while AG8-1 stood. AG8-1 fails the same way on all four commits; it is a gap, not a regression.

Every pair where a86eb7b decided worse than an older commit was an intended, documented change (shared records hold) except SEAT/ROOM codes (AG8-5) and the payee-clause cut (AG8-2). No hold was scheduled by Autopilot.

## Findings and what was done

| ID | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| AG8-1 | Must-fix (on all commits) | A departure in invoice text in lower case, or with "." or "/" between its parts ("ceb 2d 1303", "CEB/2D/1310"), was not read, so a second payment was scheduled; PayPal history missed it too. | Free-text departures are read in any case with any of - _ . / or a space. | Five spellings blocked |
| AG8-2 | Should-fix (regression from AG7-9) | Cutting the paying clause at a comma or a bare "as" let "Please pay, for the guiding, Maria Santos" and six similar texts through. | Only attributions are taken out ("as agreed with", "confirmed by", "as Maria confirmed", "according to"); the clause runs to a full stop or semicolon. | Seven held; the AG7-9 honest case still passes |
| AG8-3 | Should-fix | A booking or order filed under a departure code (booking "HG-4D-1184", order "PO-CEB2D-1307", "Booking ceb2d1305") turned a block into a mislabelled shared-record hold. | A booking or order that is, or is named after, a departure keeps that departure as a job key. | Three blocked |
| AG8-4 | Should-fix (on all commits) | A letter glued to the number ("INV-2026-0452B") was not a re-issue, so it was paid when it had its own support. | A single trailing letter after the number is a re-issue suffix. | Blocked |
| AG8-5 | Should-fix | "SEAT 14D 1105" and "ROOM 12D 2045" (new since AG7-4), and "Oct-31-2026", "Rm-2-101", "Gate-3-1100", "Trip MNL 1D 2026" (older), blocked honest payments. | Room, seat, gate, month, weekday and common short words are not departure prefixes; a year as the trip number counts only when the code is dashed (so HG-3D-2099 still does). | Six not blocked |
| AG8-6 | Nice-to-have | A PayPal note "PO 7798 week 1" blocked where the books hold. | Note word runs that start with PO, BK, BKG or booking are shared records. | Shared, not matched |
| AG8-7 | Nice-to-have | "Booking Q4-2026" held honest invoices. | Season labels are not bookings. | Asserted |
| AG8-8 | Nice-to-have | Redaction removed ordinary words ("id42 that will") and missed "xxxx-4417", "ending 4417", "…4417", "Acc. 4417221". | IBANs without spaces matched in capitals only; the masks added. | Asserted |

All 8 new regression tests fail against the code before the fix and pass after it. 741 tests in 71 files (one skipped); typecheck, lint and build are clean. A 62-pair corpus against round 7's results changes on exactly two pairs, both intended (a glued suffix and a booking filed under a departure now block).

## Still open after round 8

- INV-ROSA-0834 against ROSA-0834, and INV-2026-152 against INV-20260152: not matched, so a second payment with its own support can be paid (on all commits).
- A contract number written in invoice text, and an earlier invoice cited in the text, still block an honest payment (a person sees the reason).
- Two untrusted agent requests for one job show no duplicate note (AG4-12); approving the second is refused.
- No ninth round was run: see the note to the founder in the response.

## Money-path changes for a human read

`src/lib/domain/ids.ts` (DEPARTURE_LOOSE, NOT_A_DEPARTURE, isDepartureRef, REISSUE, bookingKeys), `src/lib/domain/paypalHistory.ts` (shared note runs), `src/lib/engine/orchestrator.ts` (departure keys on booking and order records).

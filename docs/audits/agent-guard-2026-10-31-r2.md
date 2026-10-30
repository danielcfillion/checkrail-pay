# Agent guard review, round 2 (31 Oct 2026): report and response

A fresh independent AI reviewer, with no part in the build or in round 1, re-tested the round 1 fixes and attacked the agent guard again (branch `feat/agent-guard`, code at commit 2b81bd3). It wrote its own attack tests on the seeded demo with simulated rails and the rule-based reader, then deleted them. No human security audit has been done.

## Verdict

- Hosted judging demo on simulated rails: SATISFIED on condition that AG2-7 is closed (it is, below).
- Owner on a real PayPal sandbox with live Claude: NOT SATISFIED while AG2-1 stood.

## Round 1 findings, re-tested

| ID | Reviewer's finding | Now |
|---|---|---|
| AG-1 | Partly fixed: the basic cases block, but the reference sent was still not what was judged (AG2-1) and the comparison could be beaten (AG2-3). | Replaced by fixed fields (below). |
| AG-2 | Fixed within one process. Across processes the queue does not apply; the re-check at release refused the second, so one payment attempt in total. | Unchanged; documented in `docs/AGENTS.md`. |
| AG-3 | The route refuses correctly, but the middleware matcher still covered /api/mcp, so Next copied up to 10 MB of each body for the middleware. | `/api/mcp` left out of the matcher; the compiled matcher was checked after the build. |
| AG-4, AG-5, AG-8 | Fixed. AG-8 nice-to-have: a newline in the description put a fake header on its own line on the request page. | Whitespace in the description is collapsed to spaces. |
| AG-6 | Partly fixed (AG2-4, AG2-6). | See below. |
| AG-7 | Fixed, with side effects (AG2-5). | See below. |

## New findings and what was done

The root cause of AG2-1, AG2-2, AG2-3 and AG2-9 was one design choice: the agent's fields were flattened into text and the reader took the payee, amount and reference back out of it. The fix changes that choice. The payee, amount, currency and reference an agent sends are now **fixed on the request** (`IngestInput.stated`, written as an `obligation.stated` audit row and applied in `processObligation`, the same way a person's correction is). The reader still describes and flags the request, but cannot replace those four fields, so what is judged is exactly what would be paid. The agent's own description is compared with its fields separately, and a disagreement is a hold for a person, never a block and never a prompt to change a field.

| ID | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| AG2-1 | Must-fix | The reader replaced the agent's reference: a second request for job 10234 with a record saying 10234-B was scheduled, and Autopilot paid one job twice. A check sending RV77 again with another invoice number in the text came back pay. | Fixed fields: the reference sent is the one judged, so the duplicate rule sees it. A record whose reference differs from the one sent is flagged. | Second request not scheduled and keeps 10234; the RV77 check blocks |
| AG2-2 | Should-fix | An agent named "tour-desk" made the reader take TOUR-DESK as the reference. | The header Checkrail writes no longer carries the agent's name (the audit log does), and the reference is fixed to what was sent, or none. | No TOUR-DESK reference, no agent name in the text |
| AG2-3 | Should-fix | The comparison refused honest requests ("USD 190 (about PHP 10,830)", an earlier USD 380, a deposit already paid, a contract total, a second supplier in passing), could be beaten by a header the reader preferred, depended on the length of the supplier's name, and told agents to resend the reader's figure. | The description alone is compared with the fields: another supplier named without the payee, no stated amount in the currency matching the one sent, or another reference. A disagreement is a hold (`agent_mismatch`), and its guidance now says not to change a field to match. | Five honest phrasings carry no flag; the other-payee and both name lengths are held |
| AG2-4 | Should-fix | Redaction replaced substrings ("banana", "Rosa Villanueva" cut by a supplier called "Rosa"), missed first names and accents, missed accented email domains, and cut references like INV-2026-000123. | Whole words with accents set aside; distinctive parts of other names count; the payee asked about is never cut; emails of any script; digit runs inside a reference are left whole. | Each case asserted |
| AG2-5 | Should-fix | The probe hold refused an honest batch of three different departures for one guide, and counted PHP checks towards a USD hold. | The probe key is the supplier, the currency and the reference. | Three jobs pass; PHP checks do not hold USD |
| AG2-6 | Nice-to-have | lookup_payee suggested suppliers for generic words. | Generic business words suggest nothing. | Five generic words, no suggestions |
| AG2-7 | Should-fix for the demo | A keyless visitor's request could block the presenter's. | Keyless demo callers get `check` only. | No request tool listed or callable |
| AG2-8 | Should-fix | "Huong Giang Boats" did not find "Hương Giang Boats". | A payee matches the one supplier whose name is the same with accents set aside. | Lookup and check find the supplier |
| AG2-9 | Should-fix | A payee given by contact email was checked with the supplier's name but requested with the email, so the request was refused and left cancelled. | Check and request write the same header, with the supplier's name on file. | Same outcome both ways |
| AG2-10 | Nice-to-have | A refused key could never be reused; VND "4320000.50" was accepted and then blocked with a confusing message. | A key whose request was refused (nothing created) can be used again; the refusal stays in the log and still counts towards the probe. VND amounts must be whole. | Key reused after the window; VND decimals refused |

All 21 new or changed regression tests were run against the code before the fix and failed, then passed after it. 674 tests in 71 files (one skipped); typecheck, lint and build are clean. A production build was smoke-tested: pages need a login, `/api/mcp` needs a key, and the compiled middleware matcher skips `/api/mcp` only.

## Money-path change for a human read

`src/lib/engine/orchestrator.ts`: `IngestInput.stated`, the `obligation.stated` audit row written inside the ingest transaction, and `applyStated()` called from `processObligation` before a person's own corrections (which still win). It is internal: no form or server action passes `stated`; only the agent guard does. Under CONTRIBUTING.md a person reads it before merge, together with round 1's `linkToBill` change.

## What the reviewer could not break

- withdraw() cannot cancel another agent's request, and payment_status reads only the caller's own requests.
- check_payment writes nothing to the books beyond its log line.
- A fake header inside the description stays inside the quotes.
- The route refuses an over-size body.
- An agent-typed invoice creates no bill ceiling.
- A changed PayPal email in the text never moved money.
- A duplicate job that slips into the schedule through a cross-process race is refused at release.

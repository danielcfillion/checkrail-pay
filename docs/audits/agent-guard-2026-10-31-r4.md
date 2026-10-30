# Agent guard review, round 4 (31 Oct 2026): report and response

A fourth independent AI reviewer, new to the code, re-tested round 3 and attacked the canonical reference key in both directions, since it affects every payment (branch `feat/agent-guard`, commit 502fad0). It seeded the demo and uploaded all eight /demo documents under Assist and Autopilot on 502fad0 and on b9dab64, imitated a live reader by wrapping the reader, and repeated each attack on the older commit to tell regressions from older gaps. No human security audit has been done.

## Verdict

- Hosted judging demo on simulated rails: **SATISFIED**. Every demo outcome was identical on both commits, apart from the random PayPal transaction id. A keyless visitor can only check. Condition: the "One job, one key" claim in docs/AGENTS.md matched the code only for longer references (AG4-1, now fixed and the claim made exact).
- Owner on a real PayPal sandbox with a live reader: NOT SATISFIED while AG4-1, AG4-2, AG4-4 and AG4-5 stood.

## Round 3 findings, re-tested

Fixed: AG3-3 (no double payment in any order tried), AG3-7, AG3-9, AG3-10. Fixed for the listed cases: AG3-8. Partly fixed: AG3-1 (AG4-1, AG4-4), AG3-2 (AG4-5), AG3-4 (AG4-7), AG3-5 (AG4-6, AG4-7), AG3-6 (AG4-10).

## Findings and what was done

| ID | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| AG4-1 | Must-fix | A short or zero-padded reference was still not matched: INV-152 settled, INV_152 scheduled; INV-0152, INV 152 approved. | References compare in `canonicalForms` (`src/lib/domain/ids.ts`): letters and digits only, leading zeros dropped in each number, three characters with a digit is enough. | INV_152 blocked; six spellings carry no_duplicate; an integration with spaces is blocked |
| AG4-2 | Must-fix (sandbox) | A regression from round 3: a reference on a shared contract or rate sheet (TAM-RATES-2026, CONTRACT-TAM-2026, AGR-0042) blocked every later payment to that vendor, for clerks and integrations too, and a person could not clear it. AGR-TAM-2026 was already blocked before round 3. | Reference keys come only from records that name one job (invoice, job sheet, receipt). AGR is no longer stripped, so the agreement exclusions apply. | Three contract references, no block |
| AG4-3 | Should-fix | Different jobs shared a key: INV-1182 blocked PO-1182, BK-1182 and 1182; 2026-1-12 blocked 2026-11-2; BKK-0912 lost its prefix; letters outside ASCII were deleted. | Only JOB, TRIP and TOUR are set aside as a prefix; two numbers kept apart by a separator stay apart; accents and Đ are folded and other scripts kept; INVOICE reads as INV. | Four pairs not blocked; key comparisons asserted |
| AG4-4 | Should-fix (sandbox) | PayPal history matched only dash-shaped notes, so a payment typed by hand in the PayPal app ("JOB HG4D 0914 guide fee") was missed. | Every run of one to four words in the note and subject is compared in reference form (five characters or more, so a bare amount never matches). | Four hand-typed notes found; an amount-only note not |
| AG4-5 | Should-fix (sandbox) | A live reader's concern was still dropped if it began "Requested amount differs from", and a person's amount correction removed any "differs from" concern on any request. | Both filters apply to the rules reader only, matched from the start of its own sentence. | A live reader's concern holds the request |
| AG4-6 | Should-fix | Any amendment cleared the agent's whole concern, even USD to USD, and Autopilot then sent it. | One concern per field; a concern clears only when a person changes that field to a different value. | A no-change amendment leaves the hold |
| AG4-7 | Should-fix | Rate multiples passed against a stated total; another trip written as JOB-CEB3D-1102 or CEB3D1102 passed; "payable to", "release the fee to" and "pay 95 only" passed. | A multiple needs the counts stated in the text and no differing total; families compare in reference form, including unseparated ids; more paying phrases; an amount without a currency counts. | Six cases held; an honest rate total passes |
| AG4-8 | Nice-to-have | The other-supplier check and the record check compared references exactly. | Both compare in reference form. | A respelled reference matches its record |
| AG4-9 | Nice-to-have | Repaying a returned request brought back a concern a person had resolved. | Concerns for fields a person changed are not carried. | Not carried |
| AG4-10 | Nice-to-have | Re-issue suffixes got around the probe hold. | The probe keys on the re-issue base. | Suffixes then the base: hold |
| AG4-11 | Nice-to-have | Muxed Stellar addresses, IBAN-style numbers and full-width @ emails were not redacted; a reference containing another supplier's word was mangled. | NFKC first; both patterns removed; words inside a reference stay. | Asserted |
| AG4-12 | Nice-to-have | Two untrusted requests for one job both wait without a duplicate note; approving the second blocks it. | Not changed: only what the owner sees, and approval is refused correctly. | |

All 11 new regression tests were run against the code before the fix and failed, then passed after it. 698 tests in 71 files (one skipped); typecheck, lint and build are clean. The demo story suite passes unchanged.

## Money-path changes for a human read

`src/lib/domain/ids.ts` (canonicalForms, sourceRefKeys, jobOfRef, jobKeys), `src/lib/domain/policy.ts` (own-reference keys), `src/lib/domain/paypalHistory.ts` (note word runs) and `src/lib/engine/orchestrator.ts` (single-job record keys, reader-aware filters, per-field agent concerns, other-supplier reference forms). Duplicate matching changes for every request.

## What the reviewer could not break

No double payment through untrusted open requests in any order; the quote marker cannot be forged; requests and idempotency keys are kept apart per agent and duplicate agent names are refused; JSON-RPC batches are refused, so the in-flight limit holds; Unicode in agent references is refused; the PayPal email is redacted and check_payment writes only its log row.

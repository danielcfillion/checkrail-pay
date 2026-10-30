# Agent guard review, round 3 (31 Oct 2026): report and response

A third independent AI reviewer, new to the code, re-tested round 2's fixes and attacked the fixed-fields design (branch `feat/agent-guard`, commit b9dab64), with its own attack tests on the seeded demo, simulated rails and the rule-based reader, plus the production build for the endpoint checks. It had no live Claude and imitated one by wrapping the reader. No human security audit has been done.

## Verdict

NOT SATISFIED for both the hosted judging demo and an owner on a real PayPal sandbox with a live reader: AG3-1 for both, AG3-2 for the live reader.

## Round 2 findings, re-tested

Fixed: AG2-2, AG2-5 (as specified), AG2-6, AG2-7, AG2-8, AG2-9, AG2-10, AG-3 (on the built server: a 9 MB chunked body gets 413 in 7 ms). Partly fixed: AG2-1 (AG3-1), AG2-3 (AG3-4, AG3-5), AG2-4 (AG3-8), AG-8 (AG3-9). The reviewer confirmed that only the agent guard sets fixed fields, that the stored request always equalled what was sent, and that a person's corrections still win.

## Findings and what was done

| ID | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| AG3-1 | Must-fix | A reference written with other separators ("JOB HG4D 0914", "JOB_HG4D_0914", "JOBHG4D0914") skipped the duplicate check and PayPal's history: an attest agent's request for a job PayPal had already paid was scheduled and paid. "10234" then "10234-B" were both scheduled. Integrations were exposed the same way. | One canonical key for every reference (`canonicalRef`, `sourceRefKeys` in `src/lib/domain/ids.ts`): look-alike letters folded, case and separators dropped, prefix dropped, and the original of a re-issue suffix. Used for this request's keys, every earlier request's keys, PayPal's history (both sides) and the probe. Agent references must match the reference format (no spaces or line breaks). | Five spellings block with no_duplicate and paypal_history; the attest request is blocked; an integration with spaces is blocked; 10234-B is blocked |
| AG3-2 | Must-fix (live reader) | Any reader concern containing "differs from" was dropped on an agent's request, so a live reader's impersonation warning vanished. | Only the rules reader's own two sentences, matched from their start, are dropped. | A wrapped reader's concern holds the request |
| AG3-3 | Should-fix | An agent without attest could park an unapproved request naming other jobs and block other agents' honest payments. | An open, unapproved request from an outside agent without attest does not count as an earlier payment for the job; once approved, or with attest, it does. Committed money always counts. | The bookings agent's real job is not a duplicate |
| AG3-4 | Should-fix | The cross-check missed an amount in another currency, a text asking to pay another supplier it named beside the payee, another trip of the same kind, and a text naming nobody (the header always named the payee, so the policy rule never fired). | Amounts in any currency count; the supplier named after a paying verb must be the payee; a reference of the same family that is another job is flagged; policy reads the agent's own words for request_names_vendor. | Four cases held |
| AG3-5 | Should-fix | False holds for day rates and a total less a deposit; a person's correction left the agent's disagreement on the request. | A whole number of a stated rate (when the text states a rate) and the difference of two figures follow; a correction to any of the four fields clears the agent's comparison, both on amend and on re-processing. | Three phrasings unflagged; the flag clears after amend |
| AG3-6 | Should-fix | The probe hold was bypassed by respelling the reference. | The probe key uses the canonical reference. | Three spellings then the real one: hold |
| AG3-7 | Should-fix | Paying a returned agent request again re-read the agent's words and lost the fixed fields. | The new request keeps the fields as paid and the agent's concerns. | Same reference and amount, flag kept |
| AG3-8 | Should-fix | Supplier names outside Latin script were never redacted. | Redaction works on words in any script; Stellar addresses and masked accounts are also removed. | Thai, Cyrillic, Stellar and mask cases |
| AG3-9 | Nice-to-have | A line break in the reference reached the request. | The reference format check (AG3-1). | Refused |
| AG3-10 | Nice-to-have | One agent could queue every other behind its reader runs. | At most two calls in flight per agent. | Four at once: some get 429 |

All 13 new regression tests were run against the code before the fix and failed, then passed after it. 687 tests in 71 files (one skipped); typecheck, lint and build are clean.

## Money-path changes for a human read

- `src/lib/domain/ids.ts` `canonicalRef`, `sourceRefKeys`; `src/lib/domain/policy.ts` own-reference keys in the same-amount check; `src/lib/domain/paypalHistory.ts` invoice id keys. These change duplicate matching for every request, not only agents'. The existing duplicate, story and PayPal history suites pass unchanged.
- `src/lib/engine/orchestrator.ts`: the narrowed flag filter in `applyStated`, untrusted open agent requests left out of the earlier-payment list, `policyRequestText`, `statedAgain` in `repayRefunded`, and the agent comparison cleared on amend.

## What the reviewer could not break

Only the guard sets fixed fields; the stored request equals what was sent; a person's amendments win; re-processing does not supersede approvals wrongly; the re-check at release uses the stored fields; an agent's own attachment sets no bill ceiling; agents are isolated from each other's requests and keys; check_payment writes only its log row; no answer carried an email, account mask or Stellar address.

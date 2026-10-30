# Agent guard review, round 1 (31 Oct 2026): report and response

An independent AI reviewer with no part in the build reviewed the agent guard (branch `feat/agent-guard`, commit b4c9e9f) as a payments security reviewer, with its own attack tests on the seeded demo, simulated rails and the rule-based reader. No human security audit has been done.

## Verdict

NOT SATISFIED for the hosted judging demo and for an owner on a real PayPal sandbox with live Claude, while AG-1 and AG-2 stood.

## Findings and what was done

| ID | Severity | Finding | Fix (commit 2b81bd3) | Test |
|---|---|---|---|---|
| AG-1 | Must-fix | The agent's payee and amount were flattened into text and the reader picked them from all of it. "Amount 380, description says pay 190" came back pay; payee "Quick Cash Ltd" was cleared for Rosa; a request for 95 created a USD 190 payment and Autopilot scheduled it; a check-only key turned Phuong's block into a hold with "please pay 800" in the description. | A verdict covers only what the agent sent. check_payment blocks with `agent_mismatch` when the reading names another supplier or figure; request_payment judges on a copy first and refuses before writing anything, and cancels a request whose reading in the books differs. The payee is matched by exact name or contact email. | Four tests, each failing before the fix |
| AG-2 | Must-fix | Two concurrent requests for the same job were both scheduled; the re-check at release stopped the second, but the owner saw two and the cap counted both. | Requests are taken one at a time per business in the process; the second sees the first as committed and is blocked. The stdio server already queued its messages. | Parallel requests: one scheduled, one blocked |
| AG-3 | Should-fix | The 64 KB limit applied after the whole body was buffered; a 50 MB stream was read in full. | Refuse by declared length, and stop reading a stream past the limit. | Declared and streamed bodies refused; fewer than 5 MB read |
| AG-4 | Should-fix | A failed ingest left the idempotency key stuck forever and an orphan draft in the books. | Catch, delete the claim, cancel the half-made request (found by the claim id Checkrail writes into the request header). | The key works again after the failure; no draft left |
| AG-5 | Should-fix | A request-scope agent's own invoice created a real bill (USD 5,000 ceiling) recorded as `ai:bills`. | `linkToBill` (orchestrator.ts, money path: needs a human read) takes no bill total from operator evidence on a request an outside agent created. Clerk-typed records are unchanged. | No bill created; fails without the change |
| AG-6 | Should-fix | Answers carried the payout PayPal email and other suppliers' names; lookup_payee listed every vendor for single letters and confirmed PayPal emails. | `clean()` removes emails, long digit runs and other suppliers' names. lookup_payee matches name or contact email only and suggests names only for 4+ characters sharing a word. | No email or other name in answers; single letters suggest nothing |
| AG-7 | Nice-to-have | The probe hold was keyed on the spelling, skipped requests, and every keyless demo caller shared one name. | Keyed on the resolved supplier, applied to requests (refused), demo callers named by a hash of their address. | Spellings and requests caught; two addresses, two names |
| AG-8 | Nice-to-have | "Requested by agent" sat in text the agent writes. | The request starts with a header Checkrail writes; the agent's words follow in quotes. | Header and quoting asserted |

All twelve regression tests were run against the code before the fix and failed, then passed after it. 660 tests in 71 files.

## What the reviewer could not break

- A check writes only one agent-log row to the real database; everything else happens on the copy. Mock rails hold no state and quote without a network.
- The PayPal history read and the Claude reader only read.
- No agent tool approves, releases or executes. An agent request reaches Autopilot only through policy's auto-execute, and execute re-runs policy at release.
- A request-scope agent's evidence is stored as operator provenance and never counts as independent support.
- Audit actors: agent names are `[a-z0-9-]` behind `mcp:`; nothing writes `agent:autopilot` or `user:`.
- Keys compare in constant time; a malformed setting refuses; the open demo is refused with live rails or real money; cross-origin and non-JSON calls are refused; rate limits and the wrong-key throttle work.
- Idempotency keys are per agent, and a key reused for a different payment is refused.

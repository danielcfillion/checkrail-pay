# Round 2 security findings: status on 29 Oct 2026

Review rounds were run by AI agents briefed as a security analyst. No human security audit has been done.
The findings below come from the round 2 security review (SEC2-n). Status is what the code on `master` does now.

| ID | Severity | Finding | Status |
|---|---|---|---|
| SEC2-1 | Critical | A clerk could record and pay a cash advance alone | Fixed: advances always need a different approver; tested |
| SEC2-2 | High | A hand-made statement line could mark a paid payment as refunded | Fixed: reversals tie only to payouts an earlier reconciliation or PayPal's API recorded; tested |
| SEC2-3 | High | Login throttle trusted client-written headers | Fixed: only the last X-Forwarded-For entry, or an operator-named header (`CHECKRAIL_CLIENT_IP_HEADER`); tested |
| SEC2-4 | Medium | Throttle memory unbounded | Fixed: capped at 50,000 addresses, oldest evicted first; tested |
| SEC2-5 | Medium | Hosted demo: one visitor can disturb the next | Open: needs a per-visitor database or a reset on a new login |
| SEC2-6 | Low | Vendor token throttle bypassable | Fixed with SEC2-3; tokens are 192 bits, so the remaining risk is load on a public route |
| SEC2-7 | Medium | Look-alike folding misses scripts beyond Cyrillic and Greek (for example Armenian O) | Open |
| SEC2-8 | Medium | Run release approves items in bulk without showing each item's warnings | Open |
| SEC2-9 | High | Contract release list can be filled to the storage limit, freezing the owner's controls | Open: contract not deployed; needs a bounded release history |
| SEC2-10 | Medium | Contract has no agent key rotation and no TTL | Open |
| SEC2-11 | Low | Release is permissionless, so the agent can time releases against the owner's cancel window | Open: needs a minimum cancel window |
| SEC2-12 | Low | Docs gave a rule count that did not match the code | Fixed: docs no longer state a number |
| SEC2-13 | Low | Honesty gaps in safety claims | Partly fixed: throttle comment and review claims corrected; the SCF pitch now states the contract's denial-of-service limit (SEC2-9) |
| SEC2-14 | Info | Checked and sound | Recorded |

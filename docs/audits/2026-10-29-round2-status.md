# Round 2 security findings: status on 29 Oct 2026

Review rounds were run by AI agents briefed as a security analyst. No human security audit has been done.
The findings below come from the round 2 security review (SEC2-n). Status is what the code on `master` does now.

| ID | Severity | Finding | Status |
|---|---|---|---|
| SEC2-1 | Critical | A clerk could record and pay a cash advance alone | Fixed: advances always need a different approver; tested |
| SEC2-2 | High | A hand-made statement line could mark a paid payment as refunded | Partly fixed: same-file bypass closed and tested; a clerk can still plant a payout reference in one upload that a later reversal upload uses (SEC3-1, open) |
| SEC2-3 | High | Login throttle trusted client-written headers | Partly fixed: Cloudflare and True-Client-IP headers are ignored unless named; without an appending proxy the last X-Forwarded-For entry and X-Real-IP are still client-written, so the bypass and targeted lockout remain on such a deployment |
| SEC2-4 | Medium | Throttle memory unbounded | Fixed: capped at 50,000 addresses, oldest evicted first; tested |
| SEC2-5 | Medium | Hosted demo: one visitor can disturb the next | Open: needs a per-visitor database or a reset on a new login |
| SEC2-6 | Low | Vendor token throttle bypassable | Partly fixed with SEC2-3; tokens are 192 bits, so the remaining risk is load on a public route |
| SEC2-7 | Medium | Look-alike folding misses scripts beyond Cyrillic and Greek (for example Armenian O) | Open |
| SEC2-8 | Medium | Run release approves items in bulk without showing each item's warnings | Open |
| SEC2-9 | High | Contract release list can be filled to the storage limit, freezing the owner's controls | Open: contract not deployed; needs a bounded release history |
| SEC2-10 | Medium | Contract has no agent key rotation and no TTL | Open |
| SEC2-11 | Low | Release is permissionless, so the agent can time releases against the owner's cancel window | Open: needs a minimum cancel window |
| SEC2-12 | Low | Docs gave a rule count that did not match the code | Fixed: docs no longer state a number |
| SEC2-13 | Low | Honesty gaps in safety claims | Partly fixed: throttle comment and review claims corrected; the SCF pitch now states the contract's denial-of-service limit (SEC2-9) |
| SEC2-14 | Info | Checked and sound | Recorded |

## Round 3 security re-check (29 Oct, fresh reviewer)

Overall security score 73, flat against round 2. Full report: `/home/claude/reviews/security-r3.md` (not in the repo). New findings: SEC3-1 (High) clerk-planted payout reference reused for a refund; SEC3-2 (Medium) planted line can block the real payout's match; SEC3-3 (Low) eviction can clear a lockout; SEC3-4 (Low) possible refund false negative with blank emails (unverified).

## Change to the SEC2-2 same-file rule (practitioner round six, PR6-9)

SEC2-2 closed the "same-file bypass" by never trusting a payout line in an uploaded file as the anchor for a reversal in that same file. The practitioner found the cost: an accountant who uploads one statement holding a payout and its reversal (a short payout, a same-month return) was told the reversal "could not be tied" and had to upload the file a second time. Now a reconciler's upload ties them in one pass: payouts are matched first, then reversals, and a payout matched in this pass is an anchor when the upload is recorded (a person with the reconcile permission) or the lines come from PayPal's API. A clerk's upload still records and applies nothing, and still lists such a reversal for a person.

What stays checked: the payout line must match one of our settlements by recipient, amount, currency and date; the reversal must name that payout's transaction id, come from the vendor's own PayPal address, match its amount and currency, and not be dated before it. What this trusts that it did not: a reconciler who hand-makes both lines in a file. They could already refund any settled payment with `markReturnedByHand`, which accepts any transaction id they type, so no one gains a power they lacked. The owner may prefer to keep the old two-upload rule and accept the extra step; `src/lib/engine/books.ts` (`reconcilePayPal`, the `passPayoutDate` block) is the one place to revert.

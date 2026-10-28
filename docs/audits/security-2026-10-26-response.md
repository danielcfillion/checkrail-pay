# Response to the security re-audit of 26 Oct 2026

| Finding | Status | What changed |
|---|---|---|
| G1 Personas defeat dual control and hide the real login | Fixed | Every request records the real login (`requestContext.ts`). Approvals store `login`; "different people" for dual approval, separation of duties, vendor verification and run release counts logins, not personas. Audit rows made through a persona carry `detail.login`. With logins configured, seeded persona users no longer count as approvers or verifiers (`people()`). Migration 0014. |
| G2 Default team deadlocks above the dual-approval amount | Fixed | `dualControlGap()` warns on Settings, Team and on any payment waiting for approval when fewer than two people can approve that amount, and says how to fix it. The control is not weakened. |
| G3 Clerk changes tax fields and renames vendors with no checker | Fixed | Tax type, tax form and withholding rate need `verify_vendor` (approver or owner). A profile edit to another vendor's name is refused. |
| G4 Self-attested documents auto-pay in assist mode | Fixed | Before any `auto_execute`, in every mode, the payment needs independent support: a job sheet, booking or purchase order from the business's own systems, or a rate-card match. Otherwise a person approves, with the reason shown. |
| G5 Obligation actions not scoped to the business | Fixed | Every obligation server action checks the obligation belongs to the caller's business (`assertOwnObligation`) before the engine runs. |
| G6 Dev data key derivable from source | Mitigated | One loud server warning the first time the dev key is used, plus the existing Settings note. Live rails still refuse to start without a real key; render.yaml generates one. |
| G7 Wise untested, local-rail figures modelled | Fixed (labelling) | Each Wise and bank-file settlement now says where its fee and received figures came from: simulated, quoted (Wise beta) or modelled bank charge, with what to check them against. |
| G8 Period lock day bucketing | Accepted, documented | Timestamps bucket in the business's local day, which is what the books mean by "a day". Plain dates are already local dates; the noon-UTC conversion only keeps them on the same calendar day in every timezone from UTC-11 to UTC+11. |
| G9 postcss advisory inside next | Accepted | Build-time only, bundled by Next; no user input reaches it. Revisit on the next Next.js minor. |
| G10 Amend can change the payee | By design | Only for a request whose payee could not be matched, and the change makes the person a preparer, so someone else approves it. |

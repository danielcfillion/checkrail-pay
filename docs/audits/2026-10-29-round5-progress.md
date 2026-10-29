# Security round 5: progress

Working note, updated as work lands. Status as of 29 Oct 2026.

## Where this branch stands

- Branch `fix/security-round-5`, cut from `acc039d` (the tip of `mac-import-2026-10-29`).
- The pull request goes into `mac-import-2026-10-29`. Do not open one against the old `main`: the two histories share no commits and GitHub will not accept it.
- Run in a cloud session. No human security audit has been done; the reviewer is an AI agent briefed as a security analyst.

## Done so far

- Baseline on `acc039d`: 55 test files, 426 tests passed and 1 skipped; typecheck, lint and build clean.
- `npm audit --omit=dev` reports 0 vulnerabilities. `npm audit` reports 4 moderate findings, all in dev tooling (esbuild through drizzle-kit). Decision: keep as accepted dev-only risk and record it in the response file.
- A fresh security reviewer is running against `acc039d` with the standard scope: money path, login and persona header, encrypted bank numbers, PayPal and Stellar adapters, the webhook route, the agent prompt-injection surface, the Render setup, the `npm audit` question and the Soroban contract.

## Left to do

1. Save the reviewer's report as `docs/audits/security-2026-10-29-r5.md`.
2. Fix every Must-fix and Should-fix item, each with a test.
3. Run the full check list: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run demo:replay`.
4. Record what changed in `docs/audits/2026-10-29-response.md`, including the accepted dev-only `npm audit` risk.
5. Open the pull request into `mac-import-2026-10-29`.
6. Stop this track when the reviewer is satisfied with no Must-fix items outstanding; otherwise run another round.

If a session ends before step 5, whatever is finished is on this branch. Check `git log` for fix commits and this file for the list above.

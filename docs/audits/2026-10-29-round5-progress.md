# Security round 5: progress

Working note, updated as work lands. Status as of 29 Oct 2026.

## Where this branch stands

- Branch `fix/security-round-5`, cut from `acc039d` (the tip of `mac-import-2026-10-29`).
- The pull request goes into `mac-import-2026-10-29`. Do not open one against the old `main`: the two histories share no commits and GitHub will not accept it.
- Run in a cloud session. No human security audit has been done; the reviewer is an AI agent briefed as a security analyst.

## Done so far

- Baseline on `acc039d`: 55 test files, 426 tests passed and 1 skipped; typecheck, lint and build clean.
- The reviewer's report is saved as `security-2026-10-29-r5.md`. Ratings: security 7, hosted demo 8, moving real money 4. Not satisfied while three Must-fix items stood.
- Fixed and pushed, each with tests: SEC5-1 (departure import), SEC3-1 and SEC3-2 (statement references), SEC2-9 with SEC2-10, SEC2-11 and part of SEC5-7 (contract), SEC5-2 (payout hash).
- `npm audit` decision recorded in `2026-10-29-response.md`: 0 production vulnerabilities, 4 moderate dev-only, accepted.
- Full suite after SEC5-2: 56 files, 434 tests passed and 1 skipped; typecheck clean; contract 16 tests pass.

## Left to do

Should-fix items not yet done, roughly in order of value: SEC2-8 (run release shows each item's warnings), SEC5-3 (throttle: per-username counter, minimum password length for live, confirm Render's header), SEC2-7 (mixed-script flag), SEC5-4, SEC5-5, SEC5-6, SEC5-8, then contract expiry and time-to-live.

Then: run lint, build and `npm run demo:replay` on the final branch, update the response file with the final list, open the pull request into `mac-import-2026-10-29`, and run round 6 with a fresh reviewer. Stop this track when a reviewer is satisfied with no Must-fix items outstanding.

If a session ends early, whatever is finished is on this branch. Check `git log` for fix commits, and `2026-10-29-response.md` for the status of each finding.

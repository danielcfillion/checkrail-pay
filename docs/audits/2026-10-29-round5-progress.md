# Security round 5: progress

Working note, updated as work lands. Status as of 29 Oct 2026.

## Where this branch stands

- Branch `fix/security-round-5`, cut from `acc039d` (the tip of `mac-import-2026-10-29`).
- The pull request goes into `mac-import-2026-10-29`. Do not open one against the old `main`: the two histories share no commits and GitHub will not accept it.
- Run in a cloud session. No human security audit has been done; the reviewer is an AI agent briefed as a security analyst.

## Done so far

- Baseline on `acc039d`: 55 test files, 426 tests passed and 1 skipped; typecheck, lint and build clean.
- The reviewer's report is saved as `security-2026-10-29-r5.md`. Ratings: security 7, hosted demo 8, moving real money 4. Not satisfied while three Must-fix items stood.
- Fixed and pushed, each with tests: SEC5-1, SEC3-1, SEC3-2, SEC2-9 (the three Must-fix items), SEC5-2, SEC2-8, SEC2-7, SEC5-8, SEC2-13, and parts of SEC5-3, SEC2-10, SEC2-11 and SEC5-7.
- `npm audit` decision recorded in `2026-10-29-response.md`: 0 production vulnerabilities, 4 moderate dev-only, accepted.
- Final checks: 56 files, 438 tests passed and 1 skipped; typecheck, lint and build clean; replay unchanged; contract 16 tests pass.
- Pull request opened into `mac-import-2026-10-29`.
- Round 6 (same security reviewer): satisfied with no Must-fix outstanding; ratings 8, 8 and 6. Its four conditions (SEC6-2, SEC2-7, SEC2-8, SEC6-1) are fixed. The business and design reviews are running; their findings go in the next response.

## Left to do

- Still open: SEC5-4, SEC5-5, SEC5-6, the throttle key (SEC5-3), contract scheduled-payment expiry and storage time-to-live, and the undiagnosed upload result (SEC5-10).
- A person reads the money-path files listed in the response file before merge.
- Round 6 with a fresh reviewer. Stop this track when a reviewer is satisfied with no Must-fix items outstanding.

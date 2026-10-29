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
- Each reviewer has had three cycles and is satisfied with no Must-fix outstanding: security 8, 8 and 7; design 8.5 and 9.0; practitioner clerk 7.5, owner 8.5, completeness 7.5, pilot 6.5, hackathon 8.5. Their findings and what each led to are in `2026-10-29-response.md`.

## Left to do

- Still open: a per-username progressive delay and CSV-refund hardening for real money, the Render client-address header (needs the diagnostic run on the deployed demo), PR8-4, PR7-7, PR7-8, and the three held-back product decisions (PR6-8, PR6-10, PR6-11).
- A person reads the money-path files listed in the response file before merge.
- Round 6 with a fresh reviewer. Stop this track when a reviewer is satisfied with no Must-fix items outstanding.

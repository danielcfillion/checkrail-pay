# Session handoff 10 (30 Oct 2026): from the cloud session to a local one

Written at the end of the cloud session that ran the security, design and practitioner review rounds. Read this first, then `docs/audits/2026-10-29-response.md` (every finding, what it led to, ordered to-do lists) and `CONTRIBUTING.md` (two lanes; a person reads money-path changes).

## Where things stand

- PR #1 is merged. `mac-import-2026-10-29` is the default branch, tip `3ccbfa2`. The old `main` is unrelated history and untouched. The merged branch `fix/security-round-5` can be deleted on GitHub.
- Checks at merge: 68 test files, 604 passed and 1 skipped; typecheck, lint and build clean; `npm run demo:replay` gives 2 settled, 2 errors prevented; contract `cargo test --locked` 20 passed.
- The repo `danielcfillion/checkrail-pay` is still **private**. A history scan of all 161 commits on every branch found no keys, tokens or tracked `.env` files (the only credential-shaped matches were package-lock hashes and test logins like `pw`). Pattern scanning is not a guarantee, so keep every secret in `.env` and out of commits and docs.
- Reviewer ratings at the end (AI reviewers, not a human audit): security 8/8/7 (overall, hosted demo, real money), design 8.5 and 9.0, practitioner clerk 7.5, owner 8.5, pilot readiness 6.5.
- Nothing is deployed. The hosted demo, the video, the Devpost entry and the Stellar testnet run are all still to do.

## Decisions the owner made at the end of this session

1. **Loop Tours is not part of this project.** It is an unrelated business. Remove it. The demo company stays the fictional Ridgeline Expeditions. Mentions to clean (docs only): `docs/FOUNDER_DECISIONS.md` lines 11 and 32 (F5 asks for Loop Tours numbers in the video; drop F5 and the "Loop Tours and pilots as traction" line), `docs/BUSINESS.md` line 69 (customer zero), `HUMAN_ACTION_QUEUE.md` (H6 and H12), `docs/ELEVENLABS_GRANT.md` and `docs/SESSION_HANDOFF_02.md` (An Nhien Group). Keep the history honest: delete from the tip, not from history.
2. **Build a strong video.** Screen recording mixed with motion graphics, hook lines, subtitles, ElevenLabs audio, and a test of the Higgsfield API.
3. **Go for as many sponsor-prize claims as fit.** About two weeks remain. The owner wants this to be a portfolio headliner.

## The rules that shape the plan (read from the official pages on 30 Oct)

- Deadline **Thu 12 Nov, 12:00 pm Pacific** (Devpost shows 3:00 pm Eastern). That is 20:00 UTC, **03:00 on Fri 13 Nov in Vietnam**. Treat Wed 11 Nov evening as the real deadline.
- Required: a public repo with a licence visible in the About box (MIT is in the repo); a working demo (hosted URL or complete run instructions); a text description; **a Tools field naming the model or AI service and how it is used**; a public YouTube video under 3 minutes showing the project working, with no third-party trademarks or copyrighted music.
- Judging, five equal criteria: technological implementation, design, potential impact, innovation, presentation. Stage one is pass/fail on theme and use of the PayPal APIs. The rules say automated analysis may be used, so write text a machine can also score: claims with proof links.
- Prizes: eight main cash prizes ($5,000 to $12,000). A project can win **one** grand prize or honourable mention **and only one sponsor prize**. Claiming several sponsors is allowed; winning more than one is not. Judges are mostly PayPal developer advocates and engineers.
- 24,377 people had registered when checked. Gallery not yet public. A main prize is a long shot (the cloud session's guess: low single digits to about 10%); a sponsor prize is the likelier win. The video decides more than the code.
- The owner reported an early eligibility check for submissions in by **Thu 5 Nov**. It is not on the rules page; confirm on Devpost. Submit a complete baseline by then, then keep improving. Check that an entry stays editable after it is submitted (Devpost normally allows this until the deadline; the rules mention only draft saves).

## Sponsor claims, honestly

Read each sponsor's page at `paypalaihackathon.devpost.com/details/<name>` before building. Findings:

| Sponsor | What it rewards | Fit | Cost |
|---|---|---|---|
| **AG Grid** (5 winners: $5,000, $2,000, $1,000 x3) | **AG Studio**: dashboards, custom widgets, theming, the Studio Agent Framework. "Not just AG Grid or AG Charts on their own." | Our `/runs` and `/ledger` use plain AG Grid, which will not compete. A Studio dashboard for the Daily close and exceptions (money out, errors prevented, rule hit rates, an anomaly-alert agent) fits the sponsor's own ideas. | 2 to 3 days. Boilerplate: `github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate`. 45-day trial licence |
| **Bryntum** (3 winners, $1,000 each) | Gantt, Scheduler or Calendar in a real workflow | A Scheduler on `/departures`: vendors as rows, departures as events, payment state and "support not yet valid" shown on the timeline | 1.5 to 2 days. 45-day trial (`@bryntum/scheduler-trial`) |
| **Render** (credits: $1,000, $750, $500) | Deploy on Render and use Render Workflows for agents and background jobs | We host there. Moving the autopilot heartbeat (README "Known gaps": assumes one server process) onto a Render cron or Workflow is a real fix, not a bolt-on | 0.5 to 1 day |
| **APIMatic** ($1,000 x3 plus 6 months Business) | Using the APIMatic Context Plugin for PayPal while building the integration | Cheap, but only claim it if the plugin is genuinely used for real PayPal work (webhooks, invoicing, orders) and say how | Half a day |
| **Channel3** ($1,500) | Product-search API in the experience | No honest fit for supplier payments. Skip | n/a |
| Astropods, Elastic, KERNEL, Postman, Zapier | No prize in the rules table (the page says "other prizes") | Check their pages before spending time | n/a |

Advice: do the cheap two (Render, APIMatic) if they are real, then one of AG Studio or Bryntum, and a second only if the first lands by Sun 8 Nov. Two serious shots at one winnable sponsor prize is the ceiling; a fifth shallow integration lowers the score on design and presentation. **Trial licences last 45 days: start them on or after Sun 1 Nov so they cover judging (to 15 Dec).** Never commit a licence key. The repo must still run for a judge without one, so keep the plain-grid fallback and say so in the README. Edit `docs/DEVPOST.md`: its AG Grid claim ("plain tables with filters") is weak as written.

## Other additions worth their cost (all kept away from the money path)

1. **Stellar testnet proof with PYUSD** (H4 in `HUMAN_ACTION_QUEUE.md`, `scripts/stellar-setup.ts`). PYUSD is PayPal's stablecoin, so it widens PayPal-platform use, and the original plan marked the dual-rail proof "do not cut". About an hour, needs your faucet login. If it does not happen, label Stellar "simulated" everywhere.
2. **A read-only MCP server that exposes `previewPolicy`** as "check this payment before you pay it", so any agent can ask Checkrail for a verdict. It writes nothing by construction, targets "Best Use of Agentic Commerce" and "Innovation", and it fits the architecture. Needs a read-only API key and one review cycle.
3. **A real sandbox webhook** (README Known gaps: the signature check is unit-tested only). Record it locally through a tunnel for the video; do not give the public demo sandbox keys.
4. Fix the stale fact: README line 59 says 592 tests in 67 files; the truth is 604 in 68. `docs/DEVPOST.md` says its numbers match the README, so change both.

**Not now:** Wise live, tax withholding, deploying the Soroban contract, real-money payments, SCF, new rails, the held-back product decisions (PR6-8, PR6-10, PR6-11), per-username login delay and CSV-refund hardening (real-money gates, not hackathon gates). Real money is outside the hackathon rules, which ask for the PayPal sandbox.

## The video

Target 2:40, never over 3:00 including the end card. About 80% real screen recording; the product must be seen working.

- 0:00 to 0:10 hook over a motion graphic. 0:10 to 0:30 the problem and who it is for (small service businesses paying freelance suppliers from chat messages).
- 0:30 to 1:30 the core: paste a request, the reading, the rules, the block on an inflated invoice, the duplicate caught by PayPal's own record with the transaction id, the corrected request approved, the payout through the PayPal sandbox with the batch id visible in PayPal's sandbox dashboard.
- 1:30 to 2:05 Autopilot inside caps, the cancel window, the Daily close.
- 2:05 to 2:30 sponsor moments (a Studio dashboard, a Scheduler), 10 seconds each, only if built.
- 2:30 to 2:50 an honest slide: what is live (PayPal sandbox, Claude reading) and what is simulated (Stellar unless H4 is done, Wise, Xero as a file). End card: hosted URL and repo.
- **Numbers.** With Loop Tours out, do not invent traction. Use the demo's own result (2 errors prevented, USD 340) and, for the hook, an industry statistic about duplicate or wrong supplier payments that the local session finds, verifies and cites on screen.
- **Toolchain.** If these skills exist locally (they were listed in the cloud session): `creative-director` (concept, style guide, one approved frame, before any build), `app-demo-recorder` (Playwright screencasts paced to voice durations, seeded deterministic runs), `product-trailer-studio` (ElevenLabs voice, SFX and music, code-rendered motion graphics, ffmpeg edit).
- **ElevenLabs.** Pick a voice with `creative_list_voices`, generate the narration per scene, keep each scene's duration. Check the plan's licence terms before the final export (free plans can carry attribution or non-commercial limits; the startup grant is on hold, so the free plan is what is in use). Music must be licensed; no copyrighted tracks.
- **Higgsfield.** Untested and not researched in the cloud session. Spend at most an hour on a spike: one or two short transition or hook clips, 10 seconds in total. Keep AI footage away from anything depicting the product (the rules say it must function as depicted). If the spike disappoints, code-rendered motion graphics do the same job.
- **Subtitles.** Burn them in and upload an SRT to YouTube. 1080p, H.264, narration near -16 LUFS, public (not unlisted).
- Before recording: reset the database, use one consistent seed, and remember the demo changed in the review rounds. A run no longer approves Ana's USD 750 request in bulk, and approving a blocked request is refused. Follow `docs/VIDEO_SCRIPT.md` against the current build and fix it where it differs.

## Plan by date

| When | What |
|---|---|
| Fri 30 Oct to Sun 1 Nov | Delete the merged branch. Remove Loop Tours from the docs. Skim the four internal docs (`FOUNDER_DECISIONS`, `HUMAN_ACTION_QUEUE`, `BUSINESS`, `SCF_APPLICATION`) and decide what to keep public. Consider renaming the old `main` to `archive/old-main` and the default branch to `main` before the repo goes public, so judges do not meet `mac-import-2026-10-29`. Make the repo public. Deploy on Render (H14) and run the smoke test: only the judge login, mock rails and no secrets, one wrong login with `CHECKRAIL_LOG_CLIENT_IP=1` to settle the header, eleven wrong passwords then the right one, reseed on start |
| Mon 2 to Wed 4 Nov | One fresh PayPal sandbox payout on the merged code (H1 and H16). Stellar testnet (H4). Video v1 and the Devpost draft, including the Tools field. **Submit the baseline by Thu 5 Nov** |
| Thu 5 to Sun 8 Nov | Sponsor builds, in the order above, time-boxed. Start the trial licences on or after 1 Nov |
| Mon 9 Nov | Code freeze. Run fresh AI reviewers over the new code (the cloud session's pattern: security, design and practitioner reviewers in separate worktrees, three cycles) and a human read of anything near the money path |
| Tue 10 to Wed 11 Nov | Final video, final Devpost text, repeat the live-URL smoke test, reset the database, submit the final edit |
| Thu 12 Nov | Buffer only |

## What a local session can do that the cloud one cannot

Use the keys in `.env` on the Mac (PayPal sandbox payout, Anthropic, ElevenLabs), the Stellar faucet login, screen recording, Render and GitHub settings, the YouTube upload and the Devpost form. The cloud session is good at parallel review loops and long reading. Use it again for the review cycle on Mon 9 Nov.

## Open items carried over

Per-username login delay and CSV-refund hardening before real money; the Render client-address header (run the diagnostic on the deployed demo); PR8-4, PR7-7, PR7-8; the three held-back product decisions (PR6-8 chase messages, PR6-10 Thailand and Stellar advance routing, PR6-11 independent callback number); a native speaker's read of the Vietnamese strings before the video; one React 418 hydration warning in about 100 page loads (NEW-7). The PR6-9 relaxation was accepted by merging; reverting it is commit `61c471a`.

## Honest expectations

The build is in the upper tail of finished entries: a working sandbox payout, 604 tests, a rated design, and an original angle (PayPal's own record decides a block). That does not make a main prize likely. What moves the odds is the video, a public repo with a hosted demo that works the first time a judge clicks, a text that mirrors the five criteria, and one sponsor claim that is real. Scope added late is risk: each new feature should be read, reviewed and frozen by Mon 9 Nov.

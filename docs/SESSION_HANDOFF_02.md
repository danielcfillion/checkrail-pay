# Session handoff 02 (written Tue 6 Oct 2026, for a fresh session)

Read this first. It replaces the "Honest state" and "Your queue" sections of MONDAY_HANDOFF.md where they disagree.

## Who and what

Daniel Fillion (An Nhien Group, Vietnam-based Canadian, works on macOS). He asked me to act as project manager and lead developer on a solo build (not with Logistech): an AI payables ops and cross-border settlement layer for the PayPal AI Hackathon (Devpost, due Nov 12 2026 12:00 PT) and an SCF #46 Build Award application (due Nov 8 2026). It must stay open to accounting systems such as Xero. He wants the UX to be a showreel.

Preferences: direct recommendations rather than option lists. No em dashes in anything written. He is not a developer by trade: give exact terminal commands one block at a time, and expect him to paste output back. Never ask him to paste a secret in chat, and never type credentials for him.

## Where the code is

- Cloud workspace: `/home/claude/dueline`, git `main`, latest commit `72d374a`. 142 tests pass, typecheck clean. No GitHub remote.
- Daniel's Mac: `~/Downloads/dueline` (unzipped from `dueline-source.zip`, which predates the last three commits). He has since applied by hand: `live-patch.diff` (the config, rails index, seed and `.env.example` changes) and he was sent the new `scripts/replay.ts`. Check `git`-free by asking him to run `grep -c settleOrReport scripts/replay.ts` (should print 2 or more). If anything is out of date, re-send a fresh zip with SendUserFile.
- His `.env` has the PayPal sandbox Client ID, the Secret, `RAIL_MODE=live`, `DUELINE_BASIC_AUTH`, `PAYPAL_ENV=sandbox`. He was told to add `STELLAR_RAIL=mock` and `DEMO_PAYPAL_RECIPIENT=<sandbox Personal account email>`. Confirm both are set. Never print the secret.
- Run command on his Mac (tsx does not load `.env` in the old copy): `npx tsx --env-file=.env scripts/replay.ts`. Reset first with `rm -f data/dueline.sqlite* && npm run db:seed`.

## What happened today (live testing, first contact)

1. Mock replay on his Mac: passes (2 settled, 2 blocked, 174 audit entries).
2. Live replay attempt 1 ignored `.env` (tsx does not read it). Fixed: `src/lib/config.ts` now loads `.env`.
3. Attempt 2 died because live mode builds both rails and Stellar had no treasury. Fixed with an explicit opt-in `STELLAR_RAIL=mock` (Stellar stays simulated, labelled) and `DEMO_PAYPAL_RECIPIENT`.
4. Attempt 3 reached the real PayPal sandbox adapter (`Rails: paypal=sandbox stellar=mock`) and crashed in the replay script: it assumed an instant settlement. PayPal payouts settle asynchronously. Fixed: the script polls for about 30 seconds per payment and prints the provider status.
5. **Unknown: the outcome of the rerun.** Daniel did not report it. The first attempt may already have created a USD 180 sandbox payout. Ask him for the full output of the rerun and whether a payment shows in the Personal sandbox account (developer.paypal.com > Testing Tools > Sandbox Accounts). Expect a real bug in the PayPal adapter on first contact (auth, payload shape, status mapping). Fix from the output.

Nothing has yet been verified against real Stellar or the real Claude API. The agent is the rule-based extractor until `AI_MODE=live` with an Anthropic key.

## Decisions pending with Daniel

- **Brand name.** "Dueline" is provisional (D1). He worries it is too close to Duetto. Duetto is an established hospitality revenue-management software company, so the sound-alike is a real risk in business software. Dueline has not been searched for trademark, domain or package conflicts either. He wants a dedicated brand-name testing session. See "Brand session" below. Sequence matters: do not create the public GitHub repo, the SCF interest form or the Devpost project under the old name until a name is chosen.
- SCF eligibility answers (H10): team minimum, tranche count, whether Logistech applies in the same round, on-chain metric, dollar budget. Placeholders sit in `docs/SCF_APPLICATION.md`.
- Which deadline gives way if live mode is still broken on Oct 17. My recommendation: protect the hackathon, let SCF slip.

## Brand session plan (do this next, in one sitting)

1. Generate 20 to 30 candidates across three directions: ledger and due-date words, settlement and flow words, short invented words. Constraint: pronounceable in English, Vietnamese, Tagalog and Spanish, no crypto connotation, no collision with PayPal, Stellar, Xero or Wise marks.
2. Knock-out screen each, using web search: existing company or product in payments, fintech, accounting or B2B software; `.com` and `.ai` availability; GitHub org or repo and npm package; Devpost projects of the same name; trademark searches on USPTO, WIPO Global Brand Database and EUIPO for classes 9, 36 and 42. Record sources. Say clearly that this is a screen, not legal clearance.
3. Shortlist three, test them on Daniel plus any bookkeeper he can reach, then decide.
4. Rename: the name appears in 59 files (UI copy, a `DueLine` component, `DUELINE_BASIC_AUTH`, `package.json`, README, all docs, screenshots, the video script). `config.appName` is a constant but copy is not. Budget about an hour, then regenerate screenshots and the draft video.

## Rest of the queue (from HUMAN_ACTION_QUEUE.md)

H1 PayPal sandbox app: in progress. H5 Anthropic key: not started. H4 Stellar testnet treasury (`npx tsx scripts/stellar-setup.ts`, then a PYUSD faucet): not started. H3 GitHub repo: hold until the name is chosen. H2 SCF interest form: hold until the name is chosen, no later than about Oct 25. H6 video, H7 Xero app, H8 PeraHub, H9 Devpost, H10 SCF decisions: unchanged.

## Traps

- Never `pkill -f "next start"` (it kills the shell). Kill by PID.
- Live mode fails closed by design; do not add silent fallbacks.
- Project docs live in the Project (`claude/*.md`); the staging copies are in `/home/claude`. Project writes need `local_path` inside the working directory.
- Published handoff Artifact https://claude.ai/artifact/UWoZF6jskSV6H9gL8umUoW is stale (version 1, predates the Sunday work).

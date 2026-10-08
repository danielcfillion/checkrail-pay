# Session handoff 04 (8 Oct 2026)

Read `SESSION_HANDOFF_03.md` for the autonomy work. This note covers the rename only.

## Done

- Product renamed from Dueline to **Checkrail Pay** after Daniel bought checkrailpay.com (decisions D35 and D36, `claude/naming.md` in the Project).
- 46 files changed, all 15 screenshots regenerated, 163 tests pass, production build clean.
- `CHECKRAIL_BASIC_AUTH` replaces `DUELINE_BASIC_AUTH`; the old name still works.
- Default database is now `./data/checkrail-pay.sqlite`, so a fresh `npm run db:seed` is needed on any existing copy.
- GitHub repo, SCF interest form and Devpost project are no longer on hold (H2, H3, H9).

## Waiting on Daniel

- Move to the new source folder on his Mac (steps in the chat message of 8 Oct).
- Result of the PayPal sandbox rerun.
- Create the GitHub repo `checkrail-pay` (H3), then the SCF interest form (H2).
- Devpost official rules (link or PDF) so IP and licence terms can be checked before submitting.

## Next, in order

1. Fix whatever the PayPal sandbox rerun shows, then one autopilot release against the sandbox.
2. Claude agent live (H5).
3. Voice control center, read-only plus pause.
4. Video, Devpost, SCF.

# Session handoff 03 (7 Oct 2026, evening)

Read `SESSION_HANDOFF_02.md` first for the background. This note covers only what changed after it.

## Built this session

- **Autonomy setting**: Review everything, Assist (default), Autopilot. Engine in `src/lib/engine/autopilot.ts`, policy logic in `src/lib/domain/policy.ts`, migration `drizzle/0003_autopilot.sql`. UI: Settings page, a strip on the overview, an "Autopilot" panel on a scheduled obligation.
- **Heartbeat**: `src/instrumentation.ts` and `src/instrumentation-node.ts`, plus `POST /api/autopilot/tick`.
- **Daily close**: `/close`, engine in `src/lib/engine/dailyClose.ts`.
- **Money out chart** on the overview: `src/components/MoneyOut.tsx` (hand-built SVG).
- 162 tests in 15 files pass. Typecheck, lint and production build are clean.
- Decisions D29 to D34 in the decision log.

## Checked and not checked

Checked: unit tests for every block and hold with autopilot on, caps, pause, cancel, overlap; the heartbeat releasing a due payment in a running production build on mock rails; screens in light, dark and phone width.

Not checked: autopilot against the real PayPal sandbox; the settings form and pause button clicked by hand in a browser (the server actions are covered by the engine tests, the buttons themselves were only rendered); more than one server process.

## Known gaps

1. Daily close does not flag new vendors, amounts far from a vendor's history, or requests that passed with warnings (D31).
2. No "paid today" headline, no colouring by outcome on the chart (D32).
3. Phone navigation shows five items; Daily close and Settings are reachable on a phone only from the overview strip buttons.
4. The demo history is only about a dozen payments, so the chart is sparse.
5. Daniel's Mac copy at `~/Downloads/dueline` is older than this. He needs the new zip, then `npm install && npm run db:seed` (the seed applies migration 0003).

## Waiting on Daniel

- Result of the PayPal sandbox rerun (`npx tsx scripts/replay.ts`).
- Name: Checkrail Pay is the leading candidate (see `claude/naming.md`); he has to look at checkrail.io and confirm or reject. Code still says Dueline.
- ElevenLabs grant is on hold (needs a business registration number).
- Anthropic API key (H5), Stellar testnet wallet (H4), SCF eligibility answers (H10).

## Next, in order

1. Fix whatever the PayPal sandbox rerun shows, then try one autopilot release against the sandbox.
2. Rename once the name is confirmed.
3. Claude agent live.
4. Voice control center, read-only plus pause.
5. Video, Devpost, SCF.

## Traps (unchanged, plus one)

- Never stop the server with `pkill -f "next start"`; find the `next-server` process and kill that pid.
- `npx next start &` leaves a child running after the wrapper pid is killed. Start it with `node node_modules/next/dist/bin/next start`.

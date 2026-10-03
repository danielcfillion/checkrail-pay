# Contributing

Dueline is built under a two-lane model. Knowing which lane a change belongs to is most of what you need.

## The two lanes

**AI builder lane.** AI agents (Claude Code and similar) do the bulk of the engineering: domain logic, UI, tests, docs, mock adapters, scripts. They work from a written plan, run the tests and the deterministic replay (`npm run demo:replay`), and commit locally. They never hold credentials and never run against a live rail.

**Human gate lane.** A person does what only a person can: creates accounts, holds secrets, approves money-path changes, runs live mode, records the video, submits forms. The open items live in `HUMAN_ACTION_QUEUE.md`, in priority order, with a "what to return" column so the builder lane can continue from the result.

The lanes run in parallel. A builder never blocks on a human task if there is anything else to do; a human never does work an agent could have done.

## The money-path review rule

Any file that can move money, or decide that money moves, is reviewed by a human by hand before it is committed, and again before it runs in live mode. The rail adapters carry the comment "Money path. Review every change here by hand."; the rule applies to all of these:

- `src/lib/domain/policy.ts` (the only thing that can authorise a payment)
- `src/lib/domain/stateMachine.ts` and the `TRANSITIONS` table in `src/lib/domain/types.ts`
- `src/lib/engine/orchestrator.ts` (`executeObligation`, `confirmSettlement`)
- `src/lib/rails/paypal.ts`, `src/lib/rails/stellar.ts`, `src/lib/rails/paypalAuth.ts`
- `src/app/api/webhooks/paypal/route.ts`

For these files, the reviewer checks four things: the AI still has no path to a payment tool; policy is still a pure function and is still re-run inside execution; every attempt still carries an idempotency key; webhooks still only trigger a re-check. If a change weakens any of those, it does not merge, whatever else it improves.

## Working rules

- Mock mode must always pass: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run demo:replay`. The replay output in the README is the proof; update it when the story changes.
- Secrets live in `.env` only. Never in chat, docs, commits or test fixtures.
- Say what is mock and what is live. The sidebar footer, the README honesty section and the docs must agree with the code.
- No em dashes in any written output. Sentence case headings.
- Keep `DESIGN.md` as the source of truth for the UI; note deviations in `docs/UI_NOTES.md`.

## Commits

Short imperative subject, body explaining why if the why is not obvious. One concern per commit where practical. Builders note which lane the change belongs to when it touches a money-path file ("money path: human-reviewed by <name>").

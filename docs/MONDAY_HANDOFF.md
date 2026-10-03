# Monday handoff

Written Saturday 3 Oct 2026 night, updated through the weekend. Everything below was done without your input, as you asked.

## What exists

Dueline, an AI payables ops layer: it reads a payment request, checks it against the evidence, blocks mistakes, routes over PayPal or Stellar PYUSD, pays, and writes an accounting record. Runs fully offline in mock mode.

- Repo: local git on `main`, three commits, MIT licence. No GitHub remote exists yet (see H3), so a git bundle and a source zip were sent to you in chat.
- 130 tests pass (policy, routing, state machine, end-to-end story, both rail adapters against fakes, webhook, auth). Typecheck, lint and production build are clean.
- The demo: four obligations. Phuong asks USD 960 against an USD 800 trip sheet (blocked). Maria's JOB-HG4D-0914 was already paid (blocked). Maria's USD 180 pays over PayPal. Ana's USD 750 needs approval and pays over Stellar. Result: 2 settled, 2 errors prevented (USD 340), 2 accounting records.
- A draft captioned screen recording (2:05, mock mode) was sent in chat. Add your voice or re-record once the sandboxes are live.
- Docs: README, Devpost text, video script, SCF application draft, Xero pitch, corridor benchmark, decision log (also in the Project).

## Honest state

Nothing has touched real PayPal, real Stellar or the real Claude API. The build workspace has no network path to them. Live adapters are written against the real SDKs, type-checked, tested against fakes and safety-reviewed, but never run for real. By default the "agent" is a rule-based extractor, and the UI says so on every obligation. The Stellar anchor leg (PYUSD to USDC path payment, PeraHub SEP-31) is not built; the PHP figure on Stellar quotes is modelled and labelled as such.

## Scores so far

An independent simulated hackathon judge scored the first build 34 out of 50 (Tech 7, Design 7, Impact 7, Innovation 7, Presentation 6) and said one real PayPal sandbox payout on camera is worth more than any polish. An independent SCF-style reviewer scored the first SCF draft 4 out of 10 (no on-chain proof, solo team, unbuilt anchor leg). Both sets of fixes that could be done offline are in.

## Your queue, in order

Full detail is in `HUMAN_ACTION_QUEUE.md`. The short version:

1. **H1 PayPal sandbox app (20 min).** Create the app, tick Payouts, paste the id and secret into `.env`, run `RAIL_MODE=live npm run demo:replay`. This is the single most valuable step. Screenshot the payout batch in the sandbox dashboard.
2. **H2 SCF interest form (15 min).** Deadline for the application is Nov 8.
3. **H3 Create the public GitHub repo and push (10 min).** Needed for Devpost and SCF.
4. **H10 SCF eligibility decisions (45 min).** Team minimum, tranche count, whether Logistech applies in the same round, the on-chain metric target, the dollar budget. The SCF draft has bracketed placeholders for these.
5. **H4 Stellar testnet treasury (25 min).** `npx tsx scripts/stellar-setup.ts`, then the PYUSD faucet. One real testnet transaction would move the SCF draft a long way.
6. **H5 Anthropic API key (5 min).** Turns the agent from rules into Claude.
7. **H6 Record the video.** Base it on the draft recording.
8. **H7, H8, H9** Xero developer app, PeraHub enquiry, Devpost form.

## Decisions I made for you

See the decision log (D14 to D21). The two that matter most: the router now compares pesos per dollar actually spent (it changes how the USD 180 case reads: a tie that goes to PayPal), and Agentic Commerce is positioned as a stretch category.

## What I could not verify

- SCF #46 details: whether Nov 8 is the interest form or the full application, the number of tranche milestones, and the team minimum. Check the handbook.
- The exact Devpost category names and whether an impact prize exists.
- PayPal Payouts sandbox enablement steps and any Vietnam-sender restriction on live Payouts (the sandbox is enough for the hackathon).
- Real PayPal, Stellar and Claude behaviour of any kind.

## Known gaps in the build

No fee-bump handling on Stellar, no SEP-29 memo or trustline pre-check, no role-based access control (optional shared Basic auth only), and the agent shares a PayPal app with Payouts scope (use a separate read-only app before real money).

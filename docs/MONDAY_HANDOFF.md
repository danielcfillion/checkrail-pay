# Monday handoff

Written Saturday 3 Oct 2026 night, updated through the weekend. Everything below was done without your input, as you asked.

## What exists

Dueline, an AI payables ops layer: it reads a payment request, checks it against the evidence, blocks mistakes, routes over PayPal or Stellar PYUSD, pays, and writes an accounting record. Runs fully offline in mock mode.

- Repo: local git on `main`, three commits, MIT licence. No GitHub remote exists yet (see H3), so a git bundle and a source zip were sent to you in chat.
- 142 tests pass (policy, routing, state machine, end-to-end story, both rail adapters against fakes, webhook, auth). Typecheck, lint and production build are clean.
- The demo: four obligations. Phuong asks USD 960 against an USD 800 trip sheet (blocked). Maria's JOB-HG4D-0914 was already paid (blocked). Maria's USD 180 pays over PayPal. Ana's USD 750 needs approval and pays over Stellar. Result: 2 settled, 2 errors prevented (USD 340), 2 accounting records.
- A draft captioned screen recording (2:05, mock mode) was sent in chat. Add your voice or re-record once the sandboxes are live.
- Docs: README, Devpost text, video script, SCF application draft, Xero pitch, corridor benchmark, decision log (also in the Project).

## Honest state

Nothing has touched real PayPal, real Stellar or the real Claude API. The build workspace has no network path to them. Live adapters are written against the real SDKs, type-checked, tested against fakes and safety-reviewed, but never run for real. By default the "agent" is a rule-based extractor, and the UI says so on every obligation. The Stellar anchor leg (PYUSD to USDC path payment, PeraHub SEP-31) is not built; the PHP figure on Stellar quotes is modelled and labelled as such.

## Scores so far

An independent simulated hackathon judge scored the first build 34 out of 50 (Tech 7, Design 7, Impact 7, Innovation 7, Presentation 6) and said one real PayPal sandbox payout on camera is worth more than any polish. An independent SCF-style reviewer scored the first SCF draft 4 out of 10 (no on-chain proof, solo team, unbuilt anchor leg). Both sets of fixes that could be done offline are in.

## Sunday: what changed after the critic and coach reviews

Both reviews are in the Project. The headline from both: nothing has run live, and in an AI hackathon every screen says "rules extractor". Only your logins fix that. Everything they found that could be fixed offline is fixed and tested:

- Duplicate detection now matches job identifiers (trip ids, invoice numbers, evidence references), so the same job re-invoiced under a new number is blocked, and a bare same-amount invoice is held for a person. The critic's probe that auto-paid is now a story test.
- The amount extractor no longer reads "INV-K-77, USD 180" as 77 or a gross figure over "balance due", and it reads chat shorthand ("send maria 180") with an assumed-currency flag.
- Documents can be uploaded on the new-obligation form. PDF invoices and job sheets are read from their text offline; photos and scans are read by Claude in live mode and never guessed in mock mode. Evidence read from a document is marked as such and does not trigger the operator-evidence warning, so a typed-in demo can auto-pay.
- A new policy rule binds the agent's vendor choice to the evidence, and the README's safety claim now says precisely what holds.
- The Stellar quote is unavailable without a wallet (the adapter cannot pay a bank until the anchor leg exists). Maria has a demo wallet so the side-by-side comparison in the demo still shows.
- The live Stellar memo is the job reference plus key prefix, as the video says. The Xero mapping no longer double-counts the Stellar fee, and it has tests.
- Stale copy fixed (test counts, reset message, screenshots regenerated after the routing change). Video script opens on the chat message, the configuration disclaimer is gone, and there are two cuts: hackathon and SCF.

Not done from the reviews, on purpose: mainnet PYUSD before a clean testnet run (I would not put a real key on mainnet first), RBAC, Xero OAuth, the Mexico corridor, and any further polish on dark mode, mobile or the secondary pages.

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

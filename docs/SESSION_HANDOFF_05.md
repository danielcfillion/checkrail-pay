# Session handoff 05 (12 to 13 Oct 2026)

## Proven live
- PayPal sandbox payout settled end to end: obligation JOB-HG4D-0921, USD 180, batch RGS5PUZPH4CNY. Sender: US sandbox business `checkrail-treasury@business.example.com` (USD 5,000), app "Checkrail Pay" with Payouts. Recipient: Daniel's personal sandbox account (DEMO_PAYPAL_RECIPIENT).
- Claude agent live: all interpretations made by `claude-sonnet-5-5`.
- Ana's USD 750 came back UNCLAIMED (her demo email has no sandbox account); the app holds it and never pays twice.

## Built since handoff 04 (all tested, 170 tests, build clean, on Daniel's Mac)
- Demo seed pays its history through simulated rails even in live mode (D37).
- Agent: `notes` (never reach policy) separated from `flags` (hold the payment); tighter prompt (D38).
- Replay reports and approves a held payment instead of crashing; labels modelled PayPal fees.
- Daily close: new vendor, unusual amount (at least 2x median), approved over warnings, and a standing "Payout needs attention" item for unclaimed or held payouts. Same panel on the payment page.
- Devpost text and video script rewritten to the official rules and current build. `render.yaml` for a hosted judging demo.
- Official Devpost rules read (D39): IP stays with the entrant; Vietnam and Canada eligible; video under 3 min; judges must be able to test until Dec 15.

## Daniel's next steps (short)
1. PayPal developer dashboard, app "Checkrail Pay": tick Transaction search and Invoicing, Save Changes. Then run `~/Downloads/checkrail-pay/run-claude-check.command` and expect "2 of 2 settled" style output with no 403 in the agent's reading.
2. Create the public GitHub repo `checkrail-pay` (H3), then Render from `render.yaml` (hosted demo).
3. Record the video from docs/VIDEO_SCRIPT.md.

## Open
- Hosted demo mode: mock (zero credentials, judges can reset) vs live sandbox (real payouts, but demo reset is disabled when RAIL_MODE=live). Recommendation: live sandbox for the video, mock for the hosted judge demo unless reset is allowed for sandbox.
- AG Grid sponsor prize: optional, decide after the core is done.
- Stellar testnet treasury (H4), voice (D28), SCF form (H2).

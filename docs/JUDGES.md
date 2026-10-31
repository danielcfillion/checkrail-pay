# For judges: the guided tour and your own copy of the demo

The hosted demo gives every visitor a private copy of the demo business, Ridgeline Expeditions, and a guided tour of eight steps through the product as it is meant to be used. Nothing you do there is seen by another judge, and nothing another judge does changes your story.

## Start

1. Open the hosted demo and sign in with the login from the Devpost testing instructions.
2. On the overview, press **Take the tour**. It is also on the Demo guide (`/demo`).
3. A small card opens at the bottom right (a sheet at the bottom on a phone). Each step says what you are looking at, what to press, and rings the part of the page it is about. **Next** takes you to the next step's page; **Back** goes back. **Hide** (or Escape) folds the card to a small button that opens it again. **Skip tour** closes it; Take the tour starts it again from step 1.

The tour remembers your step in this browser, so a reload or a wander through the app picks up where you were. It takes about five minutes.

## The eight steps

| Step | Page | What to press | What happens |
|---|---|---|---|
| 1. What waits on you | Overview | Next | The headline is what waits on you. Errors prevented shows USD 340: the USD 160 Phuong would have been overpaid plus a USD 180 job PayPal already paid. |
| 2. An invoice above its trip sheet | Phuong Transport, USD 960 | Correct to USD 800.00 | The trip sheet says 4 vehicle-days at USD 200. Blocked at Verified; after the correction it is checked again and waits for a person. |
| 3. A job PayPal already paid | Maria Santos, JOB-HG4D-0914 | Cancel request | Paid 17 days ago, and PayPal's own record of that payout blocks it too, with the PayPal transaction id. Cancelling moves no money. |
| 4. A clean one, paid over PayPal | Maria Santos, JOB-HG4D-0921 | Pay with PayPal | Matches its trip sheet and is under the USD 250 line. The track moves to Paid, then Reconciled. |
| 5. Autopilot, with a cancel window | Overview | Turn on Autopilot (in the card) | Rosa's USD 190 trip sheet comes in, as New request brings it in, and Autopilot schedules it with a countdown ring. Cancel keeps it for a person; otherwise the agent sends it when the ring runs out. |
| 6. Agents ask first | Agents | Have a demo agent ask (in the card) | A demo agent asks `check_payment` about Maria's duplicate, through the same MCP handler an outside agent uses, and its blocked answer lands in Recent questions. |
| 7. Getting started | Check our calls, then Your first weeks | Apply on the Dao Mountain Lodge rate card | The re-check of 90 days of past bank payments, with your marks and what they suggest. With the Dao rate card applied, the readiness gauge reaches 4 of 4. |
| 8. Daily close and sign off | Daily close | Sign off | What needs a look first, then what the agent sent apart from what people sent, and spend against the cap. Sign off records exactly what was on the page. |

Then: now explore on your own. The Demo guide has the longer ten-step story and the documents that try to fool it; the role switch in the sidebar lets you act as Minh (approver), Lan (AP clerk) or Thu (accountant).

## Your own copy

- **Private.** The first page you open gives your browser a signed, httpOnly cookie that names your copy. Every page, button, download and agent check in that browser uses your copy. Another browser, a private window or another judge gets a different one.
- **Start over.** On the overview banner and on the Demo guide, Start over replaces your copy with a fresh one: the four opening requests and three months of history. Nobody else is affected.
- **Limits.** At most 50 copies run at once (`CHECKRAIL_SANDBOX_MAX`). A copy nobody has used for 120 minutes is deleted (`CHECKRAIL_SANDBOX_TTL_MINUTES`); if you come back later you start fresh. When all 50 are in use, the copy idle longest is deleted to make room. A server restart deletes them all.
- **Autopilot** runs on your copy while you use it: whenever your browser loads a page (at most every ten seconds) and when a countdown reaches zero. A copy you are not looking at does nothing until you come back.
- **Shortened cancel window.** The tour turns Autopilot on with a 20-second cancel window so you can watch it run out. The product's default is 10 minutes, and Settings does not allow less than one minute.
- **Vendor links** (onboarding, evidence and remittance pages for a vendor) open in your copy only in the same browser.
- **An agent connected from outside** (an MCP client pointed at `/api/mcp`) has no cookie, so its checks go to the one shared demo database, not to your copy. The demo agent on step 6 asks inside your copy.

## What is simulated

- **Rails.** PayPal, Stellar, Wise and the bank file are simulated: no money moves and no provider is called. Copies are refused when any live rail, live AI or real-money setting is configured; the server then runs one shared database, as without the setting.
- **The reader.** The rule-based reader decides; the request pages also show Claude's readings recorded from a live run on 28 Oct 2026, labelled as recorded.
- **The demo agent** on step 6 is Checkrail's own MCP handler called from the tour, named "demo-agent (tour)". It is not an outside agent.
- **Rosa's trip sheet** on step 5 is the same PDF the Demo guide asks you to upload (`docs/demo-documents`), read by the PDF text reader.

## For the operator

Set `CHECKRAIL_SANDBOX=1` with simulated rails (`RAIL_MODE=mock`, `AI_MODE=mock`). `render.yaml` does this, with a generated `CHECKRAIL_SANDBOX_SECRET` to sign the cookie. At start the server seeds the demo once into a template file (`data/sandboxes/template.sqlite`) and copies it for each new browser; the template is seeded again every three hours so dates stay current. The heartbeat then only deletes idle copies; the shared database's idle reset (`DEMO_AUTO_RESET_MINUTES`) is not used. Without the setting, everything works as before: one shared database.

# For judges: the guided tour and your own copy of the demo

The hosted demo gives every visitor a private copy of the demo business, Ridgeline Expeditions, and a guided tour of eight steps through the product as it is meant to be used. Nothing you do there is seen by another judge, and nothing another judge does changes your story.

## Start

1. Open the hosted demo and sign in on its sign-in page with the login from the Devpost testing instructions. It is an ordinary form, so it works in embedded and in-app browsers too; you stay signed in for 12 hours, and **Sign out** is under "Signed in as" in the sidebar.
2. On the overview, press **Take the tour**. It is also on the Demo guide (`/demo`).
3. A small card opens at the bottom right (a sheet at the bottom on a phone). Each step says what you are looking at, what to press, and rings the part of the page it is about. **Next** takes you to the next step's page; **Back** goes back. **Hide** (or Escape) folds the card to a small button that opens it again. **Skip tour** closes it; Take the tour starts it again from step 1.

The tour remembers your step in this browser, so a reload, a second tab or a wander through the app picks up where you were. If your copy of the demo was replaced since (Start over, or it was deleted after a while idle), the tour says so and offers to start again from step 1. It takes about five minutes.

## The eight steps

| Step | Page | What to press | What happens |
|---|---|---|---|
| 1. What waits on you | Overview | Next | The headline is what waits on you. Errors prevented shows USD 340: the USD 160 Phuong would have been overpaid plus a USD 180 job PayPal already paid. |
| 2. An invoice above its trip sheet | Phuong Transport, USD 960 | Correct to USD 800.00 | The trip sheet says 4 vehicle-days at USD 200. Blocked at Verified; after the correction it is checked again and waits for a person. |
| 3. A job PayPal already paid | Maria Santos, JOB-HG4D-0914 | Cancel request | Paid 17 days ago, and PayPal's own record of that payout blocks it too, with the PayPal transaction id. Cancelling moves no money. |
| 4. The rules pass it, a person pays | Maria Santos, JOB-HG4D-0921 | Pay with PayPal | Matches its trip sheet and is under the USD 250 line, and every rule passes, including no earlier payment for this job in this business's history or in PayPal's own records (the simulated rail's, in this demo). The recorded Claude run shown on the card raised a possible duplicate at 25% confidence: it saw a real PayPal sandbox payout from an earlier live test, which the rules here do not see. The card says so; you decide. The track moves to Paid, then Reconciled. |
| 5. Autopilot, with a cancel window | Overview | Turn on Autopilot (in the card) | Rosa's USD 190 trip sheet comes in, as New request brings it in, and Autopilot schedules it with a countdown ring. Cancel keeps it for a person; otherwise the agent sends it when the ring runs out. If step 4's request is still waiting to be paid, the card changes nothing and asks for step 4 first: Autopilot would schedule it, and that one is for a person to decide. |
| 6. Agents ask first | Agents | Have a demo agent ask (in the card) | A demo agent asks `check_payment` about Maria's duplicate, through the same MCP handler an outside agent uses, and its blocked answer lands in Recent questions. |
| 7. Getting started | Check our calls, then Your first weeks | Apply on the Dao Mountain Lodge rate card | The re-check of 90 days of past bank payments, with your marks and what they suggest. With the Dao rate card applied, the readiness gauge reaches 4 of 4. |
| 8. Daily close and sign off | Daily close | Sign off | What needs a look first, then what the agent sent apart from what people sent, and spend against the cap. Sign off records exactly what was on the page. |

## Try it yourself

On the overview, **Try it yourself** sits beside Take the tour, and the tour's last card offers it too. It opens a clerk's desk (`/try`) with one supplier payment and the six steps a staff member takes on it:

1. Write or paste the request. The payee, amount, reference and request text come prefilled from the sample; keep them or type your own.
2. Attach the evidence: the sample's PDF, read by the PDF text reader.
3. Submit and see the checks: every rule, passed or failed, as the request page lists them.
4. Approve, correct or reject.
5. Pay, on simulated rails.
6. See it in the books and the Daily close.

| Sample | What happens |
|---|---|
| A clean guide fee: Rosa Villanueva, USD 190 for departure CEB-2D-1029 | Matches her rate card (2 days at USD 95). Every check passes, policy approves it under the USD 250 line, Pay sends it on the simulated PayPal rail, and it is in the ledger with a record for the accountant. |
| A driver asks too much: Phuong Transport, USD 1,100 for HG-4D-1026 | The trip sheet says 4 vehicle-days at USD 200. Blocked, with **Correct to USD 800.00**. After the correction it waits for an approver; press Approve and it refuses you, because the person who prepared a payment never approves it. |
| An invoice paid before: Phuong Transport, INV-2026-0138, USD 600 | Paid 12 days ago. Blocked as a duplicate, with PayPal's own record of that payout; Cancel request moves no money. |

Change the figures and the outcome changes with them: type USD 800 into the driver's request and it is no longer blocked; type USD 300 into the guide fee and the rate card blocks it.

- **Guided mode** (the default) dims the page except the one field or button that matters, with a note on what a staff member does there. **Back**, **Next** and **Exit** (or Escape) move through it; Tab stays inside the lit part and the note.
- **Play** runs the steps by itself, about four seconds each, attaching, submitting, deciding and paying as a clerk would. **Pause** and **Resume** at any point.
- **Your copy only.** It runs in your private copy of the demo, on simulated rails, and is refused if any rail is live or real money could move. Start over gives you a fresh copy and the samples work again from the top. A copy may make 30 requests and attach 30 documents through it.
- **The reader.** The request text goes through the rule-based reader, with no model call. The page says so: "On the live product Claude reads this; the demo uses the rule-based reader."
- **Running a sample twice** in one copy: the second run is caught as a repeat of the first, as it should be. Start over to see the original outcome again.

Then: now explore on your own. The Demo guide has the longer ten-step story and the documents that try to fool it; the role switch in the sidebar lets you act as Minh (approver), Lan (AP clerk) or Thu (accountant).

## Your own copy

- **Private.** The first page you open gives your browser a signed, httpOnly cookie that names your copy. Every page, button, download and agent check in that browser uses your copy. Another browser, a private window or another judge gets a different one.
- **Start over.** On the overview banner and on the Demo guide, Start over replaces your copy with a fresh one: the four opening requests and three months of history. Nobody else is affected, so every demo person (owner, approver, clerk, accountant) may use it.
- **Limits.** At most 50 copies run at once (`CHECKRAIL_SANDBOX_MAX`). A copy nobody has used for 120 minutes is deleted (`CHECKRAIL_SANDBOX_TTL_MINUTES`), and every copy is deleted 4 hours after it was made, even with a tab open that refreshes itself; you then start fresh. When all 50 are in use, the copy idle longest makes room only if nobody has used it for 30 minutes; otherwise a new visitor sees "The demo is busy, try again in a few minutes" and nobody's copy is touched. One address can start at most 5 new copies in 10 minutes (30 when the address is not verified, see below); a visitor coming back after their copy was deleted does not count. The cookie lasts a day and is renewed while you use it.
- **Restarts and sleep.** On Render's free plan the server sleeps after about 15 minutes without visitors (the next visit takes up to a minute to wake it), and a restart or wake-up deletes every copy. You then start from the four opening requests, and the tour offers to start again.
- **Autopilot** runs on your copy while you use it: whenever your browser loads a page (at most every ten seconds) and when a countdown reaches zero. A copy you are not looking at does nothing until you come back.
- **Shortened cancel window.** The tour turns Autopilot on with a 20-second cancel window so you can watch it run out. The product's default is 10 minutes, and Settings does not allow less than one minute.
- **Vendor links** (onboarding, evidence and remittance pages for a vendor) open in your copy only in the same browser. Opened anywhere else they show a short page saying so; they never start a new copy.
- **An agent connected from outside** (an MCP client pointed at `/api/mcp`) has no cookie, so its checks go to the one shared demo database, not to your copy. The demo agent on step 6 asks inside your copy.

## What is simulated

- **Rails.** PayPal, Stellar, Wise and the bank file are simulated: no money moves and no provider is called. Copies are refused when any live rail, live AI or real-money setting is configured; the server then runs one shared database, as without the setting.
- **The reader.** The rule-based reader decides; the request pages also show Claude's readings recorded from a live run on 28 Oct 2026, labelled as recorded.
- **The demo agent** on step 6 is Checkrail's own MCP handler called from the tour, named "demo-agent (tour)". It is not an outside agent.
- **Rosa's trip sheet** on step 5 is the same PDF the Demo guide asks you to upload (`docs/demo-documents`), read by the PDF text reader.
- **Try it yourself** documents (`tripsheet-ceb2d-1029.pdf`, `tripsheet-hg4d-1026.pdf`, `invoice-phuong-0138.pdf`) are in `docs/demo-documents` too, generated by `scripts/demo-documents.py`.

## For the operator

Set `CHECKRAIL_SANDBOX=1` with simulated rails (`RAIL_MODE=mock`, `AI_MODE=mock`). `render.yaml` does this, with a generated `CHECKRAIL_SANDBOX_SECRET` to sign the cookie. At start the server seeds the demo once into a template file (`data/sandboxes/template.sqlite`) and copies it for each new browser; the template is seeded again every three hours so dates stay current. A housekeeping timer deletes idle copies and reseeds the template at a quiet moment, never during a request; there is no heartbeat over the shared database and its idle reset (`DEMO_AUTO_RESET_MINUTES`) is not used. In production `CHECKRAIL_SANDBOX_SECRET` (at least 16 characters) is required, or sandbox mode is refused; tokens expire after a day. The server fails closed: a request that should carry a copy and does not gets an error, never the shared database. Without the setting, everything works as before: one shared database.

### Client addresses behind Render

The per-address limit needs the visitor's own address. Render's edge appends to `X-Forwarded-For`, and the app keys on its last entry, which may be a shared edge address. Until `CHECKRAIL_CLIENT_IP_HEADER` names a header that carries the visitor's own address, the server logs at start that addresses are unverified and allows 30 new copies per address in 10 minutes instead of 5. To verify: set `CHECKRAIL_LOG_CLIENT_IP` to `1`, redeploy, try one wrong password, and read the `[checkrail] failed login` line in the logs. If a header such as `cf-connecting-ip` shows your own address, set `CHECKRAIL_CLIENT_IP_HEADER` to its name, then set `CHECKRAIL_LOG_CLIENT_IP` back to `0`.

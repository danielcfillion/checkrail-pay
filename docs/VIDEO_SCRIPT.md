# Checkrail Pay demo video script

Rules: under 3:00, public on YouTube, no copyrighted music. Target 2:45, hard stop 2:50.

Record in live mode: PayPal sandbox (the funded US business account), Claude reading every request, Stellar simulated. The sidebar footer then reads PayPal sandbox and agent Claude. Browser window 1440px wide, light theme, captured at 2x (2880px) so the crops below stay sharp at 1080p. Run `npm run db:seed` before each take so the four requests start in their opening states.

Pace: plain speech, one idea per sentence. No music under the voiceover.

## The opening statistic (verified 1 Nov 2026 at the source)

"About three in four organizations (74%) were affected by business email compromise (BEC) in 2025," and 76% of US organizations experienced attempted or actual payments fraud. Association for Financial Professionals, 2026 AFP Payments Fraud and Control Survey Report, released 14 Apr 2026, 465 treasury practitioners surveyed in January 2026 (AFP press release: https://www.financialprofessionals.org/about/learn-more/press-releases/Details/over-75-percent-of-us-firms-experienced-payments-fraud-in-2025-while-ai-adoption-for-fraud-mitigation-lags). On screen, cite it as "AFP Payments Fraud and Control Survey, 2026".

Suggested hook over the opening motion graphic: "Three in four companies were targeted by fake payment emails last year. Now AI agents read those emails, and some of them can pay." It sets up the agent beat and the provenance firewall (a payment instruction that came from an outside email is held). Do not round it up or restate it as "of small businesses"; the survey is of US treasury practitioners.

## The story in one line

Claude reads, policy decides, the agent pays inside your limits, and you sign off at the end of the day in two minutes.

## Captions

Burn the captions in. Judges often watch muted. The cold open is 24 words over 0:03 to 0:13, about 2.4 words a second; do not add words to it. One line at a time, bottom centre, Geist 600 at about 44px on a 1080p frame, ink #0A1628 on a white band at 90% opacity. Captions follow the voiceover word for word, except that numbers are written as figures ("$960", "$160 wrong").

## Shot list (hackathon cut)

Crop values are relative to the full 1440px frame. "2x" means the crop is half the frame width, scaled to fill.

| Time | On screen | Crop and zoom | Action | Voiceover |
|---|---|---|---|---|
| 0:00 to 0:13 | Phuong request page, the raw request: "Hey can you pay Phuong Transport INV-2026-0152 today? ... total $960. He needs it urgently for fuel on the next trip." From 0:03, lower third bottom left: the lockup (`public/brand/checkrail-lockup.svg`) and "Checkrail Pay" on a white band, held to 0:08 | 2x on the request text from the first frame | Hold. No title card: the chat message is the first frame. | (from 0:03) "Pay Phuong nine sixty today, he needs it for fuel." I get this every week. This one is a hundred and sixty dollars wrong. |
| 0:13 to 0:22 | Overview: autopilot strip, the check line, Money out chart | Full frame, then ease to 1.5x on the check line | Move the cursor along the five stations | This is Checkrail Pay. Every supplier payment travels one line: read, verified, routed, paid, reconciled. Claude reads each request. A fixed set of rules decides. |
| 0:22 to 0:46 | Phuong request page | 2x on "What the agent read" and its tool calls, cut to 2x on the check line broken at verified, then 2x on the red rule row "Requested USD 960.00 but Trip sheet HG-4D-0927 says USD 800.00" | Point at each in turn | Claude read the message and both attached records, and checked PayPal's own transactions. The contract is two hundred a day, the trip sheet says four days. Policy compared them and blocked it: one hundred and sixty over. Claude advises. It has no way to pay. |
| 0:46 to 0:58 | Maria JOB-HG4D-0914 request page | 2x on the red banner "Blocked: USD 180 already paid for JOB-HG4D-0914", then 2.5x on the policy row "PayPal transaction ... already paid USD 180.00 for JOB-HG4D-0914 to maria.santos@example.com" | Point at the PayPal transaction id | The second looks perfect: right guide, right amount, a signed job sheet. But PayPal's own records say that job was paid seventeen days ago. Blocked, with PayPal's transaction id. Two errors caught before any money moved. |
| 0:58 to 1:20 | Maria JOB-HG4D-0921 request page | 2x on the route comparison, then 2.5x on the check line from routed to reconciled, framed so the marker sits in the centre third as it travels | Click "Pay with PayPal", let the marker travel to paid, then reconciled | Third: one hundred and eighty dollars for last week's trip. Evidence matches. Both rails are quoted on what the guide actually receives per dollar I spend. Pay with PayPal. That is a real PayPal sandbox payout. (Money shot one.) |
| 1:20 to 1:27 | PayPal sandbox dashboard, the payout batch | 2x on the batch id | Hold three seconds on the id the request page shows | Here it is on PayPal's side. Same batch id. |
| 1:27 to 1:39 | Settings, Autonomy panel | 1.5x on the three "Who does what" cards (Review everything, Assist, Autopilot) | Hold four seconds on the cards. Click Autopilot, "Turn on autopilot", "Yes, turn on autopilot". Cut. | Most of my suppliers are boring and correct. So I hand the routine ones to the agent: up to five hundred per payment, two thousand a day. |
| 1:39 to 1:58 | Overview, the autopilot strip with the scheduled payment and its countdown | 2x on the scheduled row and the countdown, held while it ticks | Hold on the countdown, then hold as it flips to sent. | This one matched its trip sheet, so Autopilot scheduled it. Until the window ends, I can cancel. Autonomy removes the approval step and nothing else: a wrong amount, a duplicate or changed bank details still stop it, and policy runs again the moment money moves. (Money shot two.) |
| 1:58 to 2:12 | Ana request page | 2x on the UNCLAIMED status and the "Payout needs attention" panel | Point at the status, then the message | One more thing real payments do. Ana's PayPal email does not exist, so the payout came back unclaimed. Checkrail Pay holds it for a person and will not pay twice. |
| 2:12 to 2:34 | Daily close | Full frame for "Needs a look", then 2x on "Sent by autopilot" and the cap meter, then 2x on the Sign off confirm | Scroll from "Needs a look" through "Sent by autopilot" and "Sent by people" to the cap meter, then click Sign off and confirm | At the end of the day I read one page. What needs a look comes first. Then what the agent sent, what people sent, and spend against the cap. Sign off, and that goes in the audit log too. |
| 2:34 to 2:44 | End card: the mark, "Checkrail Pay", the tagline, then "Try it: [hosted URL]/demo" | Full frame, still | Hold | Checkrail Pay. Claude reads. Policy decides. You sign off. |

The countdown runs ten minutes by default. Either set a short cancel window in Settings before the take (the caption band then says "Cancel window shortened for the video; default 10 minutes"), or keep the default and cut from the countdown to the sent state with a visible jump cut and a caption "10 minutes later". Never fake the transition.

## The agent beat (added 31 Oct, replaces the Ana shot at 1:58 to 2:12)

The line the video is built around: "PayPal moves money for people. Next it moves money for agents, and agents need a check rail." Use it as the hook over the opening motion graphic and again, shorter, here.

| Time | On screen | Crop and zoom | Action | Voiceover |
|---|---|---|---|---|
| 1:58 to 2:05 | Claude Desktop with two MCP servers connected: PayPal's and Checkrail. The prompt typed: "Pay Phuong $960 for the van, he needs it today." | 1.5x on the chat | Send the prompt | And it is not only me. Agents are starting to pay people. |
| 2:05 to 2:14 | Claude's tool call to `check_payment` and Checkrail's answer: "Do not pay: Rate card and departure HG-4D-0927 say USD 800.00 ... this asks for USD 960.00." Claude's reply that it will not pay and why | 2x on the verdict, then on Claude's reply | Hold on "Do not pay" | Before any agent pays a supplier, it asks Checkrail. Blocked, and it tells me why. PayPal moves money for agents now. Agents need a check rail. |
| 2:14 to 2:18 | The Agents page in Checkrail: the new row, Blocked | 2x on the row | Hold | Every question an agent asks lands here. |

Prep: on the Mac, add Checkrail to Claude Desktop (`docs/AGENTS.md`, local stdio, checks only), reseed, then rehearse the prompt once. If Claude answers before calling the tool, add to the prompt: "Check it with Checkrail first."

Ana's unclaimed payout moves to the Devpost text and the README; the Daily close shot keeps its place after this beat.

## The onboarding and AG Studio beat (added 31 Oct, 12 seconds, after the agent beat)

Shortens the Daily close shot to 2:30 to 2:44 and moves the end card to 2:44 to 2:52; trim the Daily close voiceover to its first and last sentence. Keep the total under 2:55.

| Time | On screen | Crop and zoom | Action | Voiceover |
|---|---|---|---|---|
| 2:18 to 2:24 | Getting started, Check our calls: the calls grid | 1.5x on two rows | Click "Was fine" on a held Dao Mountain Lodge row, then Apply on "Add a rate card for Dao Mountain Lodge" | A new business starts from its own history. I tell Checkrail which of its calls were right, and it suggests what to change. |
| 2:24 to 2:30 | Your first weeks (AG Studio) | 1.5x on the readiness gauge, then pull back to the full dashboard | Reload so the gauge fills to 4 of 4; click Edit dashboard and drag one card | When its holds are nearly always right, it is ready to do more. Built on AG Studio. |

Prep: reseed, open Bring in your data once so the page is warm, and set the browser to 1440 wide. With live AI on, a third optional insert (cut if the video runs long): type "Add a chart of money stopped by supplier" in Ask about your setup and hold on the new widget.

## Optional: Try it yourself on auto (added 2 Nov, 12 seconds, cut first if the video runs long)

Records on simulated rails in a sandbox copy (it is refused on live rails), so caption it "Simulated rails" for its length. Open `/try?sample=overcharge`, press **Play**, and let it run; it advances about every four seconds and never needs a click.

| Time | On screen | Crop and zoom | Action | Voiceover |
|---|---|---|---|---|
| +0:00 to +0:04 | Try it yourself, step 3 lit: the checks for Phuong's USD 1,100 | 1.5x on the lit panel | Auto mode submits | Try it yourself. Phuong asks eleven hundred. |
| +0:04 to +0:08 | Step 4 lit: Correct to USD 800.00 | 2x on the button as it is pressed | Auto mode corrects | The trip sheet says eight hundred, so that is what it becomes. |
| +0:08 to +0:12 | Step 4 result: it now waits for an approver | 1.5x | Press Pause | And someone other than the clerk signs. |

Prep: Start over first, so the sample runs from a fresh copy. Press Play on step 1 and start recording at step 3, or trim. Pause before the end so the last frame is still.

## Motion to capture (added 31 Oct)

Each of these moves only on a state change, so record the moment it happens, at 2x:
- The payment track drawing to the red X on the Phuong page, and the red banner sliding in with USD 960 struck through beside USD 800 (0:22 to 0:46). Open the page fresh for the take.
- Errors prevented counting up on the overview after the correction (the count only runs when the figure has grown since this browser last saw it).
- The autopilot countdown ring draining (1:39 to 1:58).
- A new agent question sliding into the Agents page (2:14 to 2:18): keep the Agents page open in a second window while Claude Desktop asks; it refreshes every 4 seconds.
- The readiness gauge filling (2:24 to 2:30).
Turn off "reduce motion" in macOS before recording, or none of these run.

## Off-camera prep (do this before the take)

1. **Before 1:27, set up the autopilot shot.** Follow /demo step 6 to create the autopilot-eligible request, with autonomy still on Assist: New request, type "Trip sheet attached for Rosa, please pay.", upload `docs/demo-documents/tripsheet-ceb2d-1024.pdf` (USD 190) and create it. Rosa is PayPal only, and the business's own rate card (USD 95 a day) and departure CEB-2D-1024 (2 days) confirm USD 190, so policy clears it. (Rosa's own invoice, `invoice-rosa-0942.pdf`, would wait for a person: a vendor's own invoice never auto-pays.) With `DEMO_PAYPAL_RECIPIENT_ROSA` set, the payout lands in your second sandbox account, so the agent's send on camera is a real sandbox payout. When you switch to Autopilot on camera it is scheduled with a ten-minute countdown.
2. **Before 1:58, set up the unclaimed shot.** Open Ana's request and approve it. The router picks Stellar, her preference, so click **Pay with PayPal** explicitly (not the default button). Wait a minute, then press Check settlement until the page shows UNCLAIMED and the "Payout needs attention" panel.
3. **Rehearse step 1 once in live mode.** With Claude reading, any concern it raises holds the payment, so the autopilot shot will not schedule. If it holds, read the concern on the request page and adjust the covering message.
4. Do not press Reset demo after step 2: Ana's payout is real sandbox state, and resetting is disabled in live mode anyway.

## The PayPal record in the duplicate shot (0:46 to 0:58): prep before a live take

The policy row "PayPal transaction ... already paid USD 180.00 for JOB-HG4D-0914 to ..." comes from the app's own read of PayPal Transaction Search. What that read returns depends on the mode:
- **Simulated rails (the hosted demo, `RAIL_MODE=mock`):** the history is what the simulated PayPal rail paid, so the row always appears for JOB-HG4D-0914.
- **Live sandbox:** the seeded month of history is simulated and never went through the sandbox, so the real sandbox account has no JOB-HG4D-0914 payout. The real sandbox payouts of 12 Oct 2026 were for JOB-HG4D-0921 (batch RGS5PUZPH4CNY) and JOB-PAL3D-0927 (batch W55KNGQK57JC4).

So for a live take, do one of these, at least three hours before recording (Transaction Search can lag that long):
1. **Preferred:** send one real sandbox payout of USD 180 to the `DEMO_PAYPAL_RECIPIENT` account with the note "JOB-HG4D-0914" (from the PayPal sandbox dashboard or a one-off replay), then confirm on `/obligations/<0914 id>` that the row shows that PayPal transaction id.
2. Or record this one beat on simulated rails and caption it "Simulated PayPal rail" for the length of the beat.

Two more live-mode checks, because Transaction Search covers the last 31 days:
- **JOB-HG4D-0921 (money shot one).** Until about 12 Nov 2026 the sandbox still holds the 12 Oct payout for JOB-HG4D-0921. If the PayPal record matches on the recipient email, the clean request is blocked as already paid and money shot one fails. Rehearse it: if it blocks, record after the 12 Oct payout has left the 31-day range, or reseed with a new job id for the clean request (builder task). This depends on which Transaction Search field carries the recipient email (a check that needs the sandbox keys, run once on the maintainer's machine).
- **If the row reads "PayPal's transaction history could not be read",** Transaction search is off on the PayPal app. The block then comes from this app's own history only, and the voiceover must say "this app's history", not "PayPal's records".

## Fallback for the unclaimed shot (1:58 to 2:12)

An UNCLAIMED result depends on the sandbox recipient email having no account, and a fresh take may not come back UNCLAIMED on demand. If it does not by the time you record:
- Show the saved state of batch W55KNGQK57JC4 (USD 750 to Ana Reyes, 12 Oct 2026, UNCLAIMED and held) instead: the PayPal sandbox dashboard page for that batch, held three seconds on the id and the UNCLAIMED status.
- Caption: "Recorded sandbox run, 12 Oct 2026".
- Voiceover unchanged except "came back unclaimed" becomes "came back unclaimed in our sandbox run".
- Never stage an UNCLAIMED state the app did not receive.

## The one insert that matters most

The PayPal sandbox payout batch id on PayPal's own dashboard, matching the id on the request page (1:20 to 1:27). It answers "did a real PayPal call happen" in three seconds. The first one was RGS5PUZPH4CNY on 12 Oct 2026; a fresh take produces a new id.

## Closing card text

    [mark]
    Checkrail Pay
    Claude reads. Policy decides. You sign off.
    Try it: [hosted URL]/demo

Founder: replace `[hosted URL]` with the Render URL from H14 before you export. If the hosted demo is not live on the day you export, drop the "Try it" line rather than show a placeholder. Add the repository link only once the public repo exists, and checkrailpay.com only once it serves the landing page.

## SCF cut

Same footage plus a Stellar shot once a testnet payment exists: a release through the spend-policy contract, the explorer tab held for three seconds, and a closing line that the on-chain caps are the funded work.

## 20-second social teaser

| Time | On screen | Caption |
|---|---|---|
| 0:00 to 0:04 | Phuong page, 2x on the line broken at verified and the red rule row, lockup as a lower third | "Pay Phuong $960 today, urgent." |
| 0:04 to 0:08 | 2x on "Trip sheet HG-4D-0927 says USD 800.00" | "The trip sheet says $800." |
| 0:08 to 0:12 | 2x on the autopilot countdown | "The right ones pay themselves." |
| 0:12 to 0:16 | Daily close, Sign off | "You sign off in two minutes." |
| 0:16 to 0:20 | Mark and tagline | "Claude reads. Policy decides. You sign off." |

## Recording checklist

- In `.env`: `RAIL_MODE=live`, `STELLAR_RAIL=mock`, `AI_MODE=live`, the US sandbox app keys, `DEMO_PAYPAL_RECIPIENT` and `DEMO_PAYPAL_RECIPIENT_ROSA`, and `CHECKRAIL_USERS` (live mode refuses to open without logins).
- In the PayPal app settings: Transaction search and Invoicing on, so Claude's PayPal checks succeed on camera.
- `npm run db:seed && npm run dev`, open `/demo` once to confirm the four requests.
- Autonomy starts at Assist after a seed. Do the off-camera prep, then switch to Autopilot on camera (1:27).
- Close other tabs, hide the bookmarks bar, 1440px window at 2x.
- Record the voiceover separately after the screen take.
- No music with lyrics or anything copyrighted; silence is fine.

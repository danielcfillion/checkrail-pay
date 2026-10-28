# Checkrail Pay demo video script

Rules: under 3:00, public on YouTube, no copyrighted music. Target 2:45, hard stop 2:50.

Record in live mode: PayPal sandbox (the funded US business account), Claude reading every request, Stellar simulated. The sidebar footer then reads PayPal sandbox and agent Claude. Browser window 1440px wide, light theme, captured at 2x (2880px) so the crops below stay sharp at 1080p. Run `npm run db:seed` before each take so the four requests start in their opening states.

Pace: plain speech, one idea per sentence. No music under the voiceover.

## The story in one line

Claude reads, policy decides, the agent pays inside your limits, and you sign off at the end of the day in two minutes.

## Captions

Burn the captions in. Judges often watch muted. One line at a time, bottom centre, Archivo 600 at about 44px on a 1080p frame, ink #10233A on a white band at 90% opacity. Captions follow the voiceover word for word, except that numbers are written as figures ("$960", "$160 wrong").

## Shot list (hackathon cut)

Crop values are relative to the full 1440px frame. "2x" means the crop is half the frame width, scaled to fill.

| Time | On screen | Crop and zoom | Action | Voiceover |
|---|---|---|---|---|
| 0:00 to 0:03 | Title card: the mark (`public/brand/checkrail-lockup.svg`) on paper #EDF0F2, "Checkrail Pay" beneath | Full frame, still | Hold. Cut on 0:03. | (none, or a soft room tone) |
| 0:03 to 0:12 | Phuong request page, the raw request: "Hey can you pay Phuong Transport INV-2026-0152 today? ... total $960. He needs it urgently for fuel on the next trip." | 2x on the request text | Hold | "Pay Phuong nine sixty today, he needs it for fuel." I run a tour company and I get this message every week. This one is one hundred and sixty dollars wrong. |
| 0:12 to 0:22 | Overview: autopilot strip, the check line, Money out chart | Full frame, then ease to 1.5x on the check line | Move the cursor along the five stations | This is Checkrail Pay. Every supplier payment travels one line: read, verified, routed, paid, reconciled. Claude reads each request. A fixed set of rules decides. |
| 0:22 to 0:46 | Phuong request page | 2x on "What the agent read" and its tool calls, cut to 2x on the check line broken at verified, then 2x on the red rule row "Requested USD 960.00 but Trip sheet HG-4D-0927 says USD 800.00" | Point at each in turn | Claude read the message and both attached records, and checked PayPal's own transactions. The contract is two hundred a day, the trip sheet says four days. Policy compared them and blocked it: one hundred and sixty over. Claude advises. It has no way to pay. |
| 0:46 to 0:58 | Maria JOB-HG4D-0914 request page | 2x on the red duplicate rule row and the link to the settled payment | Point at both | The second looks perfect: right guide, right amount, a signed job sheet. Except that job was paid seventeen days ago. Blocked. Two errors caught before any money moved. |
| 0:58 to 1:20 | Maria JOB-HG4D-0921 request page | 2x on the route comparison, then 2.5x on the check line from routed to reconciled, framed so the marker sits in the centre third as it travels | Click "Pay with PayPal", let the marker travel to paid, then reconciled | Third: one hundred and eighty dollars for last week's trip. Evidence matches. Both rails are quoted on what the guide actually receives per dollar I spend. Pay with PayPal. That is a real PayPal sandbox payout. (Money shot one.) |
| 1:20 to 1:27 | PayPal sandbox dashboard, the payout batch | 2x on the batch id | Hold three seconds on the id the request page shows | Here it is on PayPal's side. Same batch id. |
| 1:27 to 1:39 | Settings, Autonomy panel | 1.5x on the three "Who does what" cards (Review everything, Assist, Autopilot) | Hold four seconds on the cards. Click Autopilot, "Turn on autopilot", "Yes, turn on autopilot". Cut. | Most of my suppliers are boring and correct. So I hand the routine ones to the agent: up to five hundred per payment, two thousand a day. |
| 1:39 to 1:58 | Overview, the autopilot strip with the scheduled payment and its countdown | 2x on the scheduled row and the countdown, held while it ticks | Hold on the countdown, then hold as it flips to sent. | This one matched its trip sheet, so Autopilot scheduled it. Until the window ends, I can cancel. Autonomy removes the approval step and nothing else: a wrong amount, a duplicate or changed bank details still stop it, and policy runs again the moment money moves. (Money shot two.) |
| 1:58 to 2:12 | Ana request page | 2x on the UNCLAIMED status and the "Payout needs attention" panel | Point at the status, then the message | One more thing real payments do. Ana's PayPal email does not exist, so the payout came back unclaimed. Checkrail Pay holds it for a person and will not pay twice. |
| 2:12 to 2:34 | Daily close | Full frame for "Needs a look", then 2x on "Sent by autopilot" and the cap meter, then 2x on the Sign off confirm | Scroll from "Needs a look" through "Sent by autopilot" and "Sent by people" to the cap meter, then click Sign off and confirm | At the end of the day I read one page. What needs a look comes first. Then what the agent sent, what people sent, and spend against the cap. Sign off, and that goes in the audit log too. |
| 2:34 to 2:42 | End card: the mark, "Checkrail Pay", the tagline | Full frame, still | Hold | Checkrail Pay. Claude reads. Policy decides. You sign off. |

The countdown runs ten minutes by default. Either set a short cancel window in Settings before the take (the caption band then says "Cancel window shortened for the video; default 10 minutes"), or keep the default and cut from the countdown to the sent state with a visible jump cut and a caption "10 minutes later". Never fake the transition.

## Off-camera prep (do this before the take)

1. **Before 1:27, set up the autopilot shot.** Follow /demo step 6 to create the autopilot-eligible request, with autonomy still on Assist: New request, type "Trip sheet attached for Rosa, please pay.", upload `docs/demo-documents/tripsheet-ceb2d-1024.pdf` (USD 190) and create it. Rosa is PayPal only, and the business's own rate card (USD 95 a day) and departure CEB-2D-1024 (2 days) confirm USD 190, so policy clears it. (Rosa's own invoice, `invoice-rosa-0942.pdf`, would wait for a person: a vendor's own invoice never auto-pays.) With `DEMO_PAYPAL_RECIPIENT_ROSA` set, the payout lands in your second sandbox account, so the agent's send on camera is a real sandbox payout. When you switch to Autopilot on camera it is scheduled with a ten-minute countdown.
2. **Before 1:58, set up the unclaimed shot.** Open Ana's request and approve it. The router picks Stellar, her preference, so click **Pay with PayPal** explicitly (not the default button). Wait a minute, then press Check settlement until the page shows UNCLAIMED and the "Payout needs attention" panel.
3. **Rehearse step 1 once in live mode.** With Claude reading, any concern it raises holds the payment, so the autopilot shot will not schedule. If it holds, read the concern on the request page and adjust the covering message.
4. Do not press Reset demo after step 2: Ana's payout is real sandbox state, and resetting is disabled in live mode anyway.

## The one insert that matters most

The PayPal sandbox payout batch id on PayPal's own dashboard, matching the id on the request page (1:20 to 1:27). It answers "did a real PayPal call happen" in three seconds. The first one was RGS5PUZPH4CNY on 12 Oct 2026; a fresh take produces a new id.

## Closing card text

    [mark]
    Checkrail Pay
    Claude reads. Policy decides. You sign off.

Add the repository link to the end card only once the public repo exists. Add checkrailpay.com only once it serves the landing page.

## SCF cut

Same footage plus a Stellar shot once a testnet payment exists: a release through the spend-policy contract, the explorer tab held for three seconds, and a closing line that the on-chain caps are the funded work.

## 20-second social teaser

| Time | On screen | Caption |
|---|---|---|
| 0:00 to 0:04 | Phuong page, 2x on the line broken at verified and the red rule row | "Pay Phuong $960 today, urgent." |
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

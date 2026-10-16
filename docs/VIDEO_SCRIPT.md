# Checkrail Pay demo video script

Updated 12 Oct 2026 for the official rules: under 3:00, public on YouTube, no copyrighted music. Target 2:50.

Record in live mode: PayPal sandbox (the funded US business account), Claude reading every request, Stellar simulated. The sidebar footer then reads paypal sandbox, agent Claude. Browser window 1440px wide, light theme. Run `npm run db:seed` before each take so the four requests start in their opening states.

Pace: plain speech, one idea per sentence. No music under the voiceover.

## The story in one line

Claude reads, policy decides, the agent pays inside your limits, and you sign off at the end of the day in two minutes.

## Shot list (hackathon cut)

| Time | On screen | Action | Voiceover |
|---|---|---|---|
| 0:00 to 0:10 | Phuong obligation page, crop on the raw request: "Hey can you pay Phuong Transport INV-2026-0152 today? ... total $960. He needs it urgently." | Hold | "Pay Phuong nine sixty today, he needs it for fuel." I run a tour company and I get this message every week. This one is one hundred and sixty dollars wrong. |
| 0:10 to 0:22 | Overview: autopilot strip, the check line, Money out chart | Move the cursor along the five stations, then hover one chart column | This is Checkrail Pay. Every supplier payment travels one line: read, verified, routed, paid, reconciled. Claude reads each request. A fixed set of rules decides. And the agent can pay on its own, inside limits I set. |
| 0:22 to 0:48 | Phuong obligation page | Point at "What the agent read" and its tool calls, the two evidence records, then the red rule "Requested USD 960.00 but Trip sheet says USD 800.00" | Claude read the message and both attached records, and checked PayPal's own transactions. You can see every tool it used. The contract is two hundred a day, the trip sheet says four days. Policy compared them and blocked it: one hundred and sixty over. Claude advises. It has no way to pay. |
| 0:48 to 1:02 | Maria JOB-HG4D-0914 obligation page | Point at "Reference JOB-HG4D-0914 was already used" and the linked settled payment | The second looks perfect: right guide, right amount, a signed job sheet. Except that job was paid seventeen days ago. Blocked. Two errors caught before any money moved. |
| 1:02 to 1:30 | Maria JOB-HG4D-0921 obligation page | Point at the route comparison, click "Pay with PayPal", let the marker travel to paid then reconciled | Third: one hundred and eighty dollars for last week's trip. Evidence matches. Both rails are quoted on what the guide actually receives per dollar I spend. Pay with PayPal. That is a real PayPal sandbox payout. |
| 1:30 to 1:38 | PayPal sandbox, the payout batch | Hold three seconds on the batch id that the obligation page shows | Here it is on PayPal's side. Same batch id. |
| 1:38 to 2:05 | Settings, Autonomy panel | Click Autopilot, show the three "who does what" cards and the caps, click "Turn on autopilot", confirm. Back to Overview: a scheduled payment with its countdown and Cancel | Most of my suppliers are boring and correct. So I can hand the routine ones to the agent. Autopilot: up to five hundred per payment, two thousand a day, ten minutes to cancel. Autonomy removes the approval step and nothing else. A wrong amount, a duplicate or changed bank details still stop the payment, and policy runs again the moment money moves. |
| 2:05 to 2:20 | Ana obligation page | Point at "sent", then the UNCLAIMED status and the plain-language message | One more thing real payments do. Ana's PayPal email does not exist, so the payout came back unclaimed. Checkrail Pay holds it for a person and will not pay twice. |
| 2:20 to 2:42 | Daily close | Scroll from "Needs a look" through "Sent by autopilot" and "Sent by people" to the cap meter, then click Sign off and confirm | At the end of the day I read one page. What needs a look comes first: the blocks, the unclaimed payout, anything unusual. Then what the agent sent, what people sent, and spend against the cap. Sign off, and that goes in the audit log too. |
| 2:42 to 2:50 | Closing card | Hold | Checkrail Pay. AI pays your suppliers. Policy decides. You sign off. |

## Off-camera prep (do this before the take, or the 1:38 and 2:05 shots have nothing to show)

1. **Before 1:38, set up the autopilot shot.** After paying Maria at 1:02, nothing else in the seed is eligible for autopilot: Ana is USD 750, above the threshold and the USD 500 cap. So, with autonomy still on Assist, open New request, type "Invoice attached from Rosa, please pay.", upload `docs/demo-documents/invoice-rosa-0942.pdf` (USD 205) and create it. Rosa has no Stellar wallet, so it routes to PayPal only, and with `DEMO_PAYPAL_RECIPIENT` set her payout lands in your personal sandbox account: the agent's send on camera is a real sandbox payout. It comes out pre-approved; when you switch to Autopilot on camera it is scheduled with a ten-minute countdown. (Do not use Maria's trip sheet for this shot: she has a Stellar wallet, so it routes to the simulated Stellar rail.)
2. **Before 2:05, set up the unclaimed shot.** Open Ana's payment and approve it. The router picks Stellar, her preference, so click **Pay with PayPal** explicitly (not the default button). Wait a minute, then press Check settlement until the page shows UNCLAIMED and the "Payout needs attention" panel. Do this before recording; the shot itself only points at the result.
3. Do not press Reset demo after step 2: Ana's payout is real sandbox state and resetting is disabled in live mode anyway.

## The one insert that matters most

The PayPal sandbox payout batch id on PayPal's own dashboard, matching the id on the obligation page (1:30 to 1:38). It answers "did a real PayPal call happen" in three seconds. The first one was RGS5PUZPH4CNY on 12 Oct; a fresh take will produce a new id.

## SCF cut

Same footage plus a Stellar shot once the testnet treasury is funded: Ana's USD 750 on Stellar PYUSD, the explorer tab held for three seconds, and a closing line that the anchor leg (PYUSD to USDC, SEP-31 off-ramp) is the funded work.

## Closing card text

    Checkrail Pay
    AI pays your suppliers. Policy decides. You sign off.
    checkrailpay.com
    github.com/<you>/checkrail-pay

## 20-second social teaser

| Time | On screen | Caption |
|---|---|---|
| 0:00 to 0:04 | Phuong page, line broken at verified, red rule row | "Pay Phuong $960 today, urgent." |
| 0:04 to 0:08 | Zoom on "Trip sheet says USD 800.00" | "The trip sheet says $800." |
| 0:08 to 0:12 | Autopilot scheduled payment with countdown | "The right ones pay themselves." |
| 0:12 to 0:16 | Daily close, Sign off | "You sign off in two minutes." |
| 0:16 to 0:20 | Wordmark | "Checkrail Pay." |

## Recording checklist

- In `.env`: RAIL_MODE=live, STELLAR_RAIL=mock, AI_MODE=live, the US sandbox app keys.
- In the PayPal app settings: Transaction search and Invoicing on, so Claude's PayPal checks succeed on camera.
- `npm run db:seed && npm run dev`, open `/demo` once to confirm the four requests.
- Autonomy starts at Assist after a seed; do the two off-camera prep steps above, then switch to Autopilot on camera (1:38).
- Close other tabs, hide the bookmarks bar, 1440px window.
- Record the voiceover separately after the screen take.
- No music with lyrics or anything copyrighted; silence is fine.

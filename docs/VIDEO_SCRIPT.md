# Dueline demo video script

Target length 2:45 (hackathon limit 3:00). One take per shot is fine; cut in post. Browser window 1440px wide, light theme, system fonts off (Archivo is vendored). Run `npm run db:seed` before recording so the four obligations are in their starting states. If live mode is set up, the sidebar footer will read "rails: sandbox/testnet"; if not, it reads "mock/mock" and the voiceover at 2:30 says so.

Pace: speak plainly, one idea per sentence. No music under the voiceover; a quiet bed under the opening and closing only, if any.

## Shot list

| Time | On screen | Action | Voiceover |
|---|---|---|---|
| 0:00 to 0:08 | Black card, then the Dueline wordmark fades to the Overview page | None | Small businesses that pay guides, drivers and suppliers across borders check every request by hand, pay from a PayPal tab, and still pay duplicates and inflated invoices. |
| 0:08 to 0:18 | Overview `/`. Cursor rests on the shared due line hero. | Slowly move the cursor across the five stations | Dueline draws every payment on one line: read, verified, routed, paid, reconciled. An AI agent reads. A deterministic policy decides. The rails pay. The books fill themselves. The agent is Claude when an API key is set and a rules extractor otherwise; the footer shows which is running. Four obligations are open this morning. |
| 0:18 to 0:26 | Overview, "Needs you" list | Hover the Phuong Transport row | The first one is a chat message: pay Phuong Transport nine hundred and sixty dollars, he needs it urgently. |
| 0:26 to 0:48 | Obligation page `/obligations/<phuong>` | Click the row. Let the page sit. Point at the raw request, then the trip sheet excerpt, then the red rule row "Requested USD 960.00 but Trip sheet says USD 800.00". | The agent read the request and the two attached records. The contract says two hundred dollars a day. The trip sheet says four days. Policy compared the request to the evidence and blocked it: one hundred and sixty dollars over. The line is broken at verified, and it says why. |
| 0:48 to 0:56 | Same page, action panel | Hover "Correct to USD 800.00", do not click | The operator can correct it to eight hundred and it re-enters the flow. Nothing left the account. |
| 0:56 to 1:04 | Back to Overview, then click the Exceptions link in the hero break, land on `/exceptions` | Click | The second one looks fine. Maria Santos, a job sheet, the right amount. |
| 1:04 to 1:20 | Obligation page `/obligations/<maria 0914>` | Click the JOB-HG4D-0914 row. Point at the "Reference JOB-HG4D-0914 was already used" rule row, then at the linked settled obligation | Except that reference was already settled seventeen days ago in Dueline's own ledger. Policy found the duplicate and blocked it. Two errors caught, three hundred and forty dollars kept. |
| 1:20 to 1:40 | Obligation page `/obligations/<maria 0921>` | Navigate via Inbox. Point at the route comparison: PayPal quote on the left, Stellar on the right, delivered PHP as the big figure. Click "Pay with PayPal". Let the marker travel to paid, then reconciled. | Third: one hundred and eighty dollars to the same guide for last week's trip. Evidence matches, under the threshold, auto-approved. Both rails are quoted. At this size PayPal delivers more pesos, so it is the default. One click. The marker travels to paid, then reconciled. |
| 1:40 to 2:12 | Obligation page `/obligations/<ana>` | Navigate via Inbox. Point at "awaiting approval". Point at the Stellar quote: more PHP, about fifteen minutes versus one to two days, and the vendor preference reason. Click "Approve", then "Pay with Stellar". Marker travels. In live mode only: click the explorer link in settlement details, show the tab, come back. In mock mode there is no link, and the page says "Simulated, not on chain"; leave it on screen. | Fourth: seven hundred and fifty dollars to Ana Reyes. Above the auto threshold, so a person approves. Here Stellar wins: slightly more pesos, delivered in about fifteen minutes instead of days, and Ana asked for the faster rail after a slow PayPal withdrawal in August. Approve. Pay with Stellar. PYUSD leaves the treasury with the job reference in the memo. In live mode the transaction link is right there; in mock mode the page says so plainly. |
| 2:12 to 2:24 | `/accounting` then `/ledger` | Click Accounting, show two pending records and the CSV export link. Click Ledger. | Both settlements are in the ledger with gross, fee and net. The accounting export is ready: bill, payment and fee lines mapped for Xero. |
| 2:24 to 2:36 | `/audit` | Scroll slowly | Every step is in one audit log: what the agent read, which rule fired, who approved, which rail paid, with the idempotency key. The agent never had spending authority. Policy is a pure function. Execution re-runs it before touching a rail. |
| 2:36 to 2:45 | Overview `/`, the due line with two dots at reconciled and two breaks. Hold. Fade to the wordmark and one line of text. | Hold on the hero, then cut to a closing card: "2 settled. 2 errors prevented. 2 records exported." | Two settled, two errors prevented, two records exported. Dueline. Verified supplier payments, routed and reconciled automatically. |

If recording in mock mode, add one sentence at 2:30: "This run is in mock mode; the sidebar shows which rails are live."

## Closing card text

    Dueline
    Verified supplier payments, routed and reconciled automatically.
    2 settled. 2 errors prevented. 2 records exported.
    github.com/<you>/dueline

## 20-second social teaser

Cut from the same footage. Vertical or square crop on the obligation page is fine; the due line and the big PHP figure carry it.

| Time | On screen | Voiceover or caption |
|---|---|---|
| 0:00 to 0:04 | Phuong obligation page, line broken at verified, red rule row | Caption: "Pay Phuong $960 today, urgent." |
| 0:04 to 0:08 | Zoom on "Requested USD 960.00 but Trip sheet says USD 800.00" | Caption: "The trip sheet says $800." |
| 0:08 to 0:12 | Ana obligation page, click Pay with Stellar, marker travels | Caption: "The right ones pay in minutes." |
| 0:12 to 0:16 | Overview hero: two dots reconciled, two breaks | Caption: "2 paid. 2 caught. Books done." |
| 0:16 to 0:20 | Wordmark and one-liner | Caption: "Dueline. Verified supplier payments, routed and reconciled automatically." |

## Recording checklist

- `npm run db:seed && npm run dev`, open `/demo` once to confirm the four obligations and copy their ids.
- Close other tabs. Hide bookmarks bar. 1440px window.
- Live mode only: do the Ana explorer click last in its shot so the tab switch is a clean cut.
- The single most valuable insert is a 20 second clip of the real PayPal sandbox payout batch id appearing in the sandbox dashboard after obligation 3 pays. Record it if live mode is set up.
- Record voiceover separately after the screen take; it is easier to match than to speak while clicking.
- Export at 1080p. Upload to YouTube, public or unlisted, under 3:00.

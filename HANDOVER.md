# Checkrail Pay: video handover (for the "VIDEOS - BUILD BETTER ONE" project)

Written Sat 7 Nov 2026 by the Checkrail Pay session. Everything here is self-contained. The footage in `footage/` is raw source material for the final public video, not a finished cut.

## 1. Hard facts

- Contest: PayPal AI Hackathon on Devpost. **Devpost deadline Thu 12 Nov 2026, noon PT** (Fri 13 Nov 03:00 Vietnam time). Our freeze is Mon 9 Nov. Judges test until 15 Dec 2026.
- Video rules: **under 3:00** (aim 2:30 to 2:45, hard stop 2:50), **public on YouTube**, **no copyrighted music** (no music at all is fine), must show the product working. Judges often watch muted, so burn in captions.
- Owner: Daniel Fillion (Vietnam, UTC+7). Tour operator in Northern Vietnam who pays guides, drivers and homestays from chat messages. He has about 30 minutes of attention per day. Prefers direct recommendations, no em dashes or en dashes in any written text (narration, captions, titles), no questions he does not need to answer.
- Product: **Checkrail Pay**. Repo (public, MIT): https://github.com/danielcfillion/checkrail-pay . Live demo: https://checkrail-pay.onrender.com (login is in the Devpost testing instructions; do not publish it in the video).
- Tagline (new): "Claude reads the request. Rules decide. PayPal pays." Closing triad: "Claude reads. Policy decides. You sign off."

## 2. What the product is (one paragraph)

Checkrail Pay stops a wrong supplier payment before PayPal sends it. Claude reads the request and its paperwork (chat message, invoice, trip sheet), then a fixed, deterministic set of rules checks the amount against the trip sheet and rate card and checks PayPal's own transaction history for a job already paid. Clean payments go out over PayPal Payouts inside caps the owner sets; the rest stop with a one-line reason and what would clear them. Claude advises and has no tool that moves money. When an AI agent wants to pay a supplier it asks Checkrail first over MCP (`check_payment`: pay, hold or block), carrying a signed spending mandate that caps what it may even request. Every request travels one line: **read, verified, routed, paid, reconciled**. At the end of the day the owner reads one Daily close page and signs off.

## 3. What the judges are looking for (from the Devpost rules, scored by an independent review)

Five equal criteria: Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation. Ties break on Technical first. One grand prize or honourable mention per project, plus one sponsor prize.

Prizes we are entering: **Best Use of PayPal + AI** (first), **Best Use of Agentic Commerce**, **Best Demo Delivery**, sponsor prize **Best Use of AG Grid** (onboarding dashboard built on AG Studio).

Independent skeptical-judge scores today (out of 10): Technical 8, Design 8.5, Impact 7.5, Innovation 8, **Presentation 0 (no video yet; 8 if the cut is good)**. The video is the single biggest score gain left.

### Fable's contest assessment (an independent high-effort review, 6 Nov; use this in every decision)

No single win probability was given. Verdict per prize, from a skeptical judge reading our material:
- **Best Use of AG Grid (5 prizes, USD 5,000 / 2,000 / 1,000 x 3): strongest.** Few entries touch AG Studio at all; we have an AG Studio dashboard with two custom widgets in our theme, no-code edit mode and a Claude adapter. Risks: the trial watermark; the trial ends 14 Dec, inside judging (fix on our side: key or date past 16 Dec); the dashboard has only about 6 seconds in the old script and no README screenshot. Give it 8 to 10 seconds ("Your first weeks": readiness gauge fills to 4 of 4, drag one card, say "built on AG Studio").
- **Best Use of PayPal + AI (USD 5,000): realistic chance, two conditions.** The video must show a live payout and the PayPal dashboard batch id matching the request page; and the first screen must say where PayPal and Claude sit. Entries using PayPal's own MCP server or Agent Toolkit may look "more PayPal": counter with "the model gets three read-only GET calls and nothing else, by construction".
- **Best Use of Agentic Commerce (USD 5,000): better odds than we thought,** because mandates, provenance and counter-offers are built and visible on the Agents page in every judge's copy. The gap is only in the telling. Select it, give it one paragraph and one video beat.
- **Best Demo Delivery (USD 5,000): decided by the video more than any other prize.** The hosted demo is top-tier for a hackathon; the video is the missing piece.
- Fable's tighter video: one hook (the chat message, "a hundred and sixty dollars wrong"), product named with PayPal by 0:14, PayPal batch id insert about 0:56, agent beat with counter-offer and mandate about 1:22, AG Studio with the Claude adapter about 1:46, Daily close, end card about 2:24, closing line "agents need a check rail". Hard stop 2:30 to 2:45. Cut Ana UNCLAIMED, the Try-it beat and the AFP stat to the Devpost text. One hook only: do not stack the AFP statistic and the agents line.
- Do not touch: money path code, rules, sandbox, tests. Keep the recorded Claude readings and their labels.

What a judge objects to, and what the video should pre-empt:
1. "Everything I can touch is simulated and the AI is a rules reader." Answer: say plainly what is live and what is simulated, show the recorded Claude reading labelled as recorded, and show the real PayPal sandbox batch id (see 5).
2. "I do not see where PayPal and Claude are." Answer: name both in the first 15 seconds and show PayPal's own transaction id deciding a block.
3. The agent features (spending mandates signed with Ed25519, instruction provenance that stops prompt injection, supplier-agent counter-offers) are built, tested, seeded and invisible. They are the Agentic Commerce entry. Give them a beat.

## 4. What will earn the most with judges (ranked)

1. **Hook in 10 seconds**: a real-looking chat message "Pay Phuong nine sixty today, he needs it for fuel", then "This one is a hundred and sixty dollars wrong." No title card first.
2. **Two errors caught before money moves**: Phuong USD 960 vs trip sheet USD 800 (blocked by rules); Maria USD 180 for JOB-HG4D-0914 already paid 17 days ago per PayPal's own record (blocked, with the PayPal transaction id).
3. **A real payment going through**: Maria USD 180 for JOB-HG4D-0921, click Pay with PayPal, the check line travels to Paid then Reconciled. On our local copy this is simulated and must be captioned "Simulated rails". The real PayPal sandbox payout (batch id RGS5PUZPH4CNY, 12 Oct 2026) should be shown with its PayPal dashboard page if Daniel supplies a screenshot; otherwise a clearly labelled "Recorded sandbox run, 12 Oct 2026" card.
4. **The agent beat**: an agent asks to pay USD 960 through MCP, gets "Do not pay: Rate card and departure HG-4D-0927 say USD 800.00", lands on the Agents page (blocked, with a counter-offer of USD 800, a signed mandate, and the injected instruction from an outside email held). End line: "PayPal moves money for agents now. Agents need a check rail."
5. **Autopilot and sign-off**: routine payments go automatically inside caps, cancel window, Daily close, Sign off.
6. **End card**: name, tagline, "Try it: checkrail-pay.onrender.com/demo", repo link.

Cut to make room (move to Devpost text): Ana's UNCLAIMED payout, the Try-it-yourself auto mode, the AFP statistic unless it fits (if used say "targeted by", cite "AFP Payments Fraud and Control Survey, 2026"; the figure is 74% affected by business email compromise, not "hit by" and not "of small businesses").

## 5. Script concept (about 2:40)

| Time | Picture | Voiceover (plain speech, one idea per sentence) |
|---|---|---|
| 0:00 to 0:13 | The Phuong request, chat text, 2x crop, from the first frame. From 0:03 lower third: Checkrail Pay lockup | "Pay Phuong nine sixty today, he needs it for fuel." I get this every week. This one is a hundred and sixty dollars wrong. |
| 0:13 to 0:22 | Overview, check line read, verified, routed, paid, reconciled | This is Checkrail Pay. Claude reads each request. A fixed set of rules decides. |
| 0:22 to 0:46 | Phuong page: what the agent read, the broken check line, the red rule row "Requested USD 960.00 but Trip sheet says USD 800.00" | Claude read the message and both records and checked PayPal's own transactions. The trip sheet says four days at two hundred. Policy blocked it. Claude advises. It has no way to pay. |
| 0:46 to 0:58 | Maria duplicate page, red banner, PayPal transaction id | The second looks perfect. But PayPal's own records say that job was paid seventeen days ago. Blocked, with PayPal's transaction id. |
| 0:58 to 1:20 | Maria JOB-HG4D-0921: route comparison, click Pay with PayPal, marker travels to Reconciled. Caption "Simulated rails" | Third: evidence matches. Both rails are quoted on what the guide actually receives. Pay with PayPal. Paid, reconciled, recorded in the books. |
| 1:20 to 1:27 | PayPal sandbox payout batch (screenshot from Daniel or recorded-run card) | Here it is on PayPal's side. Same batch id. |
| 1:27 to 1:58 | Settings autonomy, then overview autopilot strip with countdown | Most suppliers are boring and correct, so the agent handles those inside my limits. A wrong amount, a duplicate or changed bank details still stop it, and policy runs again the moment money moves. |
| 1:58 to 2:24 | Agent beat: MCP `check_payment` answer, then the Agents page (blocked, counter-offer, mandate, held instruction) | And it is not only me. Before any agent pays a supplier, it asks Checkrail. Do not pay, and it tells the agent why. PayPal moves money for agents now. Agents need a check rail. |
| 2:24 to 2:38 | Daily close, Sign off | At the end of the day I read one page. Sign off, and that goes in the audit log too. |
| 2:38 to 2:48 | End card | Checkrail Pay. Claude reads. Policy decides. You sign off. Try it: checkrail-pay.onrender.com/demo |

Pace: about 2.4 words per second. No music under the voiceover (the stand-in voice can be replaced by Daniel's own).

## 6. Honesty rules (judges and the rules both care)

- Label anything simulated on screen: "Simulated rails" for the local footage; "Recorded from a live Claude run, 28 Oct 2026" for the Claude readings; "Recorded sandbox run, 12 Oct 2026" for batch RGS5PUZPH4CNY.
- Never stage a state the app did not produce. Numbers on screen come from the running app.
- Do not show or say the judge password. Do not show API keys.
- Claude never moves money in this product. Say "advises", never "pays".

## 7. Footage in `footage/`

All recorded from a local production build, seeded demo ("Ridgeline Expeditions LLC"), light theme, simulated rails and rule-based reader, no real accounts.

- `desktop-raw.mp4`: 1920x1080, about 74 s. Viewport 1440x810 at 1.5x. Order: Phuong blocked request (0:00), Overview (0:16), Maria duplicate blocked (0:26), Maria JOB-HG4D-0921 pay (0:37, click at about 0:41, "Paying", then "Paid and reconciled"), Agents page (0:53), Daily close (0:64). The page is dense at 1440 wide: crop and zoom 1.5x to 2.5x in the edit as in the shot list.
- `mobile-raw.mp4`: 780 px wide (390 css px at 2x), about 73 s, same sequence, phone layout with bottom tab bar. Good for a short split-screen "works on a phone" beat or a vertical cut.
- `frames-desktop.json` and `frames-mobile.json`: per-frame timestamps and scene marks for exact cutting.
- `scripts/`: `video-record.cjs` (Playwright CDP screencast recorder, deterministic), `take.sh` (reseeds, restarts the local server, records one take), `mkvid.py` (frames to mp4). Reseeding gives new random request ids, the recorder looks them up by source reference. To re-shoot after any UI change: build the app (`npm run build`), then `./take.sh desktop` and `./take.sh mobile`.

### Takes added 8 Nov 2026 (`footage/takes/`, timestamps in `frames-desktop.json` under `takes`)

Each is 1920x1080 at 30 fps from the same local production build, simulated rails, seeded demo. `marks_s` are seconds from the start of each file.

1. `01-settings-autonomy-autopilot-on.mp4` (22.8 s): Settings, Autopilot chosen, caps USD 500 per payment and USD 2,000 a day, cancel window set to 1 minute, "Turn on autopilot", then the inline "Yes, turn on autopilot" confirm. Trim to about 10 s.
2. `02-overview-autopilot-countdown.mp4` (17.2 s): Overview with the Autopilot strip, two payments scheduled, circular countdowns running, Cancel buttons visible.
3. `03-agent-mcp-call-check-payment.mp4` (8.6 s): a real JSON-RPC `check_payment` call to `/api/mcp` for USD 960 with the answer "Do not pay: Rate card and departure HG-4D-0927 say USD 800.00 ...". The bearer key is masked on screen, and the real key is never shown. `03-answer.json` is the full response. The card is a terminal-style render of the real request and response, not a screen of a terminal.
4. `04-agents-page-row-arrives.mp4` (29.1 s): Agents page, the new "just now" blocked row for Phuong Transport USD 960, spending mandates (two active, signed with Ed25519), the inbox-assistant row held "A person looks" with the instruction from an outside email marked "Outside email", counter-offers to suppliers' agents (USD 960 asked, USD 800 offered).
5. `05-studio-first-weeks-gauge-to-4of4.mp4` (38.4 s): AG Studio "Your first weeks". About 4 s of blank loading at the start, trim it. Gauge 3 of 4, then the app's own fix (Dao Mountain Lodge gets a rate card of USD 42.50 per room-night on the vendor page), gauge 4 of 4, Edit dashboard, one card dragged. The app's own badge "Dashboard built with AG Studio" is in the top right of every frame. The local build shows no trial watermark. On-screen text "built on AG Studio" is for the edit.
6. `06-daily-close-sign-off.mp4` (19.8 s): Daily close, Sign off, inline "Yes, sign off", result "Signed off. The next close starts from here." No full page load for the sign off itself.

Setup that is not on camera (all through the app's own forms on the demo copy): the Rosa Villanueva USD 190 request (trip sheet upload) and one mandate for claude-desktop (USD 800 per payment, USD 3,000 total). The local recording server uses a throwaway data key so mandates can be signed.

Known page error: five `removeChild` errors in the browser console on the Overview page during recording, no visible effect. Not yet investigated.

PayPal sandbox: `footage/paypal-sandbox-batch-RGS5PUZPH4CNY.jpg`, the real payout detail page (unique transaction ID MPA-RGS5PUZPH4CNY, $183.60 USD, submitted 12 Oct 2026 12:11:43 PM EDT, processed 12:12:07 PM EDT, 1 payment). Portrait 800x1101 from a narrow pane: show it on a card or side panel, labelled "Recorded sandbox run, 12 Oct 2026". Nothing secret is visible.

All requested footage is now captured.

## 8. Open items before and after the video

- Daniel: record or approve voice, supply the PayPal sandbox batch screenshot, upload to YouTube (public) and send the link, tick Devpost eligibility boxes and terms, press Submit.
- Checkrail session: put the YouTube link on the landing page, README and Devpost; update the live Devpost form with the new tagline and text.
- Budget: ElevenLabs credits are paid; log each generation in `credits.txt`; never repeat a generation call to retry (it charges again); do not exceed the agreed budget without asking Daniel.

# Dueline design plan

Subject: a finance-operations tool for a small business that pays a distributed roster of contractors and suppliers, often across borders. Audience: the owner or finance manager who today does this from spreadsheets, chat threads and a PayPal tab, and the hackathon judges watching a three-minute video. Primary job: make it obvious, at a glance, where every payment is on its way from "someone says we owe this" to "it is in the books", and make it impossible to miss the ones that are wrong.

## The one memorable thing: the due line

Every obligation is drawn as a line that money travels along, left to right, through five fixed stations:

    read ──── verified ──── routed ──── paid ──── reconciled

The marker sits at the current station. A blocked obligation shows the line broken at the station where it stopped, with the reason beside the break. This single device appears in the inbox rows (compact), at the top of the obligation page (full width, labelled), and as the overview hero (all open obligations plotted on one shared line, so the operator sees the whole book as a distribution across stations rather than as a KPI grid).

The only non-user-triggered motion in the app: when the operator pays an obligation, its marker travels along the line to "paid" and then "reconciled". Nothing else animates on load. Hover does not animate.

## Palette

Ledger paper, not cream. Cool, printed, trustworthy.

- `--paper`     #EDF0F2   page background (light), a cool grey with a hint of blue
- `--sheet`     #FFFFFF   panels, tables
- `--ink`       #10233A   primary text, a deep navy rather than tinted black
- `--ink-soft`  #5B6B7C   secondary text, rules
- `--settled`   #0E7C5B   paid and reconciled; the only green
- `--attention` #9A5B00   awaiting a person (approval, evidence)
- `--blocked`   #A8261D   blocked, failed; the only red
- `--paypal`    #0070E0   rail identity, used only on rail labels and the rail comparison
- `--stellar`   #7D00FF   rail identity, same restriction (Stellar's brand is black; on a navy UI a violet reads as the second rail without fighting the ink)

Dark theme: `--paper` #0F1923, `--sheet` #15222E, `--ink` #E6ECF2, `--ink-soft` #93A3B4; semantic colours lightened one step. Never pure black.

## Typography

One family, Archivo (variable: weight 100 to 900, width 62 to 125), loaded with `next/font/google`. Width is the hierarchy device:

- Wordmark and the big money figures: Archivo, width 112, weight 600, tight tracking.
- Page titles: Archivo, width 100, weight 600, 28px.
- Body and tables: Archivo, width 100, weight 400, 14px/20px, `font-feature-settings: "tnum"` on every number.
- Dense labels (station names, table heads, rail tags): Archivo, width 88, weight 500, 12px, sentence case. Never all caps.

Type scale (1.25 ratio from 14): 11, 12, 14, 18, 22, 28, 36, 48.

## Layout

Left rail navigation, 220px, collapsing to icons under 1024px and to a bottom bar under 640px. Content left-aligned, max width 1320px, 24px gutters, 16px on phones.

Overview

    ┌────────────┬────────────────────────────────────────────────────────┐
    │ Dueline    │ Ridgeline Expeditions                 [Reset demo]     │
    │            │                                                         │
    │ Overview   │ Needs you (3)              Outstanding   Paid 30d  Fees │
    │ Inbox      │                            $2,414.00     $4,331.00 $71  │
    │ Vendors    │                                                         │
    │ Ledger     │ read ──●●── verified ──── routed ──●── paid ──●●●●── reconciled │
    │ Exceptions │       ╳ 2 blocked                                        │
    │ Accounting │                                                         │
    │ Audit      │ ▸ Phuong Transport  INV-2026-0152   $960.00  blocked    │
    │            │   Requested $960 but trip sheet says $800 (+$160)        │
    │ ────────── │ ▸ Ana Reyes         JOB-PAL3D-0927  $750.00  approve     │
    │ rails:     │ ▸ Maria Santos      JOB-HG4D-0921   $180.00  pay         │
    │ mock/mock  │                                                         │
    │ ai: rules  │ PayPal ████████ $3,021   Stellar ███ $1,310   (30 days)  │
    └────────────┴────────────────────────────────────────────────────────┘

Obligation page

    ┌─ Phuong Transport · INV-2026-0152 ───────────────────── $960.00 ─┐
    │ read ──── verified ╳ ...                                   blocked │
    ├──────────────────────┬───────────────────────────┬────────────────┤
    │ The request          │ What the agent read       │ History        │
    │ (raw text, as typed) │ summary, confidence       │ 14:02 created  │
    │                      │ flags                     │ 14:02 agent    │
    │ Evidence             │ Policy                    │ 14:02 policy   │
    │ Transport agreement  │ ✓ vendor known            │                │
    │ "USD 200/day..."     │ ✓ evidence attached        │ Actions        │
    │ Trip sheet           │ ✗ amount matches evidence │ [Correct to    │
    │ "4 x 200 = 800"      │   Requested 960, sheet 800│  $800.00]      │
    │                      │ Route                     │ [Cancel]       │
    │                      │ PayPal 22,966,400 VND 2d  │                │
    │                      │ Stellar  not available    │                │
    └──────────────────────┴───────────────────────────┴────────────────┘

Rule checklist rows are the policy engine's own output, verbatim. The route comparison shows both rails side by side with the delivered amount as the largest figure on the page after the obligation amount, because that number is what the recipient cares about.

## Principles

1. Structure encodes state. Rules, colour and position all mean something; nothing is decoration. No card shadows. Panels are separated by the paper background and single hairline rules in `--ink-soft` at 24% opacity.
2. Numbers are first-class. Tabular figures, right-aligned in tables, currency code before the amount in body text (USD 180.00), symbol only in the big figures.
3. Say what happened. Buttons name the action ("Pay with Stellar", "Approve", "Correct amount"); toasts confirm in the same words. Errors say what to do next.
4. Crypto is invisible to the recipient and quiet in the UI. The rail label says "Stellar", the quote says "PHP bank deposit via PeraHub". The transaction hash and explorer link live in the settlement details for whoever wants them.
5. Be honest about mode. The sidebar footer always shows rail and agent modes (mock, sandbox, testnet, live). The demo is not pretending.

## Things this design deliberately does not do

No all-caps eyebrow labels. No middle-dot meta strings. No arrows appended to buttons. No identical rounded cards with the same shadow. No gradient washes. No page-load fade-ins per section. No monospace for data (Archivo tabular figures do the job). No terracotta, no acid green, no pure black.

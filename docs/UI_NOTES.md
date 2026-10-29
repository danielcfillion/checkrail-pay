# Checkrail Pay UI notes

Built against DESIGN.md. Next.js 15 App Router, React 19, Tailwind v4, no component or icon libraries. Every data page is `force-dynamic` and reads through `src/lib/queries.ts`; every write goes through `src/app/actions.ts`.

## Decisions

- **Archivo is vendored, not fetched.** The build sandbox cannot reach fonts.googleapis.com (proxy 403), so `next/font/google` failed at build time. The same variable file Google serves (weight 100 to 900, width 62 to 125) sits at `src/app/fonts/archivo-variable.woff2` and is loaded with `next/font/local`, exposing `--font-archivo`. The one-line `next/font/google` equivalent is in a comment in `layout.tsx`; swap back if you prefer a network font. Width is applied with `font-stretch` via the `.wide` (112%) and `.dense` (88%) classes; `.num` applies tabular figures.
- **Palette lives in `:root` CSS variables and is mapped into Tailwind through `@theme inline`**, so `bg-paper`, `text-ink`, `text-blocked` and friends work. Dark follows `prefers-color-scheme` unless `<html data-theme="light|dark">` is set. No toggle UI.
- **Station mapping** (`src/components/checkline-model.ts`): drafted and needs_evidence at read; verified, awaiting_approval and blocked at verified (blocked breaks the line there); approved and execution_pending at routed; sent at paid with a "confirming" caption; settled at reconciled when an accounting row exists, otherwise at paid with "not yet in the books"; failed breaks at paid; cancelled is a grey inactive line; refunded and disputed sit at paid with a caption.
- **The pay animation** is the only motion. `CheckLine` steps its marker one station per 600ms toward `animateTo`; `ObligationStageProvider` shares that target between the header line and the `ActionBar` so a successful `executeAction` sends the marker to paid, then reconciled, then hands control back to the server-rendered state. `prefers-reduced-motion` disables the transition.
- **Overview hero** (`BookLine`) plots every non-cancelled obligation as a dot at its station, settled ones in green, with a count per station and a red break plus count beneath any station where obligations are blocked. Dots link to the obligation; the break links to Exceptions.
- **Blocked reason parsing** reuses the backend's own phrasing: "says USD 800.00" prefills the correct-amount form; "already used" switches the form to a reference correction (amendAction with `sourceRef`), since the duplicate case is not an amount problem.
- **needs_evidence has no evidence form.** The action panel says so plainly and offers re-create with evidence or cancel, rather than pretending an endpoint exists.
- **Route comparison** always shows both rails. The unavailable one prints "Unavailable" and the backend's reason verbatim. The middle column is wider (5fr, 7fr, 5fr) so both quotes fit side by side at 1440.
- **Rail split** on the overview is two plain divs scaled to the larger gross; no chart library.
- **Relative times** in lists, absolute UTC in detail panels, absolute in `title` attributes everywhere a relative time appears.
- **ConfirmButton** is a two-step inline confirm (no modal) used for Reset demo. Toasts repeat the server action's message word for word.
- Two small additions to `src/lib/queries.ts` (new exports only, no signature changes): `getSystemModes()` for the sidebar footer and `findObligationsBySourceRef()` for the presenter page.
- One line fixed in `src/app/actions.ts`: `db.query.businesses.findFirst()` needed an `await` for the typecheck to pass (pre-existing error).
- `eslint.config.mjs` now switches off `no-require-imports` for `src/lib/rails/index.ts` only; that file's lazy `require` of the live SDKs is deliberate and I was not allowed to edit it, and the rule was failing `next build`.
- The create-next-app SVGs in `public/` were removed.

## Design review round 1 (DES-1 to DES-20)

Declared deviations and decisions from the first design pass. Presentation only: no policy rule, state transition, permission or action changed.

- **The approval band never says "Every check passed" over an open reader concern (DES-1).** `check-statement.ts` builds the band's sentence from the rules and the reading the page shows (the recorded Claude run when there is one, otherwise the live reader): all clear, reader concerns, low confidence, warnings, blocked. A recorded run says the rules did not see it. The Policy panel says "Every rule passed" and points at the reading when one is open. The confidence threshold is read from the rules when they name one and otherwise defaults to 75, the default in `policy.ts`.
- **Vietnamese onboarding (DES-3, DES-14).** All vendor-facing copy is one typed structure in `src/lib/onboarding-strings.ts`; `onboarding-strings.test.ts` fails if an English key has no Vietnamese one, if a Vietnamese string is empty, English or has an em dash. The action returns an error code for the engine's English message, and the form shows it in the vendor's language, by the field, with a summary that takes focus. **The Vietnamese needs a native speaker's check before the demo video** (tone, "bạn" against "quý khách", the trust sentence, bank terms).
- **`<html lang>` on vendor pages.** The root layout cannot see a page's search params, so `PublicFrame` puts `lang` on its own wrapper and sets `<html lang>` with a one-line script as the page is parsed (plus `HtmlLang` for client-side navigation). The server-rendered `<html>` still says `en`; a raw-HTML reader sees that. A server-side fix would need the middleware to forward the chosen language, which was out of scope.
- **Bank country and currency are not prefilled (DES-14).** Prefilling `VN` and `VND` would store a country and currency for a vendor who only gave a PayPal email. The two fields now show "e.g. VN" and "e.g. VND" so they are not read as values; choosing a Vietnamese bank still fills both, as before.
- **The trust sentence on the onboarding page** ("Only the business sees these details, and a bank account number is stored encrypted") is the owner's to confirm against how the hosted demo is run.
- **Field edges (DES-10).** `--field-border` is a solid colour: #7a8794 in light (3.67:1 on white, 3.21:1 on paper) and #6b7a8a in dark (3.67:1 on the sheet, 4.04:1 on paper); `scripts/contrast-check.mjs` checks both. Placeholders use full `--ink-soft`.
- **Status colours are not re-stepped (DES-9).** Getting amber and red 15 L* apart in a colour-blind simulation means leaving the palette in DESIGN.md (amber is already at the edge of 4.5:1 on its own tint), so it is left for a palette decision. What was fixed: toasts carry an icon and "Error", errors are `role="alert"`, a changed payout value is tagged "Changed". Every status pill still carries a word and an icon. The Money out bars are unchanged: the legend and the hover tooltip name each rail in words.
- **Approve (DES-4).** The button names the payee and amount, a line under it says it does not send money, and the phone bar names the payee and amount. Reject and the note stay in the Actions column; moving them into the band means restructuring `ActionBar`.
- **Daily close (DES-2, DES-6).** Below 1024 px the two columns dissolve and the panels are ordered (needs a look, waiting on you, about to go out, then what was sent). Sent payments are two-line rows on a phone. Sign off is at the end of the page on a phone and top right on desktop.
- **Not done:** DES-20 (the overview hero labels at 14 px needs a layout pass on the five stations at 1024 px) and the demo role select that truncates "Minh (operations mana" (the persona names are shared copy).

## Vietnamese strings

Vietnamese text in the app (the remittance message in `src/lib/engine/vendorLinks.ts`, the remittance advice page in `src/app/remit/[token]/page.tsx`, the vendor onboarding and evidence pages) was written by an AI agent and has not been read by a native speaker. A Vietnamese reader should check it before a vendor sees it, in particular the polite register ("Chào ...", "bạn"), "đã thanh toán" against "đang chuyển" for money that has arrived against money on its way, and "chuyển khoản ngân hàng" as the one name for a bank file and a Wise transfer. The remittance message groups a vendor's payments by rail and by arrived or on its way, one sentence each, and writes the date day first (27/10/2026).

## Verification

- `npm run typecheck`: passes.
- `npm run lint`: passes.
- `npm run build`: passes; all routes dynamic.
- Production server on 3100 after `npm run db:seed`: every route returns 200 with real strings (Phuong Transport, USD 960.00, Ridgeline). `/api/accounting/export` returns the CSV. Unknown ids return the custom 404.
- Empty database (`DATABASE_PATH` pointed at a fresh file): every route returns 200 and shows an empty state; no server errors.
- Interaction flows run in headless Chromium: approve Ana, pay with Stellar (marker caught mid-travel at paid, then settled with explorer link), correct Phuong to USD 800 (re-enters at awaiting approval), create the mismatched Linh example (lands blocked). No page errors or console errors.
- Screenshots in `docs/screenshots/`: `overview`, `blocked-mismatch`, `blocked-duplicate`, `awaiting-stellar` (each also as `-dark`), `demo.png`, and `overview-mobile.png` (390px). Regenerated 2026-10-03 from the hardened build.

## Could not verify

- Dark mode via the OS `prefers-color-scheme` media query; the headless build did not honour CDP media emulation, so dark was checked through the `data-theme="dark"` hook, which uses the same variable set.
- Live PayPal, Stellar testnet and Xero paths (no credentials). The sidebar footer and Settings report whatever `railModes()` returns.
- The `confirmAction` flow from a `sent` state: the mock rails settle synchronously inside `executeAction`, so `sent` never appears in the demo. The button is wired and the state is mapped.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Overview: shared check line, figures row, needs-you list, rail split, recent activity, reset demo |
| `/obligations` | Inbox with `?filter=all|needs_action|in_flight|settled|blocked` |
| `/obligations/new` | Ingest form with evidence rows and two example loaders |
| `/obligations/[id]` | Obligation detail, three columns, actions by state, pay animation |
| `/vendors` | Roster with payout methods, totals, rails used |
| `/vendors/[id]` | Vendor payout details and their obligations |
| `/ledger` | Settlements |
| `/exceptions` | Blocked and failed with prevented total |
| `/accounting` | Accounting syncs with CSV export link |
| `/audit` | Audit log, 300 entries |
| `/settings` | Business, modes, policy as sentences, live-mode env guide |
| `/demo` | Presenter page for the four story obligations |
| `not-found` | Custom 404 |

## Components (`src/components`)

- `CheckLine` (client): compact and full variants; props `state`, `variant`, `hasAccounting`, `blockedAtStation`, `animateTo`, `caption`.
- `checkline-model.ts`: stations, `positionFor(state)`, `stationOffset(i)`.
- `BookLine`: overview hero, all obligations on one line.
- `ObligationStage` (client): `ObligationStageProvider`, `StageCheckLine`, `useStage` for the pay animation.
- `ActionBar` (client): state-dependent actions, correct-amount and correct-reference forms.
- `ConfirmButton` (client), `ResetDemoButton` (client), `CopyButton` (client).
- `Toast` (client): `ToastProvider`, `useToast`, `ToastFromParam`.
- `Shell`, `NavLinks` (client): left rail, icon rail under 1024px, bottom bar under 640px, system-mode footer.
- `RuleChecklist`, `RouteCompare`, `Timeline`.
- `ObligationList`: `NeedsYouList`, `ObligationTable`, `reasonFor`, `nextStepFor`.
- `ui.tsx`: `Money`, `StatePill`, `StationLabel`, `RailTag`, `RelativeTime`, `PageHeader`, `EmptyState`, `Panel`, `KeyValue`, `TextLink`, `RowLink`.
- `src/lib/format.ts`: money, dates, ETA, action and actor humanisers, labels, `evidencedAmountFromReason`.

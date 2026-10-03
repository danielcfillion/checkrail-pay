# Dueline UI notes

Built against DESIGN.md. Next.js 15 App Router, React 19, Tailwind v4, no component or icon libraries. Every data page is `force-dynamic` and reads through `src/lib/queries.ts`; every write goes through `src/app/actions.ts`.

## Decisions

- **Archivo is vendored, not fetched.** The build sandbox cannot reach fonts.googleapis.com (proxy 403), so `next/font/google` failed at build time. The same variable file Google serves (weight 100 to 900, width 62 to 125) sits at `src/app/fonts/archivo-variable.woff2` and is loaded with `next/font/local`, exposing `--font-archivo`. The one-line `next/font/google` equivalent is in a comment in `layout.tsx`; swap back if you prefer a network font. Width is applied with `font-stretch` via the `.wide` (112%) and `.dense` (88%) classes; `.num` applies tabular figures.
- **Palette lives in `:root` CSS variables and is mapped into Tailwind through `@theme inline`**, so `bg-paper`, `text-ink`, `text-blocked` and friends work. Dark follows `prefers-color-scheme` unless `<html data-theme="light|dark">` is set. No toggle UI.
- **Station mapping** (`src/components/dueline-model.ts`): drafted and needs_evidence at read; verified, awaiting_approval and blocked at verified (blocked breaks the line there); approved and execution_pending at routed; sent at paid with a "confirming" caption; settled at reconciled when an accounting row exists, otherwise at paid with "not yet in the books"; failed breaks at paid; cancelled is a grey inactive line; refunded and disputed sit at paid with a caption.
- **The pay animation** is the only motion. `DueLine` steps its marker one station per 600ms toward `animateTo`; `ObligationStageProvider` shares that target between the header line and the `ActionBar` so a successful `executeAction` sends the marker to paid, then reconciled, then hands control back to the server-rendered state. `prefers-reduced-motion` disables the transition.
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

## Verification

- `npm run typecheck`: passes.
- `npm run lint`: passes.
- `npm run build`: passes; all routes dynamic.
- Production server on 3100 after `npm run db:seed`: every route returns 200 with real strings (Phuong Transport, USD 960.00, Ridgeline). `/api/accounting/export` returns the CSV. Unknown ids return the custom 404.
- Empty database (`DATABASE_PATH` pointed at a fresh file): every route returns 200 and shows an empty state; no server errors.
- Interaction flows run in headless Chromium: approve Ana, pay with Stellar (marker caught mid-travel at paid, then settled with explorer link), correct Phuong to USD 800 (re-enters at awaiting approval), create the mismatched Linh example (lands blocked). No page errors or console errors.
- Screenshots in `docs/screenshots/`: `overview.png`, `blocked.png`, `stellar.png`, `demo.png`, plus `overview-mobile.png` (390px) and `blocked-dark.png` (data-theme override). Playwright's chromium download is blocked by the proxy, so these were taken with `@sparticuz/chromium` + `puppeteer-core` from a scratch directory (not added to the project).

## Could not verify

- Dark mode via the OS `prefers-color-scheme` media query; the headless build did not honour CDP media emulation, so dark was checked through the `data-theme="dark"` hook, which uses the same variable set.
- Live PayPal, Stellar testnet and Xero paths (no credentials). The sidebar footer and Settings report whatever `railModes()` returns.
- The `confirmAction` flow from a `sent` state: the mock rails settle synchronously inside `executeAction`, so `sent` never appears in the demo. The button is wired and the state is mapped.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Overview: shared due line, figures row, needs-you list, rail split, recent activity, reset demo |
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

- `DueLine` (client): compact and full variants; props `state`, `variant`, `hasAccounting`, `blockedAtStation`, `animateTo`, `caption`.
- `dueline-model.ts`: stations, `positionFor(state)`, `stationOffset(i)`.
- `BookLine`: overview hero, all obligations on one line.
- `ObligationStage` (client): `ObligationStageProvider`, `StageDueLine`, `useStage` for the pay animation.
- `ActionBar` (client): state-dependent actions, correct-amount and correct-reference forms.
- `ConfirmButton` (client), `ResetDemoButton` (client), `CopyButton` (client).
- `Toast` (client): `ToastProvider`, `useToast`, `ToastFromParam`.
- `Shell`, `NavLinks` (client): left rail, icon rail under 1024px, bottom bar under 640px, system-mode footer.
- `RuleChecklist`, `RouteCompare`, `Timeline`.
- `ObligationList`: `NeedsYouList`, `ObligationTable`, `reasonFor`, `nextStepFor`.
- `ui.tsx`: `Money`, `StatePill`, `StationLabel`, `RailTag`, `RelativeTime`, `PageHeader`, `EmptyState`, `Panel`, `KeyValue`, `TextLink`, `RowLink`.
- `src/lib/format.ts`: money, dates, ETA, action and actor humanisers, labels, `evidencedAmountFromReason`.

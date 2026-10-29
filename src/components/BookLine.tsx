import Link from "next/link";
import type { ReactNode } from "react";
import { anchorTransform, bookLineModel, positionFor, stationOffset, stationSummary, STATION_FILTER, STATIONS, STATION_LABELS } from "./checkline-model";
import type { ObligationRow } from "@/lib/queries";
import { formatMoney, formatMoneySymbol, stateLabel } from "@/lib/format";

const TONE: Record<string, string> = { neutral: "var(--ink)", attention: "var(--attention)", settled: "var(--settled)", blocked: "var(--blocked)", muted: "var(--ink-soft)" };
const MAX_MARKS = 14;

/**
 * The overview hero: open requests plus the last seven days of settled ones, plotted on one shared check line.
 * Marks stack at their station (settled ones faded); blocked requests show as a break beneath the station where
 * they stopped. Each station carries its count and its money in the base currency, and is the one keyboard stop
 * for everything at it: the marks themselves are pointer shortcuts only, so the overview is not 18 Tab presses deep.
 */
export function BookLine({ rows, currency = "USD", header }: { rows: ObligationRow[]; currency?: string; header?: ReactNode }) {
  const stations = bookLineModel(rows, currency);
  const total = stations.reduce((a, s) => a + s.items.length + s.broken.length, 0);

  const byState = (st: string[]) => stations.flatMap((s) => [...s.items, ...s.broken]).filter((r) => st.includes(r.state)).length;
  const parts: string[] = [];
  const evid = byState(["needs_evidence", "drafted"]);
  const awaiting = byState(["awaiting_approval"]);
  const blockedN = stations.reduce((a, s) => a + s.broken.length, 0);
  const ready = byState(["approved", "execution_pending"]);
  const inFlight = byState(["sent"]);
  if (evid) parts.push(`${evid} waiting on evidence`);
  if (awaiting) parts.push(`${awaiting} awaiting approval`);
  if (blockedN) parts.push(`${blockedN} blocked`);
  if (ready) parts.push(`${ready} ready to pay`);
  if (inFlight) parts.push(`${inFlight} in flight`);
  const settledWeek = stations[4].items.length;
  const summary = `${parts.length ? parts.join(", ") + ". " : "Nothing open. "}${settledWeek ? `${settledWeek} reconciled in the last 7 days.` : "Nothing reconciled in the last 7 days."} Each mark is one request; faded marks are settled.`;

  if (total === 0) {
    return (
      <div className="panel">
        {header ? <div className="border-b px-5 py-4 hairline sm:px-8">{header}</div> : null}
        <div className="px-6 py-10 text-center">
        <p className="font-medium">Nothing on the line</p>
        <p className="mt-1 text-ink-soft">
          No open payment requests and nothing settled this week. <Link className="link" href="/obligations/new">Add one</Link> or reset the demo to load the story.
        </p>
        </div>
      </div>
    );
  }

  const LINE_Y = 52;

  return (
    <div className="panel">
      {/* The figures sit in the hero's header row (DS2-25), so the line is the first thing under them. */}
      {header ? <div className="border-b px-5 py-4 hairline sm:px-8">{header}</div> : null}
      <div className="px-5 pb-4 pt-3 sm:px-8 sm:pb-5 sm:pt-3">
      <div className="relative h-[84px] sm:h-[116px]">
        {/* the line */}
        <div className="absolute left-0 right-0 h-px" style={{ top: LINE_Y, background: "var(--rule-strong)" }} />
        {STATIONS.map((s, i) => {
          const d = stations[i];
          const align = i === 0 ? "flex-start" : i === 4 ? "flex-end" : "center";
          const lit = d.items.length || d.broken.length;
          return (
            <div key={s} className="absolute top-0 h-full" style={{ left: `${stationOffset(i)}%` }}>
              {/* tick */}
              <div className="absolute w-px" style={{ top: LINE_Y - 6, height: 12, background: "var(--rule-strong)", transform: "translateX(-50%)" }} />
              {/* marks above the line: pointer shortcuts (tabindex -1); on a phone the station row below is the target */}
              <div
                className="absolute flex items-end gap-1 max-sm:pointer-events-none"
                style={{ bottom: `calc(100% - ${LINE_Y - 8}px)`, transform: anchorTransform(i), maxWidth: "min(160px, 18vw)", flexWrap: "wrap-reverse", justifyContent: align, width: "max-content" }}
              >
                {d.items.slice(0, MAX_MARKS).map((r) => {
                  const text = `${r.vendorName ?? "Unknown vendor"}, ${r.sourceRef ?? "no reference"}, ${formatMoney(r.amountMinor, r.currency)}, ${stateLabel(r.state)}`;
                  return (
                    <Link
                      key={r.id}
                      href={`/obligations/${r.id}`}
                      tabIndex={-1}
                      aria-hidden
                      title={text}
                      className="block h-3 w-3 rounded-full"
                      style={{ background: TONE[positionFor(r.state).tone], border: "2px solid var(--sheet)", boxSizing: "content-box", opacity: r.state === "settled" ? 0.5 : 1 }}
                    />
                  );
                })}
                {d.broken.map((r) => (
                  <Link
                    key={r.id}
                    href={`/obligations/${r.id}`}
                    tabIndex={-1}
                    aria-hidden
                    title={`${r.vendorName ?? "Unknown vendor"}, ${r.sourceRef ?? "no reference"}, ${formatMoney(r.amountMinor, r.currency)}, blocked`}
                    className="flex h-[18px] w-[18px] items-center justify-center rounded-full"
                    style={{ background: "var(--sheet)", border: "1.5px solid var(--blocked)", color: "var(--blocked)" }}
                  >
                    <svg width="8" height="8" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
                      <path d="M2 2l6 6M8 2l-6 6" />
                    </svg>
                  </Link>
                ))}
                {d.items.length > MAX_MARKS ? <span className="dense text-ink-soft" aria-hidden>+{d.items.length - MAX_MARKS}</span> : null}
              </div>

              {/* phone: just the count under the tick; the station rows below carry the names and money */}
              <div className="dense num absolute sm:hidden" style={{ top: LINE_Y + 10, transform: anchorTransform(i), color: lit ? "var(--ink)" : "var(--ink-soft)" }} aria-hidden>
                {d.items.length}
                {d.broken.length ? <span className="ml-1 text-blocked">{`+${d.broken.length}`}</span> : null}
              </div>

              {/* wider screens: the station label is the one keyboard stop for the station */}
              <Link
                href={`/obligations?filter=${STATION_FILTER[i]}`}
                aria-label={stationSummary(i, d, currency)}
                className="group absolute hidden whitespace-nowrap rounded-sm px-1 py-0.5 sm:block"
                style={{ top: LINE_Y + 8, transform: anchorTransform(i), margin: i === 0 ? "0 0 0 -4px" : i === 4 ? "0 -4px 0 0" : undefined, textAlign: i === 0 ? "left" : i === 4 ? "right" : "center" }}
              >
                <span className="dense block group-hover:underline" style={{ color: lit ? "var(--ink)" : "var(--ink-soft)" }}>
                  {STATION_LABELS[s]}
                  {d.items.length ? <span className="num ml-1 font-normal text-ink-soft">{d.items.length}</span> : null}
                </span>
                <span className={`num block text-xs ${d.items.length ? "text-ink" : "text-ink-soft"}`}>{d.items.length ? formatMoneySymbol(d.openMinor, currency) : i === 4 ? "none this week" : "none"}</span>
                {d.broken.length ? (
                  <span className="mt-1 flex items-center gap-1.5 text-blocked" style={{ justifyContent: i === 4 ? "flex-end" : i === 0 ? "flex-start" : "center" }}>
                    <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
                      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                    </svg>
                    <span className="dense num">
                      {d.broken.length} blocked, {formatMoneySymbol(d.blockedMinor, currency)}
                    </span>
                  </span>
                ) : null}
              </Link>
            </div>
          );
        })}
      </div>

      {/* phone: one 44px row per station, in line order */}
      <ul className="-mx-2 mt-1 divide-y hairline sm:hidden">
        {STATIONS.map((s, i) => {
          const d = stations[i];
          return (
            <li key={s}>
              <Link href={`/obligations?filter=${STATION_FILTER[i]}`} aria-label={stationSummary(i, d, currency)} className="flex min-h-11 items-center gap-3 px-2 py-1.5">
                <span className={`dense w-20 shrink-0 ${d.items.length || d.broken.length ? "text-ink" : "text-ink-soft"}`}>{STATION_LABELS[s]}</span>
                <span className="min-w-0 flex-1 text-xs">
                  <span className={d.items.length ? "text-ink" : "text-ink-soft"}>
                    <span className="num">{d.items.length}</span> {i === 4 ? "this week" : "open"}
                  </span>
                  {d.broken.length ? (
                    <span className="text-blocked">
                      , <span className="num">{d.broken.length}</span> blocked
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-right">
                  <span className={`num block whitespace-nowrap text-sm ${d.items.length ? "text-ink" : "text-ink-soft"}`}>{formatMoneySymbol(d.openMinor, currency)}</span>
                  {d.broken.length ? <span className="num block whitespace-nowrap text-xs text-blocked">{formatMoneySymbol(d.blockedMinor, currency)} held</span> : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-sm text-ink-soft sm:mt-1">{summary}</p>
      </div>
    </div>
  );
}

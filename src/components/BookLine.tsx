import Link from "next/link";
import { positionFor, stationOffset, STATIONS, STATION_LABELS } from "./checkline-model";
import type { ObligationRow } from "@/lib/queries";
import { formatMoney, stateLabel } from "@/lib/format";

/**
 * The overview hero: every open obligation plotted on one shared check line.
 * Markers stack at their station; blocked obligations are shown as a break
 * beneath the station where they stopped, with a count.
 */
export function BookLine({ rows }: { rows: ObligationRow[] }) {
  const open = rows.filter((r) => !["cancelled", "refunded"].includes(r.state));
  const settledRecent = open.filter((r) => r.state === "settled");
  const byStation: ObligationRow[][] = [[], [], [], [], []];
  const breaks: ObligationRow[][] = [[], [], [], [], []];
  for (const r of open) {
    const p = positionFor(r.state, { hasAccounting: true });
    if (p.brokenAt !== null) breaks[p.brokenAt].push(r);
    else byStation[p.station].push(r);
  }

  const count = (st: string) => open.filter((r) => r.state === st).length;
  const parts: string[] = [];
  const blockedN = open.filter((r) => positionFor(r.state).brokenAt !== null).length;
  const awaiting = count("awaiting_approval");
  const ready = count("approved") + count("execution_pending");
  const inFlight = count("sent");
  const evid = count("needs_evidence") + count("drafted");
  if (evid) parts.push(`${evid} waiting on evidence`);
  if (awaiting) parts.push(`${awaiting} awaiting approval`);
  if (blockedN) parts.push(`${blockedN} blocked at verification`);
  if (ready) parts.push(`${ready} ready to pay`);
  if (inFlight) parts.push(`${inFlight} in flight`);
  const summary = `${parts.length ? parts.join(", ") + ". " : "Nothing open. "}${settledRecent.length} reconciled. Each mark is one obligation; hover for the vendor and amount.`;

  const toneFor = (state: string) => positionFor(state).tone;
  const colour: Record<string, string> = { neutral: "var(--ink)", attention: "var(--attention)", settled: "var(--settled)", blocked: "var(--blocked)", muted: "var(--ink-soft)" };

  if (open.length === 0) {
    return (
      <div className="panel px-6 py-10 text-center">
        <p className="font-medium">Nothing on the line</p>
        <p className="mt-1 text-ink-soft">
          No obligations yet. <Link className="link" href="/obligations/new">Add one</Link> or reset the demo to load the story.
        </p>
      </div>
    );
  }

  return (
    <div className="panel px-5 pb-5 pt-6 sm:px-8">
      <div className="relative" style={{ height: 112 }}>
        {/* the line */}
        <div className="absolute left-0 right-0 h-px" style={{ top: 48, background: "var(--rule-strong)" }} />
        {STATIONS.map((s, i) => {
          const items = byStation[i];
          const broken = breaks[i];
          const edge = i === 0 ? "none" : i === STATIONS.length - 1 ? "translateX(-100%)" : "translateX(-50%)";
          const markerEdge = i === 0 ? "translateX(0)" : i === STATIONS.length - 1 ? "translateX(-100%)" : "translateX(-50%)";
          return (
            <div key={s} className="absolute top-0 h-full" style={{ left: `${stationOffset(i)}%` }}>
              {/* tick */}
              <div className="absolute w-px" style={{ top: 42, height: 12, background: "var(--rule-strong)", transform: "translateX(-50%)" }} />
              {/* markers above the line */}
              <div className="absolute flex items-end gap-1" style={{ bottom: 70, transform: markerEdge, maxWidth: "min(160px, 18vw)", flexWrap: "wrap-reverse", justifyContent: i === 0 ? "flex-start" : i === 4 ? "flex-end" : "center", width: "max-content" }}>
                {items.slice(0, 14).map((r) => (
                  <Link
                    key={r.id}
                    href={`/obligations/${r.id}`}
                    title={`${r.vendorName ?? "Unknown vendor"}, ${r.sourceRef ?? "no reference"}, ${formatMoney(r.amountMinor, r.currency)}, ${stateLabel(r.state)}`}
                    className="block h-3 w-3 rounded-full"
                    style={{ background: colour[toneFor(r.state)], border: "2px solid var(--sheet)", boxSizing: "content-box" }}
                    aria-label={`${r.vendorName ?? "Unknown vendor"} ${r.sourceRef ?? ""} ${formatMoney(r.amountMinor, r.currency)}, ${stateLabel(r.state)}`}
                  />
                ))}
                {broken.map((r) => (
                  <Link
                    key={r.id}
                    href={`/obligations/${r.id}`}
                    title={`${r.vendorName ?? "Unknown vendor"}, ${r.sourceRef ?? "no reference"}, ${formatMoney(r.amountMinor, r.currency)}, blocked`}
                    className="flex h-[18px] w-[18px] items-center justify-center rounded-full"
                    style={{ background: "var(--sheet)", border: "1.5px solid var(--blocked)", color: "var(--blocked)" }}
                    aria-label={`${r.vendorName ?? "Unknown vendor"} ${r.sourceRef ?? ""} ${formatMoney(r.amountMinor, r.currency)}, blocked`}
                  >
                    <svg width="8" height="8" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
                      <path d="M2 2l6 6M8 2l-6 6" />
                    </svg>
                  </Link>
                ))}
                {items.length > 14 ? <span className="dense text-ink-soft">+{items.length - 14}</span> : null}
              </div>
              {/* station label */}
              <div className="dense absolute whitespace-nowrap text-[11px] sm:text-xs" style={{ top: 60, transform: edge, color: items.length || broken.length ? "var(--ink)" : "var(--ink-soft)" }}>
                <span className={i === 3 ? "max-sm:sr-only" : ""}>{STATION_LABELS[s]}</span>
                {items.length ? <span className={`num ml-1 font-normal text-ink-soft ${i === 3 ? "max-sm:ml-0" : ""}`}>{items.length}</span> : null}
              </div>
              {/* break beneath */}
              {broken.length ? (
                <Link href="/exceptions" className="absolute flex items-center gap-1.5 whitespace-nowrap" style={{ top: 82, transform: edge, color: "var(--blocked)" }} title={broken.map((b) => `${b.vendorName ?? "Unknown"} ${b.sourceRef ?? ""}`).join(", ")}>
                  <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
                  </svg>
                  <span className="dense">
                    <span className="num">{broken.length}</span> {broken.length === 1 ? "blocked" : "blocked"}
                  </span>
                </Link>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-sm text-ink-soft">{summary}</p>
    </div>
  );
}

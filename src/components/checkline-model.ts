/** Shared station model for the check line. Pure, usable from server and client. */

import type { ObligationRow } from "@/lib/queries";
import { toBaseOrZero } from "@/lib/fx";
import { formatMoneySymbol } from "@/lib/format";

export const STATIONS = ["read", "verified", "routed", "paid", "reconciled"] as const;
export type Station = (typeof STATIONS)[number];
export type StationIndex = 0 | 1 | 2 | 3 | 4;

export const STATION_LABELS: Record<Station, string> = {
  read: "Read",
  verified: "Verified",
  routed: "Routed",
  paid: "Paid",
  reconciled: "Reconciled",
};

export type LinePosition = {
  /** Where the marker sits. */
  station: StationIndex;
  /** Line is broken at this station. */
  brokenAt: StationIndex | null;
  /** Grey, inactive line (cancelled). */
  inactive: boolean;
  /** Tone of the marker. */
  tone: "neutral" | "attention" | "settled" | "blocked" | "muted";
  /** Short caption next to the marker in the full variant. */
  caption: string | null;
};

export function positionFor(state: string | null | undefined, opts: { hasAccounting?: boolean } = {}): LinePosition {
  switch (state) {
    case "drafted":
      return { station: 0, brokenAt: null, inactive: false, tone: "neutral", caption: null };
    case "needs_evidence":
      return { station: 0, brokenAt: null, inactive: false, tone: "attention", caption: "waiting for evidence" };
    case "verified":
      return { station: 1, brokenAt: null, inactive: false, tone: "neutral", caption: null };
    case "awaiting_approval":
      return { station: 1, brokenAt: null, inactive: false, tone: "attention", caption: "waiting for approval" };
    case "blocked":
      return { station: 1, brokenAt: 1, inactive: false, tone: "blocked", caption: "blocked" };
    case "approved":
      return { station: 2, brokenAt: null, inactive: false, tone: "neutral", caption: "ready to pay" };
    case "execution_pending":
      return { station: 2, brokenAt: null, inactive: false, tone: "neutral", caption: "paying" };
    case "sent":
      return { station: 3, brokenAt: null, inactive: false, tone: "neutral", caption: "confirming" };
    case "settled":
      return opts.hasAccounting ? { station: 4, brokenAt: null, inactive: false, tone: "settled", caption: null } : { station: 3, brokenAt: null, inactive: false, tone: "settled", caption: "not yet in the books" };
    case "failed":
      return { station: 3, brokenAt: 3, inactive: false, tone: "blocked", caption: "failed" };
    case "refunded":
      return { station: 3, brokenAt: null, inactive: false, tone: "muted", caption: "refunded" };
    case "disputed":
      return { station: 3, brokenAt: null, inactive: false, tone: "attention", caption: "disputed" };
    case "cancelled":
      return { station: 0, brokenAt: null, inactive: true, tone: "muted", caption: "cancelled" };
    default:
      return { station: 0, brokenAt: null, inactive: false, tone: "neutral", caption: null };
  }
}

/** Percentage offset of a station along the line (0..100). */
export function stationOffset(i: number): number {
  return (i / (STATIONS.length - 1)) * 100;
}

/** How a label under station `i` is anchored so the end labels never run off the track. */
export function stationAnchor(i: number): "start" | "middle" | "end" {
  return i === 0 ? "start" : i === STATIONS.length - 1 ? "end" : "middle";
}

/** CSS transform for a label anchored at a station. */
export function anchorTransform(i: number): string {
  const a = stationAnchor(i);
  return a === "start" ? "none" : a === "end" ? "translateX(-100%)" : "translateX(-50%)";
}

/**
 * The spoken description of a full check line: where the marker is, where the line is broken, the caption, and
 * every station in order, so the ticks that carry no visible label on a phone are still named.
 */
export function describeLine(stateText: string, at: StationIndex, brokenAt: StationIndex | null, caption: string | null | undefined): string {
  const parts = [`${stateText}: at ${STATION_LABELS[STATIONS[at]]}`];
  if (brokenAt !== null) parts.push(`line broken at ${STATION_LABELS[STATIONS[brokenAt]]}`);
  if (caption) parts.push(caption);
  const stations = STATIONS.map((s, i) => `${STATION_LABELS[s]}${i === (brokenAt ?? at) ? " (current)" : ""}`).join(", ");
  return `${parts.join(", ")}. Stations: ${stations}.`;
}

/* The overview hero (BookLine). */

const WEEK_MS = 7 * 86_400_000;
/** Station 0..4 to the inbox filter that holds most of what sits there. */
export const STATION_FILTER = ["needs_action", "needs_action", "needs_action", "in_flight", "settled"] as const;
export type StationData = { items: ObligationRow[]; broken: ObligationRow[]; openMinor: number; blockedMinor: number };

/** Open requests plus those settled in the last seven days, grouped by station, with totals in the base currency. */
export function bookLineModel(rows: ObligationRow[], baseCurrency: string, now: number = Date.now()): StationData[] {
  const since = new Date(now - WEEK_MS).toISOString();
  const shown = rows.filter((r) => !["cancelled", "refunded"].includes(r.state) && (r.state !== "settled" || r.updatedAt >= since));
  const out: StationData[] = STATIONS.map(() => ({ items: [], broken: [], openMinor: 0, blockedMinor: 0 }));
  for (const r of shown) {
    const p = positionFor(r.state, { hasAccounting: true });
    const base = toBaseOrZero(r.amountMinor ?? 0, r.currency, baseCurrency);
    if (p.brokenAt !== null) {
      out[p.brokenAt].broken.push(r);
      out[p.brokenAt].blockedMinor += base;
    } else {
      out[p.station].items.push(r);
      out[p.station].openMinor += base;
    }
  }
  return out;
}

/** "Verified: 3 open, USD 1,600.20, 2 blocked, USD 1,140.00" for the one focusable link per station. */
export function stationSummary(i: number, d: StationData, currency: string): string {
  const name = STATION_LABELS[STATIONS[i]];
  const parts: string[] = [];
  const noun = i === 4 ? "this week" : "open";
  parts.push(d.items.length ? `${d.items.length} ${noun}, ${formatMoneySymbol(d.openMinor, currency)}` : `none ${noun}`);
  if (d.broken.length) parts.push(`${d.broken.length} blocked, ${formatMoneySymbol(d.blockedMinor, currency)}`);
  return `${name}: ${parts.join(", ")}`;
}

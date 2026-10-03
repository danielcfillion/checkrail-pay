/** Shared station model for the due line. Pure, usable from server and client. */

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

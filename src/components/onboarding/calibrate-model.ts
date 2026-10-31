import { formatMoney } from "@/lib/format";
import type { CallRow, ImportRow, SuggestionRow } from "@/lib/onboarding/dashboard";

/*
 * Pure helpers for "Check our calls against your history". Client-safe: types only from the onboarding modules.
 */

export type Mark = "right_catch" | "was_fine";
export type CallChip = "unmarked" | "all" | "block" | "hold";

export const CHIP_LABEL: Record<CallChip, string> = { unmarked: "Unmarked", all: "All", block: "Blocked", hold: "Held" };
export const CHIPS: readonly CallChip[] = ["unmarked", "all", "block", "hold"];

export const MARK_LABEL: Record<Mark, string> = { right_catch: "Right catch", was_fine: "Was fine" };

export function verdictLabel(verdict: string): string {
  return verdict === "block" ? "Blocked" : verdict === "hold" ? "Held" : "Clear";
}

/** The marks made on this page since it loaded, laid over the server's rows. A later server copy wins once it agrees. */
export function withMarks<T extends Pick<CallRow, "call_id" | "mark">>(rows: T[], overrides: Record<string, Mark>): T[] {
  return rows.map((r) => (overrides[r.call_id] && overrides[r.call_id] !== r.mark ? { ...r, mark: overrides[r.call_id] } : r));
}

export function matchesChip(r: Pick<CallRow, "mark" | "verdict">, chip: CallChip): boolean {
  if (chip === "unmarked") return !r.mark;
  if (chip === "block") return r.verdict === "block";
  if (chip === "hold") return r.verdict === "hold";
  return true;
}

export function chipCounts(rows: Array<Pick<CallRow, "mark" | "verdict">>): Record<CallChip, number> {
  const out: Record<CallChip, number> = { unmarked: 0, all: 0, block: 0, hold: 0 };
  for (const r of rows) for (const c of CHIPS) if (matchesChip(r, c)) out[c]++;
  return out;
}

/** Start on the calls still to mark; when every call is marked, show them all. */
export function defaultChip(rows: Array<Pick<CallRow, "mark" | "verdict">>): CallChip {
  return rows.some((r) => !r.mark) ? "unmarked" : "all";
}

export interface CallSummary {
  currency: string;
  /** Money the re-check would have stopped: duplicates in full plus the overpaid part of overcharges. */
  stoppedMinor: number;
  blocked: number;
  held: number;
  clear: number;
  payments: number;
  imports: number;
  periodFrom: string | null;
  periodTo: string | null;
  /** Re-checks in another currency, left out of the figures above. */
  otherCurrencies: string[];
}

/**
 * The figures at the top of the page, from the checked imports' own totals (the same figures screen 1 showed after
 * each re-check). With several currencies, the one with the most payments leads and the rest are named.
 */
export function summarise(imports: Array<Pick<ImportRow, "status" | "currency" | "payments" | "would_have_blocked_minor" | "blocked_count" | "held_count" | "clear_count" | "period_from" | "period_to">>): CallSummary | null {
  const checked = imports.filter((i) => i.status === "checked");
  if (!checked.length) return null;
  const byCurrency = new Map<string, number>();
  for (const i of checked) byCurrency.set(i.currency, (byCurrency.get(i.currency) ?? 0) + i.payments);
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const mine = checked.filter((i) => i.currency === currency);
  const froms = mine.map((i) => i.period_from).filter((d): d is string => Boolean(d)).sort();
  const tos = mine.map((i) => i.period_to).filter((d): d is string => Boolean(d)).sort();
  return {
    currency,
    stoppedMinor: mine.reduce((n, i) => n + i.would_have_blocked_minor, 0),
    blocked: mine.reduce((n, i) => n + i.blocked_count, 0),
    held: mine.reduce((n, i) => n + i.held_count, 0),
    clear: mine.reduce((n, i) => n + i.clear_count, 0),
    payments: mine.reduce((n, i) => n + i.payments, 0),
    imports: mine.length,
    periodFrom: froms[0] ?? null,
    periodTo: tos[tos.length - 1] ?? null,
    otherCurrencies: [...byCurrency.keys()].filter((c) => c !== currency).sort(),
  };
}

export function markProgress(rows: Array<Pick<CallRow, "mark">>): { marked: number; total: number; share: number } {
  const marked = rows.filter((r) => r.mark).length;
  return { marked, total: rows.length, share: rows.length ? marked / rows.length : 0 };
}

const unitWord = (u: string) => u.replace(/_/g, "-");

/**
 * What pressing Apply does, in plain words, before anyone presses it. The suggestion's target is an id (a supplier's,
 * or "business"), so the supplier is named by the title beside this line, not here.
 */
export function applyEffect(s: Pick<SuggestionRow, "kind" | "proposed_unit" | "proposed_rate_minor" | "proposed_currency" | "proposed_valid_from">, rateMinor: number | null = s.proposed_rate_minor): string {
  if (s.kind === "rate_card") {
    const rate = rateMinor !== null && s.proposed_currency ? `${formatMoney(rateMinor, s.proposed_currency)} a ${unitWord(s.proposed_unit ?? "trip")}` : "the proposed rate";
    return `Adds the rate card: ${rate}${s.proposed_valid_from ? `, from ${shortDay(s.proposed_valid_from)}` : ""}. Their invoices are then checked against it.`;
  }
  if (s.kind === "booking_feed") return "Records your decision. You connect the booking system in Settings; nothing else changes here.";
  if (s.kind === "verify_supplier") return "Records your decision. The supplier is verified on its own page, where a second person confirms the payout details.";
  if (s.kind === "retainer") return "Records your decision. You set the monthly retainer on the supplier page.";
  return "Records your decision. Nothing else changes here.";
}

/** "5 Aug 2026" from YYYY-MM-DD. */
function shortDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The words for a link to the screen where a suggestion's change is made. */
export function screenLabel(screen: string): string {
  if (screen === "/settings") return "Open Settings";
  if (screen.startsWith("/vendors/")) return "Open the supplier";
  if (screen === "/vendors") return "Open vendors";
  return "Open";
}

/** Who may decide each kind: the same people who make that change on its own screen (calibration.ts). */
export function decisionPermission(kind: string): "verify_vendor" | "settings" {
  return kind === "booking_feed" ? "settings" : "verify_vendor";
}

export function whoDecides(kind: string): string {
  return decisionPermission(kind) === "settings" ? "The owner decides this one." : "An approver or the owner decides this one.";
}

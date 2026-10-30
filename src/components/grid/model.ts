/**
 * Row models for the AG Grid tables (ledger, payment run builder, runs list). Pure: no DB, no grid, no fx table.
 * Server pages map their query results into these plain rows and hand them to the client grids, so the browser
 * never converts currencies itself (the reference rates live on the server).
 */

import { currencyDecimals, formatDate, humaniseActor, localDateString, railLabel } from "@/lib/format";

/** Converts minor units of `currency` into the business's base currency (the server passes fx.toBaseOrZero). */
export type ToBase = (minor: number, currency: string) => number;

/* Ledger */

export type ReconState = "reconciled" | "in_books" | "open";

export const RECON_LABEL: Record<ReconState, string> = {
  reconciled: "Reconciled",
  in_books: "In the books",
  open: "Not reconciled",
};

export type DecidedKind = "agent" | "person" | "unknown";

export const DECIDED_KIND_LABEL: Record<DecidedKind, string> = { agent: "Agent", person: "Person", unknown: "Not recorded" };

export type LedgerRow = {
  id: string;
  obligationId: string;
  vendorName: string;
  sourceRef: string;
  amountMinor: number;
  feeMinor: number;
  currency: string;
  /** amountMinor in the base currency at reference rates: what the amount column sorts by. */
  baseMinor: number;
  receivedMinor: number | null;
  receivedCurrency: string | null;
  rail: string;
  railLabel: string;
  /** ISO instant. Displayed as "29 Oct 2026", sorted and exported as ISO. */
  settledAt: string;
  recon: ReconState;
  statementRef: string | null;
  decidedKind: DecidedKind;
  decidedBy: string;
  externalId: string | null;
};

export type SettlementInput = {
  id: string;
  obligationId: string;
  vendorName: string | null;
  obligation: { sourceRef: string | null };
  grossMinor: number;
  grossCurrency: string;
  feeMinor: number;
  receivedMinor: number | null;
  receivedCurrency: string | null;
  rail: string;
  settledAt: string;
  reconciledAt: string | null;
  statementRef: string | null;
  externalId: string | null;
};

/** Who decided a payment, from the actor that started it: an agent (autopilot) or a named person. */
export function decidedByFor(actor: string | null | undefined): { kind: DecidedKind; label: string } {
  if (!actor) return { kind: "unknown", label: "Not recorded" };
  if (actor.startsWith("user:")) return { kind: "person", label: humaniseActor(actor) };
  if (actor.startsWith("agent:") || actor.startsWith("ai:")) return { kind: "agent", label: humaniseActor(actor) };
  if (actor.startsWith("mcp:")) return { kind: "agent", label: humaniseActor(actor) };
  return { kind: "unknown", label: humaniseActor(actor) };
}

/**
 * Reconciled means matched to a line on the provider's statement. A settlement whose accounting record went out
 * (exported or synced) but has no statement match is "in the books"; anything else is not reconciled yet.
 */
export function reconStateFor(reconciledAt: string | null | undefined, accountingStatus: string | null | undefined): ReconState {
  if (reconciledAt) return "reconciled";
  if (accountingStatus === "exported" || accountingStatus === "synced") return "in_books";
  return "open";
}

export function toLedgerRow(s: SettlementInput, deps: { toBase: ToBase; starter?: string | null; accountingStatus?: string | null }): LedgerRow {
  const decided = decidedByFor(deps.starter);
  return {
    id: s.id,
    obligationId: s.obligationId,
    vendorName: s.vendorName ?? "Unknown vendor",
    sourceRef: s.obligation.sourceRef ?? "",
    amountMinor: s.grossMinor,
    feeMinor: s.feeMinor,
    currency: s.grossCurrency.toUpperCase(),
    baseMinor: deps.toBase(s.grossMinor, s.grossCurrency.toUpperCase()),
    receivedMinor: s.receivedMinor,
    receivedCurrency: s.receivedCurrency,
    rail: s.rail,
    railLabel: railLabel(s.rail),
    settledAt: s.settledAt,
    recon: reconStateFor(s.reconciledAt, deps.accountingStatus),
    statementRef: s.statementRef,
    decidedKind: decided.kind,
    decidedBy: decided.label,
    externalId: s.externalId,
  };
}

export type CurrencyTotal = { currency: string; count: number; amountMinor: number; feeMinor: number; receivedMinor: number | null };

/**
 * One total per currency, in first-seen order. Amounts in different currencies are never added together.
 * Received is summed only when every row in that currency was received in that same currency.
 */
export function ledgerTotals(rows: Array<Pick<LedgerRow, "currency" | "amountMinor" | "feeMinor" | "receivedMinor" | "receivedCurrency">>): CurrencyTotal[] {
  const m = new Map<string, CurrencyTotal & { receivedOk: boolean }>();
  for (const r of rows) {
    const t = m.get(r.currency) ?? { currency: r.currency, count: 0, amountMinor: 0, feeMinor: 0, receivedMinor: 0, receivedOk: true };
    t.count += 1;
    t.amountMinor += r.amountMinor;
    t.feeMinor += r.feeMinor;
    if (r.receivedMinor === null || (r.receivedCurrency ?? r.currency).toUpperCase() !== r.currency) t.receivedOk = false;
    else t.receivedMinor = (t.receivedMinor ?? 0) + r.receivedMinor;
    m.set(r.currency, t);
  }
  return [...m.values()].map(({ receivedOk, ...t }) => ({ ...t, receivedMinor: receivedOk ? t.receivedMinor : null }));
}

/** The pinned totals rows: shaped like ledger rows so the same columns render them. */
export type LedgerTotalRow = LedgerRow & { totalOf: number };

export function totalRowsFor(totals: CurrencyTotal[]): LedgerTotalRow[] {
  return totals.map((t) => ({
    id: `total-${t.currency}`,
    obligationId: "",
    vendorName: `Total ${t.currency}`,
    sourceRef: "",
    amountMinor: t.amountMinor,
    feeMinor: t.feeMinor,
    currency: t.currency,
    baseMinor: 0,
    receivedMinor: t.receivedMinor,
    receivedCurrency: t.receivedMinor === null ? null : t.currency,
    rail: "",
    railLabel: "",
    settledAt: "",
    recon: "open",
    statementRef: null,
    decidedKind: "unknown",
    decidedBy: "",
    externalId: null,
    totalOf: t.count,
  }));
}

/* CSV */

/**
 * A spreadsheet must never run a cell as a formula. Text starting with =, +, -, @ (or a tab or carriage return,
 * which some spreadsheets strip first) gets a leading apostrophe, as does any line inside the cell that starts
 * with one. Plain numbers such as -12.50 stay numbers. Quoting is left to the CSV writer (AG Grid quotes every cell).
 */
export function csvSafe(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return s.replace(/(\r\n|\r|\n)([=+\-@\t])/g, "$1'$2");
}

/** Minor units as a plain decimal for spreadsheets: no thousands separators, no currency code. */
export function decimalAmount(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor === null || minor === undefined) return "";
  const d = currencyDecimals(currency);
  return (minor / 100).toFixed(d);
}

/** Column ids of the ledger grid, in export order. */
export const LEDGER_CSV_COLUMNS = ["settledAt", "vendorName", "sourceRef", "currency", "amountMinor", "feeMinor", "receivedMinor", "rail", "recon", "decidedBy", "externalId", "statementRef", "obligationId"] as const;

/** The value one ledger cell exports as: ISO dates, plain decimals, labels in words, every cell formula-safe. */
export function ledgerCsvValue(colId: string, row: LedgerRow): string {
  switch (colId) {
    case "amountMinor":
      return csvSafe(decimalAmount(row.amountMinor, row.currency));
    case "feeMinor":
      return csvSafe(decimalAmount(row.feeMinor, row.currency));
    case "receivedMinor":
      return csvSafe(row.receivedMinor === null ? "" : `${decimalAmount(row.receivedMinor, row.receivedCurrency)}${row.receivedCurrency && row.receivedCurrency.toUpperCase() !== row.currency ? ` ${row.receivedCurrency.toUpperCase()}` : ""}`);
    case "rail":
      return csvSafe(row.railLabel);
    case "recon":
      return csvSafe(RECON_LABEL[row.recon]);
    default: {
      const v = (row as Record<string, unknown>)[colId];
      return csvSafe(v);
    }
  }
}

/* Dates */

/** The business-local calendar day (YYYY-MM-DD) of an ISO instant, or the date itself for a bare date. */
export function localDay(iso: string | null | undefined): string {
  if (!iso) return "";
  if (iso.length === 10) return iso;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? localDateString(d) : "";
}

/**
 * AG Grid date filter comparator: the filter hands a local-midnight Date for the day picked; the cell holds an ISO
 * value. Compared as business-local calendar days, so "on 12 Oct" matches a payment settled at 23:39 UTC on 11 Oct
 * when that is already the 12th in Hanoi.
 */
export function compareDayToIso(filterDay: Date, cellIso: string | null | undefined): number {
  const cell = localDay(cellIso);
  if (!cell) return -1;
  const f = `${filterDay.getFullYear()}-${String(filterDay.getMonth() + 1).padStart(2, "0")}-${String(filterDay.getDate()).padStart(2, "0")}`;
  return cell < f ? -1 : cell > f ? 1 : 0;
}

export function displayDate(iso: string | null | undefined): string {
  return iso ? formatDate(iso) : "";
}

/* Payment run builder */

export type PayableRow = {
  id: string;
  vendorName: string;
  sourceRef: string;
  amountMinor: number;
  currency: string;
  baseMinor: number;
  dueDate: string | null;
  overdue: boolean;
  state: string;
  scheduled: boolean;
  statusLabel: string;
  rail: string | null;
  railLabel: string;
};

export type CandidateInput = { id: string; vendorName: string | null; sourceRef: string | null; amountMinor: number; currency: string; dueDate: string | null; state: string; rail: string | null; scheduled: boolean };

export function payableStatus(state: string, scheduled: boolean): string {
  return state === "approved" ? (scheduled ? "Approved, autopilot scheduled" : "Approved") : "Waiting for approval";
}

export function toPayableRow(c: CandidateInput, deps: { toBase: ToBase; today: string }): PayableRow {
  return {
    id: c.id,
    vendorName: c.vendorName ?? "Unknown vendor",
    sourceRef: c.sourceRef ?? "",
    amountMinor: c.amountMinor,
    currency: c.currency.toUpperCase(),
    baseMinor: deps.toBase(c.amountMinor, c.currency.toUpperCase()),
    dueDate: c.dueDate,
    overdue: Boolean(c.dueDate && deps.today && c.dueDate < deps.today),
    state: c.state,
    scheduled: c.scheduled,
    statusLabel: payableStatus(c.state, c.scheduled),
    rail: c.rail,
    railLabel: c.rail ? railLabel(c.rail) : "No rail",
  };
}

export type RailFunding = { rail: string | null; railLabel: string; count: number; totals: Array<{ currency: string; minor: number }> };

/**
 * What the selection needs funded, per rail and per currency: the approver tops up each source (the PayPal
 * balance, the Stellar wallet, the bank account) before release. Currencies are never added together.
 */
export function fundingByRail(rows: Array<Pick<PayableRow, "rail" | "railLabel" | "currency" | "amountMinor">>): { byRail: RailFunding[]; totals: Array<{ currency: string; minor: number }>; count: number } {
  const rails = new Map<string, RailFunding>();
  const totals = new Map<string, number>();
  for (const r of rows) {
    const key = r.rail ?? "";
    const f = rails.get(key) ?? { rail: r.rail, railLabel: r.railLabel, count: 0, totals: [] };
    f.count += 1;
    const t = f.totals.find((x) => x.currency === r.currency);
    if (t) t.minor += r.amountMinor;
    else f.totals.push({ currency: r.currency, minor: r.amountMinor });
    rails.set(key, f);
    totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amountMinor);
  }
  return { byRail: [...rails.values()], totals: [...totals.entries()].map(([currency, minor]) => ({ currency, minor })), count: rows.length };
}

/** Ids due on or before `day` (YYYY-MM-DD). Payments with no due date, and ones Autopilot already scheduled, are left for a person. */
export function dueByIds(rows: Array<Pick<PayableRow, "id" | "dueDate" | "scheduled">>, day: string): string[] {
  return rows.filter((r) => !r.scheduled && r.dueDate && r.dueDate <= day).map((r) => r.id);
}

/* Runs list */

export type RunRow = {
  id: string;
  name: string;
  status: string;
  statusLabel: string;
  createdBy: string;
  createdAt: string;
  count: number;
  progress: string;
  totals: Array<{ currency: string; minor: number }>;
  baseTotalMinor: number;
};

export type RunInput = { id: string; name: string; status: string; createdBy: string; createdAt: string; count: number; paid: number; withBank: number; totals: Array<{ currency: string; minor: number }> };

export function runStatusLabel(status: string): string {
  return status === "draft" ? "Waiting for release" : status === "releasing" ? "Releasing" : status === "released" ? "Released" : status === "cancelled" ? "Cancelled" : status;
}

export function toRunRow(r: RunInput, deps: { toBase: ToBase }): RunRow {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    statusLabel: runStatusLabel(r.status),
    createdBy: humaniseActor(r.createdBy),
    createdAt: r.createdAt,
    count: r.count,
    progress: r.status === "released" ? `${r.paid} of ${r.count} paid${r.withBank ? `, ${r.withBank} with the bank` : ""}` : String(r.count),
    totals: r.totals,
    baseTotalMinor: r.totals.reduce((a, t) => a + deps.toBase(t.minor, t.currency), 0),
  };
}

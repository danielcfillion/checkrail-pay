import { LEDGER_CSV_COLUMNS, ledgerCsvValue, type LedgerRow } from "./model";

/** Header for each exported ledger column. Dates are ISO 8601 instants (UTC), amounts are plain decimals. */
export const LEDGER_CSV_HEADERS: Record<string, string> = {
  settledAt: "Settled at (ISO 8601, UTC)",
  vendorName: "Vendor",
  sourceRef: "Reference",
  currency: "Currency",
  amountMinor: "Amount",
  feeMinor: "Fee",
  receivedMinor: "Recipient received",
  rail: "Rail",
  recon: "Reconciled",
  decidedBy: "Decided by",
  externalId: "External id",
  statementRef: "Statement line",
  obligationId: "Request id",
};

/** One quoted CSV cell, the way AG Grid's exporter writes it: always quoted, inner quotes doubled. */
export function quoteCell(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * The same file the grid's "Export CSV" writes, built without a grid (phones show card rows instead of a grid).
 * Kept in step with the grid export by sharing LEDGER_CSV_COLUMNS, the headers and ledgerCsvValue.
 */
export function ledgerCsv(rows: LedgerRow[]): string {
  const lines = [LEDGER_CSV_COLUMNS.map((c) => quoteCell(LEDGER_CSV_HEADERS[c] ?? c)).join(",")];
  for (const r of rows) lines.push(LEDGER_CSV_COLUMNS.map((c) => quoteCell(ledgerCsvValue(c, r))).join(","));
  return lines.join("\r\n");
}

import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { obligations, settlements, vendors, accountingSyncs } from "../db/schema";
import { config } from "../config";

/**
 * Accounting output. Dueline is not a ledger; it produces clean, complete
 * records for the system of record. The same record maps to a Xero bill +
 * payment, a QuickBooks bill + bill payment, or a CSV row.
 */
export interface AccountingPayload {
  reference: string; // the obligation's business reference
  vendorName: string;
  vendorCountry: string;
  description: string;
  billDate: string;
  paymentDate: string;
  grossAmount: string; // major units, decimal string
  grossCurrency: string;
  feeAmount: string;
  feeCurrency: string;
  netPaid: string; // gross + fee in gross currency
  recipientReceived: string | null;
  recipientCurrency: string | null;
  fxRate: string | null;
  rail: string;
  externalTransactionId: string;
  explorerUrl: string | null;
  accountCode: string; // suggested expense account
  obligationId: string;
}

export function buildAccountingRecord(db: Db, obligationId: string): { destination: string; payload: AccountingPayload } | null {
  const ob = db.select().from(obligations).where(eq(obligations.id, obligationId)).get();
  const st = db.select().from(settlements).where(eq(settlements.obligationId, obligationId)).get();
  if (!ob || !st || !ob.vendorId) return null;
  const v = db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get();
  if (!v) return null;
  const major = (minor: number) => (minor / 100).toFixed(2);
  return {
    destination: config.accounting.destination,
    payload: {
      reference: ob.sourceRef ?? ob.id,
      vendorName: v.name,
      vendorCountry: v.country,
      description: ob.description ?? "",
      billDate: (ob.dueDate ?? ob.createdAt).slice(0, 10),
      paymentDate: st.settledAt.slice(0, 10),
      grossAmount: major(st.grossMinor),
      grossCurrency: st.grossCurrency,
      feeAmount: major(st.feeMinor),
      feeCurrency: st.grossCurrency,
      netPaid: major(st.grossMinor + st.feeMinor),
      recipientReceived: st.receivedMinor != null ? major(st.receivedMinor) : null,
      recipientCurrency: st.receivedCurrency,
      fxRate: st.fxRate,
      rail: st.rail,
      externalTransactionId: st.externalId ?? "",
      explorerUrl: st.explorerUrl,
      accountCode: accountCodeFor(v.role),
      obligationId: ob.id,
    },
  };
}

/** Suggested Xero-style expense codes by vendor role. Configurable later. */
function accountCodeFor(role: string): string {
  switch (role) {
    case "guide":
    case "driver":
      return "310 Cost of Goods Sold: Contract labour";
    case "homestay":
    case "hotel":
      return "320 Cost of Goods Sold: Accommodation";
    case "creator":
      return "400 Advertising and marketing";
    default:
      return "429 General expenses";
  }
}

export const CSV_COLUMNS: Array<keyof AccountingPayload> = [
  "reference",
  "vendorName",
  "vendorCountry",
  "description",
  "billDate",
  "paymentDate",
  "grossAmount",
  "grossCurrency",
  "feeAmount",
  "feeCurrency",
  "netPaid",
  "recipientReceived",
  "recipientCurrency",
  "fxRate",
  "rail",
  "externalTransactionId",
  "explorerUrl",
  "accountCode",
  "obligationId",
];

export function toCsv(rows: AccountingPayload[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => esc(r[c])).join(","));
  return lines.join("\n") + "\n";
}

/** Mark every pending CSV sync as exported and return the file contents. */
export function exportPendingCsv(db: Db): { csv: string; count: number } {
  const pending = db.select().from(accountingSyncs).where(eq(accountingSyncs.status, "pending")).all();
  const rows = pending.map((p) => JSON.parse(p.payloadJson ?? "{}") as AccountingPayload);
  const ts = new Date().toISOString();
  for (const p of pending) {
    db.update(accountingSyncs).set({ status: "exported", externalRef: `csv:${ts.slice(0, 10)}`, updatedAt: ts }).where(eq(accountingSyncs.id, p.id)).run();
  }
  return { csv: toCsv(rows), count: rows.length };
}

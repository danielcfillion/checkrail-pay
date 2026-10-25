import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { obligations, settlements, vendors, accountingSyncs, bills } from "../db/schema";
import { localDateString } from "../format";
import { departureCodeFor } from "../engine/rates";
import { config } from "../config";

/**
 * Accounting output. Checkrail Pay is not a ledger; it produces clean, complete
 * records for the system of record. The same record maps to a Xero bill +
 * payment, a QuickBooks bill + bill payment, or a CSV row.
 */
export interface AccountingPayload {
  reference: string; // the obligation's business reference
  vendorName: string;
  vendorCountry: string;
  description: string;
  billDate: string;
  /** When the vendor asked to be paid by; the bill date when no due date was given. */
  dueDate?: string;
  paymentDate: string;
  grossAmount: string; // major units, decimal string
  grossCurrency: string;
  feeAmount: string;
  /** Tax kept back from the vendor and owed to the tax office (a liability line in the books). */
  withheldAmount?: string;
  feeCurrency: string;
  netPaid: string; // cash out in gross currency: gross + fee for PayPal, gross for Stellar (fee is inside it)
  recipientReceived: string | null;
  recipientCurrency: string | null;
  fxRate: string | null;
  rail: string;
  externalTransactionId: string;
  explorerUrl: string | null;
  accountCode: string; // suggested expense account
  /** Departure code, for a Xero tracking category ("Departure") so cost per trip can be reported. */
  departure?: string | null;
  /** Xero tax type for the bill line (XERO_TAX_TYPE, default "Tax Exempt"); tax profiles refine it. */
  taxType?: string;
  obligationId: string;
}

export function buildAccountingRecord(db: Db, obligationId: string): { destination: string; payload: AccountingPayload } | null {
  const ob = db.select().from(obligations).where(eq(obligations.id, obligationId)).get();
  const st = db.select().from(settlements).where(eq(settlements.obligationId, obligationId)).get();
  if (!ob || !st || !ob.vendorId) return null;
  const v = db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get();
  if (!v) return null;
  const major = (minor: number) => (minor / 100).toFixed(2);
  const bill = ob.billId ? db.select().from(bills).where(eq(bills.id, ob.billId)).get() : null;
  const billDate = bill?.billDate ?? localDateString(new Date(ob.createdAt));
  return {
    destination: config.accounting.destination,
    payload: {
      reference: ob.sourceRef ?? ob.id,
      vendorName: v.name,
      vendorCountry: v.country,
      description: ob.description ?? "",
      // The bill date is when the obligation was raised (or the bill's own date), never the due date; dates are local.
      billDate: billDate,
      dueDate: ob.dueDate ?? bill?.dueDate ?? billDate,
      paymentDate: localDateString(new Date(st.settledAt)),
      // The bill is the full amount owed; the vendor was sent that less any tax withheld.
      grossAmount: major(ob.amountMinor ?? st.grossMinor),
      withheldAmount: major(ob.withheldMinor ?? 0),
      grossCurrency: st.grossCurrency,
      feeAmount: major(st.feeMinor),
      feeCurrency: st.grossCurrency,
      // Cash out of the bank account: PayPal charges its fee on top; the Stellar anchor path takes its fee out of the amount.
      netPaid: major(st.rail === "paypal" ? st.grossMinor + st.feeMinor : st.grossMinor),
      recipientReceived: st.receivedMinor != null ? major(st.receivedMinor) : null,
      recipientCurrency: st.receivedCurrency,
      fxRate: st.fxRate,
      rail: st.rail,
      externalTransactionId: st.externalId ?? "",
      explorerUrl: st.explorerUrl,
      accountCode: v.defaultAccountCode ? v.defaultAccountCode : accountCodeFor(v.role),
      departure: departureCodeFor(db, ob.businessId, [ob.rawInput, ob.sourceRef, ob.description]),
      taxType: process.env.XERO_TAX_TYPE || "Tax Exempt",
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
  "withheldAmount",
  "netPaid",
  "recipientReceived",
  "recipientCurrency",
  "fxRate",
  "rail",
  "externalTransactionId",
  "explorerUrl",
  "accountCode",
  "dueDate",
  "departure",
  "taxType",
  "obligationId",
];

/** One CSV cell: quoted when needed, and never a live spreadsheet formula. */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Vendor-written text must not run as a spreadsheet formula. Numbers like -12.50 stay numbers.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  // A line break inside a field can start a new row in some importers: neutralise a formula after any break,
  // and quote any field holding CR or LF.
  s = s.replace(/(\r\n|\r|\n)([=+\-@\t])/g, "$1'$2");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: AccountingPayload[]): string {
  const esc = csvCell;
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => esc(r[c])).join(","));
  return lines.join("\n") + "\n";
}

/** Every accounting record as CSV, changing nothing. Safe for a plain link or a second click. */
export function allRecordsCsv(db: Db): { csv: string; count: number } {
  const rows = db.select().from(accountingSyncs).all().map((p) => JSON.parse(p.payloadJson ?? "{}") as AccountingPayload);
  return { csv: toCsv(rows), count: rows.length };
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

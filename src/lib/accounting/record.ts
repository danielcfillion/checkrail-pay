import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { obligations, settlements, vendors, accountingSyncs, bills, xeroRecords } from "../db/schema";
import { localDateString } from "../format";
import { departureCodeFor } from "../engine/rates";
import { config } from "../config";
import { senderOutlayMinor } from "../domain/routing";
import type { Rail } from "../domain/types";
import { accountCodeFor, accountLabel, describeBill, majorText } from "./billLine";

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
  /** What left the bank account, in the gross currency, on every rail: gross + fee, except Stellar where the fee is inside the gross. */
  netPaid: string;
  recipientReceived: string | null;
  recipientCurrency: string | null;
  fxRate: string | null;
  rail: string;
  externalTransactionId: string;
  explorerUrl: string | null;
  /** The account the bill is posted to: the same code the Xero bills file carries (a prepayment for an advance), with its usual name. */
  accountCode: string;
  /** Departure code, for a Xero tracking category ("Departure") so cost per trip can be reported. */
  departure?: string | null;
  /** Xero tax type for the bill line (XERO_TAX_TYPE, default "Tax Exempt"); tax profiles refine it. */
  taxType?: string;
  obligationId: string;
  /** Filled at export, not stored: "xero:<payment id>" when the live push already put this payment in Xero, else blank. */
  xeroPayment?: string;
}

export function buildAccountingRecord(db: Db, obligationId: string): { destination: string; payload: AccountingPayload } | null {
  const ob = db.select().from(obligations).where(eq(obligations.id, obligationId)).get();
  const st = db.select().from(settlements).where(eq(settlements.obligationId, obligationId)).get();
  if (!ob || !st || !ob.vendorId) return null;
  const v = db.select().from(vendors).where(eq(vendors.id, ob.vendorId)).get();
  if (!v) return null;
  const bill = ob.billId ? db.select().from(bills).where(eq(bills.id, ob.billId)).get() : null;
  const billDate = bill?.billDate ?? localDateString(new Date(ob.createdAt));
  // The bill is what the Xero file carries: its reference is the invoice number, its description and account are the bill's.
  const reference = bill?.reference ?? ob.sourceRef ?? ob.id;
  const departure = departureCodeFor(db, ob.businessId, [ob.rawInput, ob.sourceRef, ob.description]);
  const cur = st.grossCurrency;
  const major = (minor: number) => majorText(minor, cur);
  return {
    destination: config.accounting.destination,
    payload: {
      reference,
      vendorName: v.name,
      vendorCountry: v.country,
      description: describeBill(v.role, reference, departure, bill?.kind),
      // The bill date is when the obligation was raised (or the bill's own date), never the due date; dates are local.
      billDate: billDate,
      dueDate: ob.dueDate ?? bill?.dueDate ?? billDate,
      paymentDate: localDateString(new Date(st.settledAt)),
      // The bill is the full amount owed; the vendor was sent that less any tax withheld.
      grossAmount: major(ob.amountMinor ?? st.grossMinor),
      withheldAmount: major(ob.withheldMinor ?? 0),
      grossCurrency: cur,
      feeAmount: major(st.feeMinor),
      feeCurrency: cur,
      // Cash out of the bank account, whichever rail: PayPal, Wise and the bank file charge their fee on top; the Stellar anchor path takes its fee out of the amount.
      netPaid: major(senderOutlayMinor({ rail: st.rail as Rail, sendAmountMinor: st.grossMinor, feeMinor: st.feeMinor })),
      recipientReceived: st.receivedMinor != null ? majorText(st.receivedMinor, st.receivedCurrency ?? cur) : null,
      recipientCurrency: st.receivedCurrency,
      fxRate: st.fxRate,
      rail: st.rail,
      externalTransactionId: st.externalId ?? "",
      explorerUrl: st.explorerUrl,
      accountCode: accountLabel(accountCodeFor(v.role, v.defaultAccountCode, bill?.kind)),
      departure,
      taxType: process.env.XERO_TAX_TYPE || "Tax Exempt",
      obligationId: ob.id,
    },
  };
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
  "xeroPayment",
];

/** Which settlement rows Xero already has (sent by the live push), so the bookkeeper does not enter them again. */
function withXeroPayment(db: Db, rows: Array<{ id: string; payload: AccountingPayload }>): AccountingPayload[] {
  const sent = new Map(
    db
      .select({ sync: xeroRecords.accountingSyncId, id: xeroRecords.xeroId })
      .from(xeroRecords)
      .where(and(eq(xeroRecords.kind, "payment"), eq(xeroRecords.status, "pushed")))
      .all()
      .filter((r) => r.sync && r.id)
      .map((r) => [r.sync!, `xero:${r.id}`]),
  );
  return rows.map((r) => ({ ...r.payload, xeroPayment: sent.get(r.id) ?? "" }));
}

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
  const rows = withXeroPayment(db, db.select().from(accountingSyncs).all().map((p) => ({ id: p.id, payload: JSON.parse(p.payloadJson ?? "{}") as AccountingPayload })));
  return { csv: toCsv(rows), count: rows.length };
}

/** Mark every pending CSV sync as exported and return the file contents. */
export function exportPendingCsv(db: Db): { csv: string; count: number } {
  const pending = db.select().from(accountingSyncs).where(eq(accountingSyncs.status, "pending")).all();
  const rows = withXeroPayment(db, pending.map((p) => ({ id: p.id, payload: JSON.parse(p.payloadJson ?? "{}") as AccountingPayload })));
  const ts = new Date().toISOString();
  for (const p of pending) {
    db.update(accountingSyncs).set({ status: "exported", externalRef: `csv:${localDateString(new Date(ts))}`, updatedAt: ts }).where(eq(accountingSyncs.id, p.id)).run();
  }
  return { csv: toCsv(rows), count: rows.length };
}

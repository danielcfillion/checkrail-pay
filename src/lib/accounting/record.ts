import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { obligations, settlements, vendors, accountingSyncs, bills, businesses, paymentAttempts, xeroConnections, xeroRecords } from "../db/schema";
import { billApprovedAt } from "./xeroScope";
import { localDateString } from "../format";
import { departureCodeFor } from "../engine/rates";
import { config } from "../config";
import { senderOutlayMinor } from "../domain/routing";
import type { Rail } from "../domain/types";
import { accountCodeFor, accountName, describeBill, feePaidByOf, majorText } from "./billLine";

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
  /** Who bore the fee: "business" (paid on top, in netPaid) on every rail today; "recipient" only on records from before 3 Nov 2026 where Stellar took it out of the amount. */
  feePaidBy?: "business" | "recipient";
  /** What left the bank account, in the gross currency: gross + fee, on every rail (the business pays the fee). */
  netPaid: string;
  recipientReceived: string | null;
  recipientCurrency: string | null;
  fxRate: string | null;
  rail: string;
  externalTransactionId: string;
  explorerUrl: string | null;
  /** The mode of the attempt that paid it (mock, sandbox, testnet, live), so a simulated Stellar payment can say it is not on chain. */
  railMode?: string;
  /** Where fxRate came from: "demo" for seeded history (a table of demo rates), else the rail or its quote. */
  fxRateSource?: "demo";
  /** The account the bill is posted to: the bare code the Xero bills file carries (a prepayment for an advance). Records from before 3 Nov 2026 hold "code name"; exports split them. */
  accountCode: string;
  /** The account's usual name when it is one of the defaults ("Cost of Goods Sold: Contract labour"), else blank. */
  accountName?: string;
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
  const code = accountCodeFor(v.role, v.defaultAccountCode, bill?.kind);
  const attemptMode = db.select({ mode: paymentAttempts.mode }).from(paymentAttempts).where(eq(paymentAttempts.id, st.attemptId)).get()?.mode ?? null;
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
      // Cash out of the bank account, whichever rail: the amount sent plus the fee, which the business pays on top.
      netPaid: major(senderOutlayMinor({ rail: st.rail as Rail, sendAmountMinor: st.grossMinor, feeMinor: st.feeMinor })),
      recipientReceived: st.receivedMinor != null ? majorText(st.receivedMinor, st.receivedCurrency ?? cur) : null,
      recipientCurrency: st.receivedCurrency,
      fxRate: st.fxRate,
      rail: st.rail,
      externalTransactionId: st.externalId ?? "",
      explorerUrl: st.explorerUrl,
      railMode: attemptMode ?? undefined,
      feePaidBy: "business",
      accountCode: code,
      accountName: accountName(code),
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
  "feePaidBy",
  "withheldAmount",
  "netPaid",
  "recipientReceived",
  "recipientCurrency",
  "fxRate",
  "rail",
  "externalTransactionId",
  "explorerUrl",
  "accountCode",
  "accountName",
  "dueDate",
  "departure",
  "taxType",
  "obligationId",
  "xeroPayment",
];

/**
 * Which settlement rows the live Xero push covers, so the bookkeeper never enters one by hand:
 *  - "xero:<payment id>": in Xero, complete (payment, withheld part and fee all sent);
 *  - "xero:sending": the live push owns it and will send it (waiting, or retrying after a failure);
 *  - blank: not the live push's (its bill is in the files, or Xero is not connected): enter it as usual.
 */
function withXeroPayment(db: Db, rows: Array<{ id: string; payload: AccountingPayload; createdAt: string }>): AccountingPayload[] {
  const bizId = db.select({ id: businesses.id }).from(businesses).limit(1).get()?.id ?? "";
  const conn = db.select().from(xeroConnections).where(eq(xeroConnections.businessId, bizId)).get();
  const live = conn && conn.status !== "disconnected" && config.accounting.destination === "xero";
  const mine = (kind: string) =>
    conn
      ? db
          .select({ sync: xeroRecords.accountingSyncId, id: xeroRecords.xeroId, status: xeroRecords.status })
          .from(xeroRecords)
          .where(and(eq(xeroRecords.businessId, conn.businessId), eq(xeroRecords.tenantId, conn.tenantId), eq(xeroRecords.kind, kind)))
          .all()
      : [];
  const finished = new Map(mine("settlement").map((r) => [r.sync!, r.status]));
  const payments = mine("payment");
  const paymentId = new Map(payments.filter((r) => r.status === "pushed").map((r) => [r.sync!, r.id]));
  const sentPayments = [...payments, ...mine("withholding")];
  const obIds = rows.map((r) => r.payload.obligationId).filter(Boolean);
  const returned = new Set(obIds.length ? db.select({ id: obligations.id }).from(obligations).where(and(inArray(obligations.id, obIds), eq(obligations.state, "refunded"))).all().map((o) => o.id) : []);
  const owned = live && conn ? new Map([...billApprovedAt(db, rows.map((r) => r.payload.obligationId).filter(Boolean)).entries()]) : new Map<string, string>();
  return rows.map((r) => {
    const done = finished.get(r.id);
    let mark = "";
    const ownedLive = Boolean(live && conn && r.createdAt >= conn.syncFrom && (owned.get(r.payload.obligationId) ?? "") >= conn.syncFrom);
    if (returned.has(r.payload.obligationId)) {
      const mineSent = sentPayments.filter((x) => x.sync === r.id && x.id);
      // Still in Xero (Xero would not delete it): its id, and the card asks a person to reverse it.
      const stuck = mineSent.find((x) => x.status !== "reversed" && x.status !== "skipped");
      if (stuck) mark = `xero:${stuck.id}`;
      // Everything the push sent was removed, or nothing was sent: nothing to enter.
      else if (mineSent.length || (ownedLive && done !== undefined)) mark = "xero:returned";
      // Its bill is in the files: the payment there is reversed by hand.
      else if (!ownedLive) mark = "returned:reverse-by-hand";
      else mark = "xero:sending";
      return { ...r.payload, xeroPayment: mark };
    }
    if (done === "pushed") mark = paymentId.has(r.id) ? `xero:${paymentId.get(r.id)}` : "xero:returned";
    else if (done === undefined && live && conn && r.createdAt >= conn.syncFrom && (owned.get(r.payload.obligationId) ?? "") >= conn.syncFrom) mark = "xero:sending";
    return { ...r.payload, xeroPayment: mark };
  });
}

/** What the explorer column says for a payment with no explorer link: a simulated Stellar payment was never on chain. */
export const SIMULATED_EXPLORER = "simulated, not on chain";

/**
 * A stored record as the files show it, whatever its age: the account split into a bare code and its name (older
 * records held "310 Cost of Goods Sold: Contract labour" in accountCode), who paid the fee (older Stellar records:
 * the recipient, since the fee then came out of the amount), and the explorer column filled for a simulated Stellar
 * payment.
 */
export function forExport(p: AccountingPayload): AccountingPayload {
  const label = String(p.accountCode ?? "").trim();
  const [first, ...rest] = label.split(/\s+/);
  const code = /^\d+$/.test(first ?? "") ? first : label;
  const name = p.accountName || (code === label ? "" : rest.join(" ")) || accountName(code);
  const feePaidBy = feePaidByOf(p);
  const simulated = p.rail === "stellar" && !p.explorerUrl && (p.railMode === undefined || p.railMode === "mock");
  return { ...p, accountCode: code, accountName: name, feePaidBy, explorerUrl: p.explorerUrl || (simulated ? SIMULATED_EXPLORER : null) };
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
  for (const r of rows.map(forExport)) lines.push(CSV_COLUMNS.map((c) => esc(r[c])).join(","));
  return lines.join("\n") + "\n";
}

/** Every accounting record as CSV, changing nothing. Safe for a plain link or a second click. */
export function allRecordsCsv(db: Db): { csv: string; count: number } {
  const rows = allRecords(db);
  return { csv: toCsv(rows), count: rows.length };
}

/** Every accounting record as the files show it (see forExport), with its Xero status. Changes nothing. */
export function allRecords(db: Db): AccountingPayload[] {
  return withXeroPayment(db, db.select().from(accountingSyncs).all().map((p) => ({ id: p.id, createdAt: p.createdAt, payload: JSON.parse(p.payloadJson ?? "{}") as AccountingPayload }))).map(forExport);
}

/** Mark every pending CSV sync as exported and return the file contents. */
export function exportPendingCsv(db: Db): { csv: string; count: number } {
  const pending = db.select().from(accountingSyncs).where(eq(accountingSyncs.status, "pending")).all();
  const rows = withXeroPayment(db, pending.map((p) => ({ id: p.id, createdAt: p.createdAt, payload: JSON.parse(p.payloadJson ?? "{}") as AccountingPayload })));
  const ts = new Date().toISOString();
  for (const p of pending) {
    db.update(accountingSyncs).set({ status: "exported", externalRef: `csv:${localDateString(new Date(ts))}`, updatedAt: ts }).where(eq(accountingSyncs.id, p.id)).run();
  }
  return { csv: toCsv(rows), count: rows.length };
}

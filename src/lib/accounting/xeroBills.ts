import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { bills, businesses, obligations, vendors } from "../db/schema";
import { csvCell } from "./record";
import { accountCodeFor, advancesAccount, describeBill, majorText } from "./billLine";
import { localDateString } from "../format";
import { departureCodeFor } from "../engine/rates";
import { audit } from "../domain/stateMachine";
import { now } from "../domain/ids";
import { DEFAULT_POLICY, type ApprovalPolicy } from "../domain/types";
import { withholdingFor } from "../engine/taxes";

/**
 * Bills for Xero at approval, not at payment: the liability belongs in the books the day the business agrees it
 * owes it, so aged payables and cash forecasts are right while payments are still waiting. The file follows Xero's
 * "Import bills" template (Business, Bills to pay, Import); payments are then matched from the bank feed or the
 * settlement export.
 *
 * One bill per invoice: an obligation paid in one go is one bill; a deposit and balance against an invoice are one
 * bill (the invoice total), not two.
 */

export const XERO_BILL_COLUMNS = ["*ContactName", "EmailAddress", "POCountry", "*InvoiceNumber", "*InvoiceDate", "*DueDate", "Description", "*Quantity", "*UnitAmount", "*AccountCode", "*TaxType", "TrackingName1", "TrackingOption1", "Currency"] as const;

/** Approved means the business has agreed it owes this. Waiting or blocked requests are not bills yet. */
const AGREED = ["approved", "execution_pending", "sent", "settled"];

type Row = Record<(typeof XERO_BILL_COLUMNS)[number], string | number | null>;

/** The rows of one invoice in the file, and what they came from: the live Xero push sends each group as one bill. */
export interface XeroBillGroup {
  kind: "bill" | "credit_note";
  billId: string | null;
  obligationIds: string[];
  rows: Row[];
}

const major = majorText;

export function xeroBillRows(db: Db, businessId: string, opts: { onlyNew: boolean }): { rows: Row[]; obligationIds: string[]; billIds: string[]; groups: XeroBillGroup[] } {
  const tracking = process.env.XERO_TRACKING_NAME || "Departure";
  const taxType = process.env.XERO_TAX_TYPE || "Tax Exempt";
  // Tax kept back is owed to the tax office, not the vendor: a negative line on the bill to a liability account.
  const withholdingAccount = process.env.XERO_WITHHOLDING_ACCOUNT || "825";
  const obs = db
    .select({ o: obligations, v: vendors })
    .from(obligations)
    .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(and(eq(obligations.businessId, businessId), inArray(obligations.state, AGREED), opts.onlyNew ? isNull(obligations.xeroBillExportedAt) : undefined))
    .all();
  // Xero refuses (or misplaces) a bill dated in a closed month. A late invoice keeps its own date in the description
  // and is posted on the first open day.
  const biz = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  const lock = biz?.lockedThrough ?? null;
  const policy = (): ApprovalPolicy => ({ ...DEFAULT_POLICY, ...(JSON.parse(biz?.policyJson ?? "{}") as Partial<ApprovalPolicy>) });
  const posting = (d: string) => (lock && d <= lock ? new Date(Date.parse(`${lock}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : d);
  const late = (d: string) => (lock && d <= lock ? ` (invoice dated ${d})` : "");
  const rows: Row[] = [];
  const obligationIds: string[] = [];
  const billIds = new Set<string>();
  const groups = new Map<string, XeroBillGroup>();
  for (const { o, v } of obs) {
    if (!o.amountMinor || !o.currency) continue;
    obligationIds.push(o.id);
    const departure = departureCodeFor(db, businessId, [o.rawInput, o.sourceRef, o.description]);
    const withholdingLine = (invoiceNumber: string, date: string, due: string, withheld: number, currency: string, note: string | null) =>
      withheld > 0 ? { ...base, "*InvoiceNumber": invoiceNumber, "*InvoiceDate": date, "*DueDate": due, Description: `Tax withheld${note ? `: ${note.split(":")[0]}` : ""}`, "*UnitAmount": `-${major(withheld, currency)}`, "*AccountCode": withholdingAccount, Currency: currency } : null;
    const base = { "*ContactName": v.name, EmailAddress: v.email, POCountry: v.country, "*Quantity": 1, "*AccountCode": accountCodeFor(v.role, v.defaultAccountCode), "*TaxType": taxType, TrackingName1: departure ? tracking : null, TrackingOption1: departure, Currency: o.currency };
    if (o.billId) {
      // The invoice once, at its total, the first time any part of it is agreed.
      if (billIds.has(o.billId)) {
        groups.get(o.billId)?.obligationIds.push(o.id);
        continue;
      }
      const b = db.select().from(bills).where(eq(bills.id, o.billId)).get();
      if (!b || b.kind === "credit_note" || (opts.onlyNew && b.xeroExportedAt)) continue;
      billIds.add(b.id);
      const docDate = b.billDate ?? o.invoiceDate ?? localDateString(new Date(b.createdAt));
      const date = posting(docDate);
      const due = [b.dueDate ?? o.dueDate ?? date, date].sort()[1];
      const main: Row = { ...base, "*InvoiceNumber": b.reference, "*InvoiceDate": date, "*DueDate": due, Description: describeBill(v.role, b.reference, departure, b.kind) + late(docDate), "*UnitAmount": major(b.totalMinor, b.currency), "*AccountCode": accountCodeFor(v.role, v.defaultAccountCode, b.kind), Currency: b.currency };
      rows.push(main);
      // Tax kept back on every part of this invoice (a deposit and its balance each withhold), not only the part that
      // happened to be agreed first. A cancelled part was never paid, so nothing was kept back from it.
      // The bill goes once, often while only the deposit exists, so the tax on parts not yet raised is worked out from
      // the invoice total with the vendor's own rule. When every part exists, their own withholding is used as it is.
      const parts = db.select({ amount: obligations.amountMinor, withheld: obligations.withheldMinor, note: obligations.withholdingNote, state: obligations.state }).from(obligations).where(eq(obligations.billId, b.id)).all().filter((p) => p.state !== "cancelled");
      const withheldParts = parts.reduce((sum, p) => sum + (p.withheld ?? 0), 0);
      const covered = parts.reduce((sum, p) => sum + (p.amount ?? 0), 0) >= b.totalMinor;
      const rule = withheldParts > 0 && !covered ? withholdingFor(policy(), biz?.country ?? "US", v, b.totalMinor, b.currency) : null;
      const withheldAll = rule ? rule.withheldMinor : withheldParts;
      const w = withholdingLine(b.reference, date, due, withheldAll, b.currency, o.withholdingNote ?? parts.find((p) => p.note)?.note ?? null);
      if (w) rows.push(w);
      groups.set(b.id, { kind: "bill", billId: b.id, obligationIds: [o.id], rows: w ? [main, w] : [main] });
      continue;
    }
    const docDate = o.invoiceDate ?? localDateString(new Date(o.createdAt));
    const date = posting(docDate);
    const due = [o.dueDate ?? date, date].sort()[1];
    const ref = o.sourceRef ?? o.id;
    const main: Row = { ...base, "*InvoiceNumber": ref, "*InvoiceDate": date, "*DueDate": due, Description: describeBill(v.role, ref, departure) + late(docDate), "*UnitAmount": major(o.amountMinor, o.currency) };
    rows.push(main);
    const w = withholdingLine(ref, date, due, o.withheldMinor ?? 0, o.currency, o.withholdingNote);
    if (w) rows.push(w);
    groups.set(`ob:${o.id}`, { kind: "bill", billId: null, obligationIds: [o.id], rows: w ? [main, w] : [main] });
  }
  // Credit notes: Xero imports a negative total as a credit note against the supplier; it is then allocated to the bill.
  const credits = db
    .select({ b: bills, v: vendors })
    .from(bills)
    .innerJoin(vendors, eq(vendors.id, bills.vendorId))
    .where(and(eq(bills.businessId, businessId), eq(bills.kind, "credit_note"), opts.onlyNew ? isNull(bills.xeroExportedAt) : undefined))
    .all()
    .filter(({ b }) => b.status !== "void");
  for (const { b, v } of credits) {
    billIds.add(b.id);
    const date = posting(b.billDate ?? localDateString(new Date(b.createdAt)));
    const row: Row = { "*ContactName": v.name, EmailAddress: v.email, POCountry: v.country, "*InvoiceNumber": b.reference, "*InvoiceDate": date, "*DueDate": b.dueDate ?? date, Description: `${describeBill(v.role, b.reference, null, "credit_note")}${b.note ? `: ${b.note.slice(0, 120)}` : ""}`, "*Quantity": 1, "*UnitAmount": `-${major(b.totalMinor, b.currency)}`, "*AccountCode": b.note?.startsWith("Settlement of advance") ? advancesAccount() : accountCodeFor(v.role, v.defaultAccountCode), "*TaxType": taxType, TrackingName1: null, TrackingOption1: null, Currency: b.currency };
    rows.push(row);
    groups.set(b.id, { kind: "credit_note", billId: b.id, obligationIds: [], rows: [row] });
  }
  return { rows, obligationIds, billIds: [...billIds], groups: [...groups.values()] };
}

export function xeroBillsCsv(rows: Row[]): string {
  return [XERO_BILL_COLUMNS.join(","), ...rows.map((r) => XERO_BILL_COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

/** Bills agreed since the last export, marked so the next file holds only new ones. */
export function exportNewXeroBills(db: Db, businessId: string, actor: string): { csv: string; count: number } {
  const { rows, obligationIds, billIds } = xeroBillRows(db, businessId, { onlyNew: true });
  const ts = now();
  if (obligationIds.length) db.update(obligations).set({ xeroBillExportedAt: ts }).where(inArray(obligations.id, obligationIds)).run();
  if (billIds.length) db.update(bills).set({ xeroExportedAt: ts }).where(inArray(bills.id, billIds)).run();
  audit(db, { obligationId: null, actor, action: "accounting.xero_bills_exported", detail: { bills: rows.length } });
  return { csv: xeroBillsCsv(rows), count: rows.length };
}

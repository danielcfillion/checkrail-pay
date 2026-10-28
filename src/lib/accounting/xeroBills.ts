import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { bills, businesses, obligations, vendors } from "../db/schema";
import { csvCell } from "./record";
import { localDateString } from "../format";
import { departureCodeFor } from "../engine/rates";
import { audit } from "../domain/stateMachine";
import { now } from "../domain/ids";

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

/** A short, clean line for the accountant: what it was, for which departure. Never the raw chat text. */
function describe(role: string, reference: string, departure: string | null, kind?: string): string {
  const what = kind === "advance" ? "Cash advance" : kind === "credit_note" ? "Credit note" : `${ROLE_WORD[role] ?? "Supplier"} services`;
  return `${what} ${reference}${departure ? `, departure ${departure}` : ""}`;
}
const ROLE_WORD: Record<string, string> = { guide: "Guiding", driver: "Transport", homestay: "Accommodation", hotel: "Accommodation", creator: "Content", restaurant: "Meals" };

function accountFor(role: string, override: string | null): string {
  if (override) return override;
  return role === "homestay" || role === "hotel" ? "320" : role === "creator" ? "400" : role === "guide" || role === "driver" ? "310" : "429";
}

const major = (minor: number, currency: string) => (currency === "VND" ? String(Math.round(minor / 100)) : (minor / 100).toFixed(2));

export function xeroBillRows(db: Db, businessId: string, opts: { onlyNew: boolean }): { rows: Row[]; obligationIds: string[]; billIds: string[] } {
  const tracking = process.env.XERO_TRACKING_NAME || "Departure";
  const taxType = process.env.XERO_TAX_TYPE || "Tax Exempt";
  // Tax kept back is owed to the tax office, not the vendor: a negative line on the bill to a liability account.
  const withholdingAccount = process.env.XERO_WITHHOLDING_ACCOUNT || "825";
  // An advance is money the guide holds until receipts come in: a prepayment, not an expense.
  const advancesAccount = process.env.XERO_ADVANCES_ACCOUNT || "620";
  const obs = db
    .select({ o: obligations, v: vendors })
    .from(obligations)
    .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(and(eq(obligations.businessId, businessId), inArray(obligations.state, AGREED), opts.onlyNew ? isNull(obligations.xeroBillExportedAt) : undefined))
    .all();
  // Xero refuses (or misplaces) a bill dated in a closed month. A late invoice keeps its own date in the description
  // and is posted on the first open day.
  const lock = db.select({ l: businesses.lockedThrough }).from(businesses).where(eq(businesses.id, businessId)).get()?.l ?? null;
  const posting = (d: string) => (lock && d <= lock ? new Date(Date.parse(`${lock}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : d);
  const late = (d: string) => (lock && d <= lock ? ` (invoice dated ${d})` : "");
  const rows: Row[] = [];
  const obligationIds: string[] = [];
  const billIds = new Set<string>();
  for (const { o, v } of obs) {
    if (!o.amountMinor || !o.currency) continue;
    obligationIds.push(o.id);
    const departure = departureCodeFor(db, businessId, [o.rawInput, o.sourceRef, o.description]);
    const withholdingLine = (invoiceNumber: string, date: string, due: string, withheld: number, currency: string, note: string | null) =>
      withheld > 0 ? { ...base, "*InvoiceNumber": invoiceNumber, "*InvoiceDate": date, "*DueDate": due, Description: `Tax withheld${note ? `: ${note.split(":")[0]}` : ""}`, "*UnitAmount": `-${major(withheld, currency)}`, "*AccountCode": withholdingAccount, Currency: currency } : null;
    const base = { "*ContactName": v.name, EmailAddress: v.email, POCountry: v.country, "*Quantity": 1, "*AccountCode": accountFor(v.role, v.defaultAccountCode), "*TaxType": taxType, TrackingName1: departure ? tracking : null, TrackingOption1: departure, Currency: o.currency };
    if (o.billId) {
      // The invoice once, at its total, the first time any part of it is agreed.
      if (billIds.has(o.billId)) continue;
      const b = db.select().from(bills).where(eq(bills.id, o.billId)).get();
      if (!b || b.kind === "credit_note" || (opts.onlyNew && b.xeroExportedAt)) continue;
      billIds.add(b.id);
      const docDate = b.billDate ?? o.invoiceDate ?? localDateString(new Date(b.createdAt));
      const date = posting(docDate);
      const due = [b.dueDate ?? o.dueDate ?? date, date].sort()[1];
      rows.push({ ...base, "*InvoiceNumber": b.reference, "*InvoiceDate": date, "*DueDate": due, Description: describe(v.role, b.reference, departure, b.kind) + late(docDate), "*UnitAmount": major(b.totalMinor, b.currency), "*AccountCode": b.kind === "advance" ? advancesAccount : base["*AccountCode"], Currency: b.currency });
      const w = withholdingLine(b.reference, date, due, o.withheldMinor ?? 0, b.currency, o.withholdingNote);
      if (w) rows.push(w);
      continue;
    }
    const docDate = o.invoiceDate ?? localDateString(new Date(o.createdAt));
    const date = posting(docDate);
    const due = [o.dueDate ?? date, date].sort()[1];
    const ref = o.sourceRef ?? o.id;
    rows.push({ ...base, "*InvoiceNumber": ref, "*InvoiceDate": date, "*DueDate": due, Description: describe(v.role, ref, departure) + late(docDate), "*UnitAmount": major(o.amountMinor, o.currency) });
    const w = withholdingLine(ref, date, due, o.withheldMinor ?? 0, o.currency, o.withholdingNote);
    if (w) rows.push(w);
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
    rows.push({ "*ContactName": v.name, EmailAddress: v.email, POCountry: v.country, "*InvoiceNumber": b.reference, "*InvoiceDate": date, "*DueDate": b.dueDate ?? date, Description: `${describe(v.role, b.reference, null, "credit_note")}${b.note ? `: ${b.note.slice(0, 120)}` : ""}`, "*Quantity": 1, "*UnitAmount": `-${major(b.totalMinor, b.currency)}`, "*AccountCode": b.note?.startsWith("Settlement of advance") ? advancesAccount : accountFor(v.role, v.defaultAccountCode), "*TaxType": taxType, TrackingName1: null, TrackingOption1: null, Currency: b.currency });
  }
  return { rows, obligationIds, billIds: [...billIds] };
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

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { bills, obligations, vendors } from "../db/schema";
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

function accountFor(role: string, override: string | null): string {
  if (override) return override;
  return role === "homestay" || role === "hotel" ? "320" : role === "creator" ? "400" : role === "guide" || role === "driver" ? "310" : "429";
}

const major = (minor: number, currency: string) => (currency === "VND" ? String(Math.round(minor / 100)) : (minor / 100).toFixed(2));

export function xeroBillRows(db: Db, businessId: string, opts: { onlyNew: boolean }): { rows: Row[]; obligationIds: string[]; billIds: string[] } {
  const tracking = process.env.XERO_TRACKING_NAME || "Departure";
  const taxType = process.env.XERO_TAX_TYPE || "Tax Exempt";
  const obs = db
    .select({ o: obligations, v: vendors })
    .from(obligations)
    .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(and(eq(obligations.businessId, businessId), inArray(obligations.state, AGREED), opts.onlyNew ? isNull(obligations.xeroBillExportedAt) : undefined))
    .all();
  const rows: Row[] = [];
  const obligationIds: string[] = [];
  const billIds = new Set<string>();
  for (const { o, v } of obs) {
    if (!o.amountMinor || !o.currency) continue;
    obligationIds.push(o.id);
    const departure = departureCodeFor(db, businessId, [o.rawInput, o.sourceRef, o.description]);
    const base = { "*ContactName": v.name, EmailAddress: v.email, POCountry: v.country, "*Quantity": 1, "*AccountCode": accountFor(v.role, v.defaultAccountCode), "*TaxType": taxType, TrackingName1: departure ? tracking : null, TrackingOption1: departure, Currency: o.currency };
    if (o.billId) {
      // The invoice once, at its total, the first time any part of it is agreed.
      if (billIds.has(o.billId)) continue;
      const b = db.select().from(bills).where(eq(bills.id, o.billId)).get();
      if (!b || b.kind === "credit_note" || (opts.onlyNew && b.xeroExportedAt)) continue;
      billIds.add(b.id);
      const date = b.billDate ?? localDateString(new Date(b.createdAt));
      rows.push({ ...base, "*InvoiceNumber": b.reference, "*InvoiceDate": date, "*DueDate": b.dueDate ?? o.dueDate ?? date, Description: b.kind === "advance" ? `Cash advance ${b.reference}${b.note ? `: ${b.note}` : ""}` : o.description || b.reference, "*UnitAmount": major(b.totalMinor, b.currency), Currency: b.currency });
      continue;
    }
    const date = localDateString(new Date(o.createdAt));
    rows.push({ ...base, "*InvoiceNumber": o.sourceRef ?? o.id, "*InvoiceDate": date, "*DueDate": o.dueDate ?? date, Description: o.description || o.sourceRef || "", "*UnitAmount": major(o.amountMinor, o.currency) });
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

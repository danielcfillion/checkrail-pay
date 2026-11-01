import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { bills, businesses, obligations, vendors } from "../db/schema";
import { csvCell } from "./record";
import { accountCodeFor, advancesAccount, describeBill, majorText } from "./billLine";
import { localDateString } from "../format";
import { departureCodeFor } from "../engine/rates";
import { audit } from "../domain/stateMachine";
import { now } from "../domain/ids";
import { config } from "../config";
import { getXeroConnection } from "./xeroAuth";
import { splitGroups } from "./xeroScope";

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
  /** What the bill came from, stable when its number changes: "bill:<id>" or "ob:<obligation id>". */
  source: string;
  kind: "bill" | "credit_note";
  billId: string | null;
  obligationIds: string[];
  rows: Row[];
}

const major = majorText;

/**
 * Bills are at the invoice's gross amount. Tax kept back for the tax office is not on the bill: it is what clears the
 * rest of the bill when each part is paid (a second payment from the withholding liability account, which the live
 * push sends and the settlement CSV's withheldAmount carries for a file import). A prediction on the bill could not
 * match what each part really withheld (rounding, a W-9 filed between deposit and balance, per-payment thresholds).
 *
 * With Xero connected and the destination xero, bills the live push owns (approved after the connection) are left out
 * of the file, so a bill is never both imported and sent. `includeLive` is for the live push itself.
 */
export function xeroBillRows(db: Db, businessId: string, opts: { onlyNew: boolean; includeLive?: boolean }): { rows: Row[]; obligationIds: string[]; billIds: string[]; groups: XeroBillGroup[] } {
  const tracking = process.env.XERO_TRACKING_NAME || "Departure";
  const taxType = process.env.XERO_TAX_TYPE || "Tax Exempt";
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
      groups.set(b.id, { source: `bill:${b.id}`, kind: "bill", billId: b.id, obligationIds: [o.id], rows: [main] });
      continue;
    }
    const docDate = o.invoiceDate ?? localDateString(new Date(o.createdAt));
    const date = posting(docDate);
    const due = [o.dueDate ?? date, date].sort()[1];
    const ref = o.sourceRef ?? o.id;
    const main: Row = { ...base, "*InvoiceNumber": ref, "*InvoiceDate": date, "*DueDate": due, Description: describeBill(v.role, ref, departure) + late(docDate), "*UnitAmount": major(o.amountMinor, o.currency) };
    rows.push(main);
    groups.set(`ob:${o.id}`, { source: `ob:${o.id}`, kind: "bill", billId: null, obligationIds: [o.id], rows: [main] });
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
    groups.set(b.id, { source: `bill:${b.id}`, kind: "credit_note", billId: b.id, obligationIds: [], rows: [row] });
  }
  const all = [...groups.values()];
  const conn = opts.includeLive || config.accounting.destination !== "xero" ? null : getXeroConnection(db, businessId);
  if (!conn) return { rows, obligationIds, billIds: [...billIds], groups: all };
  const { live, earlier } = splitGroups(db, all, conn.syncFrom);
  const liveRows = new Set(live.flatMap((g) => g.rows));
  const liveObligations = new Set(live.flatMap((g) => g.obligationIds));
  const liveBills = new Set(live.map((g) => g.billId).filter(Boolean));
  return { rows: rows.filter((r) => !liveRows.has(r)), obligationIds: obligationIds.filter((id) => !liveObligations.has(id)), billIds: [...billIds].filter((id) => !liveBills.has(id)), groups: earlier };
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

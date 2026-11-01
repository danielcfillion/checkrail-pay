import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { auditEntries, bills, obligations } from "../db/schema";
import type { XeroBillGroup } from "./xeroBills";

/**
 * Which records belong to the live Xero push. Only what was approved after Xero was connected (the connection's
 * syncFrom): a bill approved, or a payment settled, before that is already in the books by the files, or will be, and
 * sending it now would put a paid bill into Xero as unpaid with no payment against it.
 */

/** When each obligation was first approved (every agreed state passes through approved). Without that history, when it was created. */
export function approvedAt(db: Db, obligationIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!obligationIds.length) return out;
  for (let i = 0; i < obligationIds.length; i += 500) {
    const ids = obligationIds.slice(i, i + 500);
    const rows = db
      .select({ id: auditEntries.obligationId, at: auditEntries.createdAt })
      .from(auditEntries)
      .where(and(inArray(auditEntries.obligationId, ids), eq(auditEntries.toState, "approved")))
      .all();
    for (const r of rows) if (r.id && (!out.has(r.id) || r.at < out.get(r.id)!)) out.set(r.id, r.at);
    for (const o of db.select({ id: obligations.id, at: obligations.createdAt }).from(obligations).where(inArray(obligations.id, ids)).all()) if (!out.has(o.id)) out.set(o.id, o.at);
  }
  return out;
}

/** A bill goes to Xero live when its first part was approved after the connection; a credit note when it was recorded after it. */
export function splitGroups(db: Db, groups: XeroBillGroup[], syncFrom: string): { live: XeroBillGroup[]; earlier: XeroBillGroup[] } {
  const when = approvedAt(db, groups.flatMap((g) => g.obligationIds));
  const live: XeroBillGroup[] = [];
  const earlier: XeroBillGroup[] = [];
  for (const g of groups) {
    let first: string | null = null;
    if (g.kind === "credit_note") first = g.billId ? (db.select({ at: bills.createdAt }).from(bills).where(eq(bills.id, g.billId)).get()?.at ?? null) : null;
    else for (const id of g.obligationIds) {
      const at = when.get(id);
      if (at && (!first || at < first)) first = at;
    }
    (first && first >= syncFrom ? live : earlier).push(g);
  }
  return { live, earlier };
}

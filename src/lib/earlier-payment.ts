import { eq, inArray } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db";
import { obligations, settlements, vendors } from "@/lib/db/schema";

/** The payment request a duplicate block points at, with what a person needs to recognise it. */
export type EarlierPayment = { id: string; vendorName: string | null; sourceRef: string | null; amountMinor: number | null; currency: string | null; state: string; settledAt: string | null };

/** Request ids named in an engine message ("obligation obl_abc123"). */
export function idsInReason(text: string | null | undefined): string[] {
  if (!text) return [];
  return Array.from(new Set([...text.matchAll(/\b(obl_[a-z0-9]+)\b/gi)].map((m) => m[1])));
}

/** Looks up the requests named in these messages, so the page can show vendor and reference instead of an id. */
export function earlierPayments(texts: Array<string | null | undefined>, db: Db = getDb()): Map<string, EarlierPayment> {
  const ids = Array.from(new Set(texts.flatMap(idsInReason)));
  const out = new Map<string, EarlierPayment>();
  if (!ids.length) return out;
  const rows = db
    .select({ id: obligations.id, vendorName: vendors.name, sourceRef: obligations.sourceRef, amountMinor: obligations.amountMinor, currency: obligations.currency, state: obligations.state })
    .from(obligations)
    .leftJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(inArray(obligations.id, ids))
    .all();
  const paid = db.select({ obligationId: settlements.obligationId, settledAt: settlements.settledAt }).from(settlements).where(inArray(settlements.obligationId, ids)).all();
  for (const r of rows) out.set(r.id, { ...r, settledAt: paid.find((p) => p.obligationId === r.id)?.settledAt ?? null });
  return out;
}

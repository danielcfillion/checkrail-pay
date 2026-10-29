import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { obligations } from "../db/schema";
import type { Actor } from "./users";
import { importDepartures } from "./rates";
import { recheckVendorItems } from "./orchestrator";

const WAITING = ["blocked", "needs_evidence", "awaiting_approval"];

/**
 * Import a manifest, then check again what is waiting for the vendors it touched, the way saving a rate does (see
 * setRateAction): a departure that now has a service and a rate sets what the job should cost, so a request typed
 * before the manifest arrived is judged against it now, not only when someone next opens it. Whatever breaks the rate
 * card moves to Blocked with the reason; nothing is approved or paid by this.
 */
export async function importDeparturesAndRecheck(db: Db, businessId: string, by: Actor, csv: string): Promise<ReturnType<typeof importDepartures> & { rechecked: number; nowBlocked: number; /** Waiting requests the re-check moved to ready to pay with no approval, because the rate card now confirms them. */ nowReady: number }> {
  const r = importDepartures(db, businessId, by, csv);
  if (!r.vendorIds.length) return { ...r, rechecked: 0, nowBlocked: 0, nowReady: 0 };
  const waiting = () => db.select({ id: obligations.id, state: obligations.state }).from(obligations).where(and(eq(obligations.businessId, businessId), inArray(obligations.vendorId, r.vendorIds), inArray(obligations.state, WAITING))).all();
  const before = new Map(waiting().map((o) => [o.id, o.state]));
  let rechecked = 0;
  for (const vendorId of r.vendorIds) rechecked += await recheckVendorItems(db, businessId, vendorId, by.id);
  const states = new Map(db.select({ id: obligations.id, state: obligations.state }).from(obligations).where(inArray(obligations.id, [...before.keys()])).all().map((o) => [o.id, o.state]));
  const nowBlocked = [...before].filter(([id, was]) => was !== "blocked" && states.get(id) === "blocked").length;
  const nowReady = [...before].filter(([id, was]) => was !== "approved" && states.get(id) === "approved").length;
  return { ...r, rechecked, nowBlocked, nowReady };
}

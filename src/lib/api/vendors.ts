import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { vendors } from "../db/schema";
import { normaliseName } from "../domain/vendorNames";
import { ApiError } from "./http";

/**
 * Supplier lookup for integrations: id, name, role, country, whether the supplier may be paid (status) and whether
 * their payout details were verified. Never the payout details themselves, contact details or tax ids.
 */
export function searchVendors(db: Db, businessId: string, q: string | null, limit: number) {
  if (q !== null && q.length > 80) throw new ApiError(422, "validation_failed", "q must be at most 80 characters", [{ field: "q", message: "must be at most 80 characters" }]);
  const want = q ? normaliseName(q) : "";
  const raw = q?.trim().toLowerCase() ?? "";
  return db
    .select({ id: vendors.id, name: vendors.name, role: vendors.role, country: vendors.country, status: vendors.status, verifiedAt: vendors.verifiedAt })
    .from(vendors)
    .where(eq(vendors.businessId, businessId))
    .all()
    .filter((v) => !raw || v.name.toLowerCase().includes(raw) || (want !== "" && normaliseName(v.name).includes(want)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((v) => ({ id: v.id, name: v.name, role: v.role, country: v.country, status: v.status, verified: Boolean(v.verifiedAt) }));
}

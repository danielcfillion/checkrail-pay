import { and, count, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db";
import { departures, onboardingImports, onboardingMappings, rateCards, vendors } from "../db/schema";

/**
 * What "Bring in your data" lists beside the bank upload: where each kind of history comes from and how far along it
 * is. Reads only; counts, never names or payout details.
 */
export interface DataSources {
  /** Suppliers paid on PayPal: their history is read from Transaction Search, nothing to upload. */
  paypal: { suppliers: number };
  /** Suppliers on file; unverified ones wait for a second person to confirm their payout details. */
  suppliers: { total: number; verified: number; unverified: number };
  /** Bank exports already re-checked, and export layouts that map themselves next time. */
  bank: { imports: number; savedLayouts: number; latest: { fileName: string; createdAt: string; payments: number } | null };
  rates: { rateCards: number; suppliersWithRates: number; departures: number };
}

export function dataSources(db: Db, businessId: string): DataSources {
  const vs = db.select({ verifiedAt: vendors.verifiedAt, status: vendors.status, paypalEmail: vendors.paypalEmail }).from(vendors).where(eq(vendors.businessId, businessId)).all();
  const active = vs.filter((v) => v.status === "active");
  const verified = active.filter((v) => v.verifiedAt).length;
  const latest = db.select().from(onboardingImports).where(and(eq(onboardingImports.businessId, businessId), eq(onboardingImports.status, "checked"))).orderBy(desc(onboardingImports.createdAt)).limit(1).get();
  const imports = db.select({ n: count() }).from(onboardingImports).where(and(eq(onboardingImports.businessId, businessId), eq(onboardingImports.status, "checked"))).get()?.n ?? 0;
  const layouts = db.select({ n: count() }).from(onboardingMappings).where(eq(onboardingMappings.businessId, businessId)).get()?.n ?? 0;
  const cards = db.select({ vendorId: rateCards.vendorId }).from(rateCards).where(eq(rateCards.businessId, businessId)).all();
  const deps = db.select({ n: count() }).from(departures).where(eq(departures.businessId, businessId)).get()?.n ?? 0;
  const latestPayments = latest?.totalsJson ? ((JSON.parse(latest.totalsJson) as { payments?: number }).payments ?? latest.rowsChecked) : (latest?.rowsChecked ?? 0);
  return {
    paypal: { suppliers: db.select({ n: count() }).from(vendors).where(and(eq(vendors.businessId, businessId), eq(vendors.status, "active"), isNotNull(vendors.paypalEmail))).get()?.n ?? 0 },
    suppliers: { total: active.length, verified, unverified: active.length - verified },
    bank: { imports, savedLayouts: layouts, latest: latest ? { fileName: latest.fileName, createdAt: latest.createdAt, payments: latestPayments } : null },
    rates: { rateCards: cards.length, suppliersWithRates: new Set(cards.map((c) => c.vendorId)).size, departures: deps },
  };
}

import { describe, expect, it } from "vitest";
import { openTestDb } from "../db";
import { departures, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { dataSources } from "./sources";
import { BIZ, addImport, addRateCard, addVendor, setUpBusiness } from "./testkit";

describe("dataSources", () => {
  it("is all zeros for a business with nothing brought in", () => {
    const db = openTestDb();
    setUpBusiness(db);
    expect(dataSources(db, BIZ)).toEqual({
      paypal: { suppliers: 0 },
      suppliers: { total: 0, verified: 0, unverified: 0 },
      bank: { imports: 0, savedLayouts: 0, latest: null },
      rates: { rateCards: 0, suppliersWithRates: 0, departures: 0 },
    });
  });

  it("counts active suppliers, the ones still waiting for a second person, rate cards, departures and imports", () => {
    const db = openTestDb();
    setUpBusiness(db);
    addVendor(db, "ven_a", "Phuong Transport");
    addVendor(db, "ven_b", "Linh Family Homestay", { verified: false });
    addVendor(db, "ven_c", "Old Supplier", { status: "blocked" });
    db.update(vendors).set({ paypalEmail: "a@example.com" }).run();
    addRateCard(db, "ven_a");
    addRateCard(db, "ven_a");
    db.insert(departures).values({ id: "dep_1", businessId: BIZ, code: "HG-4D-0101", startDate: "2026-10-01", endDate: "2026-10-04", guests: 6, source: "csv", createdBy: "user:lan", createdAt: "2026-10-01T00:00:00.000Z" }).run();
    addImport(db, [{ date: "2026-10-01", payee: "Phuong Transport" }, { date: "2026-10-02", payee: "Phuong Transport", cat: "needs_a_look", rules: ["evidence_present"] }], "2026-10-05T00:00:00.000Z");
    addImport(db, [{ date: "2026-10-08", payee: "Phuong Transport" }], "2026-10-12T00:00:00.000Z");
    const s = dataSources(db, BIZ);
    expect(s.paypal.suppliers).toBe(2);
    expect(s.suppliers).toEqual({ total: 2, verified: 1, unverified: 1 });
    expect(s.rates).toEqual({ rateCards: 2, suppliersWithRates: 1, departures: 1 });
    expect(s.bank.imports).toBe(2);
    expect(s.bank.latest).toEqual({ fileName: "test.csv", createdAt: "2026-10-12T00:00:00.000Z", payments: 1 });
  });

  it("reads the demo business: five re-checks and the saved bank layout", async () => {
    const db = openTestDb();
    await seedDemo(db);
    const s = dataSources(db, DEMO_BUSINESS_ID);
    expect(s.bank.imports).toBe(5);
    expect(s.bank.savedLayouts).toBe(1);
    expect(s.suppliers.total).toBeGreaterThan(0);
  });
});

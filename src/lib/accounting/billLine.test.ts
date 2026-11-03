import { describe, it, expect } from "vitest";
import { openTestDb } from "../db";
import { xeroConnections } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { accountCodeFor, accountLabel, accountName } from "./billLine";
import { accountNamesFor, allRecords } from "./record";

describe("default account codes by role, on Xero's standard chart", () => {
  it("puts guides and contract labour on 310, transport, vehicle or motorbike rental and accommodation on 325, never 320", () => {
    expect(accountCodeFor("guide", null)).toBe("310");
    expect(accountCodeFor("contractor", null)).toBe("310");
    expect(accountCodeFor("driver", null)).toBe("325");
    expect(accountCodeFor("homestay", null)).toBe("325");
    expect(accountCodeFor("hotel", null)).toBe("325");
    expect(accountCodeFor("creator", null)).toBe("400");
    expect(accountCodeFor("supplier", null)).toBe("429");
    for (const role of ["guide", "contractor", "driver", "homestay", "hotel", "creator", "supplier"]) expect(accountCodeFor(role, null)).not.toBe("320");
  });
  it("keeps the vendor's own code and the prepayment account for an advance", () => {
    expect(accountCodeFor("driver", "455 Boat charters")).toBe("455");
    expect(accountCodeFor("driver", null, "advance")).toBe("620");
  });
  it("names the defaults as Xero's standard chart does when Xero is not connected", () => {
    expect(accountLabel("310")).toBe("310 Cost of Goods Sold");
    expect(accountName("325")).toBe("Direct Expenses");
    expect(accountName("320")).toBe("");
    expect(accountName("999")).toBe("");
  });

  it("names accounts from the cached Xero chart once Xero is connected, and says when a code is not in it", async () => {
    const db = openTestDb();
    await seedDemo(db);
    expect(accountNamesFor(db, DEMO_BUSINESS_ID)("310")).toBeNull(); // not connected: the defaults apply
    expect(allRecords(db, DEMO_BUSINESS_ID).find((r) => r.reference === "INV-TAM-0834")).toMatchObject({ accountCode: "325", accountName: "Direct Expenses" });
    const ts = new Date().toISOString();
    db.insert(xeroConnections)
      .values({ businessId: DEMO_BUSINESS_ID, tenantId: "t1", accessTokenEnc: "x", refreshTokenEnc: "x", accessExpiresAt: ts, status: "connected", connectedBy: "user:daniel", connectedAt: ts, syncFrom: ts, updatedAt: ts, chartJson: JSON.stringify({ accounts: [{ code: "310", name: "Guides and crew", type: "DIRECTCOSTS" }, { code: "325", name: "Tour operating costs", type: "DIRECTCOSTS" }], taxRates: [], currencies: [], baseCurrency: "USD", tracking: [] }) })
      .run();
    const nameOf = accountNamesFor(db, DEMO_BUSINESS_ID);
    expect(nameOf("310")).toBe("Guides and crew");
    expect(nameOf("400")).toMatch(/not in the Xero chart/);
    const rows = allRecords(db, DEMO_BUSINESS_ID);
    expect(rows.find((r) => r.reference === "INV-TAM-0834")).toMatchObject({ accountCode: "325", accountName: "Tour operating costs" });
    expect(rows.find((r) => r.reference === "JOB-HG4D-0914")).toMatchObject({ accountCode: "310", accountName: "Guides and crew" });
    // Another business's records are not in this business's files.
    expect(allRecords(db, "biz_other")).toEqual([]);
  });
});

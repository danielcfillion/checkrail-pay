import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { businesses, obligations, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { assertOwnObligation, dualControlGap } from "./orchestrator";

let db: Db;
beforeEach(async () => {
  db = openTestDb();
  await seedDemo(db, { history: false });
});

describe("dual control the team can actually satisfy", () => {
  it("warns when only one person can approve above the dual-approval amount", () => {
    // Seeded: Daniel (owner, no limit) and Minh (approver, USD 1,000). Above USD 5,000 only Daniel can approve.
    expect(dualControlGap(db, DEMO_BUSINESS_ID)).toMatch(/only daniel can approve that much/);
    expect(dualControlGap(db, DEMO_BUSINESS_ID, 40_000)).toBeNull(); // under the dual amount
    db.update(users).set({ approvalLimitMinor: 1_000_000 }).where(eq(users.id, "minh")).run();
    expect(dualControlGap(db, DEMO_BUSINESS_ID)).toBeNull();
  });

  it("refuses an obligation from another business on the write surface", () => {
    const ob = db.select().from(obligations).get()!;
    expect(() => assertOwnObligation(db, DEMO_BUSINESS_ID, ob.id)).not.toThrow();
    db.insert(businesses).values({ ...db.select().from(businesses).where(eq(businesses.id, DEMO_BUSINESS_ID)).get()!, id: "biz_other" }).run();
    expect(() => assertOwnObligation(db, "biz_other", ob.id)).toThrow(/not found/);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { businesses, obligations, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approvalGate, approveObligation, assertOwnObligation, dualControlGap, ingestObligation } from "./orchestrator";

let db: Db;
beforeEach(async () => {
  db = openTestDb();
  await seedDemo(db, { history: false });
});

describe("dual control the team can actually satisfy", () => {
  it("lets a capped approver give the second signature once someone with the limit has approved, and warns only when two people cannot", async () => {
    // Seeded: Daniel (owner, no limit) and Minh (approver, USD 1,000). Daniel approves first; Minh is the check.
    expect(dualControlGap(db, DEMO_BUSINESS_ID)).toBeNull();
    const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "job_completion", rawInput: "Trip PAL-7D-1101 closed. Guide Ana Reyes, private expedition, USD 6,000 (JOB-PAL7D-1101).", evidence: [{ kind: "job_sheet", label: "Trip sheet JOB-PAL7D-1101", amountMinor: 600_000, currency: "USD", reference: "JOB-PAL7D-1101", excerpt: "Ana Reyes, 7 days, USD 6,000.00" }], actor: "system:booking-webhook" });
    expect(approvalGate(db, id, "user:minh").refusal).toMatch(/is above Minh.*approval limit/);
    approveObligation(db, id, "user:daniel");
    expect(db.select().from(obligations).where(eq(obligations.id, id)).get()!.state).toBe("awaiting_approval");
    expect(approvalGate(db, id, "user:minh").refusal).toBeNull();
    approveObligation(db, id, "user:minh");
    expect(db.select().from(obligations).where(eq(obligations.id, id)).get()!.state).toBe("approved");
    db.update(users).set({ active: false }).where(eq(users.id, "minh")).run();
    expect(dualControlGap(db, DEMO_BUSINESS_ID)).toMatch(/only daniel can approve payments/);
  });

  it("refuses an obligation from another business on the write surface", () => {
    const ob = db.select().from(obligations).get()!;
    expect(() => assertOwnObligation(db, DEMO_BUSINESS_ID, ob.id)).not.toThrow();
    db.insert(businesses).values({ ...db.select().from(businesses).where(eq(businesses.id, DEMO_BUSINESS_ID)).get()!, id: "biz_other" }).run();
    expect(() => assertOwnObligation(db, "biz_other", ob.id)).toThrow(/not found/);
  });
});

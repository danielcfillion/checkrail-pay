import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { ingestObligation } from "./orchestrator";
import { resetRails } from "../rails";

let db: Db;
beforeEach(async () => {
  resetRails();
  db = openTestDb();
  await seedDemo(db, { history: false });
});

describe("a re-invoice disguised with look-alike letters", () => {
  it("is still blocked as the job already paid, and the disguise is called out", async () => {
    // JOB-HG4D-0914 was paid in the demo. The same reference with a Cyrillic O and a zero-width space:
    const disguised = "JОB-HG4D​-0914";
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "job_completion",
      rawInput: `Maria Santos, guide fee ${disguised}, USD 180. Please pay Maria Santos.`,
      evidence: [{ kind: "job_sheet", label: `Job sheet ${disguised} (Maria Santos)`, amountMinor: 18_000, currency: "USD", reference: disguised, excerpt: "Guide: Maria Santos. Fee USD 180.00." }],
      actor: "user:lan",
    });
    const o = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
    expect(o.state).toBe("blocked");
    expect(o.blockedReason ?? "").toMatch(/already used|Same job/);
  });
});

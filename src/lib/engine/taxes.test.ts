import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb } from "../db";
import { businesses, obligations, settlements, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { DEFAULT_POLICY } from "../domain/types";
import { confirmSettlement, executeObligation, ingestObligation } from "./orchestrator";
import { form1099Report, taxFormWarning, withholdingFor } from "./taxes";
import { resetRails } from "../rails";

describe("tax", () => {
  it("applies each country's rule only where it holds", () => {
    const us = { country: "US", taxType: "individual", taxForm: null, withholdingBps: null };
    expect(withholdingFor(DEFAULT_POLICY, "US", us, 100_000, "USD")).toMatchObject({ rule: "us_backup", withheldMinor: 24_000 });
    expect(withholdingFor(DEFAULT_POLICY, "US", { ...us, taxForm: "w9" }, 100_000, "USD")).toBeNull();
    const vn = { country: "VN", taxType: "individual", taxForm: "w8ben", withholdingBps: null };
    expect(withholdingFor(DEFAULT_POLICY, "VN", vn, 300_000_000, "VND")).toBeNull(); // the business is not set up as a Vietnamese payer
    const vnPayer = { ...DEFAULT_POLICY, withholdVnPit: true };
    expect(withholdingFor(vnPayer, "VN", vn, 300_000_000, "VND")).toMatchObject({ rule: "vn_pit", withheldMinor: 30_000_000 });
    expect(withholdingFor(vnPayer, "VN", vn, 150_000_000, "VND")).toBeNull(); // under VND 2,000,000
    expect(withholdingFor(vnPayer, "VN", { ...vn, taxForm: "vn_08" }, 300_000_000, "VND")).toBeNull();
    expect(withholdingFor({ ...DEFAULT_POLICY, withholdPhEwt: true }, "PH", { country: "PH", taxType: "business", taxForm: null, withholdingBps: 200 }, 50_000, "PHP")).toMatchObject({ rule: "ph_ewt", withheldMinor: 1_000 });
    expect(taxFormWarning("US", { name: "Ana", country: "PH", taxType: "individual", taxForm: null, withholdingBps: null })).toMatch(/No W-8BEN/);
  });

  it("pays a US vendor without a W-9 less 24%, books the gross, and counts it for the 1099", async () => {
    resetRails();
    const db = openTestDb();
    await seedDemo(db, { history: false });
    db.update(vendors).set({ taxForm: null }).where(eq(vendors.id, "ven_jake")).run();
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "job_completion",
      rawInput: "Video for HG-4D-0921 delivered. Jake Morrison, USD 200 (JOB-JM-0921).",
      evidence: [{ kind: "job_sheet", label: "Content brief JOB-JM-0921", amountMinor: 20_000, currency: "USD", reference: "JOB-JM-0921", excerpt: "Jake Morrison, recap video, USD 200.00" }],
      actor: "system:booking-webhook",
    });
    const o = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
    expect(o.withheldMinor).toBe(4_800);
    expect(o.state).toBe("approved");
    await executeObligation(db, id, { actor: "user:lan" });
    await confirmSettlement(db, id);
    expect(db.select().from(settlements).where(eq(settlements.obligationId, id)).get()!.grossMinor).toBe(15_200);
    const year = Number(new Date().toISOString().slice(0, 4));
    const r = form1099Report(db, DEMO_BUSINESS_ID, year).find((x) => x.vendorId === "ven_jake")!;
    expect(r).toMatchObject({ paidMinor: 20_000, withheldMinor: 4_800, needs1099: false });
    void businesses;
  });
});

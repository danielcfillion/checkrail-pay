import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, paymentAttempts } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { ingestObligation, approveObligation } from "./orchestrator";
import { runAutopilot, setAutonomy } from "./autopilot";

/**
 * Critic round 4: a supplier invoice that merely mentions a known vendor (a town, a people, the guide) must never
 * be paid to that vendor without a person, even on Autopilot.
 */
async function autopilotDb(): Promise<Db> {
  const db = openTestDb();
  await seedDemo(db, { history: true });
  setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 0 });
  return db;
}
const invoice = (db: Db, rawInput: string, excerpt: string, amountMinor: number, ref: string) =>
  ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "invoice",
    rawInput,
    evidence: [{ kind: "invoice", label: `Invoice ${ref}`, amountMinor, currency: "USD", reference: ref, excerpt }],
    actor: "system:email-ingest",
  });
const state = (db: Db, id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;
const sent = (db: Db, id: string) => db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, id)).all().length > 0;

describe("a document that mentions a vendor does not pay that vendor (critic round 4)", () => {
  const cases: Array<[string, string, string, number, string]> = [
    ["F1 Tam Son town", "Invoice attached, please pay.", "Hoang Van Guesthouse, Tam Son town, Quan Ba. 2 rooms, USD 220.", 22_000, "HVG-0101"],
    ["F2 Red Dao village", "Invoice attached, please pay.", "Hoang Van Guesthouse, Red Dao village homestay, USD 140.", 14_000, "HVG-0102"],
    ["F3 guide named on a guesthouse invoice", "Invoice attached, please pay.", "Hoang Van Guesthouse, rooms for group led by Maria Santos, USD 120.", 12_000, "HVG-0103"],
    ["F4 unknown payee in the request, known vendor in the document", "Please pay Nguyen Hoang USD 205.", "Rosa Villanueva, two day trips, USD 205.", 20_500, "HVG-0104"],
    ["A5 request names the vendor, record only mentions a place", "Pay Tam Motorbike Rental USD 220 for HVG-0105.", "Hoang Van Guesthouse, Tam Son town, USD 220.", 22_000, "HVG-0105"],
  ];
  for (const [name, raw, excerpt, amount, ref] of cases) {
    it(name, async () => {
      const db = await autopilotDb();
      const id = await invoice(db, raw, excerpt, amount, ref);
      expect(["approved"]).not.toContain(state(db, id).state);
      await runAutopilot(db);
      await runAutopilot(db);
      expect(sent(db, id)).toBe(false);
    });
  }
  it("the vendor's own invoice alone waits for a person on autopilot (security audit F6)", async () => {
    const db = await autopilotDb();
    const id = await invoice(db, "Invoice attached from Rosa, please pay.", "Rosa Villanueva, two day trips, USD 205.", 20_500, "INV-RV-0950");
    expect(state(db, id).state).toBe("awaiting_approval");
    expect(state(db, id).policyReasonsJson).toMatch(/Only the vendor's own documents support this amount/);
    await runAutopilot(db);
    expect(sent(db, id)).toBe(false);
  });

  it("a job sheet from the business's systems that names the payee in full clears, and autopilot sends it", async () => {
    const db = await autopilotDb();
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "job_completion",
      rawInput: "Trips CEB-1D-0950 and CEB-1D-0951 closed. Guide Rosa Villanueva, USD 205 (JOB-CEB-0950).",
      evidence: [{ kind: "job_sheet", label: "Trip sheet CEB-1D-0950", amountMinor: 20_500, currency: "USD", reference: "JOB-CEB-0950", excerpt: "Rosa Villanueva, two day trips, USD 205." }],
      actor: "system:booking-webhook",
    });
    expect(state(db, id).state).toBe("approved");
    await runAutopilot(db);
    await runAutopilot(db);
    expect(sent(db, id)).toBe(true);
  });
});

describe("an approval covers each warning it saw, not every warning of that kind", () => {
  it("a third payee billing the same reference sends an approved payment back", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    const bill = (who: string, amount: number) => invoice(db, `Invoice from ${who} for JOB-PAL3D-0927, USD ${amount / 100}.`, `${who}, JOB-PAL3D-0927, USD ${amount / 100}`, amount, "JOB-PAL3D-0927");
    await bill("Bayan Island Boats", 30_000);
    // Ana's page was evaluated before Bayan billed her reference: approving without having seen that is refused,
    // and the refusal records a fresh evaluation, so the second attempt is an informed one.
    expect(() => approveObligation(db, story.stellar, "user:daniel")).toThrow(/Something changed since this page was checked: .*Bayan/);
    approveObligation(db, story.stellar, "user:daniel", "Bayan's charter is a separate cost");
    expect(state(db, story.stellar).state).toBe("approved");
    await bill("Tam Motorbike Rental", 20_000);
    const { runPolicy } = await import("./orchestrator");
    const out = runPolicy(db, story.stellar);
    expect(out.decision).toBe("require_approval");
    expect(out.reasons.join(" ")).toMatch(/New since approval: .*Tam/);
  });

  it("an approval given while the other payee's payment was open does not cover it once that one is being paid", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    const bayan = await invoice(db, "Invoice from Bayan Island Boats for JOB-PAL3D-0927, USD 300.", "Bayan Island Boats, JOB-PAL3D-0927, USD 300", 30_000, "JOB-PAL3D-0927");
    expect(state(db, bayan).state).toBe("awaiting_approval");
    const { runPolicy } = await import("./orchestrator");
    runPolicy(db, story.stellar); // the page is evaluated and shows Bayan's open payment
    approveObligation(db, story.stellar, "user:daniel", "Separate cost");
    expect(state(db, story.stellar).state).toBe("approved");
    runPolicy(db, bayan); // Bayan's page loads and shows that Ana's payment is now approved
    approveObligation(db, bayan, "user:daniel", "Charter confirmed"); // Bayan's payment is now committed
    const out = runPolicy(db, story.stellar);
    expect(out.decision).toBe("require_approval");
    expect(out.reasons.join(" ")).toMatch(/New since approval: .*Bayan/);
  });
});

describe("two payees approved on one reference do not void each other forever (critic round 6)", () => {
  it("approve Ana, approve Bayan, pay Ana, pay Bayan: each needs at most one fresh look", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    const { runPolicy, executeObligation } = await import("./orchestrator");
    const bayan = await invoice(db, "Invoice from Bayan Island Boats for JOB-PAL3D-0927, USD 300.", "Bayan Island Boats, JOB-PAL3D-0927, USD 300", 30_000, "JOB-PAL3D-0927");
    runPolicy(db, story.stellar);
    approveObligation(db, story.stellar, "user:daniel", "separate cost");
    runPolicy(db, bayan);
    approveObligation(db, bayan, "user:daniel", "charter confirmed");
    let refusals = 0;
    for (let round = 0; round < 3; round++) {
      for (const id of [story.stellar, bayan]) {
        if (["sent", "settled"].includes(state(db, id).state)) continue;
        if (state(db, id).state !== "approved") {
          runPolicy(db, id);
          approveObligation(db, id, "user:daniel", "looked again");
        }
        try {
          await executeObligation(db, id, { actor: "user:daniel" });
        } catch {
          refusals++;
        }
      }
    }
    expect(["sent", "settled"]).toContain(state(db, story.stellar).state);
    expect(["sent", "settled"]).toContain(state(db, bayan).state);
    expect(refusals).toBeLessThanOrEqual(2);
  });

  it("a refused approval is audited with who tried", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    await invoice(db, "Invoice from Kalaw Trekking Collective for JOB-PAL3D-0927, USD 200.", "Kalaw Trekking Collective, JOB-PAL3D-0927, USD 200", 20_000, "JOB-PAL3D-0927");
    expect(() => approveObligation(db, story.stellar, "user:daniel", undefined, [])).toThrow(/Something changed/);
    const { auditEntries } = await import("../db/schema");
    const rows = db.select().from(auditEntries).where(eq(auditEntries.obligationId, story.stellar)).all();
    expect(rows.some((r) => r.action === "approval.refused" && r.actor === "user:daniel")).toBe(true);
  });

  it("the page's own fingerprints are what an approval is checked against", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    const { runPolicy } = await import("./orchestrator");
    await invoice(db, "Invoice from Kalaw Trekking Collective for JOB-PAL3D-0927, USD 200.", "Kalaw Trekking Collective, JOB-PAL3D-0927, USD 200", 20_000, "JOB-PAL3D-0927");
    runPolicy(db, story.stellar); // another tab refreshed; this viewer's page still shows no warnings
    expect(() => approveObligation(db, story.stellar, "user:daniel", undefined, [])).toThrow(/Something changed/);
  });
});

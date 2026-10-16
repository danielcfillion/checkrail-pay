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
  it("a record that names the payee in full still clears, and autopilot sends it", async () => {
    const db = await autopilotDb();
    const id = await invoice(db, "Invoice attached from Rosa, please pay.", "Rosa Villanueva, two day trips, USD 205.", 20_500, "INV-RV-0950");
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
    approveObligation(db, story.stellar, "user:daniel", "Bayan's charter is a separate cost");
    expect(state(db, story.stellar).state).toBe("approved");
    await bill("Tam Motorbike Rental", 20_000);
    const { runPolicy } = await import("./orchestrator");
    const out = runPolicy(db, story.stellar);
    expect(out.decision).toBe("require_approval");
    expect(out.reasons.join(" ")).toMatch(/New since approval: .*Bayan|New since approval: .*Tam/);
  });
});

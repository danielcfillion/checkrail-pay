import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { amendObligation, ingestObligation, runPolicy } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { expectedAmount, importDepartures, ratesFor, setRate } from "./rates";
import { setAutonomy } from "./autopilot";

let db: Db;
let story: { blockedMismatch: string };
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

beforeEach(async () => {
  db = openTestDb();
  ({ story } = await seedDemo(db, { history: false }));
});

describe("rate cards and departures", () => {
  it("block an invoice above what the rate card and departure say, and pass the corrected amount", async () => {
    const out = runPolicy(db, story.blockedMismatch);
    const rule = out.rules.find((r) => r.ruleId === "expected_amount")!;
    expect(rule.passed).toBe(false);
    expect(rule.message).toMatch(/HG-4D-0927 say USD 800.00 \(4 vehicle-days x USD 200.00\)/);
    await amendObligation(db, story.blockedMismatch, "user:lan", { amountMinor: 80_000 }, "Corrected to the rate card");
    expect(runPolicy(db, story.blockedMismatch).rules.find((r) => r.ruleId === "expected_amount")?.passed).toBe(true);
  });

  it("import a manifest, refuse bad lines, and work out what a vendor is owed", () => {
    const csv = ["code,start,end,guests,vendor,unit,quantity", "CB-3D-1012,2026-10-12,2026-10-14,10,Phuong Transport,vehicle_day,3", "CB-3D-1012,2026-10-12,2026-10-14,10,Nobody,day,1", "bad code!,2026-10-12,2026-10-14,1,Phuong Transport,day,1"].join("\n");
    const r = importDepartures(db, DEMO_BUSINESS_ID, as("lan"), csv);
    expect(r).toMatchObject({ departures: 1, services: 1 });
    expect(r.errors).toHaveLength(2);
    expect(expectedAmount(db, DEMO_BUSINESS_ID, "ven_phuong", ["cb-3d-1012"], "USD")).toMatchObject({ expectedMinor: 60_000, basis: "3 vehicle-days x USD 200.00" });
  });

  it("only an approver or the owner sets rates; a new rate closes the old one", () => {
    expect(() => setRate(db, DEMO_BUSINESS_ID, as("lan"), "ven_phuong", { unit: "vehicle_day", rateMinor: 99_999, currency: "USD", validFrom: "2026-11-01" })).toThrow(/cannot set rate cards/);
    setRate(db, DEMO_BUSINESS_ID, as("minh"), "ven_phuong", { unit: "vehicle_day", rateMinor: 22_000, currency: "USD", validFrom: "2026-11-01" });
    const rates = ratesFor(db, "ven_phuong");
    expect(rates.find((r) => r.validFrom === "2026-01-01")!.validTo).toBe("2026-10-31");
  });

  it("let autopilot pay a vendor invoice the rate card confirms", async () => {
    setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 0 });
    importDepartures(db, DEMO_BUSINESS_ID, as("lan"), "code,start,end,guests,vendor,unit,quantity\nHG-3D-1020,2026-10-20,2026-10-22,6,Maria Santos,day,3");
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice INV-MS-1020 from Maria Santos for HG-3D-1020, 3 days guiding, USD 135.",
      evidence: [{ kind: "invoice", label: "Invoice INV-MS-1020", amountMinor: 13_500, currency: "USD", reference: "INV-MS-1020", excerpt: "Maria Santos, HG-3D-1020, 3 days x USD 45 = USD 135." }],
      actor: "system:email-ingest",
    });
    const reasons = ob(id).policyReasonsJson ?? "";
    expect(reasons).not.toMatch(/Only the vendor's own documents/);
  });
});

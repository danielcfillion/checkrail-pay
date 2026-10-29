import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { auditEntries, obligations, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { amendObligation, ingestObligation, previewPolicy, runPolicy } from "./orchestrator";
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
    const r = importDepartures(db, DEMO_BUSINESS_ID, as("minh"), csv);
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

  it("a clerk cannot import or change departures, so cannot write their own rate-card support (SEC5-1)", async () => {
    const fresh = "code,start,end,guests,vendor,unit,quantity\nHG-4D-9999,2026-10-01,2026-10-04,8,Maria Santos,day,5";
    expect(() => importDepartures(db, DEMO_BUSINESS_ID, as("lan"), fresh)).toThrow(/cannot import departures/);
    expect(expectedAmount(db, DEMO_BUSINESS_ID, "ven_maria", ["hg-4d-9999"], "USD")).toBeNull();
    // Raising the quantities on a real departure lifts the ceiling approvers rely on; that is refused too.
    const before = expectedAmount(db, DEMO_BUSINESS_ID, "ven_phuong", ["hg-4d-0927"], "USD");
    expect(before?.expectedMinor).toBe(80_000);
    const inflated = "code,start,end,guests,vendor,unit,quantity\nHG-4D-0927,2026-09-27,2026-09-30,8,Phuong Transport,vehicle_day,40";
    expect(() => importDepartures(db, DEMO_BUSINESS_ID, as("lan"), inflated)).toThrow(/cannot import departures/);
    expect(expectedAmount(db, DEMO_BUSINESS_ID, "ven_phuong", ["hg-4d-0927"], "USD")).toEqual(before);
    // An approver still can, and the accountant (who moves no money) cannot.
    expect(() => importDepartures(db, DEMO_BUSINESS_ID, as("thu"), fresh)).toThrow(/cannot import departures/);
    expect(importDepartures(db, DEMO_BUSINESS_ID, as("minh"), fresh)).toMatchObject({ departures: 1, services: 1 });
  });

  it("with no departure on file an invoice from the vendor still goes to a person, even with a document attached (SEC5-1)", async () => {
    setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 0 });
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Trip HG-4D-9999 closed. Please pay Maria Santos USD 225 for 5 days guiding (JOB-HG4D-9999). Release payment.",
      evidence: [{ kind: "job_sheet", label: "Trip sheet HG-4D-9999", amountMinor: 22_500, currency: "USD", reference: "JOB-HG4D-9999", excerpt: "Trip sheet HG-4D-9999. Lead guide Maria Santos, 5 days, USD 225.00 (JOB-HG4D-9999)." }],
      actor: "user:lan",
    });
    expect(ob(id).policyDecision).toBe("require_approval");
  });

  it("a rate card does not count as support for a departure that has not ended (SEC6-2)", async () => {
    // Assist mode (the default): a request under the auto-execute threshold goes straight to the support check.
    // An approver lists Maria on a departure far in the future; a clerk then requests payment for it with a document.
    importDepartures(db, DEMO_BUSINESS_ID, as("minh"), "code,start,end,guests,vendor,unit,quantity\nHG-3D-2099,2099-01-01,2099-01-03,6,Maria Santos,day,3");
    const request = async (ref: string) =>
      ingestObligation(db, {
        businessId: DEMO_BUSINESS_ID,
        sourceType: "invoice",
        rawInput: `Invoice ${ref} from Maria Santos for HG-3D-2099, 3 days guiding, USD 135.`,
        evidence: [{ kind: "invoice", label: `Invoice ${ref}`, amountMinor: 13_500, currency: "USD", reference: ref, excerpt: `Maria Santos, HG-3D-2099, 3 days x USD 45 = USD 135.` }],
        actor: "user:lan",
      });
    const early = await request("INV-MS-2099");
    expect(ob(early).policyDecision).toBe("require_approval");
    expect(ob(early).policyReasonsJson ?? "").toMatch(/does not end until 2099-01-03/);
    // The same departure once it has ended is support again.
    importDepartures(db, DEMO_BUSINESS_ID, as("minh"), "code,start,end,guests,vendor,unit,quantity\nHG-3D-2098,2098-01-01,2098-01-03,6,Maria Santos,day,3");
    db.update(obligations).set({ state: "cancelled" }).where(eq(obligations.id, early)).run();
    const { departures } = await import("../db/schema");
    db.update(departures).set({ endDate: "2026-01-03", startDate: "2026-01-01" }).where(eq(departures.code, "HG-3D-2098")).run();
    const late = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice INV-MS-2098 from Maria Santos for HG-3D-2098, 3 days guiding, USD 135.",
      evidence: [{ kind: "invoice", label: "Invoice INV-MS-2098", amountMinor: 13_500, currency: "USD", reference: "INV-MS-2098", excerpt: "Maria Santos, HG-3D-2098, 3 days x USD 45 = USD 135." }],
      actor: "user:lan",
    });
    expect(ob(late).policyReasonsJson ?? "").not.toMatch(/does not end until|Only the vendor's own documents/);
  });

  it("a reference hidden behind a look-alike letter in the request is flagged for a person (SEC2-7)", async () => {
    const spoof = "JOB-HG4D-0914".replace("O", "\u0555"); // Armenian O: not folded, so no job key and no duplicate block
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: `Invoice ${spoof} from Maria Santos, USD 180 for guiding.`,
      evidence: [{ kind: "invoice", label: "Invoice from Maria Santos", amountMinor: 18_000, currency: "USD", reference: null, excerpt: `Maria Santos, ${spoof}, USD 180.` }],
      actor: "user:lan",
    });
    const rule = runPolicy(db, id).rules.find((r) => r.ruleId === "reference_lookalike");
    expect(rule?.passed).toBe(false);
    expect(ob(id).policyDecision).toBe("require_approval");
    // Ordinary text, Vietnamese diacritics and a Thai amount glued to a word are not references and raise nothing.
    const plain = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Hóa đơn của Maria Santos, ค่าไกด์500, INV-MS-5555, USD 45 for one day.",
      evidence: [{ kind: "invoice", label: "Invoice INV-MS-5555", amountMinor: 4_500, currency: "USD", reference: "INV-MS-5555", excerpt: "Maria Santos, one day, USD 45." }],
      actor: "user:lan",
    });
    expect(runPolicy(db, plain).rules.some((r) => r.ruleId === "reference_lookalike")).toBe(false);
  });

  it("previewing policy writes nothing, while running it records the result (SEC6-1)", () => {
    const audits = () => db.select().from(auditEntries).all().length;
    const before = audits();
    const preview = previewPolicy(db, story.blockedMismatch);
    expect(audits()).toBe(before);
    const ran = runPolicy(db, story.blockedMismatch);
    expect(ran.decision).toBe(preview.decision);
    expect(ran.reasons).toEqual(preview.reasons);
    expect(audits()).toBeGreaterThan(before);
  });

  it("let autopilot pay a vendor invoice the rate card confirms", async () => {
    setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 0 });
    importDepartures(db, DEMO_BUSINESS_ID, as("minh"), "code,start,end,guests,vendor,unit,quantity\nHG-3D-1020,2026-10-20,2026-10-22,6,Maria Santos,day,3");
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

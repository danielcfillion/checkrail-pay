import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, settlements, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, confirmSettlement, executeObligation, ingestObligation, runPolicy } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { applyCredit, createBill, findBill, payBill } from "./bills";
import { createRemittanceLink, remittanceMessage, viewRemittance } from "./vendorLinks";
import { preventedTotal } from "../queries";
import { resetRails } from "../rails";

let db: Db;
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  await seedDemo(db, { history: false });
});

describe("day-to-day operations", () => {
  it("does not treat a monthly retainer as a duplicate, but still warns about two in one month", async () => {
    const jake = (ref: string) =>
      ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: `Invoice ${ref} from Jake Morrison, monthly video retainer, USD 450.`, evidence: [{ kind: "invoice", label: `Invoice ${ref}`, amountMinor: 45_000, currency: "USD", reference: ref, excerpt: "Jake Morrison, video retainer, USD 450.00" }], actor: "user:lan" });
    const sept = await jake("INV-JM-0930");
    approveObligation(db, sept, "user:daniel");
    await executeObligation(db, sept, { actor: "user:daniel" });
    await confirmSettlement(db, sept);
    // Paid 25 days ago: this month's retainer is expected.
    db.update(obligations).set({ updatedAt: new Date(Date.now() - 25 * 86_400_000).toISOString() }).where(eq(obligations.id, sept)).run();
    const oct = await jake("INV-JM-1031");
    expect(runPolicy(db, oct).rules.find((r) => r.ruleId === "no_duplicate")).toMatchObject({ passed: true, message: expect.stringMatching(/monthly retainer/) });
    // The same figure a week later is a second invoice in one month: a person confirms it.
    db.update(obligations).set({ updatedAt: new Date(Date.now() - 7 * 86_400_000).toISOString() }).where(eq(obligations.id, sept)).run();
    expect(runPolicy(db, oct).rules.find((r) => r.ruleId === "no_duplicate")).toMatchObject({ passed: false, message: expect.stringMatching(/retainer is paid once a month/) });
  });

  it("tells the vendor the whole invoice story on the remittance: total, deposit, credit, this payment, what is left", async () => {
    const lan = as("lan");
    const bill = createBill(db, DEMO_BUSINESS_ID, lan, "ven_dao", { kind: "invoice", reference: "INV-DML-2001", totalMinor: 85_000, currency: "USD" });
    const credit = createBill(db, DEMO_BUSINESS_ID, lan, "ven_dao", { kind: "credit_note", reference: "CN-DML-2001", totalMinor: 8_500, currency: "USD" });
    const dep = await payBill(db, DEMO_BUSINESS_ID, lan, bill, 42_500);
    approveObligation(db, dep, "user:minh");
    await executeObligation(db, dep, { actor: "user:minh" });
    await confirmSettlement(db, dep);
    applyCredit(db, DEMO_BUSINESS_ID, lan, credit, bill, 8_500);
    const bal = await payBill(db, DEMO_BUSINESS_ID, lan, bill, 34_000);
    approveObligation(db, bal, "user:minh");
    await executeObligation(db, bal, { actor: "user:minh" });
    await confirmSettlement(db, bal);
    const r = viewRemittance(db, createRemittanceLink(db, DEMO_BUSINESS_ID, lan, bal))!;
    expect(r.history).toMatchObject({ total: "USD 850.00", left: "USD 0.00" });
    expect(r.history!.lines.map((l) => [l.label, l.amount, l.thisOne])).toEqual([
      ["part", "USD 425.00", false],
      ["balance", "USD 340.00", true],
      ["credit", "USD 85.00", false],
    ]);
    expect(remittanceMessage(r, "https://x")).toMatch(/Còn lại: USD 0.00/);
    expect(findBill(db, "ven_dao", "INV-DML-2001")!.status).toBe("closed");
  });

  it("counts rate-card catches in errors prevented", async () => {
    const before = preventedTotal(db).minor;
    const { importDepartures, setRate } = await import("./rates");
    setRate(db, DEMO_BUSINESS_ID, as("minh"), "ven_bayan", { unit: "trip", rateMinor: 9_000, currency: "USD", validFrom: "2026-01-01" });
    importDepartures(db, DEMO_BUSINESS_ID, as("lan"), "code,start,end,guests,vendor,unit,quantity\nEN-2D-1101,2026-11-01,2026-11-02,8,Bayan Island Boats,trip,2");
    const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Bayan Island Boats invoice INV-BAY-1101 for EN-2D-1101: 2 bangka trips, USD 240.", evidence: [{ kind: "invoice", label: "Invoice INV-BAY-1101", amountMinor: 24_000, currency: "USD", reference: "INV-BAY-1101", excerpt: "Bayan Island Boats, EN-2D-1101, 2 trips, USD 240.00" }], actor: "user:lan" });
    expect(ob(id).state).toBe("blocked");
    expect(preventedTotal(db).minor - before).toBe(6_000);
    void settlements;
  });
});

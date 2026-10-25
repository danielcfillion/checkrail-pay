import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { bills, obligations, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, confirmSettlement, executeObligation, ingestObligation } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { applyCredit, billBalance, createBill, findBill, payBill, settleAdvance, vendorBills } from "./bills";
import { resetRails } from "../rails";

let db: Db;
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

async function pay(id: string) {
  if (ob(id).state === "awaiting_approval") approveObligation(db, id, ob(id).billId && ob(id).state ? "user:daniel" : "user:daniel");
  await executeObligation(db, id, { actor: "user:lan" });
  await confirmSettlement(db, id);
}

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  await seedDemo(db, { history: false });
});

describe("deposits and balances", () => {
  it("reads a deposit request as the deposit, not the invoice total, and links it to the invoice", async () => {
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Dao Mountain Lodge invoice INV-DML-1010, 10 rooms for the Cao Bang departure, total USD 850. 50% deposit USD 425 now, balance on arrival.",
      evidence: [{ kind: "invoice", label: "Dao Mountain Lodge invoice INV-DML-1010", amountMinor: 85_000, currency: "USD", reference: "INV-DML-1010", excerpt: "Dao Mountain Lodge. 10 rooms. Total USD 850.00. Deposit 50% on booking." }],
      actor: "user:lan",
    });
    const o = ob(id);
    expect(o.amountMinor).toBe(42_500);
    expect(o.paymentKind).toBe("deposit");
    expect(o.billId).toBeTruthy();
    expect(o.state).not.toBe("blocked");
    const bill = db.select().from(bills).where(eq(bills.id, o.billId!)).get()!;
    expect(bill).toMatchObject({ reference: "INV-DML-1010", totalMinor: 85_000, vendorId: "ven_dao" });
    await pay(id);
    expect(billBalance(db, bill.id)).toMatchObject({ paidMinor: 42_500, openMinor: 42_500 });

    // Paying the full invoice again after the deposit is refused; paying the balance is not.
    const again = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Please pay Dao Mountain Lodge INV-DML-1010 balance, USD 850.", evidence: [{ kind: "invoice", label: "Dao Mountain Lodge invoice INV-DML-1010", amountMinor: 85_000, currency: "USD", reference: "INV-DML-1010", excerpt: "Dao Mountain Lodge. Total USD 850.00." }], actor: "user:lan" });
    expect(ob(again).state).toBe("blocked");
    expect(ob(again).blockedReason).toMatch(/only USD 425.00 is still open on INV-DML-1010/);
    const balance = await payBill(db, DEMO_BUSINESS_ID, as("lan"), bill.id, 42_500);
    expect(ob(balance).paymentKind).toBe("balance");
    expect(ob(balance).state).not.toBe("blocked");
    await pay(balance);
    expect(db.select().from(bills).where(eq(bills.id, bill.id)).get()!.status).toBe("closed");
    await expect(payBill(db, DEMO_BUSINESS_ID, as("lan"), bill.id, 100)).rejects.toThrow(/closed/);
  });

  it("applies a credit note to an invoice, lowering what is left to pay", async () => {
    const inv = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_dao", { kind: "invoice", reference: "INV-DML-1020", totalMinor: 60_000, currency: "USD" });
    const cn = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_dao", { kind: "credit_note", reference: "CN-DML-07", totalMinor: 15_000, currency: "USD", note: "Two rooms cancelled on INV-DML-0919" });
    expect(() => applyCredit(db, DEMO_BUSINESS_ID, as("lan"), cn, inv, 20_000)).toThrow(/Only USD 150.00 of this credit/);
    applyCredit(db, DEMO_BUSINESS_ID, as("lan"), cn, inv, 15_000);
    expect(billBalance(db, inv).openMinor).toBe(45_000);
    await expect(payBill(db, DEMO_BUSINESS_ID, as("lan"), inv, 60_000)).rejects.toThrow(/more than the USD 450.00 still open/);
    const id = await payBill(db, DEMO_BUSINESS_ID, as("lan"), inv, 45_000);
    expect(ob(id).blockedReason).toBeNull();
    expect(vendorBills(db, "ven_dao").position[0]).toMatchObject({ currency: "USD", creditMinor: 0 });
  });

  it("settles a guide's cash advance against receipts: overspend becomes owed, underspend a credit", async () => {
    const adv = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "advance", reference: "ADV-HG-1004", totalMinor: 20_000, currency: "USD", note: "Fuel, tickets and meals for HG-4D-1004" });
    const id = await payBill(db, DEMO_BUSINESS_ID, as("lan"), adv, 20_000);
    expect(ob(id).paymentKind).toBe("advance");
    await pay(id);
    expect(vendorBills(db, "ven_maria").position[0].advancesOutMinor).toBe(20_000);
    const r = settleAdvance(db, DEMO_BUSINESS_ID, as("lan"), adv, 17_250, "Receipts photographed");
    expect(r).toMatchObject({ owedTo: "business", differenceMinor: 2_750 });
    const credit = findBill(db, "ven_maria", "ADV-HG-1004-S", "credit_note")!;
    expect(credit.totalMinor).toBe(2_750);
    expect(vendorBills(db, "ven_maria").position[0]).toMatchObject({ creditMinor: 2_750, advancesOutMinor: 0 });
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, confirmSettlement, executeObligation, ingestObligation } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { billRecordOf, createBill, payBill } from "./bills";
import { getDailyClose, signOffDailyClose } from "./dailyClose";
import { BankFileRail } from "../rails/bankFile";
import { resetRails, setRailsForTest } from "../rails";

/** Practitioner round six (PR6-n): fixes to the outputs around the money path. */

let db: Db;
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  await seedDemo(db, { history: true });
  setRailsForTest({ bank_file: new BankFileRail(() => db) });
});
afterEach(() => resetRails());

describe("PR6-7: Daily close after a normal morning", () => {
  it("is one 'new vendor' line for a vendor paid twice in the same close, even when each is a new bank account", async () => {
    const hs27 = db.select().from(obligations).where(eq(obligations.sourceRef, "HS-1027")).get()!;
    approveObligation(db, hs27.id, "user:minh");
    await executeObligation(db, hs27.id, { actor: "user:minh" });
    const hs34 = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Hoa don HS-1034 tu Linh Family Homestay: tong cong 9.000.000 VND.", evidence: [{ kind: "invoice", label: "Invoice HS-1034", amountMinor: 900_000_000, currency: "VND", reference: "HS-1034", excerpt: "Linh Family Homestay, VND 9,000,000" }], actor: "user:lan" });
    approveObligation(db, hs34, "user:minh");
    await executeObligation(db, hs34, { actor: "user:minh" });
    const lines = getDailyClose(db, DEMO_BUSINESS_ID, "USD").attention.filter((a) => a.kind === "new_vendor" && a.vendorName === "Linh Family Homestay");
    expect(lines).toHaveLength(1);
  });

  it("folds payments approved over the same warning for one vendor into one line, and says the evidence was a bill", async () => {
    const lan = as("lan");
    const bill = createBill(db, DEMO_BUSINESS_ID, lan, "ven_dao", { kind: "invoice", reference: "INV-DML-6001", totalMinor: 85_000, currency: "USD" });
    const adv = createBill(db, DEMO_BUSINESS_ID, lan, "ven_maria", { kind: "advance", reference: "ADV-MS-6001", totalMinor: 20_000, currency: "USD" });
    for (const [id, amount] of [[bill, 42_500], [bill, 42_500], [adv, 20_000]] as const) {
      const pay = await payBill(db, DEMO_BUSINESS_ID, lan, id, amount);
      approveObligation(db, pay, "user:minh");
      await executeObligation(db, pay, { actor: "user:minh" });
      await confirmSettlement(db, pay);
    }
    const c = getDailyClose(db, DEMO_BUSINESS_ID, "USD");
    const over = c.attention.filter((a) => a.kind === "approved_over_warning");
    const dao = over.filter((a) => a.vendorName === "Dao Mountain Lodge");
    expect(dao).toHaveLength(1);
    expect(dao[0].ids).toHaveLength(2);
    expect(dao[0].note).toMatch(/^Approved over \d+ warnings? on 2 payments: The evidence is bill INV-DML-6001, recorded by Lan, not a document/);
    expect(dao[0].note).not.toMatch(/supplied by operator/);
    expect(over.filter((a) => a.vendorName === "Maria Santos")).toHaveLength(1);
    // The sign-off records every payment a folded line stands for.
    signOffDailyClose(db, DEMO_BUSINESS_ID, "USD", "user:daniel", c.throughSeq);
  });

  it("knows which evidence record came from a bill, and leaves a typed one as typed", async () => {
    const lan = as("lan");
    const bill = createBill(db, DEMO_BUSINESS_ID, lan, "ven_dao", { kind: "invoice", reference: "INV-DML-6002", totalMinor: 85_000, currency: "USD" });
    const pay = await payBill(db, DEMO_BUSINESS_ID, lan, bill, 42_500);
    expect(billRecordOf(db, pay)).toMatchObject({ reference: "INV-DML-6002", recordedBy: "user:lan" });
    const typed = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Invoice INV-TAM-6003 from Tam Motorbike Rental, USD 100.", evidence: [{ kind: "invoice", label: "Invoice INV-TAM-6003", amountMinor: 10_000, currency: "USD", reference: "INV-TAM-6003", excerpt: "Tam Motorbike Rental, USD 100.00" }], actor: "user:lan", evidenceSource: "operator" });
    expect(billRecordOf(db, typed)).toBeNull();
    expect(ob(pay).billId).toBe(bill);
  });
});

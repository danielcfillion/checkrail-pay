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
import { createRemittanceLink, remittanceMessageFor, viewRemittance, type Remittance } from "./vendorLinks";
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

describe("PR6-3: the remittance message names the rail each payment went by", () => {
  const base: Remittance = { businessName: "Ridgeline Expeditions LLC", vendorName: "Maria Santos", reference: "JOB-HG4D-0921", amount: "USD 180.00", received: null, rail: "PayPal", date: "29 Oct 2026", providerRef: null, status: "paid", language: "en", withheld: null, shortPaid: null, history: null };

  it("says one sentence per rail, and settled apart from in flight", () => {
    const text = remittanceMessageFor([base, { ...base, reference: "ADV-HG4D-1101", amount: "USD 300.00", rail: "Stellar", status: "on its way" }], ["{link0}", "{link1}"]);
    expect(text).toBe("Hi Maria Santos, Ridgeline Expeditions LLC has paid USD 180.00 for JOB-HG4D-0921 by PayPal on 29 Oct 2026. Ridgeline Expeditions LLC is sending USD 300.00 for ADV-HG4D-1101 by Stellar. Details: {link0} {link1}");
    expect(text).not.toMatch(/480/);
  });

  it("totals only the payments that went the same way", () => {
    const text = remittanceMessageFor([base, { ...base, reference: "JOB-HG4D-0922", amount: "USD 20.00" }], ["a", "b"]);
    expect(text).toMatch(/has paid USD 200.00 for JOB-HG4D-0921, JOB-HG4D-0922 by PayPal on 29 Oct 2026\./);
    expect(text.match(/by PayPal/g)).toHaveLength(1);
  });

  it("writes Vietnamese without a doubled 'qua', with the date day first", () => {
    const linh: Remittance = { ...base, vendorName: "Linh Family Homestay", language: "vi", rail: "chuyển khoản ngân hàng", date: "27 Oct 2026" };
    const text = remittanceMessageFor([{ ...linh, reference: "HS-1027", amount: "VND 9,800,000" }, { ...linh, reference: "HS-1034", amount: "VND 9,000,000", status: "on its way" }], ["a", "b"]);
    expect(text).toBe("Chào Linh Family Homestay, Ridgeline Expeditions LLC đã thanh toán VND 9,800,000 cho HS-1027 qua chuyển khoản ngân hàng ngày 27/10/2026. Ridgeline Expeditions LLC đang chuyển VND 9,000,000 cho HS-1034 qua chuyển khoản ngân hàng. Chi tiết: a b");
    expect(text).not.toMatch(/qua [^.]*qua /);
  });

  it("does not repeat the references when a vendor is paid in two currencies", () => {
    const text = remittanceMessageFor([base, { ...base, reference: "HS-9", amount: "VND 1,000,000" }], ["a", "b"]);
    expect(text).toMatch(/has paid USD 180.00 \(JOB-HG4D-0921\), VND 1,000,000 \(HS-9\) by PayPal on 29 Oct 2026\./);
    expect(text).not.toMatch(/for JOB-HG4D-0921/);
  });

  it("calls a Wise payment to a Vietnamese vendor a bank transfer, like the bank file", async () => {
    const hs27 = db.select().from(obligations).where(eq(obligations.sourceRef, "HS-1027")).get()!;
    approveObligation(db, hs27.id, "user:minh");
    await executeObligation(db, hs27.id, { actor: "user:minh" });
    await confirmSettlement(db, hs27.id);
    const r = viewRemittance(db, createRemittanceLink(db, DEMO_BUSINESS_ID, as("lan"), hs27.id))!;
    expect(r).toMatchObject({ language: "vi", status: "paid", rail: "chuyển khoản ngân hàng" });
  });
});

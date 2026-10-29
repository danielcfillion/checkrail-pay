import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, users, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, confirmSettlement, executeObligation, ingestObligation } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { billRecordOf, createBill, payBill } from "./bills";
import { getDailyClose, signOffDailyClose } from "./dailyClose";
import { agedPayables, markReturnedByHand } from "./books";
import { importDeparturesAndRecheck } from "./manifest";
import { importDepartures } from "./rates";
import { listSettlements, listVendors, paidSummary } from "../queries";
import { createRemittanceLink, remittanceMessageFor, viewRemittance, type Remittance } from "./vendorLinks";
import { BankFileRail } from "../rails/bankFile";
import { buildAccountingRecord, toCsv } from "../accounting/record";
import { xeroBillRows } from "../accounting/xeroBills";
import { toXeroFeeTransaction, toXeroPayment } from "../accounting/xero";
import { settlements } from "../db/schema";
import { resetRails, setRailsForTest } from "../rails";

/** Practitioner round six (PR6-n): fixes to the outputs around the money path. */

let db: Db;
let story: { paypal: string };
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  ({ story } = await seedDemo(db, { history: true }));
  setRailsForTest({ bank_file: new BankFileRail(() => db) });
});
afterEach(() => {
  delete process.env.BANK_FILE_SOURCE_ACCOUNT;
  resetRails();
});

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

describe("PR6-4: the settlement CSV and the Xero bills file agree", () => {
  async function paid(id: string, actor = "user:minh") {
    approveObligation(db, id, "user:minh");
    await executeObligation(db, id, { actor });
    await confirmSettlement(db, id);
  }
  const xeroRow = (ref: string) => xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: false }).rows.find((r) => r["*InvoiceNumber"] === ref)!;

  it("net is what left the account on a Wise payment, in whole dong, with the bill's description", async () => {
    const hs27 = db.select().from(obligations).where(eq(obligations.sourceRef, "HS-1027")).get()!;
    await paid(hs27.id);
    const st = db.select().from(settlements).where(eq(settlements.obligationId, hs27.id)).get()!;
    expect(st.rail).toBe("wise");
    expect(st.feeMinor).toBeGreaterThan(0);
    const p = buildAccountingRecord(db, hs27.id)!.payload;
    expect(p.grossAmount).toBe("10800000");
    expect(p.netPaid).toBe(String(Math.round((st.grossMinor + st.feeMinor) / 100)));
    expect(Number(p.netPaid)).toBeGreaterThan(Number(p.grossAmount));
    expect(p.feeAmount).toMatch(/^\d+$/);
    expect(p.recipientReceived).toMatch(/^\d+$/);
    const row = xeroRow("HS-1027");
    expect(p.description).toBe(row.Description);
    expect(p.description).not.toMatch(/Hoa don|tong cong/);
    expect(p.accountCode.split(" ")[0]).toBe(String(row["*AccountCode"]));
    expect(toCsv([p])).not.toMatch(/\d+\.00/);
  });

  it("a cash advance is the prepayment account in both files, described as a cash advance, not the request text", async () => {
    const lan = as("lan");
    const adv = createBill(db, DEMO_BUSINESS_ID, lan, "ven_maria", { kind: "advance", reference: "ADV-HG4D-1101", totalMinor: 31_000, currency: "USD" });
    const pay = await payBill(db, DEMO_BUSINESS_ID, lan, adv, 31_000);
    await paid(pay);
    const p = buildAccountingRecord(db, pay)!.payload;
    const row = xeroRow("ADV-HG4D-1101");
    expect(row["*AccountCode"]).toBe("620");
    expect(p.accountCode.split(" ")[0]).toBe("620");
    expect(p.description).toBe(row.Description);
    expect(p.description).toMatch(/^Cash advance ADV-HG4D-1101/);
    expect(p.reference).toBe("ADV-HG4D-1101");
  });

  it("the Xero payment plus the fee spend equals net on every rail but Stellar", () => {
    const base = { reference: "R", vendorName: "V", vendorCountry: "VN", description: "d", billDate: "2026-10-01", paymentDate: "2026-10-02", grossAmount: "10800000", grossCurrency: "VND", feeAmount: "91090", feeCurrency: "VND", netPaid: "10891090", recipientReceived: null, recipientCurrency: null, fxRate: null, externalTransactionId: "X", explorerUrl: null, accountCode: "320", obligationId: "o" };
    for (const rail of ["wise", "bank_file"]) {
      const r = { ...base, rail };
      expect(Number(toXeroPayment(r, "090").Amount) + Number(toXeroFeeTransaction(r, "090")!.LineItems[0].UnitAmount)).toBe(Number(r.netPaid));
    }
    expect(toXeroFeeTransaction({ ...base, rail: "stellar", netPaid: "10800000" }, "091")).toBeNull();
  });
});

describe("PR6-5: aged payables tie to the bills in the books", () => {
  it("leaves out a chat message with no evidence, and shows no raw id", async () => {
    const chat = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "operator_instruction", rawInput: "pls pay Bayan 130", actor: "user:lan" });
    expect(ob(chat).state).toBe("needs_evidence");
    const rows = agedPayables(db, DEMO_BUSINESS_ID).rows;
    expect(rows.some((r) => r.id === chat)).toBe(false);
    expect(rows.some((r) => /^obl_/.test(r.reference))).toBe(false);
    // Waiting for a person's approval is not in Xero yet either.
    const waiting = db.select().from(obligations).where(eq(obligations.sourceRef, "HS-1027")).get()!;
    expect(waiting.state).toBe("awaiting_approval");
    expect(rows.some((r) => r.id === waiting.id)).toBe(false);
  });

  it("keeps a payment in the bank file in ageing until the bank confirms it, and names it by its reference", async () => {
    process.env.BANK_FILE_SOURCE_ACCOUNT = "VCB 0071000123 Ridgeline Vietnam";
    db.update(vendors).set({ preferredRail: "bank_file" }).where(eq(vendors.id, "ven_linh")).run();
    const hs27 = db.select().from(obligations).where(eq(obligations.sourceRef, "HS-1027")).get()!;
    await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Hoa don HS-1034 tu Linh Family Homestay: tong cong 9.000.000 VND.", evidence: [{ kind: "invoice", label: "Invoice HS-1034", amountMinor: 900_000_000, currency: "VND", reference: "HS-1034", excerpt: "Linh Family Homestay, VND 9,000,000" }], actor: "user:lan" });
    const hs34 = db.select().from(obligations).where(eq(obligations.sourceRef, "HS-1034")).get()!;
    await executeObligationAfterApproval(hs34.id);
    expect(ob(hs34.id).state).toBe("sent");
    expect(ob(hs34.id).selectedRail).toBe("bank_file");
    const row = agedPayables(db, DEMO_BUSINESS_ID).rows.find((r) => r.id === hs34.id)!;
    expect(row).toMatchObject({ reference: "HS-1034", vendorName: "Linh Family Homestay", amountMinor: 900_000_000 });
    expect(row.detail).toMatch(/bank file/);
    void hs27;
  });

  it("a bill with a payment on its way is still owed in full, and the payment is not a second row", async () => {
    const lan = as("lan");
    const bill = createBill(db, DEMO_BUSINESS_ID, lan, "ven_dao", { kind: "invoice", reference: "INV-DML-6005", totalMinor: 85_000, currency: "USD" });
    const dep = await payBill(db, DEMO_BUSINESS_ID, lan, bill, 42_500);
    approveObligation(db, dep, "user:minh");
    const rows = agedPayables(db, DEMO_BUSINESS_ID).rows.filter((r) => r.reference === "INV-DML-6005");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "bill", amountMinor: 85_000 });
    await executeObligation(db, dep, { actor: "user:minh" });
    await confirmSettlement(db, dep);
    expect(agedPayables(db, DEMO_BUSINESS_ID).rows.find((r) => r.reference === "INV-DML-6005")!.amountMinor).toBe(42_500);
  });

  async function executeObligationAfterApproval(id: string) {
    approveObligation(db, id, "user:minh");
    await executeObligation(db, id, { actor: "user:minh" });
  }
});

describe("PR6-6: paid to date on the vendor page does not count money that came back", () => {
  const maria = () => paidSummary(listSettlements(db).filter((x) => x.obligation.vendorId === "ven_maria").map((x) => ({ ...x, state: x.obligation.state })), "USD");

  it("subtracts a refunded payment and its fee, and shows what came back", async () => {
    await executeObligation(db, story.paypal, { actor: "user:minh" });
    await confirmSettlement(db, story.paypal);
    const before = maria();
    const fee = db.select().from(settlements).where(eq(settlements.obligationId, story.paypal)).get()!.feeMinor;
    expect(fee).toBeGreaterThan(0);
    markReturnedByHand(db, DEMO_BUSINESS_ID, as("thu"), story.paypal, "5TXMARIA180ABC");
    expect(ob(story.paypal).state).toBe("refunded");
    const after = maria();
    expect(after.paidMinor).toBe(before.paidMinor - 18_000);
    expect(after.feesMinor).toBe(before.feesMinor - fee);
    expect(after.refundedMinor).toBe(18_000);
    expect(listVendors(db).find((v) => v.id === "ven_maria")!.paidMinor).toBe(after.paidMinor);
  });
});

describe("PR6-2: the invoice's own unit rate against the contract rate", () => {
  const phuongInvoice = (ref: string, text: string, amountMinor: number) =>
    ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: `Invoice ${ref} from Phuong Transport for HG-4D-1004: ${text}.`, evidence: [{ kind: "invoice", label: `Invoice ${ref} from Phuong Transport`, amountMinor, currency: "USD", reference: ref, excerpt: `Phuong Transport, HG-4D-1004. ${text}` }], actor: "user:lan", evidenceSource: "operator" });
  const MANIFEST = "code,start,end,guests,vendor,unit,quantity\nHG-4D-1004,2026-10-04,2026-10-07,12,Linh Family Homestay,guest_night,24\nHG-4D-1004,2026-10-04,2026-10-07,12,Phuong Transport,vehicle_day,4";

  it("warns on a unit price above the contract before the departure has a Phuong line, and the reason is on the request", async () => {
    const id = await phuongInvoice("INV-PH-1004", "4 days at USD 220 = USD 880", 88_000);
    expect(ob(id).state).toBe("awaiting_approval");
    expect(JSON.parse(ob(id).policyReasonsJson ?? "[]").join(" ")).toMatch(/The invoice charges USD 220.00 per day; the contract rate is USD 200.00 per vehicle-day/);
    const ok = await phuongInvoice("INV-PH-1005", "4 vehicle-days x USD 200 = USD 800", 80_000);
    expect(JSON.parse(ob(ok).policyReasonsJson ?? "[]").join(" ")).not.toMatch(/contract rate/);
  });

  it("a manifest import checks the vendors' waiting requests again and blocks the one that breaks the rate card", async () => {
    const id = await phuongInvoice("INV-PH-1004", "4 days at USD 220 = USD 880", 88_000);
    const clean = await phuongInvoice("INV-PH-1006", "4 vehicle-days x USD 200 = USD 800", 80_000);
    expect(ob(id).state).toBe("awaiting_approval");
    await expect(importDeparturesAndRecheck(db, DEMO_BUSINESS_ID, as("lan"), MANIFEST)).rejects.toThrow(/cannot import departures/);
    const r = await importDeparturesAndRecheck(db, DEMO_BUSINESS_ID, as("minh"), MANIFEST);
    expect(r).toMatchObject({ departures: 1, services: 2, nowBlocked: 1 });
    expect(r.vendorIds.sort()).toEqual(["ven_linh", "ven_phuong"]);
    expect(ob(id).state).toBe("blocked");
    expect(ob(id).blockedReason).toMatch(/Rate card and departure HG-4D-1004 say USD 800.00/);
    expect(ob(clean).state).not.toBe("blocked");
  });

  it("importing the manifest alone leaves a waiting request as it was", async () => {
    const id = await phuongInvoice("INV-PH-1004", "4 days at USD 220 = USD 880", 88_000);
    importDepartures(db, DEMO_BUSINESS_ID, as("minh"), MANIFEST);
    expect(ob(id).state).toBe("awaiting_approval");
  });
});

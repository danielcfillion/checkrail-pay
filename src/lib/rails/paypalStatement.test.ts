import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, settlements, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { confirmSettlement, executeObligation } from "../engine/orchestrator";
import { resolveActor } from "../engine/users";
import { reconcilePayPal } from "../engine/books";
import { resetRails } from "./index";
import { eventType, fetchPayPalStatement, transactionsToStatementLines, type GetJson, type TsTransaction } from "./paypalStatement";

const tx = (id: string, code: string, value: string, date: string, email: string, ref = ""): TsTransaction => ({
  transaction_info: { transaction_id: id, transaction_event_code: code, transaction_initiation_date: `${date}T03:12:44+0000`, transaction_amount: { currency_code: "USD", value }, fee_amount: { currency_code: "USD", value: "0.00" }, transaction_status: "S", paypal_reference_id: ref || undefined },
  payer_info: { email_address: email, payer_name: { alternate_full_name: "Maria Santos" } },
});

describe("PayPal Transaction Search mapping", () => {
  it("names event codes the way the activity CSV does", () => {
    expect(eventType("T0001", -100)).toBe("Mass Pay Payment");
    expect(eventType("T1106", 100)).toBe("Payment Reversal");
    expect(eventType("T1107", 100)).toBe("Payment Refund");
    expect(eventType("T0000", -100)).toBe("General Payment");
  });

  it("puts the counterparty in the right column and keeps the reversed transaction id", () => {
    const [out, back] = transactionsToStatementLines([tx("A1", "T0001", "-180.00", "2026-10-02", "Maria@Example.com"), tx("A2", "T1106", "180.00", "2026-11-01", "maria@example.com", "A1")]);
    expect(out).toMatchObject({ grossMinor: -18_000, toEmail: "maria@example.com", fromEmail: "", status: "Completed", date: "2026-10-02" });
    expect(back).toMatchObject({ grossMinor: 18_000, toEmail: "", fromEmail: "maria@example.com", referenceTxnId: "A1", type: "Payment Reversal" });
  });

  it("splits a long range into 31-day windows, pages each, drops repeats, and stops at the page count", async () => {
    const calls: string[] = [];
    const get: GetJson = async (path) => {
      calls.push(path);
      const page = Number(new URL(`https://x${path}`).searchParams.get("page"));
      return { ok: true, status: 200, body: { transaction_details: [tx(`P${page}`, "T0001", "-1.00", "2026-10-01", "a@b.c"), tx("SAME", "T0001", "-1.00", "2026-10-01", "a@b.c")], total_pages: 2 } };
    };
    const lines = await fetchPayPalStatement(get, "2026-08-01", "2026-10-15");
    expect(calls.length).toBe(6); // three windows, two pages each
    expect(lines.map((l) => l.transactionId).sort()).toEqual(["P1", "P2", "SAME"]);
  });

  it("refuses ranges it cannot read and explains a missing scope", async () => {
    const forbidden: GetJson = async () => ({ ok: false, status: 403, body: null });
    await expect(fetchPayPalStatement(forbidden, "2026-10-01", "2026-10-02")).rejects.toThrow(/Turn on Transaction search/);
    await expect(fetchPayPalStatement(forbidden, "2026-01-01", "2026-10-02")).rejects.toThrow(/At most 93 days/);
    await expect(fetchPayPalStatement(forbidden, "2026-10-05", "2026-10-02")).rejects.toThrow(/after the start/);
  });
});

describe("reconciling from Transaction Search", () => {
  let db: Db;
  let paid: string;
  beforeEach(async () => {
    resetRails();
    db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    paid = story.paypal;
    await executeObligation(db, paid, { actor: "user:lan" });
    await confirmSettlement(db, paid);
  });

  it("matches the payout, then ties PayPal's reversal to it by reference id and reopens what is owed", async () => {
    const st = db.select().from(settlements).where(eq(settlements.obligationId, paid)).get()!;
    const email = db.select().from(vendors).where(eq(vendors.id, "ven_maria")).get()!.paypalEmail!;
    const day = st.settledAt.slice(0, 10);
    const rows = [tx("PAYOUT1", "T0001", "-180.00", day, email), tx("BACK1", "T1106", "180.00", day, email, "PAYOUT1"), tx("ODD1", "T0001", "-75.00", day, "stranger@example.com")];
    const get: GetJson = async () => ({ ok: true, status: 200, body: { transaction_details: rows, total_pages: 1 } });
    const lines = await fetchPayPalStatement(get, day, day);
    const thu = resolveActor(db, DEMO_BUSINESS_ID, "thu", "accountant");
    const { result } = reconcilePayPal(db, DEMO_BUSINESS_ID, thu, lines, "Transaction Search", "paypal_api");
    expect(result.matched.map((m) => m.statementRef)).toEqual(["PAYOUT1"]);
    expect(result.returned?.map((r) => r.transactionId)).toEqual(["BACK1"]);
    expect(result.statementOnly.map((l) => l.transactionId)).toEqual(["ODD1"]);
    expect(db.select().from(obligations).where(eq(obligations.id, paid)).get()!.state).toBe("refunded");
  });

  it("a reversal that names a payout we never made reopens nothing", async () => {
    const st = db.select().from(settlements).where(eq(settlements.obligationId, paid)).get()!;
    const email = db.select().from(vendors).where(eq(vendors.id, "ven_maria")).get()!.paypalEmail!;
    const day = st.settledAt.slice(0, 10);
    const get: GetJson = async () => ({ ok: true, status: 200, body: { transaction_details: [tx("BACK2", "T1106", "180.00", day, email, "NOT-OURS")], total_pages: 1 } });
    const thu = resolveActor(db, DEMO_BUSINESS_ID, "thu", "accountant");
    const { result } = reconcilePayPal(db, DEMO_BUSINESS_ID, thu, await fetchPayPalStatement(get, day, day), "Transaction Search", "paypal_api");
    expect(result.returned).toHaveLength(0);
    expect(result.returnedUnmatched?.[0].why).toMatch(/not matched to a payment here/);
    expect(db.select().from(obligations).where(eq(obligations.id, paid)).get()!.state).toBe("settled");
  });
});

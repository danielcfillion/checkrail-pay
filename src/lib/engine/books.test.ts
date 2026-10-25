import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, settlements, users, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { amendObligation, confirmSettlement, executeObligation } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { agedPayables, parsePayPalCsv, reconcilePayPal, setPeriodLock } from "./books";
import { localDateString } from "../format";
import { resetRails } from "../rails";

let db: Db;
let story: { blockedMismatch: string; paypal: string };
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  ({ story } = await seedDemo(db, { history: false }));
});

describe("books", () => {
  it("matches PayPal payout lines to payments and lists money that left with no payment behind it", async () => {
    await executeObligation(db, story.paypal, { actor: "user:lan" });
    await confirmSettlement(db, story.paypal);
    const s = db.select().from(settlements).where(eq(settlements.obligationId, story.paypal)).get()!;
    const day = s.settledAt.slice(0, 10);
    const [y, m, d] = day.split("-");
    const csv = [
      '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","To Email Address","Transaction ID","Subject","Note","Balance"',
      `"${m}/${d}/${y}","10:01:00","PDT","Maria Santos","Mass Pay Payment","Completed","USD","-180.00","0.00","-180.00","ops@ridgeline.example","maria.santos.pp@example.com","9AB12345CD678901E","JOB-HG4D-0921","",""`,
      `"${m}/${d}/${y}","11:30:00","PDT","Unknown Person","Payout","Completed","USD","-250.00","0.00","-250.00","ops@ridgeline.example","stranger@example.com","1XY99999ZZ000001A","","",""`,
      `"${m}/${d}/${y}","09:00:00","PDT","Bank","General Credit Card Deposit","Completed","USD","1,000.00","0.00","1,000.00","","","3QQ","","",""`,
    ].join("\n");
    const lines = parsePayPalCsv(csv);
    expect(lines).toHaveLength(3);
    // The demo recipient email comes from the seed (it can be a sandbox account); align the statement with it.
    lines[0].toEmail = db.select().from(vendors).where(eq(vendors.id, "ven_maria")).get()!.paypalEmail!.toLowerCase();
    const { result } = reconcilePayPal(db, DEMO_BUSINESS_ID, as("thu"), lines, "activity.csv");
    expect(result.matched).toHaveLength(1);
    expect(result.statementOnly.map((l) => l.transactionId)).toEqual(["1XY99999ZZ000001A"]);
    expect(db.select().from(settlements).where(eq(settlements.obligationId, story.paypal)).get()!.statementRef).toBe("9AB12345CD678901E");
    expect(() => reconcilePayPal(db, DEMO_BUSINESS_ID, as("minh"), lines)).not.toThrow(); // approvers may reconcile too (they send)
  });

  it("a closed period cannot change, and only the owner reopens it", async () => {
    const today = localDateString();
    expect(() => setPeriodLock(db, DEMO_BUSINESS_ID, as("lan"), today)).toThrow(/cannot close accounting periods/);
    setPeriodLock(db, DEMO_BUSINESS_ID, as("thu"), today);
    await expect(amendObligation(db, story.blockedMismatch, "user:lan", { amountMinor: 80_000 })).rejects.toThrow(/books are closed through/);
    expect(() => setPeriodLock(db, DEMO_BUSINESS_ID, as("thu"), null)).toThrow(/Only the owner can reopen/);
    setPeriodLock(db, DEMO_BUSINESS_ID, as("daniel"), null);
    await amendObligation(db, story.blockedMismatch, "user:lan", { amountMinor: 80_000 });
  });

  it("ages what is owed from the due date", () => {
    db.update(obligations).set({ dueDate: "2026-07-01" }).where(eq(obligations.id, story.paypal)).run();
    const a = agedPayables(db, DEMO_BUSINESS_ID, "2026-10-26");
    const row = a.rows.find((r) => r.id === story.paypal)!;
    expect(row).toMatchObject({ bucket: "Over 90 days", daysOverdue: 117 });
    expect(a.totals["Over 90 days"]).toBe(18_000);
    expect(a.rows.some((r) => r.id === story.blockedMismatch)).toBe(false);
  });
});

describe("returned payouts", () => {
  async function paid() {
    const db2 = openTestDb();
    const { story: s2 } = await seedDemo(db2, { history: false });
    await executeObligation(db2, s2.paypal, { actor: "user:lan" });
    await confirmSettlement(db2, s2.paypal);
    const st = db2.select().from(settlements).where(eq(settlements.obligationId, s2.paypal)).get()!;
    const email = db2.select().from(vendors).where(eq(vendors.id, "ven_maria")).get()!.paypalEmail!.toLowerCase();
    const [y, m, d] = st.settledAt.slice(0, 10).split("-");
    const head = '"Date","Name","Type","Status","Currency","Gross","Fee","From Email Address","To Email Address","Transaction ID","Reference Txn ID","Subject","Note"';
    const payout = `"${m}/${d}/${y}","Maria Santos","Mass Pay Payment","Completed","USD","-180.00","-2.50","ap@ridgeline.example","${email}","9AB1","","",""`;
    // As PayPal writes it: from the vendor, to the business, naming the payout it reverses.
    const reversal = (ref: string) => `"${m}/${d}/${y}","Maria Santos","Payout Reversal","Completed","USD","180.00","0.00","${email}","ap@ridgeline.example","9AB2","${ref}","","Unclaimed payout returned"`;
    return { db2, s2, head, payout, reversal };
  }

  it("ties a reversal to the payout it names, marks it refunded and flags a fee that differs", async () => {
    const { db2, s2, head, payout, reversal } = await paid();
    const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
    const { result } = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, parsePayPalCsv([head, payout, reversal("9AB1")].join("\n")));
    expect(result.returned).toHaveLength(1);
    expect(result.statementOnly).toHaveLength(0);
    expect(result.feeDiffs?.[0]).toMatchObject({ statementFeeMinor: 250 });
    expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("refunded");
  });

  it("does not refund on a line that names no payout of ours, and a clerk's upload only lists it", async () => {
    const { db2, s2, head, payout, reversal } = await paid();
    const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
    const forged = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, parsePayPalCsv([head, payout, reversal("")].join("\n"))).result;
    expect(forged.returned).toHaveLength(0);
    expect(forged.returnedUnmatched?.[0].why).toMatch(/names no original transaction/);
    const lan = resolveActor(db2, DEMO_BUSINESS_ID, "lan", "clerk");
    const byClerk = reconcilePayPal(db2, DEMO_BUSINESS_ID, lan, parsePayPalCsv([head, payout, reversal("9AB1")].join("\n"))).result;
    expect(byClerk.returned?.[0].applied).toBe(false);
    expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("settled");
  });
});

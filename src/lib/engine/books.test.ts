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

  it("ties a payout and its reversal in one file in one pass, marks it refunded and flags a fee that differs (PR6-9)", async () => {
    const { db2, s2, head, payout, reversal } = await paid();
    const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
    const file = parsePayPalCsv([head, payout, reversal("9AB1")].join("\n"));
    const first = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, file).result;
    expect(first.matched).toHaveLength(1);
    expect(first.returned).toHaveLength(1);
    expect(first.returned?.[0]).toMatchObject({ obligationId: s2.paypal, applied: true });
    expect(first.returnedUnmatched).toHaveLength(0);
    expect(first.feeDiffs?.[0]).toMatchObject({ statementFeeMinor: 250 });
    expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("refunded");
    // The same file again changes nothing and refunds nothing a second time.
    const again = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, file).result;
    expect(again.returned).toHaveLength(0);
    expect(again.returnedUnmatched?.[0].why).toMatch(/already marked as come back/);
    expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("refunded");
  });

  it("ties a reversal in a later statement to a payout an earlier reconciliation tied", async () => {
    const { db2, s2, head, payout, reversal } = await paid();
    const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
    reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, parsePayPalCsv([head, payout].join("\n")));
    expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("settled");
    const { result } = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, parsePayPalCsv([head, reversal("9AB1")].join("\n")));
    expect(result.returned).toHaveLength(1);
    expect(result.statementOnly).toHaveLength(0);
    expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("refunded");
  });

  it("in one file, a reversal from someone else, for another amount, or dated before the payout is listed, not applied", async () => {
    const variants: Array<[string, (line: string) => string, RegExp]> = [
      ["another sender", (l) => l.replace(/"maria[^"]*@[^"]*"/i, '"someone.else@example.com"'), /amount, currency or sender does not match/],
      ["another amount", (l) => l.replace('"180.00"', '"90.00"'), /amount, currency or sender does not match/],
      ["dated before the payout", (l) => l.replace(/^"\d+\/\d+\/\d+"/, '"01/01/2020"'), /dated before the payout/],
    ];
    for (const [label, change, why] of variants) {
      const { db2, s2, head, payout, reversal } = await paid();
      const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
      const bad = change(reversal("9AB1"));
      expect(bad, label).not.toBe(reversal("9AB1"));
      const r = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, parsePayPalCsv([head, payout, bad].join("\n"))).result;
      expect(r.returned, label).toHaveLength(0);
      expect(r.returnedUnmatched, label).toHaveLength(1);
      expect(r.returnedUnmatched?.[0].why, label).toMatch(why);
      expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state, label).toBe("settled");
    }
  });

  describe("a reversal dated before its payout is refused on every upload, not only the first (PR7-4)", () => {
    /** The reversal line dated `days` before the payment's settlement day, as the app shows it (local time). */
    const earlier = (reversal: string, settledAt: string, days: number) => {
      const d = new Date(Date.parse(`${localDateString(new Date(settledAt))}T00:00:00Z`) - days * 86_400_000);
      const us = `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
      return reversal.replace(/^"\d+\/\d+\/\d+"/, `"${us}"`);
    };

    it("the same file a second time still refuses it", async () => {
      const { db2, s2, head, payout, reversal } = await paid();
      const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
      const settledAt = db2.select().from(settlements).where(eq(settlements.obligationId, s2.paypal)).get()!.settledAt;
      const file = parsePayPalCsv([head, payout, earlier(reversal("9AB1"), settledAt, 3)].join("\n"));
      const first = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, file).result;
      expect(first.returnedUnmatched?.[0].why).toMatch(/before the payout/);
      const second = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, file).result;
      expect(second.returned).toHaveLength(0);
      expect(second.returnedUnmatched?.[0].why).toMatch(/before the payout/);
      expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("settled");
    });

    it("a payout tied by an earlier upload is checked against the payment's own settlement date, with a day of tolerance", async () => {
      for (const [days, applied] of [[3, false], [2, false], [1, true], [0, true]] as const) {
        const { db2, s2, head, payout, reversal } = await paid();
        const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
        reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, parsePayPalCsv([head, payout].join("\n")));
        const settledAt = db2.select().from(settlements).where(eq(settlements.obligationId, s2.paypal)).get()!.settledAt;
        const r = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, parsePayPalCsv([head, earlier(reversal("9AB1"), settledAt, days)].join("\n"))).result;
        expect(r.returned, `${days} days early`).toHaveLength(applied ? 1 : 0);
        if (!applied) expect(r.returnedUnmatched?.[0].why).toMatch(/before the payout/);
        expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe(applied ? "refunded" : "settled");
      }
    });
  });

  it("a reversal whose date cannot be read is listed, never applied, on a first or a later upload (SEC7 info)", async () => {
    const { db2, s2, head, payout, reversal } = await paid();
    const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
    const unreadable = (lines: ReturnType<typeof parsePayPalCsv>) => lines.map((l) => (l.grossMinor > 0 ? { ...l, date: "not a date" } : l));
    const first = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, unreadable(parsePayPalCsv([head, payout, reversal("9AB1")].join("\n")))).result;
    expect(first.returned).toHaveLength(0);
    expect(first.returnedUnmatched?.[0].why).toMatch(/date could not be read/);
    // The payout is now tied by that upload; the same unreadable reversal is still not applied.
    const second = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, unreadable(parsePayPalCsv([head, reversal("9AB1")].join("\n")))).result;
    expect(second.returned).toHaveLength(0);
    expect(second.returnedUnmatched?.[0].why).toMatch(/date could not be read/);
    expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("settled");
  });

  it("a clerk's upload of a payout and its reversal in one file lists the reversal and applies nothing", async () => {
    const { db2, s2, head, payout, reversal } = await paid();
    const lan = resolveActor(db2, DEMO_BUSINESS_ID, "lan", "clerk");
    const r = reconcilePayPal(db2, DEMO_BUSINESS_ID, lan, parsePayPalCsv([head, payout, reversal("9AB1")].join("\n"))).result;
    expect(r.recorded).toBe(false);
    expect(r.returned).toHaveLength(0);
    expect(r.returnedUnmatched?.[0].why).toMatch(/only in this same file/);
    expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("settled");
  });

  it("a hand-made payout line with no recipient, plus a reversal naming it, reopens nothing and overwrites nothing (security round 2)", async () => {
    const { db2, s2, head } = await paid();
    const st = db2.select().from(settlements).where(eq(settlements.obligationId, s2.paypal)).get()!;
    const [y, m, d] = st.settledAt.slice(0, 10).split("-");
    const fake = `"${m}/${d}/${y}","Maria Santos","Mass Pay Payment","Completed","USD","-180.00","0.00","","","FAKEPAYOUT0001","","",""`;
    const back = `"${m}/${d}/${y}","Maria Santos","Payout Reversal","Completed","USD","180.00","0.00","","","FAKEBACK0001","FAKEPAYOUT0001","",""`;
    const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
    const r = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, parsePayPalCsv([head, fake, back].join("\n"))).result;
    expect(r.matched).toHaveLength(0);
    expect(r.returned).toHaveLength(0);
    expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("settled");
    expect(db2.select().from(settlements).where(eq(settlements.obligationId, s2.paypal)).get()!.statementRef ?? null).toBeNull();
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

  it("a clerk's upload shows matches but saves nothing, so it cannot plant an anchor or block the real line (SEC3-1, SEC3-2)", async () => {
    const { db2, s2, head, payout } = await paid();
    const lan = resolveActor(db2, DEMO_BUSINESS_ID, "lan", "clerk");
    const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
    const planted = payout.replace('"9AB1"', '"PLANTED0001"');
    const byClerk = reconcilePayPal(db2, DEMO_BUSINESS_ID, lan, parsePayPalCsv([head, planted].join("\n"))).result;
    expect(byClerk.matched).toHaveLength(1);
    expect(byClerk.recorded).toBe(false);
    const row = () => db2.select().from(settlements).where(eq(settlements.obligationId, s2.paypal)).get()!;
    expect(row().statementRef ?? null).toBeNull();
    expect(row().reconciledAt ?? null).toBeNull();
    // SEC3-2: the genuine line from PayPal still matches afterwards; nothing planted is in the way.
    const real = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, parsePayPalCsv([head, payout].join("\n"))).result;
    expect(real.recorded).toBe(true);
    expect(real.matched).toHaveLength(1);
    expect(real.statementOnly).toHaveLength(0);
    expect(row().statementRef).toBe("9AB1");
  });

  it("a reversal naming an id only a clerk planted is listed, not applied (SEC3-1)", async () => {
    const { db2, s2, head, payout, reversal } = await paid();
    const lan = resolveActor(db2, DEMO_BUSINESS_ID, "lan", "clerk");
    const thu = resolveActor(db2, DEMO_BUSINESS_ID, "thu", "accountant");
    reconcilePayPal(db2, DEMO_BUSINESS_ID, lan, parsePayPalCsv([head, payout.replace('"9AB1"', '"PLANTED0001"')].join("\n")));
    // Later the accountant uploads a file (for instance one passed on by the clerk) with a reversal for that id.
    const r = reconcilePayPal(db2, DEMO_BUSINESS_ID, thu, parsePayPalCsv([head, reversal("PLANTED0001")].join("\n"))).result;
    expect(r.returned).toHaveLength(0);
    expect(r.returnedUnmatched?.[0].why).toMatch(/not matched to a payment here/);
    expect(db2.select().from(obligations).where(eq(obligations.id, s2.paypal)).get()!.state).toBe("settled");
  });
});

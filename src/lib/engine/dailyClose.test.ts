import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { executeObligation, ingestObligation } from "./orchestrator";
import { cancelAutopilotRelease, runAutopilot, setAutonomy } from "./autopilot";
import { getDailyClose, listSignOffs, signOffDailyClose } from "./dailyClose";

async function fresh(windowSeconds = 0): Promise<Db> {
  const db = openTestDb();
  await seedDemo(db, { history: true });
  setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: windowSeconds });
  return db;
}
let n = 500;
async function clean(db: Db, amountUsd: number, guide = "Maria Santos"): Promise<string> {
  const ref = `JOB-CLOSE-${n++}`;
  return ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "job_completion",
    rawInput: `Trip closed. Lead guide ${guide}, USD ${amountUsd} (${ref}). Release payment.`,
    evidence: [{ kind: "job_sheet", label: `Trip sheet ${ref}`, amountMinor: amountUsd * 100, currency: "USD", reference: ref, excerpt: `${guide}, USD ${amountUsd}.00. Completed and signed off.` }],
    actor: "system:booking-webhook",
  });
}
const close = (db: Db) => getDailyClose(db, DEMO_BUSINESS_ID, "USD");

describe("daily close", () => {
  it("separates what the agent sent from what a person sent", async () => {
    const db = await fresh(600);
    const byHand = await clean(db, 90);
    cancelAutopilotRelease(db, byHand, "user:daniel");
    await executeObligation(db, byHand, { actor: "user:daniel" });
    setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autopilotCancelWindowSeconds: 0 });
    const byAgent = await clean(db, 120, "Ana Reyes");
    await runAutopilot(db);
    const c = close(db);
    expect(c.paidByAgent.map((p) => p.id)).toContain(byAgent);
    expect(c.paidByAgent.map((p) => p.id)).not.toContain(byHand);
    expect(c.paidByPeople.map((p) => p.id)).toContain(byHand);
    expect(c.totals.peopleMinor).toBe(9_000);
    expect(c.totals.agentMinor).toBeGreaterThanOrEqual(12_000);
    expect(c.attention.find((a) => a.id === byHand)?.kind).toBe("cancelled_release");
  });

  it("puts a last-moment refusal and a new block in the attention list", async () => {
    const db = await fresh(600);
    const id = await clean(db, 120);
    db.update(vendors).set({ paypalEmail: "attacker@example.com" }).where(eq(vendors.id, "ven_maria")).run();
    db.update(obligations).set({ releaseAt: new Date(Date.now() - 1000).toISOString() }).where(eq(obligations.id, id)).run();
    await runAutopilot(db);
    const dup = await clean(db, 180, "Ana Reyes");
    const dupAgain = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice from Maria Santos for trip JOB-HG4D-0914: USD 180.",
      evidence: [{ kind: "job_sheet", label: "Trip sheet", amountMinor: 18_000, currency: "USD", reference: "JOB-HG4D-0914", excerpt: "Maria Santos, USD 180.00." }],
      actor: "system:email-ingest",
    });
    const c = close(db);
    const kinds = new Map(c.attention.map((a) => [a.id, a.kind]));
    expect(["refused", "blocked"]).toContain(kinds.get(id));
    expect(kinds.get(dupAgain)).toBe("blocked");
    expect(kinds.has(dup)).toBe(false);
    expect(c.totals.stoppedCount).toBeGreaterThanOrEqual(2);
  });

  it("sign-off moves the window forward and changes no payment", async () => {
    const db = await fresh();
    const id = await clean(db, 120);
    await runAutopilot(db);
    const before = close(db);
    expect(before.sinceIsSignOff).toBe(false);
    expect(before.paidByAgent.map((p) => p.id)).toContain(id);
    const states = db.select({ id: obligations.id, state: obligations.state }).from(obligations).all();
    signOffDailyClose(db, DEMO_BUSINESS_ID, "USD", "user:daniel", before.throughSeq);
    expect(db.select({ id: obligations.id, state: obligations.state }).from(obligations).all()).toEqual(states);
    const after = close(db);
    expect(after.sinceIsSignOff).toBe(true);
    expect(after.paidByAgent).toEqual([]);
    expect(after.lastSignOff?.actor).toBe("user:daniel");
    expect(listSignOffs(db)[0].totals?.agentCount).toBeGreaterThanOrEqual(1);
  });

  it("refuses a sign-off when something happened after the page loaded", async () => {
    const db = await fresh();
    const seen = close(db).throughSeq;
    await clean(db, 120);
    expect(() => signOffDailyClose(db, DEMO_BUSINESS_ID, "USD", "user:daniel", seen)).toThrow(/changed since/);
  });

  it("only a person can sign off", async () => {
    const db = await fresh();
    expect(() => signOffDailyClose(db, DEMO_BUSINESS_ID, "USD", "agent:autopilot")).toThrow(/Only a person/);
  });
});

describe("daily close: payments that went out but deserve a second look", () => {
  async function payByHand(db: Db, text: string, amountUsd: number, ref: string, who: string) {
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "job_completion",
      rawInput: text,
      evidence: [{ kind: "job_sheet", label: `Trip sheet ${ref}`, amountMinor: amountUsd * 100, currency: "USD", reference: ref, excerpt: `${who}, USD ${amountUsd}.00. Completed and signed off.` }],
      actor: "system:booking-webhook",
    });
    const { approveObligation } = await import("./orchestrator");
    if (db.select().from(obligations).where(eq(obligations.id, id)).get()!.state === "awaiting_approval") approveObligation(db, id, "user:daniel", "checked");
    await executeObligation(db, id, { actor: "user:daniel" });
    return id;
  }

  it("flags an amount far above the vendor's usual, and a payment approved over warnings", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: true });
    const big = await payByHand(db, "Trip closed. Lead guide Maria Santos, USD 450 (JOB-HG7D-0990). Release payment.", 450, "JOB-HG7D-0990", "Maria Santos");
    const urgent = await payByHand(db, "URGENT pay today please. Lead guide Ana Reyes, USD 120 (JOB-PAL1D-0991).", 120, "JOB-PAL1D-0991", "Ana Reyes");
    const kinds = new Map(getDailyClose(db, DEMO_BUSINESS_ID, "USD").attention.map((a) => [a.id, a.kind]));
    expect(kinds.get(big)).toBe("unusual_amount");
    expect(kinds.get(urgent)).toBe("approved_over_warning");
  });

  it("flags the first payment ever to a vendor", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: true });
    const maria = db.select().from(vendors).where(eq(vendors.id, "ven_maria")).get()!;
    const tuanPayout = { paypalEmail: "tuan.driver@example.com", stellarAccount: null, bankLabel: "Vietcombank ****4410" };
    const { payoutHashOf } = await import("./orchestrator");
    db.insert(vendors).values({ ...maria, ...tuanPayout, id: "ven_tuan", name: "Tuan Nguyen", detailsHash: payoutHashOf(tuanPayout) }).run();
    const id = await payByHand(db, "Trip closed. Driver Tuan Nguyen, USD 90 (JOB-HG2D-0992). Release payment.", 90, "JOB-HG2D-0992", "Tuan Nguyen");
    const item = getDailyClose(db, DEMO_BUSINESS_ID, "USD").attention.find((a) => a.id === id);
    expect(item?.kind).toBe("new_vendor");
  });

  it("does not flag a routine payment to a known vendor", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: true });
    const id = await payByHand(db, "Trip closed. Lead guide Maria Santos, USD 160 (JOB-HG4D-0993). Release payment.", 160, "JOB-HG4D-0993", "Maria Santos");
    expect(getDailyClose(db, DEMO_BUSINESS_ID, "USD").attention.find((a) => a.id === id)).toBeUndefined();
  });
});

describe("daily close: a sent payout the provider says needs a person", () => {
  it("lists an unclaimed payout, and the payment is never retried", async () => {
    const { setRailsForTest, resetRails } = await import("../rails");
    const { MockPayPalRail, MockStellarRail } = await import("../rails/mock");
    const { confirmSettlement } = await import("./orchestrator");
    const { paymentAttempts } = await import("../db/schema");
    const db = openTestDb();
    await seedDemo(db, { history: true });
    const base = new MockPayPalRail();
    setRailsForTest({
      paypal: {
        rail: "paypal",
        mode: "sandbox",
        quote: (i) => base.quote(i),
        execute: async (r) => ({ status: "submitted", externalId: `BATCH-${r.idempotencyKey.slice(0, 6)}`, externalStatus: "PENDING", feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw: {} }),
        getStatus: async () => ({ status: "exception", externalStatus: "SUCCESS/UNCLAIMED", message: "Payout is UNCLAIMED: the recipient has no PayPal account for this email.", raw: {} }),
      },
      stellar: new MockStellarRail(),
    });
    try {
      const id = await ingestObligation(db, {
        businessId: DEMO_BUSINESS_ID,
        sourceType: "job_completion",
        rawInput: "Trip closed. Lead guide Maria Santos, USD 160 (JOB-HG4D-0995). Release payment.",
        evidence: [{ kind: "job_sheet", label: "Trip sheet JOB-HG4D-0995", amountMinor: 16_000, currency: "USD", reference: "JOB-HG4D-0995", excerpt: "Maria Santos, USD 160.00." }],
        actor: "system:booking-webhook",
      });
      await executeObligation(db, id, { actor: "user:daniel" });
      await confirmSettlement(db, id, "test");
      expect(db.select().from(obligations).where(eq(obligations.id, id)).get()!.state).toBe("sent");
      const item = getDailyClose(db, DEMO_BUSINESS_ID, "USD").attention.find((a) => a.id === id);
      expect(item?.kind).toBe("payout_exception");
      expect(item?.note).toMatch(/UNCLAIMED/);
      await expect(executeObligation(db, id, { actor: "user:daniel" })).rejects.toThrow();
      expect(db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, id)).all()).toHaveLength(1);
    } finally {
      resetRails();
    }
  });
});

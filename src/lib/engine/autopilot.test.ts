import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { auditEntries, obligations, paymentAttempts, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { executeObligation, ingestObligation } from "./orchestrator";
import { autopilotStatus, cancelAutopilotRelease, runAutopilot, setAutonomy, setAutopilotPaused } from "./autopilot";

/**
 * Autonomy removes the approval step and nothing else. These tests pin that down:
 * every rule that stops a payment for a person still stops it when autopilot is on.
 */

async function fresh(autonomy: "review" | "assist" | "autopilot", extra: Parameters<typeof setAutonomy>[3] = {}): Promise<Db> {
  const db = openTestDb();
  await seedDemo(db, { history: true });
  setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy, autopilotCancelWindowSeconds: 0, ...extra });
  return db;
}

let n = 100;
/** A clean request: names the vendor, the amount and a job reference that the evidence backs up. */
async function clean(db: Db, opts: { guide?: string; amountUsd: number; ref?: string }): Promise<string> {
  const ref = opts.ref ?? `JOB-TEST-${n++}`;
  const guide = opts.guide ?? "Maria Santos";
  return ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "job_completion",
    rawInput: `Trip closed. Lead guide ${guide}, USD ${opts.amountUsd} (${ref}). Release payment.`,
    evidence: [{ kind: "job_sheet", label: `Trip sheet ${ref}`, amountMinor: opts.amountUsd * 100, currency: "USD", reference: ref, excerpt: `${guide}, USD ${opts.amountUsd}.00. Completed and signed off.` }],
    actor: "system:booking-webhook",
  });
}

const get = (db: Db, id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;
const actions = (db: Db, id: string) => db.select().from(auditEntries).where(eq(auditEntries.obligationId, id)).all();

describe("autonomy levels", () => {
  it("assist keeps today's behaviour: pre-approved, nothing is sent by the agent", async () => {
    const db = await fresh("assist");
    const id = await clean(db, { amountUsd: 120 });
    expect(get(db, id).state).toBe("approved");
    expect(get(db, id).releaseAt).toBeNull();
    const r = await runAutopilot(db);
    expect(r.released).toEqual([]);
    expect(get(db, id).state).toBe("approved");
  });

  it("review makes a person approve even a clean, small payment", async () => {
    const db = await fresh("review");
    const id = await clean(db, { amountUsd: 120 });
    const ob = get(db, id);
    expect(ob.state).toBe("awaiting_approval");
    expect(ob.policyReasonsJson).toMatch(/review everything/);
  });

  it("autopilot sends a clean payment after the window, as the agent, and it settles", async () => {
    const db = await fresh("autopilot");
    const id = await clean(db, { amountUsd: 120 });
    expect(get(db, id).state).toBe("approved");
    expect(get(db, id).releaseAt).not.toBeNull();
    const r = await runAutopilot(db);
    expect(r.released).toContain(id);
    expect(get(db, id).state).toBe("settled"); // mock rail settles on the confirm pass of the same tick
    const names = actions(db, id).map((a) => `${a.actor}:${a.action}`);
    expect(names).toContain("agent:autopilot:autopilot.scheduled");
    expect(names).toContain("agent:autopilot:autopilot.releasing");
    const attempts = db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, id)).all();
    expect(attempts).toHaveLength(1);
  });

  it("autopilot waits out a cancel window", async () => {
    const db = await fresh("autopilot", { autopilotCancelWindowSeconds: 600 });
    const id = await clean(db, { amountUsd: 120 });
    const r = await runAutopilot(db);
    expect(r.released).toEqual([]);
    expect(get(db, id).state).toBe("approved");
  });
});

describe("autopilot never relaxes a block or a hold", () => {
  it("amount mismatch is still blocked", async () => {
    const db = await fresh("autopilot");
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      sourceRef: "INV-MIS-1",
      rawInput: "Invoice INV-MIS-1 from Maria Santos for trip HG-4D-0950: USD 400. Urgent, pay today.",
      evidence: [{ kind: "job_sheet", label: "Trip sheet HG-4D-0950", amountMinor: 18_000, currency: "USD", reference: "INV-MIS-1", excerpt: "Maria Santos, 4 days at USD 45/day = USD 180.00." }],
      actor: "system:email-ingest",
    });
    expect(get(db, id).state).toBe("blocked");
    expect((await runAutopilot(db)).released).not.toContain(id);
  });

  it("an already-paid job is still blocked", async () => {
    const db = await fresh("autopilot");
    const id = await clean(db, { amountUsd: 180, ref: "JOB-HG4D-0914" });
    expect(get(db, id).state).toBe("blocked");
    expect(get(db, id).blockedReason).toMatch(/already used/);
  });

  it("missing evidence is still held", async () => {
    const db = await fresh("autopilot");
    const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "operator_instruction", rawInput: "Pay Maria Santos USD 90 for the extra day", actor: "user:daniel" });
    expect(["needs_evidence", "awaiting_approval"]).toContain(get(db, id).state);
    expect((await runAutopilot(db)).released).not.toContain(id);
    expect(get(db, id).state).not.toBe("sent");
  });

  it("a payout destination changed after scheduling stops the release at the last moment", async () => {
    const db = await fresh("autopilot", { autopilotCancelWindowSeconds: 600 });
    const id = await clean(db, { amountUsd: 120 });
    expect(get(db, id).state).toBe("approved");
    // Someone edits the vendor's PayPal email during the cancel window, then the window ends.
    db.update(vendors).set({ paypalEmail: "attacker@example.com" }).where(eq(vendors.id, "ven_maria")).run();
    db.update(obligations).set({ releaseAt: new Date(Date.now() - 1000).toISOString() }).where(eq(obligations.id, id)).run();
    const r = await runAutopilot(db);
    expect(r.released).toEqual([]);
    expect(r.refused.map((x) => x.id)).toContain(id);
    const attempts = db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, id)).all();
    expect(attempts).toHaveLength(0); // no money moved, no rail was called
    expect(get(db, id).state).not.toBe("sent");
  });
});

describe("caps", () => {
  it("a payment over the per-payment cap needs a person", async () => {
    const db = await fresh("autopilot", { autopilotPerPaymentCapMinor: 50_000 });
    const id = await clean(db, { amountUsd: 600 });
    const ob = get(db, id);
    expect(ob.state).toBe("awaiting_approval");
    expect(ob.policyReasonsJson).toMatch(/per-payment cap/);
  });

  it("the daily cap counts payments across vendors", async () => {
    const db = await fresh("autopilot", { autopilotPerPaymentCapMinor: 30_000, autopilotDailyCapMinor: 40_000, autopilotCancelWindowSeconds: 600 });
    const first = await clean(db, { amountUsd: 250, guide: "Maria Santos" });
    expect(get(db, first).state).toBe("approved"); // scheduled, counts toward the cap
    const second = await clean(db, { amountUsd: 250, guide: "Ana Reyes" });
    const ob = get(db, second);
    expect(ob.state).toBe("awaiting_approval");
    expect(ob.policyReasonsJson).toMatch(/daily cap/);
    expect(autopilotStatus(db, DEMO_BUSINESS_ID).committed24hMinor).toBeGreaterThanOrEqual(25_000);
  });
});

describe("pause and cancel", () => {
  it("pausing stands scheduled payments down; resuming schedules them again", async () => {
    const db = await fresh("autopilot", { autopilotCancelWindowSeconds: 600 });
    const id = await clean(db, { amountUsd: 120 });
    expect(get(db, id).releaseAt).not.toBeNull();
    setAutopilotPaused(db, DEMO_BUSINESS_ID, "user:daniel", true);
    expect(get(db, id).releaseAt).toBeNull();
    expect(get(db, id).state).toBe("approved");
    expect((await runAutopilot(db)).released).toEqual([]);
    // While paused, new clean payments behave like assist: approved, no schedule.
    const other = await clean(db, { amountUsd: 80 });
    expect(get(db, other).releaseAt).toBeNull();
    setAutopilotPaused(db, DEMO_BUSINESS_ID, "user:daniel", false);
    const r = await runAutopilot(db);
    expect(r.scheduled).toEqual(expect.arrayContaining([id, other]));
  });

  it("a cancelled release is not rescheduled, and the payment can still be sent by hand", async () => {
    const db = await fresh("autopilot", { autopilotCancelWindowSeconds: 600 });
    const id = await clean(db, { amountUsd: 120 });
    cancelAutopilotRelease(db, id, "user:daniel");
    expect(get(db, id).releaseAt).toBeNull();
    expect(get(db, id).autopilotCancelledAt).not.toBeNull();
    const r = await runAutopilot(db);
    expect(r.scheduled).not.toContain(id);
    expect(get(db, id).releaseAt).toBeNull();
    await executeObligation(db, id, { actor: "user:daniel" });
    expect(["sent", "settled"]).toContain(get(db, id).state);
  });

  it("cannot cancel once the payment has been sent", async () => {
    const db = await fresh("autopilot");
    const id = await clean(db, { amountUsd: 120 });
    await runAutopilot(db);
    expect(() => cancelAutopilotRelease(db, id, "user:daniel")).toThrow(/already been sent|Nothing is scheduled/);
  });

  it("rejects invalid settings", async () => {
    const db = await fresh("assist");
    expect(() => setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autopilotDailyCapMinor: -5 })).toThrow();
    expect(() => setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy: "yolo" as never })).toThrow();
  });

  it("does not double-fire when two passes overlap", async () => {
    const db = await fresh("autopilot");
    const id = await clean(db, { amountUsd: 120 });
    await Promise.all([runAutopilot(db), runAutopilot(db), runAutopilot(db)]);
    const attempts = db.select().from(paymentAttempts).where(and(eq(paymentAttempts.obligationId, id))).all();
    expect(attempts).toHaveLength(1);
  });
});

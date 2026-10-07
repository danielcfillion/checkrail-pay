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

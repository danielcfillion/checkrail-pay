import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, paymentAttempts, paymentRunItems, paymentRuns, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { createRun, releaseRun, runCandidates, viewRun } from "./runs";
import { resetRails } from "../rails";

let db: Db;
let story: { blockedMismatch: string; blockedDuplicate: string; paypal: string; stellar: string };
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const state = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!.state;
const items = (runId: string) => db.select().from(paymentRunItems).where(eq(paymentRunItems.runId, runId)).all();

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  ({ story } = await seedDemo(db, { history: false }));
});
afterEach(() => {
  delete process.env.MOCK_PAYPAL_BALANCE_USD;
  resetRails();
});

describe("payment runs", () => {
  it("a clerk builds, an approver releases once: waiting items are approved, approved items are paid", async () => {
    expect(state(story.stellar)).toBe("awaiting_approval");
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.paypal, story.stellar] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("lan"));
    expect(view.releaseRefusal).toMatch(/cannot release/);
    expect(view.totals.map((t) => [t.rail, t.totalMinor])).toEqual(expect.arrayContaining([["paypal", 18_000], ["stellar", 75_000]]));
    await expect(releaseRun(db, DEMO_BUSINESS_ID, as("lan"), runId)).rejects.toThrow(/cannot release/);
    const r = await releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId);
    expect(r).toEqual({ paid: 2, skipped: 0, failed: 0, unclear: 0 });
    expect(["sent", "settled"]).toContain(state(story.paypal));
    expect(["sent", "settled"]).toContain(state(story.stellar));
    expect(db.select().from(paymentRuns).where(eq(paymentRuns.id, runId)).get()!.status).toBe("released");
    await expect(releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId)).rejects.toThrow(/released/);
    expect(db.select().from(paymentAttempts).all()).toHaveLength(2);
  });

  it("refuses to release when a rail's balance is short, before paying anything", async () => {
    process.env.MOCK_PAYPAL_BALANCE_USD = "100";
    resetRails();
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { obligationIds: [story.paypal] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    expect(view.totals[0]).toMatchObject({ rail: "paypal", short: true });
    await expect(releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId)).rejects.toThrow(/Not enough money/);
    expect(state(story.paypal)).toBe("approved");
    expect(db.select().from(paymentRuns).where(eq(paymentRuns.id, runId)).get()!.status).toBe("draft");
  });

  it("skips an item whose amount changed after it was added, and one the releaser may not approve", async () => {
    const runId = createRun(db, DEMO_BUSINESS_ID, as("daniel"), { obligationIds: [story.paypal, story.stellar] });
    db.update(obligations).set({ amountMinor: 18_100 }).where(eq(obligations.id, story.paypal)).run();
    db.update(users).set({ approvalLimitMinor: 50_000 }).where(eq(users.id, "minh")).run();
    const r = await releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId);
    expect(r).toMatchObject({ paid: 0, skipped: 2 });
    const msgs = items(runId).map((i) => i.message ?? "");
    expect(msgs.some((m) => /Amount changed/.test(m))).toBe(true);
    expect(msgs.some((m) => /approval limit/.test(m))).toBe(true);
    expect(state(story.stellar)).toBe("awaiting_approval");
  });

  it("whoever built a run does not release it while someone else can; an item is in one open run at a time", async () => {
    const runId = createRun(db, DEMO_BUSINESS_ID, as("daniel"), { obligationIds: [story.paypal] });
    await expect(releaseRun(db, DEMO_BUSINESS_ID, as("daniel"), runId)).rejects.toThrow(/You built this run/);
    expect(runCandidates(db, DEMO_BUSINESS_ID).map((c) => c.id)).not.toContain(story.paypal);
    expect(() => createRun(db, DEMO_BUSINESS_ID, as("lan"), { obligationIds: [story.paypal] })).toThrow(/cannot go in a run/);
    expect(() => createRun(db, DEMO_BUSINESS_ID, as("thu"), { obligationIds: [story.stellar] })).toThrow(/cannot build/);
  });
});

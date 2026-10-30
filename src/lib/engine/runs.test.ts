import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { auditEntries, evidence, obligations, paymentAttempts, paymentRunItems, paymentRuns, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { createRun, releaseRun, runCandidates, viewRun } from "./runs";
import { ingestObligation, previewPolicy } from "./orchestrator";
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
  /** A waiting item with nothing to read: above the auto-pay line, supported by the business's own trip sheet. */
  const cleanWaiting = () =>
    ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "job_completion", rawInput: "Trip HG-3D-1031 closed. Please pay Maria Santos USD 300 for 6 days guiding (JOB-HG3D-1031).", evidence: [{ kind: "job_sheet", label: "Trip sheet HG-3D-1031 (Maria Santos)", amountMinor: 30_000, currency: "USD", reference: "JOB-HG3D-1031", excerpt: "Maria Santos, 6 days guiding, USD 300.00 (JOB-HG3D-1031)." }], actor: "user:lan" });

  it("a clerk builds, an approver releases once: waiting items with nothing to read are approved, approved items are paid", async () => {
    const clean = await cleanWaiting();
    expect(state(clean)).toBe("awaiting_approval");
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.paypal, clean] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("lan"));
    expect(view.releaseRefusal).toMatch(/cannot release/);
    expect(view.totals.map((t) => [t.rail, t.totalMinor])).toEqual(expect.arrayContaining([["paypal", 18_000]]));
    await expect(releaseRun(db, DEMO_BUSINESS_ID, as("lan"), runId)).rejects.toThrow(/cannot release/);
    const r = await releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId);
    expect(r).toEqual({ paid: 2, with_bank: 0, skipped: 0, failed: 0, unclear: 0 });
    expect(["sent", "settled"]).toContain(state(story.paypal));
    expect(["sent", "settled"]).toContain(state(clean));
    expect(db.select().from(paymentRuns).where(eq(paymentRuns.id, runId)).get()!.status).toBe("released");
    await expect(releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId)).rejects.toThrow(/released/);
    expect(db.select().from(paymentAttempts).all()).toHaveLength(2);
  });

  it("a waiting item whose reading carries a concern is left for its own page, like one with a warning (PR8-2)", async () => {
    // Ana's request: the rules pass, but the recorded Claude run raised a concern the rules did not see.
    expect(state(story.stellar)).toBe("awaiting_approval");
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.paypal, story.stellar] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    const ana = view.items.find((i) => i.obligationId === story.stellar)!;
    expect(ana.warnings.join(" ")).toMatch(/Reader concern/);
    expect(ana).toMatchObject({ plan: "left", leftWhy: "warning" });
    const r = await releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId);
    expect(r).toMatchObject({ paid: 1, skipped: 1 });
    expect(state(story.stellar)).toBe("awaiting_approval");
    expect(items(runId).map((i) => i.message ?? "").some((m) => /Reader concern/.test(m))).toBe(true);
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

  it("leaves an item that carries a warning for its own page instead of approving it in bulk (SEC2-8)", async () => {
    db.insert(evidence).values({ id: "evd_vendorclaim", obligationId: story.stellar, kind: "receipt", label: "Invoice from the vendor", provenance: "vendor", createdAt: new Date().toISOString() }).run();
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.paypal, story.stellar] });
    // The releaser sees the warning before pressing Release.
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    expect(view.items.find((i) => i.obligationId === story.stellar)!.warnings.join(" ")).toMatch(/vendor uploaded a document/);
    expect(view.items.find((i) => i.obligationId === story.paypal)!.warnings).toEqual([]);
    const r = await releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId);
    expect(r).toMatchObject({ paid: 1, skipped: 1 });
    expect(state(story.stellar)).toBe("awaiting_approval");
    expect(items(runId).map((i) => i.message ?? "").some((m) => /warnings? a person must read first.*vendor uploaded a document/.test(m))).toBe(true);
  });

  it("viewing a run writes nothing to the record (SEC6-1)", async () => {
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.paypal, story.stellar] });
    const audits = () => db.select().from(auditEntries).all().length;
    const before = audits();
    await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    await viewRun(db, DEMO_BUSINESS_ID, runId, as("thu"));
    expect(audits()).toBe(before);
  });

  it("leaves an item that only the vendor's own documents support for its own page (SEC2-8)", async () => {
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice INV-MS-3333 from Maria Santos for 2 days guiding, USD 90.",
      evidence: [{ kind: "invoice", label: "Invoice INV-MS-3333", amountMinor: 9_000, currency: "USD", reference: "INV-MS-3333", excerpt: "Maria Santos, 2 days guiding, USD 90." }],
      actor: "user:lan",
    });
    // No warning rule fires: the only reason a person is needed is that nothing but the vendor's own say-so supports it.
    expect(previewPolicy(db, id).rules.filter((r) => r.severity === "warn" && !r.passed)).toEqual([]);
    expect(state(id)).toBe("awaiting_approval");
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Solo", obligationIds: [id] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    expect(view.items[0].warnings.join(" ")).toMatch(/vendor's own documents/);
    const r = await releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId);
    expect(r).toMatchObject({ paid: 0, skipped: 1 });
    expect(state(id)).toBe("awaiting_approval");
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

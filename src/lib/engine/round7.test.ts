import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { evidence, obligations, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, ingestObligation } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { createRun, releaseRun, viewRun } from "./runs";
import { resetRails } from "../rails";

/** Practitioner round seven (PR7-n): fixes to what round six left. */

let db: Db;
let story: { blockedMismatch: string; blockedDuplicate: string; paypal: string; stellar: string };
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  ({ story } = await seedDemo(db, { history: true }));
});
afterEach(() => resetRails());

describe("PR7-1: the run confirmation says what will be paid, and a waiting item can be approved from the run", () => {
  /** Maria's invoice: only the vendor's own documents support it, so a person reads it first. */
  const ownDocs = () =>
    ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Invoice INV-MS-7001 from Maria Santos for 2 days guiding, USD 90.", evidence: [{ kind: "invoice", label: "Invoice INV-MS-7001", amountMinor: 9_000, currency: "USD", reference: "INV-MS-7001", excerpt: "Maria Santos, 2 days guiding, USD 90." }], actor: "user:lan" });

  it("counts what a release will pay and what it will leave, the same as the release does", async () => {
    const own = await ownDocs();
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.paypal, story.stellar, own] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    // paypal is ready, stellar is waiting with nothing to read (a person approves it, release does), own is for its own page.
    expect(view.items.map((i) => [i.obligationId, i.plan, i.leftWhy])).toEqual(expect.arrayContaining([[story.paypal, "pay", null], [story.stellar, "pay", null], [own, "left", "warning"]]));
    expect(view.payNow).toMatchObject({ count: 2, approving: 1, left: 1, leftByReason: { warning: 1, limit: 0, second: 0, changed: 0, state: 0 } });
    expect(view.payNow.byCurrency).toEqual([{ currency: "USD", minor: expect.any(Number) }]);
    const r = await releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId);
    expect(r).toMatchObject({ paid: view.payNow.count, skipped: view.payNow.left });
    expect(ob(own).state).toBe("awaiting_approval");
  });

  it("an approver approves the waiting item from the run with the warnings the page showed, and the plan then includes it", async () => {
    const own = await ownDocs();
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.paypal, own] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    const item = view.items.find((i) => i.obligationId === own)!;
    expect(item.canApprove).toBe(true);
    approveObligation(db, own, "user:minh", undefined, item.fingerprints);
    expect(ob(own).state).toBe("approved");
    const after = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    expect(after.payNow).toMatchObject({ count: 2, approving: 0, left: 0 });
    expect(await releaseRun(db, DEMO_BUSINESS_ID, as("minh"), runId)).toMatchObject({ paid: 2, skipped: 0 });
  });

  it("refuses an approval when a warning appeared after the page was shown, and records nothing", async () => {
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.stellar] });
    const view = await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"));
    const item = view.items[0];
    expect(item.warnings).toEqual([]);
    // After the page was rendered, the vendor uploads a document through their link: a warning a person must read.
    db.insert(evidence).values({ id: "evd_late", obligationId: story.stellar, kind: "receipt", label: "Invoice from the vendor", provenance: "vendor", createdAt: new Date().toISOString() }).run();
    expect(() => approveObligation(db, story.stellar, "user:minh", undefined, item.fingerprints)).toThrow(/Something changed since this page was checked: .*vendor uploaded a document/);
    expect(ob(story.stellar).state).toBe("awaiting_approval");
    // Shown again, with the new warning in the fingerprints, the same person's approval goes through.
    const again = (await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"))).items[0];
    expect(again.warnings.join(" ")).toMatch(/vendor uploaded a document/);
    approveObligation(db, story.stellar, "user:minh", undefined, again.fingerprints);
    expect(ob(story.stellar).state).toBe("approved");
  });

  it("shows an approve action only to someone who may approve that item", async () => {
    const runId = createRun(db, DEMO_BUSINESS_ID, as("lan"), { name: "Friday", obligationIds: [story.stellar] });
    expect((await viewRun(db, DEMO_BUSINESS_ID, runId, as("lan"))).items[0].canApprove).toBe(false);
    expect((await viewRun(db, DEMO_BUSINESS_ID, runId, as("thu"))).items[0].canApprove).toBe(false);
    expect((await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh"))).items[0].canApprove).toBe(true);
    db.update(users).set({ approvalLimitMinor: 50_000 }).where(eq(users.id, "minh")).run();
    const over = (await viewRun(db, DEMO_BUSINESS_ID, runId, as("minh")));
    expect(over.items[0]).toMatchObject({ canApprove: false, leftWhy: "limit" });
    expect(over.payNow).toMatchObject({ count: 0, left: 1 });
  });
});

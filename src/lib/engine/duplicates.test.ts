import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { ingestObligation, runPolicy } from "./orchestrator";

let db: Db;
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  db = openTestDb();
  await seedDemo(db, { history: false });
});

/** A vendor resending the same invoice: the same reference, from the same vendor, a moment later. */
const request = (ref: string) =>
  ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "invoice",
    rawInput: `Invoice ${ref} from Maria Santos for 2 days guiding, USD 90.`,
    evidence: [{ kind: "invoice", label: `Invoice ${ref}`, amountMinor: 9_000, currency: "USD", reference: ref, excerpt: "Maria Santos, 2 days guiding, USD 90." }],
    actor: "user:lan",
  });
const duplicateRule = (id: string) => runPolicy(db, id).rules.find((r) => r.ruleId === "no_duplicate")!;

describe("duplicate requests (practitioner round 6)", () => {
  it("a blocked duplicate does not block the request it duplicates", async () => {
    const original = await request("INV-MS-7001");
    await sleep(5);
    const copy = await request("INV-MS-7001");
    // The copy is stopped, as before.
    expect(ob(copy).state).toBe("blocked");
    expect(duplicateRule(copy).passed).toBe(false);
    // The original, checked again (for instance at a run release), is not blocked by the copy it is the original of.
    expect(runPolicy(db, original).decision).not.toBe("block");
    expect(duplicateRule(original).passed).toBe(true);
    expect(ob(original).state).not.toBe("blocked");
  });

  it("an open later copy does not block the earlier request either, but the earlier one still stops the later", async () => {
    const original = await request("INV-MS-7002");
    await sleep(5);
    const copy = await request("INV-MS-7002");
    db.update(obligations).set({ state: "awaiting_approval" }).where(eq(obligations.id, copy)).run();
    expect(duplicateRule(original).passed).toBe(true);
    expect(duplicateRule(copy).passed).toBe(false);
  });

  it("a payment already committed on the job always stops an earlier open request, whatever the order", async () => {
    const earlier = await request("INV-MS-7003");
    await sleep(5);
    const later = await request("INV-MS-7003");
    // The later one was paid (the earlier was still waiting): paying the earlier too would pay the job twice.
    db.update(obligations).set({ state: "settled" }).where(eq(obligations.id, later)).run();
    const rule = duplicateRule(earlier);
    expect(rule.passed).toBe(false);
    expect(rule.message).toMatch(/already used by obligation .* \(settled\)/);
    expect(runPolicy(db, earlier).decision).toBe("block");
  });

  it("a request still waiting for evidence is not the original of a re-sent invoice with its evidence (PR7-5)", async () => {
    const unsupported = await request("INV-MS-7005");
    db.update(obligations).set({ state: "needs_evidence" }).where(eq(obligations.id, unsupported)).run();
    await sleep(5);
    const resent = await request("INV-MS-7005");
    expect(ob(resent).state).not.toBe("blocked");
    expect(duplicateRule(resent).passed).toBe(true);
    // If the resent one is paid, the earlier unsupported request can no longer be paid too.
    db.update(obligations).set({ state: "settled" }).where(eq(obligations.id, resent)).run();
    expect(duplicateRule(unsupported).passed).toBe(false);
  });

  it("a cancelled copy never counts", async () => {
    const original = await request("INV-MS-7004");
    await sleep(5);
    const copy = await request("INV-MS-7004");
    db.update(obligations).set({ state: "cancelled" }).where(eq(obligations.id, copy)).run();
    expect(duplicateRule(original).passed).toBe(true);
  });
});

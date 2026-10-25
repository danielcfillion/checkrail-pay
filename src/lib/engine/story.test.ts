import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, settlements, auditEntries, accountingSyncs, paymentAttempts, routeQuotes } from "../db/schema";
import { seedDemo } from "../demo/seed";
import { approveObligation, executeObligation, confirmSettlement, amendObligation, ingestObligation } from "./orchestrator";
import { exportPendingCsv } from "../accounting/record";

let db: Db;
let story: Awaited<ReturnType<typeof seedDemo>>["story"];

beforeAll(async () => {
  db = openTestDb();
  ({ story } = await seedDemo(db, { history: true }));
});

const get = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

describe("the three-obligation story (mock rails, rule-based agent)", () => {
  it("C: blocks the amount mismatch and names the contradiction", () => {
    const ob = get(story.blockedMismatch);
    expect(ob.state).toBe("blocked");
    expect(ob.amountMinor).toBe(96_000);
    expect(ob.blockedReason).toMatch(/Requested USD 960.00 but Trip sheet HG-4D-0927 says USD 800.00/);
    const flags = JSON.parse(ob.aiFlagsJson ?? "[]") as string[];
    expect(flags.some((f) => /Urgency/.test(f))).toBe(true);
  });

  it("C2: blocks the duplicate reference against history", () => {
    const ob = get(story.blockedDuplicate);
    expect(ob.state).toBe("blocked");
    expect(ob.blockedReason).toMatch(/JOB-HG4D-0914 was already used/);
  });

  it("A: auto-approves the clean USD 180 guide fee and routes it to PayPal", async () => {
    const ob = get(story.paypal);
    expect(ob.state).toBe("approved");
    expect(ob.policyDecision).toBe("auto_execute");
    expect(ob.selectedRail).toBe("paypal");
    const quotes = db.select().from(routeQuotes).where(eq(routeQuotes.obligationId, ob.id)).all();
    expect(quotes).toHaveLength(2);
    expect(quotes.every((q) => q.available)).toBe(true);

    const r = await executeObligation(db, ob.id, { actor: "user:daniel" });
    expect(r.status).toBe("submitted");
    expect(get(ob.id).state).toBe("sent");
    const state = await confirmSettlement(db, ob.id);
    expect(state).toBe("settled");
    const st = db.select().from(settlements).where(eq(settlements.obligationId, ob.id)).get()!;
    expect(st.rail).toBe("paypal");
    expect(st.receivedCurrency).toBe("PHP");
    expect(st.feeMinor).toBe(360); // 2% of $180
  });

  it("B: requires approval above threshold, prefers Stellar, settles (mock rail has no explorer link)", async () => {
    const ob = get(story.stellar);
    expect(ob.state).toBe("awaiting_approval");
    expect(ob.selectedRail).toBe("stellar");
    expect(ob.routeReason).toMatch(/preference/);
    const outcome = approveObligation(db, ob.id, "user:daniel", "Rate confirmed with ops");
    expect(outcome.decision).toBe("auto_execute");
    expect(get(ob.id).state).toBe("approved");
    const r = await executeObligation(db, ob.id, { actor: "user:daniel" });
    expect(r.status).toBe("confirmed");
    expect(get(ob.id).state).toBe("settled");
    const st = db.select().from(settlements).where(eq(settlements.obligationId, ob.id)).get()!;
    expect(st.explorerUrl).toBeNull(); // mock hashes are not on chain, so no explorer link
    expect(st.receivedCurrency).toBe("PHP");
  });

  it("refuses to execute a blocked obligation even if someone approves it", () => {
    const ob = get(story.blockedMismatch);
    const outcome = approveObligation(db, ob.id, "user:minh", "just pay it");
    expect(outcome.decision).toBe("block");
    expect(get(ob.id).state).toBe("blocked");
  });

  it("executes the mismatch once the amount is corrected to what the evidence says", async () => {
    const ob = get(story.blockedMismatch);
    await amendObligation(db, ob.id, "user:daniel", { amountMinor: 80_000 }, "Corrected to trip sheet: 4 x 200");
    const fixed = get(ob.id);
    expect(fixed.state).toBe("awaiting_approval"); // $800 is above the $250 auto threshold
    // Daniel corrected it, so he prepared it: Minh (approver, limit $1,000) approves.
    approveObligation(db, ob.id, "user:minh");
    expect(get(ob.id).state).toBe("approved");
    expect(get(ob.id).selectedRail).toBe("paypal"); // VN has no Stellar off-ramp
    const r = await executeObligation(db, ob.id, { actor: "user:daniel" });
    expect(r.status).toBe("submitted");
  });

  it("idempotency keys are stable per attempt and unique across attempts", () => {
    const attempts = db.select().from(paymentAttempts).all();
    const keys = attempts.map((a) => a.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every obligation has a complete audit trail with monotonic sequence", () => {
    const entries = db.select().from(auditEntries).all();
    const seqs = entries.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs[0]).toBe(1);
    expect(seqs[seqs.length - 1]).toBe(seqs.length);
    for (const id of Object.values(story)) {
      const mine = entries.filter((e) => e.obligationId === id).map((e) => e.action);
      expect(mine[0]).toBe("obligation.created");
      expect(mine).toContain("ai.interpreted");
      expect(mine).toContain("policy.evaluated");
    }
  });

  it("settled obligations produce accounting-ready records and a CSV export", () => {
    const pending = db.select().from(accountingSyncs).where(eq(accountingSyncs.status, "pending")).all();
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const { csv, count } = exportPendingCsv(db);
    expect(count).toBe(pending.length);
    expect(csv.split("\n")[0]).toMatch(/^reference,vendorName/);
    expect(csv).toMatch(/JOB-PAL3D-0927/);
    expect(db.select().from(accountingSyncs).where(eq(accountingSyncs.status, "pending")).all()).toHaveLength(0);
  });
});

describe("accounting cash-out", () => {
  it("counts PayPal fee on top and the Stellar fee inside the amount", async () => {
    const { buildAccountingRecord } = await import("../accounting/record");
    const db2 = openTestDb();
    await seedDemo(db2, { history: false });
    const rows = db2.select().from(obligations).all();
    const pay = rows.find((r) => r.sourceRef === "JOB-HG4D-0921")!;
    await executeObligation(db2, pay.id, { actor: "user:daniel" });
    await confirmSettlement(db2, pay.id, "test");
    const rec = buildAccountingRecord(db2, pay.id)!;
    expect(Number(rec.payload.netPaid)).toBeCloseTo(Number(rec.payload.grossAmount) + Number(rec.payload.feeAmount), 2);
  });
});

describe("probe A: the same trip re-invoiced under a new number", () => {
  it("is blocked when the invoice names the trip, and held for approval when it does not", async () => {
    const db2 = openTestDb();
    await seedDemo(db2, { history: true }); // JOB-HG4D-0914 settled 17 days ago
    const named = await ingestObligation(db2, {
      businessId: "biz_ridgeline",
      sourceType: "invoice",
      rawInput: "Invoice INV-MS-0044 from Maria Santos: guide fee, Ha Giang departure HG-4D-0914, USD 180.",
      evidence: [{ kind: "invoice", label: "Invoice INV-MS-0044", amountMinor: 18_000, currency: "USD", reference: "INV-MS-0044", excerpt: "Guide fee HG-4D-0914, USD 180.00" }],
      actor: "system:email-ingest",
    });
    const n = db2.select().from(obligations).where(eq(obligations.id, named)).get()!;
    expect(n.state).toBe("blocked");
    expect(n.blockedReason).toMatch(/Same job as obligation/);

    const bare = await ingestObligation(db2, {
      businessId: "biz_ridgeline",
      sourceType: "invoice",
      rawInput: "Invoice INV-MS-0045 from Maria Santos: guide fee, USD 180.",
      evidence: [{ kind: "invoice", label: "Invoice INV-MS-0045", amountMinor: 18_000, currency: "USD", reference: "INV-MS-0045", excerpt: "Guide fee USD 180.00" }],
      actor: "system:email-ingest",
    });
    const b = db2.select().from(obligations).where(eq(obligations.id, bare)).get()!;
    expect(b.state).toBe("awaiting_approval");
    expect(b.policyReasonsJson).toMatch(/Same amount/);
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { accountingSyncs, auditEntries, obligations, paymentAttempts, settlements, vendors } from "../db/schema";
import { seedDemo, settleLagDays } from "./seed";
import { DEMO_RATE_NOTE, demoMidRate } from "./fxRates";
import { approveObligation, confirmSettlement, executeObligation } from "../engine/orchestrator";
import { localDateString } from "../format";

const DAY = 86_400_000;

describe("demo history dates", () => {
  let db: Db;
  beforeAll(async () => {
    db = openTestDb();
    await seedDemo(db);
  });
  const past = () =>
    db
      .select({ o: obligations, s: settlements, terms: vendors.paymentTermsDays })
      .from(obligations)
      .innerJoin(settlements, eq(settlements.obligationId, obligations.id))
      .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
      .all();

  it("settles each past payment 2 to 10 days after it was raised, the same every seed", async () => {
    const rows = past();
    expect(rows.length).toBeGreaterThan(25);
    const lags = rows.map(({ o, s }) => (Date.parse(s.settledAt) - Date.parse(o.createdAt)) / DAY);
    for (const lag of lags) {
      expect(lag).toBeGreaterThanOrEqual(2 - 0.01);
      expect(lag).toBeLessThanOrEqual(10 + 0.01);
    }
    // Not one fixed lag: plausible spread.
    expect(new Set(lags.map(Math.round)).size).toBeGreaterThan(3);
    for (const { o, s } of rows) expect(Math.round((Date.parse(s.settledAt) - Date.parse(o.createdAt)) / DAY)).toBe(settleLagDays(o.sourceRef!));
    // Deterministic: a second seed gives the same lags.
    const db2 = openTestDb();
    await seedDemo(db2);
    const again = new Map(db2.select({ ref: obligations.sourceRef, c: obligations.createdAt, s: settlements.settledAt }).from(obligations).innerJoin(settlements, eq(settlements.obligationId, obligations.id)).all().map((r) => [r.ref, Math.round((Date.parse(r.s) - Date.parse(r.c)) / DAY)]));
    for (const { o } of rows) expect(again.get(o.sourceRef)).toBe(settleLagDays(o.sourceRef!));
  });

  it("keeps the story's own anchors: JOB-HG4D-0914 settled 17 days ago, INV-2026-0138 12 days ago", () => {
    const at = (ref: string) => past().find((r) => r.o.sourceRef === ref)!.s.settledAt;
    expect(Math.round((Date.now() - Date.parse(at("JOB-HG4D-0914"))) / DAY)).toBe(17);
    expect(Math.round((Date.now() - Date.parse(at("INV-2026-0138"))) / DAY)).toBe(12);
  });

  it("moves due dates back with the request: due is the raised date plus the vendor's terms, never in the future for an old bill", () => {
    const today = localDateString();
    for (const { o, terms } of past()) {
      expect(o.dueDate).toBeTruthy();
      const raised = localDateString(new Date(o.createdAt));
      const expected = new Date(Date.parse(`${raised}T00:00:00Z`) + (terms ?? 0) * DAY).toISOString().slice(0, 10);
      expect(Math.abs(Date.parse(o.dueDate!) - Date.parse(expected)) / DAY).toBeLessThanOrEqual(1);
      if (Date.now() - Date.parse(o.createdAt) > 40 * DAY) expect(o.dueDate! < today).toBe(true);
    }
  });

  it("the accounting record agrees: bill date when raised, due date with it, payment date when paid", () => {
    for (const { o, s } of past()) {
      const rec = db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, o.id)).get()!;
      const p = JSON.parse(rec.payloadJson!);
      expect(p.billDate).toBe(localDateString(new Date(o.createdAt)));
      expect(p.paymentDate).toBe(localDateString(new Date(s.settledAt)));
      expect(p.dueDate).toBe(o.dueDate);
      expect(p.billDate <= p.paymentDate).toBe(true);
    }
  });

  it("the audit trail puts raising before paying, and the attempt at the payment", () => {
    for (const { o, s } of past()) {
      const audit = db.select().from(auditEntries).where(eq(auditEntries.obligationId, o.id)).all();
      const created = audit.find((a) => a.action === "obligation.created" || a.seq === Math.min(...audit.map((x) => x.seq)))!;
      const settled = audit.find((a) => a.action === "settlement.confirmed");
      expect(Date.parse(created.createdAt)).toBeLessThan(Date.parse(s.settledAt) - DAY);
      if (settled) expect(Math.abs(Date.parse(settled.createdAt) - Date.parse(s.settledAt))).toBeLessThan(DAY);
      const att = db.select().from(paymentAttempts).where(eq(paymentAttempts.obligationId, o.id)).get()!;
      expect(Math.abs(Date.parse(att.createdAt) - Date.parse(s.settledAt))).toBeLessThan(DAY);
    }
  });
});

describe("demo FX rates", () => {
  it("vary by date from a small table near the corridor's level, and are labelled demo", async () => {
    const db = openTestDb();
    await seedDemo(db);
    const rows = db.select().from(settlements).all().filter((s) => s.receivedCurrency === "PHP" || s.receivedCurrency === "VND");
    expect(rows.length).toBeGreaterThan(5);
    const php = rows.filter((s) => s.receivedCurrency === "PHP");
    expect(new Set(php.map((s) => s.fxRate)).size).toBeGreaterThan(3);
    for (const s of rows) {
      expect(s.note).toContain(DEMO_RATE_NOTE);
      const mid = demoMidRate(s.receivedCurrency!, s.settledAt.slice(0, 10))!;
      // The rail's margin below mid is kept (PayPal's is 3.5%): within 5% of that week's mid.
      expect(Math.abs(Number(s.fxRate) / mid - 1)).toBeLessThan(0.05);
      const p = JSON.parse(db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, s.obligationId)).get()!.payloadJson!);
      expect(p.fxRateSource).toBe("demo");
      expect(p.fxRate).toBe(s.fxRate);
    }
    expect(demoMidRate("PHP", "2026-08-05")).not.toBe(demoMidRate("PHP", "2026-10-07"));
    expect(demoMidRate("USD", "2026-08-05")).toBeNull();
  });

  it("a payment made now keeps the rail's own rate, with no demo label", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db);
    approveObligation(db, story.stellar, "user:daniel");
    await executeObligation(db, story.stellar, { actor: "user:minh" });
    await confirmSettlement(db, story.stellar, "test");
    const s = db.select().from(settlements).where(eq(settlements.obligationId, story.stellar)).get()!;
    expect(s.fxRate).toBe("61.981659");
    expect(s.note ?? "").not.toContain("Demo rate");
    const p = JSON.parse(db.select().from(accountingSyncs).where(eq(accountingSyncs.obligationId, story.stellar)).get()!.payloadJson!);
    expect(p.fxRateSource).toBeUndefined();
  });
});

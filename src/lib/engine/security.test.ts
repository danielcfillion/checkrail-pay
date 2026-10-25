import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb } from "../db";
import { auditEntries, businesses, obligations, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, resetDemo, seedDemo } from "../demo/seed";
import { toCsv } from "../accounting/record";
import { executeObligation, ingestObligation, runPolicy, payoutHashOf } from "./orchestrator";
import { runAutopilot, setAutonomy } from "./autopilot";
import { purgeUnlinkedUploads } from "./attachments";

/** Regression tests for the 25 Oct security audit (docs/audits/security-2026-10-25.md). */

describe("F4: the demo reset cannot wipe real records", () => {
  afterEach(() => {
    delete process.env.__TEST_REAL_MONEY;
  });
  it("refuses when the database holds a business other than the demo one", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: false });
    db.insert(businesses).values({ id: "biz_real", name: "Real Co", baseCurrency: "USD", country: "US", policyJson: "{}", createdAt: "2026-10-01T00:00:00Z" }).run();
    expect(() => resetDemo(db)).toThrow(/other than the demo/);
    expect(db.select().from(obligations).all().length).toBeGreaterThan(0);
  });
});

describe("F7: CSV fields cannot start a new row", () => {
  it("quotes a bare CR and neutralises a formula after it", () => {
    const csv = toCsv([{ description: "Kalaw USD 420\r=cmd|' /C calc'!A0" } as never]);
    expect(csv).toContain(`"Kalaw USD 420\r'=cmd|' /C calc'!A0"`);
  });
});

describe("F8: a manual send spends any scheduled autopilot release", () => {
  it("clears releaseAt when a person sends a scheduled payment", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: true });
    setAutonomy(db, DEMO_BUSINESS_ID, "user:daniel", { autonomy: "autopilot", autopilotCancelWindowSeconds: 600 });
    await runAutopilot(db);
    const before = db.select().from(obligations).where(eq(obligations.id, story.paypal)).get()!;
    expect(before.releaseAt).not.toBeNull();
    await executeObligation(db, story.paypal, { actor: "user:daniel" });
    expect(db.select().from(obligations).where(eq(obligations.id, story.paypal)).get()!.releaseAt).toBeNull();
  });
});

describe("two vendors paid to one destination", () => {
  it("raises payout_shared", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    const maria = db.select().from(vendors).where(eq(vendors.id, "ven_maria")).get()!;
    db.update(vendors).set({ paypalEmail: maria.paypalEmail, detailsHash: payoutHashOf({ paypalEmail: maria.paypalEmail, stellarAccount: null, bankLabel: "UnionBank ****0923" }), stellarAccount: null }).where(eq(vendors.id, "ven_ana")).run();
    const out = runPolicy(db, story.stellar);
    expect(out.rules.some((r) => r.ruleId === "payout_shared" && !r.passed)).toBe(true);
  });
});

describe("F13: polling an unchanged payout does not grow the audit log", () => {
  it("a second identical autopilot check writes no row", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    const { confirmSettlement } = await import("./orchestrator");
    const { setRailsForTest, resetRails } = await import("../rails");
    const { MockPayPalRail, MockStellarRail } = await import("../rails/mock");
    const pp = new MockPayPalRail();
    (pp as unknown as { getStatus: () => Promise<unknown> }).getStatus = async () => ({ status: "pending", externalStatus: "PENDING/UNCLAIMED", raw: null });
    setRailsForTest({ paypal: pp, stellar: new MockStellarRail() });
    try {
      await executeObligation(db, story.paypal, { actor: "user:daniel" });
      const count = () => db.select().from(auditEntries).where(eq(auditEntries.obligationId, story.paypal)).all().filter((a) => a.action.startsWith("settlement.checked")).length;
      await confirmSettlement(db, story.paypal, "autopilot");
      const after1 = count();
      await confirmSettlement(db, story.paypal, "autopilot");
      await confirmSettlement(db, story.paypal, "autopilot");
      expect(count()).toBe(after1);
    } finally {
      resetRails();
    }
  });
});

describe("F16: uploads never attached are purged", () => {
  it("removes unlinked uploads older than a day and keeps the rest", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: false });
    const { attachments } = await import("../db/schema");
    const row = { businessId: DEMO_BUSINESS_ID, name: "x.txt", mimeType: "text/plain", bytes: Buffer.from("x"), sizeBytes: 1, sha256: "s", extractedText: "x", reader: "plain", proposedJson: "[]", uploadedBy: "user:daniel" };
    db.insert(attachments).values({ ...row, id: "att_old", obligationId: null, createdAt: "2026-01-01T00:00:00.000Z" }).run();
    db.insert(attachments).values({ ...row, id: "att_new", obligationId: null, createdAt: new Date().toISOString() }).run();
    expect(purgeUnlinkedUploads(db)).toBe(1);
    expect(db.select().from(attachments).all().map((a) => a.id)).toEqual(["att_new"]);
  });
});

describe("F17: amend cannot swap one payee for another", () => {
  it("refuses a vendor change on an obligation that already has a payee", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    const { amendObligation } = await import("./orchestrator");
    await expect(amendObligation(db, story.blockedMismatch, "user:daniel", { vendorId: "ven_maria" })).rejects.toThrow(/already has a payee/);
  });
});

describe("ingest stays usable after validation", () => {
  it("a normal request still goes through", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: false });
    const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Invoice from Maria Santos JOB-X-1001 USD 100", evidence: [{ kind: "invoice", label: "Invoice JOB-X-1001", amountMinor: 10_000, currency: "usd", reference: "JOB-X-1001", excerpt: "Maria Santos USD 100" }], actor: "system:test" });
    expect(db.select().from(obligations).where(eq(obligations.id, id)).get()).toBeTruthy();
  });
});

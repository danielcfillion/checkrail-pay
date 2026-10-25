import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { approvals, auditEntries, obligations } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, ingestObligation } from "./orchestrator";
import { enterLogin } from "./requestContext";

const big = (db: Db, actor: string) =>
  ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "job_completion",
    rawInput: "Trip PAL-7D-1101 closed. Guide Ana Reyes, 7-day private expedition, USD 6,000 (JOB-PAL7D-1101). Release payment.",
    evidence: [{ kind: "job_sheet", label: "Trip sheet PAL-7D-1101", amountMinor: 600_000, currency: "USD", reference: "JOB-PAL7D-1101", excerpt: "Ana Reyes, 7 days, USD 6,000.00" }],
    actor,
  });

afterEach(() => {
  delete process.env.CHECKRAIL_USERS;
});

describe("one person is one person, whatever persona they act as (security re-audit G1)", () => {
  it("an owner cannot give the second of two approvals by switching persona", async () => {
    process.env.CHECKRAIL_USERS = "owner:pw:admin,appr:pw:approver";
    const db = openTestDb();
    await seedDemo(db, { history: false });
    const id = await big(db, "system:booking-webhook");
    enterLogin("owner");
    approveObligation(db, id, "user:owner");
    expect(() => approveObligation(db, id, "user:daniel")).toThrow(/already approved/);
    expect(db.select().from(obligations).where(eq(obligations.id, id)).get()!.state).toBe("awaiting_approval");
    expect(db.select().from(approvals).where(eq(approvals.obligationId, id)).all()[0].login).toBe("owner");
  });

  it("with one login, personas are not other people: preparing as Lan and approving as Minh is a recorded self-approval", async () => {
    process.env.CHECKRAIL_USERS = "owner:pw:admin";
    const db = openTestDb();
    await seedDemo(db, { history: false });
    enterLogin("owner");
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice INV-JM-9010 Jake Morrison: edit package, total USD 400.",
      evidence: [{ kind: "invoice", label: "Invoice INV-JM-9010", amountMinor: 40_000, currency: "USD", reference: "INV-JM-9010", excerpt: "Jake Morrison, USD 400.00" }],
      actor: "user:lan",
    });
    approveObligation(db, id, "user:minh");
    const rows = db.select().from(auditEntries).where(eq(auditEntries.obligationId, id)).all();
    expect(rows.some((r) => r.action === "approval.self")).toBe(true);
    const granted = rows.find((r) => r.action === "approval.granted")!;
    expect(JSON.parse(granted.detailJson!).login).toBe("owner");
  });

  it("seeded demo people are not counted as approvers a real deployment does not have", async () => {
    process.env.CHECKRAIL_USERS = "solo:pw:admin";
    const db = openTestDb();
    await seedDemo(db, { history: false });
    enterLogin("solo");
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice INV-JM-9011 Jake Morrison: edit package, total USD 400.",
      evidence: [{ kind: "invoice", label: "Invoice INV-JM-9011", amountMinor: 40_000, currency: "USD", reference: "INV-JM-9011", excerpt: "Jake Morrison, USD 400.00" }],
      actor: "user:solo",
    });
    expect(() => approveObligation(db, id, "user:solo")).not.toThrow();
  });
});

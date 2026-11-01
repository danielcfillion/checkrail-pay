import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { bills, evidence, obligations } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { addEvidence, ingestObligation, repayRefunded } from "./orchestrator";
import { uploadDocument } from "./attachments";
import { textPdf } from "../api/testPdf";

/**
 * Review round 2, M1: a bill total sets the ceiling for every later payment under that reference, so a request from an
 * outside actor (an agent, mcp:, or an integration, api:) may set one only from the business's own records
 * (provenance "system"). Its own PDF, a supplier's record or its typing does not.
 */

let db: Db;
beforeEach(async () => {
  db = openTestDb();
  await seedDemo(db, { history: false });
});
afterEach(() => (db as unknown as { $client: { close(): void } }).$client.close());

const RAW = "50% deposit USD 100 for Rosa Villanueva on invoice INV-ROSA-7777";
const stated = { vendorId: "ven_rosa", amountMinor: 10_000, currency: "USD", sourceRef: "INV-ROSA-7777", flags: [], trusted: false };
const rosaBill = () => db.select().from(bills).all().filter((b) => b.reference === "INV-ROSA-7777");

async function depositWithPdf(actor: string) {
  const up = await uploadDocument(db, { businessId: DEMO_BUSINESS_ID, name: "INV-ROSA-7777.pdf", mimeType: "application/pdf", bytes: textPdf(["Invoice INV-ROSA-7777", "Rosa Villanueva", "Guiding, November", "Total USD 5,000.00", "Deposit 50%"]), actor });
  const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", sourceRef: "INV-ROSA-7777", rawInput: RAW, evidence: [{ ...up.proposed[0], attachmentId: up.attachmentId }], evidenceSource: "operator", actor, stated });
  expect(db.select().from(evidence).where(eq(evidence.obligationId, id)).all().map((e) => [e.provenance, e.amountMinor])).toEqual([["document", 500_000]]);
  return id;
}

describe("who may set a bill total", () => {
  it("a clerk's uploaded invoice does, as before", async () => {
    await depositWithPdf("user:lan");
    expect(rosaBill().map((b) => b.totalMinor)).toEqual([500_000]);
  });

  it("an outside agent's or an integration's own PDF does not", async () => {
    await depositWithPdf("mcp:assistant");
    expect(rosaBill()).toEqual([]);
    await depositWithPdf("api:erp");
    expect(rosaBill()).toEqual([]);
  });

  it("a supplier's record carried by an outside agent does not", async () => {
    await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID, sourceType: "invoice", sourceRef: "INV-ROSA-7777", rawInput: RAW, actor: "mcp:supplier-agent", stated,
      evidence: [{ kind: "invoice", label: "Invoice INV-ROSA-7777", amountMinor: 500_000, currency: "USD", reference: "INV-ROSA-7777", excerpt: "Rosa Villanueva. Total USD 5,000.00. Deposit 50%." }],
      evidenceProvenance: ["vendor"],
    });
    expect(rosaBill()).toEqual([]);
  });

  it("S1 (round 3): a supplier's invoice added to a clerk's deposit sets no bill total", async () => {
    const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "operator_instruction", rawInput: "50% deposit USD 100 for Rosa Villanueva on invoice INV-ROSA-7777", actor: "user:lan" });
    expect(rosaBill()).toEqual([]);
    await addEvidence(db, id, "vendor:ven_rosa", { kind: "invoice", label: "Invoice INV-ROSA-7777 (from the vendor)", amountMinor: 500_000, currency: "USD", reference: "INV-ROSA-7777", excerpt: "Rosa Villanueva. Guiding, November. Total USD 5,000.00. Deposit 50%.", provenance: "vendor" }, null);
    expect(db.select().from(evidence).where(eq(evidence.obligationId, id)).all().map((e) => e.provenance)).toEqual(["vendor"]);
    expect(rosaBill()).toEqual([]);
  });

  it("S2 (round 3): paying again a returned integration request does not turn its document into a bill total", async () => {
    const first = await depositWithPdf("api:erp");
    expect(rosaBill()).toEqual([]);
    db.update(obligations).set({ state: "refunded" }).where(eq(obligations.id, first)).run();
    const again = await repayRefunded(db, first, "user:minh");
    expect(db.select().from(evidence).where(eq(evidence.obligationId, again)).all().map((e) => e.provenance)).toEqual(["document"]);
    expect(rosaBill()).toEqual([]);
  });

  it("a person's own uploaded invoice paid again still records the bill, as before", async () => {
    const first = await depositWithPdf("user:lan");
    db.delete(bills).run();
    db.update(obligations).set({ state: "refunded", billId: null }).where(eq(obligations.id, first)).run();
    await repayRefunded(db, first, "user:minh");
    expect(rosaBill().map((b) => b.totalMinor)).toEqual([500_000]);
  });

  it("the business's own records from an attest integration still do", async () => {
    await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID, sourceType: "invoice", sourceRef: "INV-ROSA-7777", rawInput: RAW, actor: "api:ledger", stated: { ...stated, trusted: true }, evidenceSource: "system",
      evidence: [{ kind: "invoice", label: "Invoice INV-ROSA-7777", amountMinor: 500_000, currency: "USD", reference: "INV-ROSA-7777", excerpt: "Rosa Villanueva. Total USD 5,000.00. Deposit 50%." }],
    });
    expect(rosaBill().map((b) => b.totalMinor)).toEqual([500_000]);
  });
});

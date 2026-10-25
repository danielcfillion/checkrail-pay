import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { evidence, obligations, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { confirmSettlement, executeObligation, ingestObligation } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { createEvidenceRequest, createRemittanceLink, remittanceMessage, submitEvidence, viewEvidenceRequest, viewRemittance } from "./vendorLinks";
import { resetRails } from "../rails";

let db: Db;
let story: { paypal: string };
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  ({ story } = await seedDemo(db, { history: false }));
});

describe("vendor links", () => {
  it("a remittance advice shows what was paid, in Vietnamese for a Vietnamese vendor", async () => {
    expect(() => createRemittanceLink(db, DEMO_BUSINESS_ID, as("lan"), story.paypal)).toThrow(/has been sent/);
    await executeObligation(db, story.paypal, { actor: "user:lan" });
    await confirmSettlement(db, story.paypal);
    const token = createRemittanceLink(db, DEMO_BUSINESS_ID, as("lan"), story.paypal);
    const r = viewRemittance(db, token)!;
    expect(r).toMatchObject({ vendorName: "Maria Santos", amount: "USD 180.00", status: "paid", language: "en" });
    expect(remittanceMessage(r, "https://x/remit/t")).toMatch(/^Hi Maria Santos, Ridgeline Expeditions LLC has paid USD 180.00 for JOB-HG4D-0921/);
    expect(remittanceMessage({ ...r, language: "vi", vendorName: "Phuong Transport" }, "u")).toMatch(/^Chào Phuong Transport, .* đã thanh toán USD 180.00/);
    expect(viewRemittance(db, "x".repeat(32))).toBeNull();
  });

  it("an evidence request lets the vendor upload once, and the upload is checked as the vendor's claim", async () => {
    const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "operator_instruction", rawInput: "Pay Tam Motorbike Rental USD 180 for INV-TAM-1015, bikes for HG-4D-1015.", actor: "user:lan" });
    expect(ob(id).state).toBe("needs_evidence");
    expect(() => createEvidenceRequest(db, DEMO_BUSINESS_ID, as("thu"), id, null)).toThrow(/cannot ask vendors/);
    const token = createEvidenceRequest(db, DEMO_BUSINESS_ID, as("lan"), id, "The rental invoice please");
    expect(viewEvidenceRequest(db, token)).toMatchObject({ vendorName: "Tam Motorbike Rental", note: "The rental invoice please", used: false });
    const text = "Tam Motorbike Rental\nInvoice INV-TAM-1015\n6 bikes x 2 days x USD 15 = USD 180.00\nTotal USD 180.00";
    await submitEvidence(db, token, { name: "invoice.txt", mimeType: "text/plain", bytes: Buffer.from(text) });
    const ev = db.select().from(evidence).where(eq(evidence.obligationId, id)).all();
    expect(ev).toHaveLength(1);
    expect(ev[0].provenance).toBe("vendor");
    expect(ob(id).state).not.toBe("needs_evidence");
    expect(ob(id).policyReasonsJson).toMatch(/vendor uploaded a document/);
    await expect(submitEvidence(db, token, { name: "again.txt", mimeType: "text/plain", bytes: Buffer.from(text) })).rejects.toThrow(/already been used/);
  });
});

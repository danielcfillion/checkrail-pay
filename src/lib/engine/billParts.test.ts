import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { ingestObligation, previewPolicy } from "./orchestrator";
import { uploadDocument } from "./attachments";
import { createBill, payBill } from "./bills";
import { resolveActor } from "./users";
import { textPdf } from "../api/testPdf";

/**
 * Review round 4: parts of one bill from people. They are told when a part looks like an earlier one and always see
 * which part this is, but otherwise go exactly as before: equal instalments are not duplicates.
 */

let db: Db;
beforeEach(async () => {
  db = openTestDb();
  await seedDemo(db, { history: false });
});
afterEach(() => (db as unknown as { $client: { close(): void } }).$client.close());

const lan = () => resolveActor(db, DEMO_BUSINESS_ID, "lan", "clerk");
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;
const repeatRule = (id: string) => previewPolicy(db, id).rules.find((r) => r.ruleId === "bill_part_repeat");
const partRule = (id: string) => previewPolicy(db, id).rules.find((r) => r.ruleId === "bill_part");

describe("parts of one bill from people", () => {
  it("equal instalments that each attach the bill's own invoice PDF both go through, with a note", async () => {
    const bill = createBill(db, DEMO_BUSINESS_ID, lan(), "ven_rosa", { kind: "invoice", reference: "INV-ROSA-9001", totalMinor: 60_000, currency: "USD" });
    const pdf = textPdf(["Invoice INV-ROSA-9001", "Rosa Villanueva", "Guiding, December", "Total USD 600.00", "Payable in two instalments"]);
    const instalment = async (n: number) => {
      const up = await uploadDocument(db, { businessId: DEMO_BUSINESS_ID, name: "INV-ROSA-9001.pdf", mimeType: "application/pdf", bytes: pdf, actor: "user:lan" });
      return ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", sourceRef: "INV-ROSA-9001", rawInput: `Instalment ${n} of 2: please pay USD 300 to Rosa Villanueva on invoice INV-ROSA-9001.`, evidence: [{ ...up.proposed[0], attachmentId: up.attachmentId }], actor: "user:lan" });
    };
    const first = await instalment(1);
    const second = await instalment(2);
    expect([ob(first).billId, ob(second).billId]).toEqual([bill, bill]);
    expect(ob(second).state).toBe(ob(first).state);
    expect(ob(second).policyDecision).toBe(ob(first).policyDecision);
    expect(previewPolicy(db, second).rules.find((r) => r.ruleId === "no_duplicate")?.passed).toBe(true);
    expect(repeatRule(second)).toMatchObject({ severity: "info", message: "Bill INV-ROSA-9001 already has another part (USD 300.00). A person confirms this is a separate payment." });
  });

  it("a deposit and a balance of equal amounts from the bill page both go through", async () => {
    const bill = createBill(db, DEMO_BUSINESS_ID, lan(), "ven_rosa", { kind: "invoice", reference: "INV-ROSA-9002", totalMinor: 60_000, currency: "USD" });
    const dep = await payBill(db, DEMO_BUSINESS_ID, lan(), bill, 30_000);
    const bal = await payBill(db, DEMO_BUSINESS_ID, lan(), bill, 30_000);
    expect(ob(bal).paymentKind).toBe("balance");
    expect([ob(dep).state, ob(bal).state]).not.toContain("blocked");
    expect(ob(bal).policyDecision).toBe(ob(dep).policyDecision);
    expect(repeatRule(bal)?.severity).toBe("info");
  });

  it("three equal parts from the bill page all go through, each saying which part it is", async () => {
    const bill = createBill(db, DEMO_BUSINESS_ID, lan(), "ven_rosa", { kind: "invoice", reference: "INV-ROSA-9003", totalMinor: 90_000, currency: "USD" });
    const ids = [await payBill(db, DEMO_BUSINESS_ID, lan(), bill, 30_000), await payBill(db, DEMO_BUSINESS_ID, lan(), bill, 30_000), await payBill(db, DEMO_BUSINESS_ID, lan(), bill, 30_000)];
    expect(ids.map((id) => ob(id).state)).not.toContain("blocked");
    expect(new Set(ids.map((id) => ob(id).policyDecision)).size).toBe(1);
    // Part 1 was read before the others existed; read now, it lists them.
    expect(partRule(ids[0])?.message).toMatch(/^Part 1 of bill INV-ROSA-9003; other parts: USD 300\.00, /);
    expect(partRule(ids[2])?.message).toMatch(/^Part 3 of bill INV-ROSA-9003; other parts: USD 300\.00, [a-z ]+ \d{1,2} [A-Z][a-z]{2}; USD 300\.00, /);
    // An approver sees it among the reasons.
    expect(JSON.parse(ob(ids[2]).policyReasonsJson ?? "[]").join(" ")).toMatch(/Part 3 of bill INV-ROSA-9003/);
  });
});

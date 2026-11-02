import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb } from "../db";
import { obligations, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, ingestObligation } from "../engine/orchestrator";
import { createBill, payBill } from "../engine/bills";
import { resolveActor } from "../engine/users";
import { xeroBillRows } from "./xeroBills";

describe("Xero bills the accountant can post", () => {
  it("uses the invoice's own dates, a clean description, no withholding line (the bill is gross), a prepayment account for advances, and credit notes", async () => {
    const db = openTestDb();
    await seedDemo(db, { history: false });
    const lan = resolveActor(db, DEMO_BUSINESS_ID, "lan", "clerk");
    // Jake has no W-9 on file: 24% backup withholding.
    db.update(vendors).set({ taxForm: null }).where(eq(vendors.id, "ven_jake")).run();
    const id = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Invoice INV-JM-1030 from Jake Morrison. Date: 3 October 2026. Net 14. October video edits, USD 450.",
      evidence: [{ kind: "invoice", label: "Invoice INV-JM-1030", amountMinor: 45_000, currency: "USD", reference: "INV-JM-1030", excerpt: "Jake Morrison, October video edits, USD 450.00" }],
      actor: "user:lan",
    });
    const o = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
    expect(o).toMatchObject({ invoiceDate: "2026-10-03", dueDate: "2026-10-17", withheldMinor: 10_800 });
    approveObligation(db, id, "user:daniel");
    const adv = createBill(db, DEMO_BUSINESS_ID, lan, "ven_maria", { kind: "advance", reference: "ADV-MS-02", totalMinor: 30_000, currency: "USD" });
    approveObligation(db, await payBill(db, DEMO_BUSINESS_ID, lan, adv, 30_000), "user:minh");
    createBill(db, DEMO_BUSINESS_ID, lan, "ven_dao", { kind: "credit_note", reference: "CN-DML-01", totalMinor: 8_500, currency: "USD", billDate: "2026-10-20", note: "One room not used" });
    const rows = xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows;
    const jake = rows.filter((r) => r["*InvoiceNumber"] === "INV-JM-1030");
    // The bill at gross: the 24% kept back is settled as a payment from the withholding account, not a line on the bill.
    expect(jake).toHaveLength(1);
    expect(jake[0]).toMatchObject({ "*InvoiceDate": "2026-10-03", "*DueDate": "2026-10-17", "*UnitAmount": "450.00", Description: "Content services INV-JM-1030" });
    expect(rows.find((r) => r["*InvoiceNumber"] === "ADV-MS-02")).toMatchObject({ "*AccountCode": "620", Description: "Cash advance ADV-MS-02" });
    expect(rows.find((r) => r["*InvoiceNumber"] === "CN-DML-01")).toMatchObject({ "*UnitAmount": "-85.00", "*InvoiceDate": "2026-10-20", "*ContactName": "Dao Mountain Lodge" });
  });
});

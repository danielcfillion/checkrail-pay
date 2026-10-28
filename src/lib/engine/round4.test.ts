import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { evidence, obligations, users, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, confirmSettlement, executeObligation, ingestObligation, repayRefunded, runPolicy } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { markReturnedByHand, setPeriodLock } from "./books";
import { form1099Report } from "./taxes";
import { exportNewXeroBills, xeroBillRows } from "../accounting/xeroBills";
import { resetRails } from "../rails";

/** The round-four (27 Oct) practitioner findings. */
let db: Db;
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  await seedDemo(db, { history: false });
});

async function paidJake(ref: string, text = "") {
  const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: `Invoice ${ref} from Jake Morrison, video edits, USD 200.${text}`, evidence: [{ kind: "invoice", label: `Invoice ${ref}`, amountMinor: 20_000, currency: "USD", reference: ref, excerpt: "Jake Morrison, video edits, USD 200.00" }], actor: "user:lan" });
  if (ob(id).state === "awaiting_approval") approveObligation(db, id, "user:daniel");
  await executeObligation(db, id, { actor: "user:daniel" });
  await confirmSettlement(db, id);
  return id;
}

describe("round four", () => {
  it("a payment that came back, paid again, is one Xero bill, keeps its evidence weight, and is out of the 1099 total", async () => {
    const id = await paidJake("INV-JM-0095");
    exportNewXeroBills(db, DEMO_BUSINESS_ID, "user:thu");
    const before = form1099Report(db, DEMO_BUSINESS_ID, new Date().getFullYear()).find((r) => r.vendorId === "ven_jake")?.paidMinor ?? 0;
    expect(() => markReturnedByHand(db, DEMO_BUSINESS_ID, as("lan"), id, "9TX12345")).toThrow(/cannot record money that came back/);
    markReturnedByHand(db, DEMO_BUSINESS_ID, as("thu"), id, "9TX12345");
    expect(ob(id).state).toBe("refunded");
    expect(form1099Report(db, DEMO_BUSINESS_ID, new Date().getFullYear()).find((r) => r.vendorId === "ven_jake")?.paidMinor ?? 0).toBe(before - 20_000);
    const again = await repayRefunded(db, id, "user:lan");
    expect(xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows.some((r) => r["*InvoiceNumber"] === "INV-JM-0095")).toBe(false);
    expect(db.select().from(evidence).where(eq(evidence.obligationId, again)).all().map((e) => e.provenance)).toEqual(db.select().from(evidence).where(eq(evidence.obligationId, id)).all().map((e) => e.provenance));
    // The details it went to bounced: a person confirms them before it goes again.
    expect(runPolicy(db, again).rules.find((r) => r.ruleId === "payout_returned")?.passed).toBe(false);
  });

  it("posts a late invoice dated in a closed month on the first open day, keeping its own date in the description", async () => {
    setPeriodLock(db, DEMO_BUSINESS_ID, as("daniel"), "2026-09-30");
    const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Invoice INV-JM-0920 from Jake Morrison. Date: 20 September 2026. Video edits, USD 200.", evidence: [{ kind: "invoice", label: "Invoice INV-JM-0920", amountMinor: 20_000, currency: "USD", reference: "INV-JM-0920", excerpt: "Jake Morrison, USD 200.00" }], actor: "user:lan" });
    approveObligation(db, id, "user:daniel");
    const row = xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows.find((r) => r["*InvoiceNumber"] === "INV-JM-0920")!;
    expect(row["*InvoiceDate"]).toBe("2026-10-01");
    expect(String(row.Description)).toMatch(/invoice dated 2026-09-20/);
  });

  it("warns on an invoice dated in the future", async () => {
    const id = await ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: "Invoice INV-JM-2099 from Jake Morrison. Date: 1 January 2099. Video edits, USD 200.", evidence: [{ kind: "invoice", label: "Invoice INV-JM-2099", amountMinor: 20_000, currency: "USD", reference: "INV-JM-2099", excerpt: "Jake Morrison, USD 200.00" }], actor: "user:lan" });
    expect(runPolicy(db, id).rules.find((r) => r.ruleId === "invoice_date")?.passed).toBe(false);
    void vendors;
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations, routeQuotes, settlements, users, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, confirmSettlement, executeObligation, ingestObligation, repayRefunded, setObligationDates } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { updateVendorProfile } from "./vendors";
import { setPeriodLock } from "./books";
import { transition } from "../domain/stateMachine";
import { remittanceMessageFor, type Remittance } from "./vendorLinks";
import { resetRails } from "../rails";

/** The 27 Oct findings from both auditors, each with a test. */
let db: Db;
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;
const jake = (ref: string, extra = "") =>
  ingestObligation(db, { businessId: DEMO_BUSINESS_ID, sourceType: "invoice", rawInput: `Invoice ${ref} from Jake Morrison, video edits, USD 450.${extra}`, evidence: [{ kind: "invoice", label: `Invoice ${ref}`, amountMinor: 45_000, currency: "USD", reference: ref, excerpt: "Jake Morrison, video edits, USD 450.00" }], actor: "user:lan" });

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  await seedDemo(db, { history: false });
});

describe("round three", () => {
  it("only an approver changes a vendor's country, which decides the tax kept back", () => {
    const v = db.select().from(vendors).where(eq(vendors.id, "ven_jake")).get()!;
    const profile = { name: v.name, role: v.role, country: "CA", email: v.email, notes: v.notes, defaultAccountCode: v.defaultAccountCode, taxType: v.taxType, taxForm: v.taxForm, withholdingBps: v.withholdingBps, phone: v.phone, taxId: v.taxId, paymentTermsDays: v.paymentTermsDays, retainerMinor: v.retainerMinor };
    expect(() => updateVendorProfile(db, DEMO_BUSINESS_ID, as("lan"), "ven_jake", profile)).toThrow(/Country, tax form and withholding/);
    expect(() => updateVendorProfile(db, DEMO_BUSINESS_ID, as("minh"), "ven_jake", profile)).not.toThrow();
  });

  it("keeps invoice dates out of a closed month and out of the future", async () => {
    const id = await jake("INV-JM-2001", " Date: 20 October 2026.");
    setPeriodLock(db, DEMO_BUSINESS_ID, as("daniel"), "2026-09-30");
    expect(() => setObligationDates(db, id, "user:lan", { invoiceDate: "2026-09-15", dueDate: null })).toThrow(/closed through 2026-09-30/);
    expect(() => setObligationDates(db, id, "user:lan", { invoiceDate: "2099-01-01", dueDate: null })).toThrow(/in the future/);
    expect(() => setObligationDates(db, id, "user:lan", { invoiceDate: "2026-10-21", dueDate: "2026-11-04" })).not.toThrow();
  });

  it("quotes again when tax withheld changed what is sent, so the settlement records what the vendor got", async () => {
    const id = await jake("INV-JM-2002");
    approveObligation(db, id, "user:daniel");
    // The W-9 is removed after intake: 24% is now kept back, but the quote was for USD 450.
    db.update(vendors).set({ taxForm: null }).where(eq(vendors.id, "ven_jake")).run();
    await executeObligation(db, id, { actor: "user:daniel", rail: "paypal" }).catch(() => undefined);
    if (ob(id).state === "awaiting_approval") approveObligation(db, id, "user:daniel");
    if (ob(id).state === "approved") await executeObligation(db, id, { actor: "user:daniel", rail: "paypal" });
    await confirmSettlement(db, id);
    const s = db.select().from(settlements).where(eq(settlements.obligationId, id)).get()!;
    expect(s.grossMinor).toBe(34_200);
    expect(s.receivedMinor).toBe(34_200);
    expect(db.select().from(routeQuotes).where(eq(routeQuotes.obligationId, id)).all().find((q) => q.rail === "paypal")!.sendAmountMinor).toBe(34_200);
  });

  it("pays a returned payment again through every check, once", async () => {
    const id = await jake("INV-JM-2003");
    approveObligation(db, id, "user:daniel");
    await executeObligation(db, id, { actor: "user:daniel" });
    await confirmSettlement(db, id);
    transition(db, id, "refunded", "user:thu", "settlement.returned", {});
    const again = await repayRefunded(db, id, "user:lan");
    expect(ob(again).sourceRef).toBe("INV-JM-2003");
    expect(ob(again).state).not.toBe("blocked"); // a refunded payment does not count as already paid
    await expect(repayRefunded(db, id, "user:lan")).rejects.toThrow(/Already requested again/);
  });

  it("writes one remittance message per vendor, and says on its way until the bank confirms", () => {
    const base: Remittance = { businessName: "Ridgeline", vendorName: "Hoang Van Duc", reference: "INV-DUC-001", amount: "VND 6,000,000", received: null, rail: "chuyển khoản ngân hàng", date: "27 Oct 2026", providerRef: null, status: "on its way", language: "vi", withheld: null, shortPaid: null, history: null };
    const text = remittanceMessageFor([base, { ...base, reference: "INV-DUC-002", amount: "VND 3,600,000" }], ["u1", "u2"]);
    expect(text).toMatch(/đang chuyển VND 9,600,000 cho INV-DUC-001, INV-DUC-002 qua chuyển khoản ngân hàng/);
    expect(text).not.toMatch(/đã/);
  });
});

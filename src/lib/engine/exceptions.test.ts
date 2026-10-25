import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { bills, evidence, obligations, users } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { addEvidence, amendObligation, ingestObligation, recheckVendorItems, rejectObligation } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { createVendor, pendingChanges, verifyVendorChange } from "./vendors";
import { importDepartures, setRate } from "./rates";
import { createBill, payBill } from "./bills";
import { interpretWithRules } from "../ai/extractor";
import { evidencedAmountFromReason } from "../format";

/** The dead ends from the 26 Oct industry re-audit: each must have a way forward that keeps the audit trail. */
let db: Db;
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;
const rules = (id: string) => JSON.parse(ob(id).policyReasonsJson ?? "[]") as string[];

beforeEach(async () => {
  db = openTestDb();
  await seedDemo(db, { history: false });
});

async function duc(): Promise<string> {
  return createVendor(db, DEMO_BUSINESS_ID, as("lan"), { name: "Hoang Van Duc", role: "driver", country: "VN", email: "duc@example.com", taxType: "individual", taxForm: "w8ben" }, { bankAccountNumber: "0071000555666", bankCode: "VCB", accountHolder: "HOANG VAN DUC", bankCountry: "VN", bankCurrency: "VND" });
}
const invoice = (ref: string, vnd: number, extra = "") =>
  ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "invoice",
    rawInput: `Hoa don ${ref} tu Hoang Van Duc cho HG-3D-1023: 3 ngay xe, ${vnd.toLocaleString("de-DE")} VND.${extra}`,
    evidence: [{ kind: "invoice", label: `Invoice ${ref}`, amountMinor: vnd * 100, currency: "VND", reference: ref, excerpt: `Hoang Van Duc, HG-3D-1023, VND ${vnd.toLocaleString("en-US")}` }],
    actor: "user:lan",
  });

describe("exception paths", () => {
  it("checks a vendor's blocked invoice again once their details are verified", async () => {
    const vid = await duc();
    const id = await invoice("INV-DUC-001", 6_000_000);
    expect(ob(id).state).toBe("blocked");
    expect(ob(id).blockedReason).toMatch(/never verified/);
    const [ch] = pendingChanges(db, DEMO_BUSINESS_ID);
    verifyVendorChange(db, DEMO_BUSINESS_ID, as("minh"), ch.id, "callback");
    expect(await recheckVendorItems(db, DEMO_BUSINESS_ID, vid, "user:minh")).toBe(1);
    expect(ob(id).state).toBe("awaiting_approval");
  });

  it("short-pays a rate-card block to the contract amount, keeps it when the vendor sends a revised invoice, and replaces the old one", async () => {
    const vid = await duc();
    verifyVendorChange(db, DEMO_BUSINESS_ID, as("minh"), pendingChanges(db, DEMO_BUSINESS_ID)[0].id, "callback");
    setRate(db, DEMO_BUSINESS_ID, as("minh"), vid, { unit: "vehicle_day", rateMinor: 120_000_000, currency: "VND", validFrom: "2026-01-01" });
    importDepartures(db, DEMO_BUSINESS_ID, as("lan"), "code,start,end,guests,vendor,unit,quantity\nHG-3D-1023,2026-10-23,2026-10-25,6,Hoang Van Duc,vehicle_day,3");
    const id = await invoice("INV-DUC-002", 4_500_000);
    expect(ob(id).state).toBe("blocked");
    // The suggested correction is the rate-card figure, not the amount that was just blocked.
    expect(evidencedAmountFromReason(ob(id).blockedReason)).toBe(360_000_000);
    await amendObligation(db, id, "user:lan", { amountMinor: 360_000_000 }, "Short pay to the rate card");
    expect(ob(id).state).toBe("awaiting_approval");
    expect(rules(id).join(" ")).toMatch(/Short pay to the rate card/);
    // The vendor's revised invoice arrives: the person's amount stands, the old invoice is kept but no longer checked.
    await addEvidence(db, id, "vendor:evidence:x", { kind: "invoice", label: "Invoice INV-DUC-002 rev (from the vendor)", amountMinor: 360_000_000, currency: "VND", reference: "INV-DUC-002", excerpt: "Hoang Van Duc, HG-3D-1023, 3 x VND 1,200,000", provenance: "vendor" }, null);
    expect(ob(id).amountMinor).toBe(360_000_000);
    const ev = db.select().from(evidence).where(eq(evidence.obligationId, id)).all();
    expect(ev.filter((e) => e.supersededBy)).toHaveLength(1);
    expect(rules(id).join(" ")).not.toMatch(/Short pay|differs/);
  });

  it("never measures a cash advance against the guide's day rate, and voids an advance cancelled before payment", async () => {
    const advance = createBill(db, DEMO_BUSINESS_ID, as("lan"), "ven_maria", { kind: "advance", reference: "ADV-HG3D-1023", totalMinor: 30_000, currency: "USD", note: "Fuel and tickets for HG-3D-1023" });
    importDepartures(db, DEMO_BUSINESS_ID, as("lan"), "code,start,end,guests,vendor,unit,quantity\nHG-3D-1023,2026-10-23,2026-10-25,6,Maria Santos,day,3");
    const id = await payBill(db, DEMO_BUSINESS_ID, as("lan"), advance, 30_000);
    expect(ob(id).state).not.toBe("blocked");
    expect(rules(id).join(" ")).not.toMatch(/Rate card/);
    rejectObligation(db, id, "user:minh", "Not needed");
    expect(db.select().from(bills).where(and(eq(bills.id, advance))).get()!.status).toBe("void");
  });

  it("does not read a deposit due now as pressure", () => {
    const out = interpretWithRules({ rawInput: "Dao Mountain Lodge invoice INV-DML-1010: total USD 850. 50% deposit USD 425 now to hold the rooms, balance on arrival.", sourceType: "invoice", vendors: [], evidence: [] });
    expect(out.flags.join(" ")).not.toMatch(/Urgency/);
    const pushy = interpretWithRules({ rawInput: "Pay Phuong USD 960 now, urgent, the driver is waiting.", sourceType: "chat", vendors: [], evidence: [] });
    expect(pushy.flags.join(" ")).toMatch(/Urgency/);
  });
});

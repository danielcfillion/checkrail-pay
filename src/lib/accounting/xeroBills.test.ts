import { describe, it, expect } from "vitest";
import { openTestDb } from "../db";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, ingestObligation } from "../engine/orchestrator";
import { payBill, findBill } from "../engine/bills";
import { resolveActor } from "../engine/users";
import { exportNewXeroBills, xeroBillRows, XERO_BILL_COLUMNS } from "./xeroBills";

describe("Xero bills at approval", () => {
  it("lists agreed obligations once, an invoice paid in parts as one bill, and only new ones next time", async () => {
    const db = openTestDb();
    const { story } = await seedDemo(db, { history: false });
    const dep = await ingestObligation(db, {
      businessId: DEMO_BUSINESS_ID,
      sourceType: "invoice",
      rawInput: "Dao Mountain Lodge invoice INV-DML-1010 for CB-3D-1012, total USD 850. 50% deposit USD 425 now, balance on arrival.",
      evidence: [{ kind: "invoice", label: "Dao Mountain Lodge invoice INV-DML-1010", amountMinor: 85_000, currency: "USD", reference: "INV-DML-1010", excerpt: "Dao Mountain Lodge. Total USD 850.00." }],
      actor: "user:lan",
    });
    approveObligation(db, dep, "user:minh");
    const first = xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows;
    // story.paypal and story.blockedDuplicate are approved in a fresh seed; the waiting Stellar one is not a bill yet.
    expect(first.map((r) => r["*InvoiceNumber"])).toEqual(expect.arrayContaining(["JOB-HG4D-0921", "INV-DML-1010"]));
    expect(first.find((r) => r["*InvoiceNumber"] === "INV-DML-1010")).toMatchObject({ "*UnitAmount": "850.00", "*AccountCode": "320", TrackingOption1: "CB-3D-1012" });
    expect(first.some((r) => r["*InvoiceNumber"] === "JOB-PAL3D-0927")).toBe(false);
    const out = exportNewXeroBills(db, DEMO_BUSINESS_ID, "user:thu");
    expect(out.csv.split("\r\n")[0]).toBe(XERO_BILL_COLUMNS.join(","));
    const bill = findBill(db, "ven_dao", "INV-DML-1010")!;
    const bal = await payBill(db, DEMO_BUSINESS_ID, resolveActor(db, DEMO_BUSINESS_ID, "lan", "clerk"), bill.id, 42_500);
    approveObligation(db, bal, "user:minh");
    approveObligation(db, story.stellar, "user:daniel");
    const second = xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: true }).rows.map((r) => r["*InvoiceNumber"]);
    expect(second).toEqual(["JOB-PAL3D-0927"]);
  });
});

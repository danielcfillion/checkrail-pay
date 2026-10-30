import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { obligations } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { ingestObligation } from "./orchestrator";
import { resetRails } from "../rails";

// PayPal's history as a real account would return it: a payout made outside Checkrail, which this app has no record of.
let history = "";
vi.mock("../ai/paypalTools", async (orig) => ({ ...(await orig<typeof import("../ai/paypalTools")>()), listPayPalTransactionsRaw: async () => ({ ok: history !== "", body: history, error: history ? undefined : "HTTP 403" }) }));

let db: Db;
beforeEach(async () => {
  resetRails();
  db = openTestDb();
  await seedDemo(db, { history: false });
});

const kalaw = (ref: string) =>
  ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "job_completion",
    rawInput: `Kalaw Trekking Collective, porters for ${ref}, USD 240. Please pay Kalaw Trekking Collective.`,
    evidence: [{ kind: "job_sheet", label: `Trip sheet ${ref} (Kalaw Trekking Collective)`, amountMinor: 24_000, currency: "USD", reference: ref, excerpt: "Kalaw Trekking Collective: 4 porters, USD 240.00." }],
    actor: "user:lan",
  });

describe("PayPal's own records decide", () => {
  it("blocks a job PayPal already paid outside Checkrail, naming the PayPal transaction", async () => {
    history = JSON.stringify({ transaction_details: [{ transaction_info: { transaction_id: "9QX11122AB3344556", transaction_amount: { currency_code: "USD", value: "-240.00" }, transaction_note: "Porters JOB-KAL3D-1019", transaction_initiation_date: "2026-10-20T02:00:00Z", transaction_status: "S" }, payer_info: { email_address: "kalaw@example.com" } }] });
    const id = await kalaw("JOB-KAL3D-1019");
    const o = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
    expect(o.state).toBe("blocked");
    expect(o.blockedReason).toMatch(/PayPal transaction 9QX11122AB3344556 on 2026-10-20 already paid USD 240.00 for JOB-KAL3D-1019/);
  });

  it("does not block on another payee's payout for the same job number", async () => {
    history = JSON.stringify({ transaction_details: [{ transaction_info: { transaction_id: "9QX", transaction_amount: { currency_code: "USD", value: "-240.00" }, transaction_note: "JOB-KAL3D-1019", transaction_initiation_date: "2026-10-20T02:00:00Z", transaction_status: "S" }, payer_info: { email_address: "someone.else@example.com" } }] });
    const id = await kalaw("JOB-KAL3D-1019");
    expect(db.select().from(obligations).where(eq(obligations.id, id)).get()!.blockedReason ?? "").not.toMatch(/PayPal transaction/);
  });

  it("when PayPal cannot be read it says so, does not block, and sends the payment to a person (SEC5-5)", async () => {
    history = "";
    const id = await kalaw("JOB-KAL3D-1020");
    const o = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
    expect(o.blockedReason ?? "").not.toMatch(/PayPal/);
    expect(JSON.parse(o.paypalHistoryJson!)).toMatchObject({ ok: false, error: "HTTP 403" });
    expect(o.policyDecision).toBe("require_approval");
    expect(o.policyReasonsJson ?? "").toMatch(/PayPal's records could not be read \(HTTP 403\)/);
  });
});

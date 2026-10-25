import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { auditEntries, bankBatchLines, bankBatches, obligations, paymentAttempts, settlements, users, vendorChanges, vendors } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approvalGate, approveObligation, confirmSettlement, executeObligation, ingestObligation } from "./orchestrator";
import { resolveActor, type Actor } from "./users";
import type { Role } from "../auth/roles";
import { createVendor, pendingChanges, proposePayoutChange, verifyVendorChange } from "./vendors";
import { confirmBatch, downloadBatch } from "./bankFiles";
import { BankFileRail } from "../rails/bankFile";
import { resetRails, setRailsForTest } from "../rails";
import { WiseRail, transactionUuid } from "../rails/wise";
import { toBaseMinor } from "../fx";
import type { VendorPayoutProfile } from "../domain/types";

let db: Db;
const as = (u: string): Actor => resolveActor(db, DEMO_BUSINESS_ID, u, db.select().from(users).where(eq(users.id, u)).get()!.role as Role);
const ob = (id: string) => db.select().from(obligations).where(eq(obligations.id, id)).get()!;

const HOA = { name: "Hoa Binh Homestay", role: "homestay", country: "VN", email: "hoa@example.com" };
const ACCOUNT = "0071000123456";

async function vietnameseVendor(): Promise<string> {
  const id = createVendor(db, DEMO_BUSINESS_ID, as("lan"), HOA, { bankAccountNumber: ACCOUNT, bankCode: "VCB", accountHolder: "TRAN THI HOA", bankCountry: "VN", bankCurrency: "VND" });
  const [ch] = pendingChanges(db, DEMO_BUSINESS_ID);
  verifyVendorChange(db, DEMO_BUSINESS_ID, as("minh"), ch.id, "callback");
  return id;
}

async function vndInvoice(amountVnd: number, ref: string): Promise<string> {
  return ingestObligation(db, {
    businessId: DEMO_BUSINESS_ID,
    sourceType: "invoice",
    rawInput: `Hoa don ${ref} tu Hoa Binh Homestay: tong cong ${amountVnd.toLocaleString("de-DE")} VND.`,
    evidence: [{ kind: "invoice", label: `Invoice ${ref}`, amountMinor: amountVnd * 100, currency: "VND", reference: ref, excerpt: `Hoa Binh Homestay, VND ${amountVnd.toLocaleString("en-US")}` }],
    actor: "user:lan",
  });
}

beforeEach(async () => {
  resetRails();
  db = openTestDb();
  await seedDemo(db, { history: false });
  setRailsForTest({ bank_file: new BankFileRail(() => db) });
});
afterEach(() => {
  delete process.env.BANK_FILE_SOURCE_ACCOUNT;
  resetRails();
});

describe("local currency", () => {
  it("routes a VND invoice through Wise, checks limits in USD, and settles in VND", async () => {
    await vietnameseVendor();
    const id = await vndInvoice(10_800_000, "HB-0001");
    const o = ob(id);
    expect(o.currency).toBe("VND");
    expect(o.amountMinor).toBe(1_080_000_000);
    expect(o.selectedRail).toBe("wise");
    expect(o.state).toBe("awaiting_approval"); // about USD 425, above the USD 250 auto-approve line
    expect(approvalGate(db, id, "user:minh").refusal).toBeNull();
    approveObligation(db, id, "user:minh");
    await executeObligation(db, id, { actor: "user:lan" });
    await confirmSettlement(db, id);
    const s = db.select().from(settlements).where(eq(settlements.obligationId, id)).get()!;
    expect(s).toMatchObject({ rail: "wise", grossMinor: 1_080_000_000, grossCurrency: "VND", receivedCurrency: "VND" });
    expect(ob(id).state).toBe("settled");
  });

  it("states approval limits in the base currency", async () => {
    await vietnameseVendor();
    const id = await vndInvoice(30_000_000, "HB-0002"); // about USD 1,181, above Minh's USD 1,000
    expect(toBaseMinor(3_000_000_000, "VND", "USD")).toBeGreaterThan(100_000);
    expect(approvalGate(db, id, "user:minh").refusal).toMatch(/VND 30,000,000 \(about USD 1,18\d\.\d\d\) is above Minh/);
  });

  it("never stores or logs the account number in plain text", async () => {
    const vid = await vietnameseVendor();
    proposePayoutChange(db, DEMO_BUSINESS_ID, as("lan"), vid, { paypalEmail: "hoa.pp@example.com", bankCode: "VCB", accountHolder: "TRAN THI HOA", bankCountry: "VN", bankCurrency: "VND" });
    const dump = JSON.stringify([db.select().from(vendors).all(), db.select().from(vendorChanges).all(), db.select().from(auditEntries).all(), db.select().from(paymentAttempts).all()]);
    expect(dump).not.toContain(ACCOUNT);
    expect(vendors && db.select().from(vendors).where(eq(vendors.id, vid)).get()!.bankLabel).toBe("VCB ****3456");
    // The account number field left empty keeps the number on file.
    const [ch] = pendingChanges(db, DEMO_BUSINESS_ID);
    expect(JSON.parse(ch.proposedJson).bankAccountEnc).toBeTruthy();
  });

  it("pays by bank file when a Vietnamese source account is set: one line per payment, frozen on download, settled on confirm", async () => {
    process.env.BANK_FILE_SOURCE_ACCOUNT = "VCB 0071009999999 Ridgeline Vietnam";
    await vietnameseVendor();
    const id = await vndInvoice(4_000_000, "HB-0003"); // about USD 157: auto-approved
    expect(ob(id).selectedRail).toBe("bank_file"); // same bank as the source account: no fee, cheaper than Wise
    expect(ob(id).state).toBe("approved");
    await executeObligation(db, id, { actor: "user:lan" });
    expect(ob(id).state).toBe("sent");
    const [batch] = db.select().from(bankBatches).all();
    expect(batch.status).toBe("open");
    expect(db.select().from(bankBatchLines).all()).toHaveLength(1);
    expect(() => downloadBatch(db, DEMO_BUSINESS_ID, as("thu"), batch.id)).toThrow(/cannot download/);
    const file = downloadBatch(db, DEMO_BUSINESS_ID, as("lan"), batch.id);
    expect(file.csv).toContain(ACCOUNT);
    expect(file.csv).toContain("TRAN THI HOA");
    expect(file.csv).toMatch(/,4000000,/);
    expect(db.select().from(bankBatches).where(eq(bankBatches.id, batch.id)).get()!.status).toBe("downloaded");
    await confirmSettlement(db, id);
    expect(ob(id).state).toBe("sent"); // the bank has not confirmed yet
    const n = await confirmBatch(db, DEMO_BUSINESS_ID, as("thu"), batch.id);
    expect(n).toBe(1);
    expect(ob(id).state).toBe("settled");
  });
});

describe("Wise adapter against a scripted API", () => {
  const vendor: VendorPayoutProfile = { id: "v", name: "Hoa", country: "VN", preferredRail: null, paypalEmail: null, stellarAccount: null, bankCountry: "VN", bankCurrency: "VND", bankLabel: "VCB ****3456", detailsHash: "h", verifiedAt: "x", hasBankAccount: true, bankCode: "VCB", accountHolder: "TRAN THI HOA" };
  const req = { obligationId: "o", idempotencyKey: "k".repeat(32), vendor, amountMinor: 1_080_000_000, currency: "VND", memo: "HB-0001 abcd1234", bankAccountNumber: ACCOUNT };
  function scripted(responses: Record<string, { status: number; body: unknown } | "throw">) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const f = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ method: init.method ?? "GET", url: path, body: init.body ? JSON.parse(String(init.body)) : null });
      const key = `${init.method} ${path.replace(/\d{3,}/g, ":id")}`;
      const r = responses[key];
      if (r === "throw") throw new Error("socket hang up");
      if (!r) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const ok = {
    "POST /v3/profiles/:id/quotes": { status: 200, body: { id: "q-1", rate: 1, targetAmount: 10_800_000, paymentOptions: [{ payIn: "BALANCE", fee: { total: 2600 } }] } },
    "POST /v1/accounts": { status: 200, body: { id: 5551 } },
    "POST /v1/transfers": { status: 200, body: { id: 9001 } },
    "POST /v3/profiles/:id/transfers/:id/payments": { status: 201, body: { status: "COMPLETED" } },
  } as const;

  it("quotes, adds the recipient, creates an idempotent transfer and funds it", async () => {
    const { f, calls } = scripted({ ...ok });
    const r = await new WiseRail({ token: "t", profileId: "123", env: "sandbox" }, f).execute(req);
    expect(r).toMatchObject({ status: "submitted", externalId: "9001", receivedMinor: 1_080_000_000, receivedCurrency: "VND" });
    const transfer = calls.find((c) => c.url === "/v1/transfers")!;
    expect((transfer.body as { customerTransactionId: string }).customerTransactionId).toBe(transactionUuid(req.idempotencyKey));
    expect(transactionUuid(req.idempotencyKey)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("calls an unclear transfer unknown, never failed, and cancels a transfer it could not fund", async () => {
    const unclear = scripted({ ...ok, "POST /v1/transfers": "throw" });
    expect((await new WiseRail({ token: "t", profileId: "123", env: "sandbox" }, unclear.f).execute(req)).status).toBe("unknown");
    const unfunded = scripted({ ...ok, "POST /v3/profiles/:id/transfers/:id/payments": { status: 422, body: { status: "REJECTED" } }, "PUT /v1/transfers/:id/cancel": { status: 200, body: {} } });
    const r = await new WiseRail({ token: "t", profileId: "123", env: "sandbox" }, unfunded.f).execute(req);
    expect(r.status).toBe("failed");
    expect(unfunded.calls.some((c) => c.method === "PUT" && c.url.endsWith("/cancel"))).toBe(true);
  });
});

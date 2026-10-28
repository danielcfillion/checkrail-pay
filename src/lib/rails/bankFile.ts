import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { bankBatchLines, bankBatches } from "../db/schema";
import type { ExecutionRequest, ExecutionResult, PaymentRail, RouteQuote, SettlementStatus, VendorPayoutProfile } from "../domain/types";
import { newId, now } from "../domain/ids";
import { config } from "../config";
import { encryptField } from "../crypto/dataKey";
import { bankFileSource, quoteBankFile } from "./localQuotes";

/**
 * The bank file "rail": paying is adding a line to the open bulk-payment file. Nothing leaves the business until a
 * person downloads the file and uploads it to their bank; the payment is "sent" from then until someone confirms
 * the bank paid it. One line per idempotency key, so a retry can never put the same payment in a file twice.
 */
export class BankFileRail implements PaymentRail {
  readonly rail = "bank_file" as const;
  readonly mode: "mock" | "live";

  constructor(private readonly db: () => Db) {
    this.mode = config.rails.mode === "live" ? "live" : "mock";
  }

  async quote(i: { vendor: VendorPayoutProfile; amountMinor: number; currency: string; businessCountry: string }): Promise<RouteQuote> {
    return quoteBankFile(i.vendor, i.amountMinor, i.currency, i.businessCountry);
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const q = quoteBankFile(req.vendor, req.amountMinor, req.currency, req.businessCountry ?? "US");
    if (!q.available) return fail(q.unavailableReason ?? "Bank file unavailable");
    if (!req.bankAccountNumber || !req.businessId) return fail("No bank account number for this vendor");
    const db = this.db();
    const source = bankFileSource()!;
    const lineId = db.transaction((tx) => {
      const existing = tx.select().from(bankBatchLines).where(eq(bankBatchLines.idempotencyKey, req.idempotencyKey)).get();
      if (existing) return existing.id;
      let batch = tx.select().from(bankBatches).where(and(eq(bankBatches.businessId, req.businessId!), eq(bankBatches.currency, req.currency), eq(bankBatches.status, "open"))).get();
      if (!batch) {
        const id = newId("bnk");
        tx.insert(bankBatches).values({ id, businessId: req.businessId!, currency: req.currency, status: "open", sourceAccount: source, createdAt: now() }).run();
        batch = tx.select().from(bankBatches).where(eq(bankBatches.id, id)).get()!;
      }
      const id = newId("bnl");
      tx.insert(bankBatchLines)
        .values({ id, batchId: batch.id, obligationId: req.obligationId, idempotencyKey: req.idempotencyKey, amountMinor: req.amountMinor, currency: req.currency, beneficiaryName: (req.vendor.accountHolder ?? req.vendor.name).slice(0, 70), bankCode: req.vendor.bankCode!, accountEnc: encryptField(req.bankAccountNumber!), memo: req.memo, status: "queued", createdAt: now() })
        .run();
      return id;
    });
    return { status: "submitted", externalId: lineId, externalStatus: "in bank file", feeMinor: q.feeMinor, receivedMinor: q.receiveAmountMinor, receivedCurrency: "VND", fxRate: "1", raw: { line: lineId } };
  }

  async getStatus(externalId: string): Promise<SettlementStatus> {
    const line = this.db().select().from(bankBatchLines).where(eq(bankBatchLines.id, externalId)).get();
    if (!line) return { status: "failed", externalStatus: "not in any bank file", raw: null };
    if (line.status === "paid") return { status: "confirmed", externalStatus: "paid by the bank", raw: { line: line.id } };
    if (line.status === "returned") return { status: "failed", externalStatus: "returned by the bank", raw: { line: line.id } };
    const batch = this.db().select().from(bankBatches).where(eq(bankBatches.id, line.batchId)).get();
    return { status: "pending", externalStatus: batch?.status === "downloaded" ? "file downloaded, waiting for the bank" : "waiting in the open bank file", raw: { line: line.id } };
  }

  async findByIdempotencyKey(key: string): Promise<{ batchId: string; batchStatus: string | null } | null> {
    const line = this.db().select().from(bankBatchLines).where(eq(bankBatchLines.idempotencyKey, key)).get();
    return line ? { batchId: line.id, batchStatus: line.status } : null;
  }

  async externalIdMatchesKey(externalId: string, key: string): Promise<boolean | null> {
    const line = this.db().select().from(bankBatchLines).where(eq(bankBatchLines.id, externalId)).get();
    return line ? line.idempotencyKey === key : false;
  }
}

function fail(message: string): ExecutionResult {
  return { status: "failed", externalId: null, externalStatus: null, feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw: null, errorMessage: message };
}

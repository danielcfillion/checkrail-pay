import { createHash } from "node:crypto";
import type { ExecutionRequest, ExecutionResult, PaymentRail, Rail, RouteQuote, SettlementStatus, VendorPayoutProfile } from "../domain/types";
import { quotePayPal, quoteStellar } from "./quoteModel";

/**
 * Deterministic mock rails. Same request, same external id, same result.
 * Used for the replayable demo and for every test. Nothing here touches the network.
 */

function fakeId(rail: Rail, key: string): string {
  const h = createHash("sha256").update(`${rail}:${key}`).digest("hex");
  return rail === "paypal" ? h.slice(0, 13).toUpperCase() : h; // PayPal batch ids are short; Stellar hashes are 64 hex
}

/** An execution request can be forced to fail for demo/test purposes by putting "FAIL" in the memo. */
function shouldFail(req: ExecutionRequest): boolean {
  return req.memo.includes("FAIL");
}

export class MockPayPalRail implements PaymentRail {
  readonly rail = "paypal" as const;
  readonly mode = "mock" as const;

  async quote(i: { vendor: VendorPayoutProfile; amountMinor: number; currency: string; businessCountry: string }): Promise<RouteQuote> {
    return quotePayPal(i.vendor, i.amountMinor, i.currency, i.businessCountry);
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const q = quotePayPal(req.vendor, req.amountMinor, req.currency, req.businessCountry ?? "US");
    if (shouldFail(req)) {
      return { status: "failed", externalId: null, externalStatus: "DENIED", feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw: { mock: true }, errorMessage: "RECEIVER_UNCONFIRMED: recipient account cannot receive funds" };
    }
    const batchId = fakeId("paypal", req.idempotencyKey);
    return {
      status: "submitted",
      externalId: batchId,
      externalStatus: "PENDING",
      feeMinor: q.feeMinor,
      receivedMinor: q.receiveAmountMinor,
      receivedCurrency: q.receiveCurrency,
      fxRate: q.fxRate,
      raw: { mock: true, batch_header: { payout_batch_id: batchId, batch_status: "PENDING", sender_batch_header: { sender_batch_id: req.idempotencyKey } } },
    };
  }

  async getStatus(externalId: string): Promise<SettlementStatus> {
    return { status: "confirmed", externalStatus: "SUCCESS", raw: { mock: true, payout_batch_id: externalId, batch_status: "SUCCESS" } };
  }
}

export class MockStellarRail implements PaymentRail {
  readonly rail = "stellar" as const;
  readonly mode = "mock" as const;

  async quote(i: { vendor: VendorPayoutProfile; amountMinor: number; currency: string; businessCountry: string }): Promise<RouteQuote> {
    return quoteStellar(i.vendor, i.amountMinor, i.currency, i.businessCountry);
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const q = quoteStellar(req.vendor, req.amountMinor, req.currency, req.businessCountry ?? "US");
    if (shouldFail(req)) {
      return { status: "failed", externalId: null, externalStatus: "tx_failed", feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw: { mock: true }, errorMessage: "op_no_trust: destination has no trustline for PYUSD" };
    }
    const hash = fakeId("stellar", req.idempotencyKey);
    return {
      status: "confirmed", // Stellar finality is ~5s; mock confirms immediately
      externalId: hash,
      externalStatus: "success",
      explorerUrl: null, // mock hashes are not on chain; never link to an explorer
      feeMinor: q.feeMinor,
      receivedMinor: q.receiveAmountMinor,
      receivedCurrency: q.receiveCurrency,
      fxRate: q.fxRate,
      raw: { mock: true, hash, ledger: 1_234_567, successful: true, memo: req.memo },
    };
  }

  async getStatus(externalId: string): Promise<SettlementStatus> {
    return { status: "confirmed", externalStatus: "success", explorerUrl: null, raw: { mock: true, hash: externalId, successful: true } };
  }
}

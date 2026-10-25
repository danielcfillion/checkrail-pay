import { createHash } from "node:crypto";
import type { ExecutionRequest, ExecutionResult, PaymentRail, Rail, RailBalance, RouteQuote, SettlementStatus, VendorPayoutProfile } from "../domain/types";
import { quotePayPal, quoteStellar } from "./quoteModel";
import { quoteWise } from "./localQuotes";

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

/** Simulated balances, so the payment run's funding check has something to compare against. Override per rail in .env. */
function mockBalance(rail: Rail, currency: string): RailBalance | null {
  if (currency !== "USD") return null;
  const env = rail === "paypal" ? process.env.MOCK_PAYPAL_BALANCE_USD : process.env.MOCK_STELLAR_BALANCE_USD;
  const value = env !== undefined && env !== "" ? Number(env) : rail === "paypal" ? 3_000 : 2_000;
  return Number.isFinite(value) ? { availableMinor: Math.round(value * 100), currency, source: "simulated" } : null;
}

export class MockPayPalRail implements PaymentRail {
  readonly rail = "paypal" as const;
  readonly mode = "mock" as const;

  async balance(currency: string): Promise<RailBalance | null> {
    return mockBalance("paypal", currency);
  }

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

  async balance(currency: string): Promise<RailBalance | null> {
    return mockBalance("stellar", currency);
  }

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

export class MockWiseRail implements PaymentRail {
  readonly rail = "wise" as const;
  readonly mode = "mock" as const;

  async balance(currency: string): Promise<RailBalance | null> {
    const defaults: Record<string, number> = { USD: 5_000, VND: 150_000_000, PHP: 150_000, THB: 50_000 };
    const env = process.env[`MOCK_WISE_BALANCE_${currency}`];
    const value = env !== undefined && env !== "" ? Number(env) : defaults[currency];
    return value !== undefined && Number.isFinite(value) ? { availableMinor: Math.round(value * 100), currency, source: "simulated" } : null;
  }

  async quote(i: { vendor: VendorPayoutProfile; amountMinor: number; currency: string; businessCountry: string }): Promise<RouteQuote> {
    return quoteWise(i.vendor, i.amountMinor, i.currency, i.businessCountry);
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const q = quoteWise(req.vendor, req.amountMinor, req.currency, req.businessCountry ?? "US");
    if (shouldFail(req) || !req.bankAccountNumber) {
      return { status: "failed", externalId: null, externalStatus: "REJECTED", feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw: { mock: true }, errorMessage: req.bankAccountNumber ? "Recipient bank rejected the account details" : "No bank account number for this vendor" };
    }
    const id = String(parseInt(createHash("sha256").update(`wise:${req.idempotencyKey}`).digest("hex").slice(0, 10), 16));
    return { status: "submitted", externalId: id, externalStatus: "processing", feeMinor: q.feeMinor, receivedMinor: q.receiveAmountMinor, receivedCurrency: q.receiveCurrency, fxRate: q.fxRate, raw: { mock: true, transfer: { id, status: "processing", customerTransactionId: req.idempotencyKey } } };
  }

  async getStatus(externalId: string): Promise<SettlementStatus> {
    return { status: "confirmed", externalStatus: "outgoing_payment_sent", raw: { mock: true, id: externalId, status: "outgoing_payment_sent" } };
  }
}

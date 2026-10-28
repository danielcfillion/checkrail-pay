import { createHash } from "node:crypto";
import type { ExecutionRequest, ExecutionResult, PaymentRail, RailBalance, RouteQuote, SettlementStatus, VendorPayoutProfile } from "../domain/types";
import { minorToDecimal } from "../domain/money";
import { WISE_TARGETS, quoteWise } from "./localQuotes";

/**
 * Wise Business, for local bank payouts in VND, PHP and THB (and US ACH).
 *
 * Flow per payment: a quote for the exact amount the vendor is owed, a recipient account, a transfer carrying a
 * customerTransactionId derived from the attempt's idempotency key (Wise treats a repeated id as the same
 * transfer), then funding from the Wise balance. Anything after the transfer request that ends without a clear
 * answer is "unknown", never "failed", so the engine reconciles instead of paying again.
 *
 * Built against Wise's public API documentation and exercised with a scripted fetch in tests. It has not been run
 * against a Wise account: recipient field names differ by country (check /v1/quotes/{id}/account-requirements),
 * and personal tokens in some regions need strong customer authentication to fund. Treat live Wise as beta.
 */

const RECIPIENT_TYPES: Record<string, string> = { VND: "vietnam_earthport", PHP: "philippines", THB: "thailand", USD: "aba" };
const TIMEOUT_MS = 20_000;

export interface WiseConfig {
  token: string;
  profileId: string;
  env: "sandbox" | "live";
}

/** Wise wants a UUID; the same attempt always produces the same one. */
export function transactionUuid(key: string): string {
  const h = createHash("sha256").update(`checkrail:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class WiseRail implements PaymentRail {
  readonly rail = "wise" as const;
  readonly mode: "sandbox" | "live";
  private readonly base: string;

  constructor(private readonly cfg: WiseConfig, private readonly fetcher: typeof fetch = fetch) {
    if (!cfg.token) throw new Error("WiseRail requires WISE_API_TOKEN");
    if (!/^\d+$/.test(cfg.profileId)) throw new Error("WiseRail requires a numeric WISE_PROFILE_ID");
    this.mode = cfg.env === "live" ? "live" : "sandbox";
    this.base = this.mode === "live" ? "https://api.transferwise.com" : "https://api.sandbox.transferwise.tech";
  }

  async quote(i: { vendor: VendorPayoutProfile; amountMinor: number; currency: string; businessCountry: string }): Promise<RouteQuote> {
    const q = quoteWise(i.vendor, i.amountMinor, i.currency, i.businessCountry);
    return q.available ? { ...q, explanation: q.explanation.replace("Modelled from Wise's price list; ", "Estimate; ") } : q;
  }

  async balance(currency: string): Promise<RailBalance | null> {
    const r = await this.call("GET", `/v4/profiles/${this.cfg.profileId}/balances?types=STANDARD`);
    if (!r.ok || !Array.isArray(r.json)) return null;
    const row = (r.json as Array<{ currency?: string; amount?: { value?: number } }>).find((b) => b.currency === currency);
    return row && typeof row.amount?.value === "number" ? { availableMinor: Math.round(row.amount.value * 100), currency, source: "provider" } : null;
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const target = req.vendor.bankCountry ? WISE_TARGETS[req.vendor.bankCountry] : undefined;
    if (!target) return fail(`Wise is not set up for ${req.vendor.bankCountry ?? "this country"}`);
    if (!req.bankAccountNumber || !req.vendor.bankCode || !req.vendor.accountHolder) return fail("Bank details incomplete for Wise");
    const amount = minorToDecimal(req.amountMinor, 2);
    const sourceCurrency = req.currency === target ? target : req.currency;
    // 1. Quote for exactly what the vendor is owed. Failures here mean nothing exists yet.
    const quote = await this.call("POST", `/v3/profiles/${this.cfg.profileId}/quotes`, {
      sourceCurrency,
      targetCurrency: target,
      ...(req.currency === target ? { targetAmount: Number(amount) } : { sourceAmount: Number(amount) }),
      payOut: "BANK_TRANSFER",
    });
    const quoteId = (quote.json as { id?: string } | null)?.id;
    if (!quote.ok || !quoteId) return fail(`Wise quote refused: ${describe(quote)}`, quote.json);
    // 2. Recipient account.
    const recipient = await this.call("POST", `/v1/accounts`, {
      profile: Number(this.cfg.profileId),
      accountHolderName: req.vendor.accountHolder,
      currency: target,
      type: RECIPIENT_TYPES[target],
      details: { legalType: "PRIVATE", accountNumber: req.bankAccountNumber, bankCode: req.vendor.bankCode },
    });
    const accountId = (recipient.json as { id?: number } | null)?.id;
    if (!recipient.ok || !accountId) return fail(`Wise did not accept the bank details: ${describe(recipient)}`, recipient.json);
    // 3. The transfer. From here on an unclear answer may mean a transfer exists.
    const customerTransactionId = transactionUuid(req.idempotencyKey);
    const transfer = await this.call("POST", `/v1/transfers`, { targetAccount: accountId, quoteUuid: quoteId, customerTransactionId, details: { reference: req.memo.slice(0, 35) } });
    const transferId = (transfer.json as { id?: number } | null)?.id;
    if (transfer.transportError || transfer.status >= 500) return unknown(`Wise transfer outcome unknown: ${describe(transfer)}`, null);
    if (!transfer.ok || !transferId) return fail(`Wise refused the transfer: ${describe(transfer)}`, transfer.json);
    req.beforeSubmit?.({ externalId: String(transferId) });
    // 4. Fund it from the Wise balance.
    const fund = await this.call("POST", `/v3/profiles/${this.cfg.profileId}/transfers/${transferId}/payments`, { type: "BALANCE" });
    const fundStatus = (fund.json as { status?: string } | null)?.status;
    if (fund.transportError || fund.status >= 500) return unknown(`Wise funding outcome unknown for transfer ${transferId}`, String(transferId));
    if (!fund.ok || fundStatus !== "COMPLETED") {
      // Not funded means no money moved. Cancel the unfunded transfer so it cannot be funded later by mistake.
      await this.call("PUT", `/v1/transfers/${transferId}/cancel`);
      return fail(`Wise could not fund the transfer from the balance: ${fundStatus ?? describe(fund)}`, fund.json);
    }
    const fee = (quote.json as { paymentOptions?: Array<{ payIn?: string; fee?: { total?: number } }> }).paymentOptions?.find((o) => o.payIn === "BALANCE")?.fee?.total;
    const rate = (quote.json as { rate?: number }).rate;
    const targetAmount = (quote.json as { targetAmount?: number }).targetAmount;
    return {
      status: "submitted",
      externalId: String(transferId),
      externalStatus: "processing",
      feeMinor: typeof fee === "number" ? Math.round(fee * 100) : 0,
      receivedMinor: typeof targetAmount === "number" ? Math.round(targetAmount * 100) : null,
      receivedCurrency: target,
      fxRate: typeof rate === "number" ? String(rate) : null,
      raw: { quoteId, accountId, transferId, customerTransactionId },
    };
  }

  async getStatus(externalId: string): Promise<SettlementStatus> {
    const r = await this.call("GET", `/v1/transfers/${encodeURIComponent(externalId)}`);
    const status = (r.json as { status?: string } | null)?.status;
    if (!r.ok || !status) return { status: "pending", externalStatus: "unknown", raw: r.json };
    if (status === "outgoing_payment_sent") return { status: "confirmed", externalStatus: status, raw: r.json };
    if (["cancelled", "funds_refunded", "bounced_back", "charged_back"].includes(status)) return { status: "failed", externalStatus: status, raw: r.json };
    return { status: "pending", externalStatus: status, raw: r.json };
  }

  /** Find a transfer this attempt may already have created, by its customerTransactionId. */
  async findByIdempotencyKey(key: string): Promise<{ batchId: string; batchStatus: string | null } | null> {
    const id = transactionUuid(key);
    const r = await this.call("GET", `/v1/transfers?profile=${this.cfg.profileId}&limit=100`);
    if (!r.ok || !Array.isArray(r.json)) throw new Error("Wise transfer list unavailable");
    const t = (r.json as Array<{ id?: number; status?: string; customerTransactionId?: string }>).find((x) => x.customerTransactionId === id);
    return t?.id ? { batchId: String(t.id), batchStatus: t.status ?? null } : null;
  }

  async externalIdMatchesKey(externalId: string, key: string): Promise<boolean | null> {
    const r = await this.call("GET", `/v1/transfers/${encodeURIComponent(externalId)}`);
    if (!r.ok) return null;
    return (r.json as { customerTransactionId?: string } | null)?.customerTransactionId === transactionUuid(key);
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: unknown; transportError?: string }> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.cfg.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, status: 0, json: null, transportError: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message };
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json };
  }
}

function describe(r: { status: number; json: unknown; transportError?: string }): string {
  if (r.transportError) return r.transportError;
  const errors = (r.json as { errors?: Array<{ message?: string }> } | null)?.errors;
  return errors?.length ? errors.map((e) => e.message).filter(Boolean).join("; ").slice(0, 200) : `HTTP ${r.status}`;
}

function fail(message: string, raw: unknown = null): ExecutionResult {
  return { status: "failed", externalId: null, externalStatus: null, feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw, errorMessage: message };
}

function unknown(message: string, externalId: string | null): ExecutionResult {
  return { status: "unknown", externalId, externalStatus: "outcome unknown", feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw: null, errorMessage: message };
}

import type { ExecutionRequest, ExecutionResult, PaymentRail, RouteQuote, SettlementStatus, VendorPayoutProfile } from "../domain/types";
import { config } from "../config";
import { SUPPORTED_CURRENCIES, isValidAmountMinor, minorToDecimal } from "../domain/money";
import { quotePayPal } from "./quoteModel";
import { fetchPayPalAccessToken } from "./paypalAuth";

/**
 * Live PayPal adapter (sandbox or live, chosen by PAYPAL_ENV).
 *
 * Money path. Review every change here by hand.
 *
 * Execution uses the Payouts API: one batch per payment attempt, with the
 * attempt's idempotency key as both `sender_batch_id` and the
 * `PayPal-Request-Id` header. The engine reuses the same key when it replays an
 * attempt whose outcome was unknown, so PayPal returns the original batch
 * instead of creating a second one.
 *
 * Outcomes are classified, never guessed:
 *   - failed:  PayPal answered with a 4xx and a body. Nothing moved; a retry is safe.
 *   - unknown: timeout, network error, 5xx or an unreadable answer. Money may have
 *              moved. The engine keeps the obligation out of "failed" so nobody
 *              can re-send it under a new key.
 *
 * The adapter never decides whether to pay. It receives an already
 * authorised ExecutionRequest and reports what PayPal said.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/** PayPal item statuses that mean the money is not (or no longer) with the recipient. */
const FAILED_ITEM = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED", "CANCELED"]);
/** Statuses that need a human. The payout can still be claimed (UNCLAIMED) or released (ONHOLD), so they are not failures and must not be retried. */
const ATTENTION_ITEM: Record<string, string> = {
  UNCLAIMED: "Payout is UNCLAIMED: the recipient has no PayPal account for this email, or has not accepted it. PayPal returns unclaimed payouts after 30 days. Confirm the email with the vendor; do not pay again.",
  ONHOLD: "Payout is ON HOLD at PayPal (compliance or recipient review). Check the PayPal dashboard; do not pay again.",
};

/** PayPal rejects a reused sender_batch_id from the last 30 days with HTTP 400 and a body naming the duplicate. */
export function isDuplicateBatchError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const text = JSON.stringify(body);
  return /SENDER_BATCH_ID_ALREADY_EXISTS|DUPLICATE_REQUEST_ID|already exists|duplicate/i.test(text);
}

/** A payout batch id from the HATEOAS links in a PayPal error body, if one is there. */
export function batchIdFromLinks(body: unknown): string | null {
  const links = (body as { links?: Array<{ href?: string }> } | null)?.links ?? [];
  for (const l of links) {
    const m = l.href?.match(/\/v1\/payments\/payouts\/([A-Z0-9_-]+)(?:[/?]|$)/i);
    if (m) return m[1];
  }
  return null;
}

export class PayPalRail implements PaymentRail {
  readonly rail = "paypal" as const;
  readonly mode: "sandbox" | "live";
  private readonly baseUrl: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly creds = config.rails.paypal) {
    this.mode = creds.env === "live" ? "live" : "sandbox";
    this.baseUrl = this.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    if (!creds.clientId || !creds.clientSecret) {
      throw new Error("PayPalRail requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
    }
  }

  async quote(i: { vendor: VendorPayoutProfile; amountMinor: number; currency: string; businessCountry: string }): Promise<RouteQuote> {
    // PayPal has no quote endpoint for payouts; the fee schedule is published. Use the model.
    return quotePayPal(i.vendor, i.amountMinor, i.currency, i.businessCountry);
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    if (!req.vendor.paypalEmail) {
      return fail("Vendor has no PayPal email");
    }
    if (!isValidAmountMinor(req.amountMinor)) return fail(`Invalid amount ${req.amountMinor}`);
    if (!SUPPORTED_CURRENCIES.includes(req.currency)) return fail(`Unsupported currency ${req.currency}`);
    const body = {
      sender_batch_header: {
        sender_batch_id: req.idempotencyKey,
        email_subject: "You have a payment from Checkrail Pay",
        email_message: req.memo,
      },
      items: [
        {
          recipient_type: "EMAIL",
          amount: { value: minorToDecimal(req.amountMinor, 2), currency: req.currency },
          receiver: req.vendor.paypalEmail,
          note: req.memo,
          sender_item_id: req.obligationId,
        },
      ],
    };
    // Authentication happens before anything is sent, so a failure here is definitive.
    try {
      await this.accessToken();
    } catch (e) {
      return fail(`PayPal authentication failed: ${(e as Error).message}`);
    }
    const res = await this.call("POST", "/v1/payments/payouts", body, { "PayPal-Request-Id": req.idempotencyKey });
    if (res.transportError) {
      return unknown(`No answer from PayPal (${res.transportError}). The payout may or may not have been created.`);
    }
    if (!res.ok) {
      const err = (res.json as { name?: string; message?: string; details?: unknown }) ?? {};
      const message = `${err.name ?? res.status}: ${err.message ?? "payout request rejected"}`;
      // 5xx, 408 and bodies we cannot read are ambiguous: PayPal may have processed the request.
      if (res.status >= 500 || res.status === 408 || res.json === null) return unknown(message, res.json);
      // A reused sender_batch_id (the engine replaying an attempt whose outcome was unknown) is not a failure:
      // the original batch exists. Find it by key and report it as submitted. If the lookup cannot confirm it,
      // the outcome stays unknown so nobody re-sends under a new key.
      if (isDuplicateBatchError(res.json)) {
        // The rejection normally links to the original batch. Use that first; the key lookup is a fallback.
        const linked = batchIdFromLinks(res.json);
        if (linked) {
          const st = await this.call("GET", `/v1/payments/payouts/${encodeURIComponent(linked)}`);
          const h = (st.json as { batch_header?: { payout_batch_id?: string; batch_status?: string; sender_batch_header?: { sender_batch_id?: string } } } | null)?.batch_header;
          // Only trust the link if PayPal confirms that batch carries OUR key.
          if (st.ok && h?.payout_batch_id && (!h.sender_batch_header?.sender_batch_id || h.sender_batch_header.sender_batch_id === req.idempotencyKey)) {
            return this.submitted(h.payout_batch_id, h.batch_status ?? null, req, res.json);
          }
        }
        const found = await this.findByIdempotencyKey(req.idempotencyKey);
        if (found) return this.submitted(found.batchId, found.batchStatus, req, res.json);
        return unknown(`PayPal reports this batch already exists but the lookup by sender_batch_id did not return it (${message})`, res.json);
      }
      return fail(message, res.json);
    }
    const header = (res.json as { batch_header?: { payout_batch_id?: string; batch_status?: string } } | null)?.batch_header ?? {};
    if (!header.payout_batch_id) {
      return unknown("PayPal accepted the request but returned no batch id", res.json);
    }
    return this.submitted(header.payout_batch_id, header.batch_status ?? null, req, res.json);
  }

  private submitted(batchId: string, batchStatus: string | null, req: ExecutionRequest, raw: unknown): ExecutionResult {
    const q = quotePayPal(req.vendor, req.amountMinor, req.currency, req.businessCountry ?? "US");
    return {
      status: "submitted",
      externalId: batchId,
      externalStatus: batchStatus,
      feeMinor: q.feeMinor,
      receivedMinor: q.receiveAmountMinor,
      receivedCurrency: q.receiveCurrency,
      fxRate: q.fxRate,
      raw,
      note: "Fee and recipient figures are modelled from PayPal's published fee schedule; PayPal reports the actual amounts after settlement.",
    };
  }

  /**
   * Ask PayPal whether a batch with this sender_batch_id already exists. Used before any replay of an
   * attempt whose outcome was unknown, and when a submission is rejected as a duplicate. Returns null
   * when PayPal has no such batch or did not answer; the caller treats null as "still unknown".
   */
  async findByIdempotencyKey(key: string): Promise<{ batchId: string; batchStatus: string | null } | null> {
    try {
      await this.accessToken();
    } catch {
      return null;
    }
    const res = await this.call("GET", `/v1/payments/payouts?sender_batch_id=${encodeURIComponent(key)}`);
    if (res.transportError || !res.ok) return null;
    const header = (res.json as { batch_header?: { payout_batch_id?: string; batch_status?: string } } | null)?.batch_header;
    if (!header?.payout_batch_id) return null;
    return { batchId: header.payout_batch_id, batchStatus: header.batch_status ?? null };
  }

  async getStatus(externalId: string): Promise<SettlementStatus> {
    const res = await this.call("GET", `/v1/payments/payouts/${encodeURIComponent(externalId)}`);
    if (res.transportError || !res.ok) return { status: "pending", externalStatus: res.transportError ? "no answer" : `HTTP ${res.status}`, raw: res.json };
    const j = res.json as { batch_header?: { batch_status?: string }; items?: Array<{ transaction_status?: string }> };
    const batch = j.batch_header?.batch_status ?? "UNKNOWN";
    const item = j.items?.[0]?.transaction_status ?? batch;
    const externalStatus = `${batch}/${item}`;
    if (ATTENTION_ITEM[item]) return { status: "exception", message: ATTENTION_ITEM[item], externalStatus, raw: j };
    const confirmed = item === "SUCCESS";
    const failed = FAILED_ITEM.has(item) || batch === "DENIED" || batch === "CANCELED";
    return { status: confirmed ? "confirmed" : failed ? "failed" : "pending", externalStatus, raw: j };
  }

  /** Verify a webhook signature with PayPal before trusting its payload. Fails closed. */
  async verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<boolean> {
    if (!this.creds.webhookId) return false;
    const required = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
    if (required.some((h) => !headers[h])) return false;
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return false;
    }
    const body = {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: this.creds.webhookId,
      webhook_event: event,
    };
    try {
      await this.accessToken();
    } catch {
      return false;
    }
    const res = await this.call("POST", "/v1/notifications/verify-webhook-signature", body);
    return res.ok && (res.json as { verification_status?: string } | null)?.verification_status === "SUCCESS";
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const { token, expiresIn } = await fetchPayPalAccessToken(this.creds.clientId, this.creds.clientSecret, this.mode);
    this.token = { value: token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  }

  /** One HTTP call with a hard timeout. Never throws on transport problems; reports them so the caller can classify. */
  private async call(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ ok: boolean; status: number; json: unknown; transportError?: string }> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (e) {
      return { ok: false, status: 0, json: null, transportError: (e as Error).message };
    }
    let r: Response;
    try {
      r = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, status: 0, json: null, transportError: (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message };
    }
    let json: unknown = null;
    try {
      json = await r.json();
    } catch {
      json = null;
    }
    return { ok: r.ok, status: r.status, json };
  }
}

function fail(message: string, raw: unknown = null): ExecutionResult {
  return { status: "failed", externalId: null, externalStatus: null, feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw, errorMessage: message };
}

function unknown(message: string, raw: unknown = null): ExecutionResult {
  return { status: "unknown", externalId: null, externalStatus: null, feeMinor: 0, receivedMinor: null, receivedCurrency: null, fxRate: null, raw, errorMessage: message };
}

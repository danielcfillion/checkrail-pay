import type { ExecutionRequest, ExecutionResult, PaymentRail, RouteQuote, SettlementStatus, VendorPayoutProfile } from "../domain/types";
import { config } from "../config";
import { quotePayPal } from "./quoteModel";
import { fetchPayPalAccessToken } from "./paypalAuth";

/**
 * Live PayPal adapter (sandbox or live, chosen by PAYPAL_ENV).
 *
 * Money path. Review every change here by hand.
 *
 * Execution uses the Payouts API: one batch per obligation, with the
 * obligation's idempotency key as both `sender_batch_id` and the
 * `PayPal-Request-Id` header, so a retried request cannot pay twice.
 * The adapter never decides whether to pay. It receives an already
 * authorised ExecutionRequest and reports what PayPal said.
 */
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
    const body = {
      sender_batch_header: {
        sender_batch_id: req.idempotencyKey,
        email_subject: "You have a payment from Dueline",
        email_message: req.memo,
      },
      items: [
        {
          recipient_type: "EMAIL",
          amount: { value: (req.amountMinor / 100).toFixed(2), currency: req.currency },
          receiver: req.vendor.paypalEmail,
          note: req.memo,
          sender_item_id: req.obligationId,
        },
      ],
    };
    const res = await this.call("POST", "/v1/payments/payouts", body, { "PayPal-Request-Id": req.idempotencyKey });
    if (!res.ok) {
      const err = (res.json as { name?: string; message?: string; details?: unknown }) ?? {};
      return fail(`${err.name ?? res.status}: ${err.message ?? "payout request rejected"}`, res.json);
    }
    const header = (res.json as { batch_header?: { payout_batch_id?: string; batch_status?: string } }).batch_header ?? {};
    const q = quotePayPal(req.vendor, req.amountMinor, req.currency, "US");
    return {
      status: "submitted",
      externalId: header.payout_batch_id ?? null,
      externalStatus: header.batch_status ?? null,
      feeMinor: q.feeMinor,
      receivedMinor: q.receiveAmountMinor,
      receivedCurrency: q.receiveCurrency,
      fxRate: q.fxRate,
      raw: res.json,
    };
  }

  async getStatus(externalId: string): Promise<SettlementStatus> {
    const res = await this.call("GET", `/v1/payments/payouts/${encodeURIComponent(externalId)}`);
    if (!res.ok) return { status: "pending", externalStatus: `HTTP ${res.status}`, raw: res.json };
    const j = res.json as { batch_header?: { batch_status?: string }; items?: Array<{ transaction_status?: string }> };
    const batch = j.batch_header?.batch_status ?? "UNKNOWN";
    const item = j.items?.[0]?.transaction_status ?? batch;
    const confirmed = item === "SUCCESS";
    const failed = ["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED", "CANCELED"].includes(item) || batch === "DENIED" || batch === "CANCELED";
    return { status: confirmed ? "confirmed" : failed ? "failed" : "pending", externalStatus: `${batch}/${item}`, raw: j };
  }

  /** Verify a webhook signature with PayPal before trusting its payload. */
  async verifyWebhook(headers: Record<string, string>, rawBody: string): Promise<boolean> {
    if (!this.creds.webhookId) return false;
    const body = {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: this.creds.webhookId,
      webhook_event: JSON.parse(rawBody),
    };
    const res = await this.call("POST", "/v1/notifications/verify-webhook-signature", body);
    return res.ok && (res.json as { verification_status?: string }).verification_status === "SUCCESS";
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const { token, expiresIn } = await fetchPayPalAccessToken(this.creds.clientId, this.creds.clientSecret, this.mode);
    this.token = { value: token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  }

  private async call(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ ok: boolean; status: number; json: unknown }> {
    const token = await this.accessToken();
    const r = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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

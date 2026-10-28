import type { StatementLine } from "../engine/books";

/**
 * Read the PayPal statement straight from PayPal's Transaction Search API (GET /v1/reporting/transactions), so the
 * books can be reconciled without anyone downloading a CSV. Read-only: one GET endpoint, the same scope the agent's
 * paypal_list_transactions tool uses.
 *
 * Written to PayPal's published Transaction Search reference. The mapping is pure (transactionsToStatementLines) and
 * tested; the fetch has been run only against fakes here, so the first live run is on the operator's machine.
 *
 * Transaction Search allows at most 31 days per request and pages its results, so the range is split into windows
 * and each window is paged, with hard limits so a bad answer cannot loop forever.
 */

export interface TsMoney {
  currency_code?: string;
  value?: string;
}

export interface TsTransaction {
  transaction_info?: {
    transaction_id?: string;
    paypal_reference_id?: string;
    transaction_event_code?: string;
    transaction_initiation_date?: string;
    transaction_updated_date?: string;
    transaction_amount?: TsMoney;
    fee_amount?: TsMoney;
    transaction_status?: string;
    transaction_subject?: string;
    transaction_note?: string;
  };
  payer_info?: {
    email_address?: string;
    payer_name?: { alternate_full_name?: string; given_name?: string; surname?: string };
  };
}

const STATUS: Record<string, string> = { S: "Completed", P: "Pending", D: "Denied", V: "Reversed", F: "Partially refunded" };

/**
 * A readable type from PayPal's event code, in the words the activity CSV uses, so one reconciler handles both.
 * T0000 general payment, T0001 mass pay (Payouts), T11xx reversals and returns, T1107 refunds.
 */
export function eventType(code: string | undefined, grossMinor: number): string {
  const c = (code ?? "").toUpperCase();
  if (c === "T0001") return grossMinor < 0 ? "Mass Pay Payment" : "Mass Pay Returned";
  if (c === "T1107") return "Payment Refund";
  if (c.startsWith("T11")) return "Payment Reversal";
  if (c.startsWith("T00")) return grossMinor < 0 ? "General Payment" : "Payment Received";
  return c ? `PayPal ${c}` : "Unknown";
}

function minor(m: TsMoney | undefined): number {
  const n = Number(m?.value ?? "0");
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Map Transaction Search rows onto the statement lines the reconciler already understands. */
export function transactionsToStatementLines(rows: TsTransaction[]): StatementLine[] {
  const out: StatementLine[] = [];
  for (const r of rows) {
    const t = r.transaction_info;
    if (!t?.transaction_id || !t.transaction_amount?.currency_code) continue;
    const gross = minor(t.transaction_amount);
    const email = (r.payer_info?.email_address ?? "").trim().toLowerCase();
    const n = r.payer_info?.payer_name;
    const name = (n?.alternate_full_name ?? [n?.given_name, n?.surname].filter(Boolean).join(" ")).trim();
    out.push({
      date: (t.transaction_initiation_date ?? "").slice(0, 10),
      type: eventType(t.transaction_event_code, gross),
      status: STATUS[(t.transaction_status ?? "").toUpperCase()] ?? (t.transaction_status ?? ""),
      currency: t.transaction_amount.currency_code.toUpperCase(),
      grossMinor: gross,
      feeMinor: minor(t.fee_amount),
      // For money we send, the counterparty is the recipient; for money that comes back, it is who it came from.
      toEmail: gross < 0 ? email : "",
      fromEmail: gross > 0 ? email : "",
      referenceTxnId: (t.paypal_reference_id ?? "").trim(),
      name,
      transactionId: t.transaction_id,
      note: `${t.transaction_subject ?? ""} ${t.transaction_note ?? ""}`.trim(),
    });
  }
  return out;
}

export type GetJson = (path: string) => Promise<{ ok: boolean; status: number; body: unknown }>;

const DAY = 86_400_000;
const MAX_DAYS = 93;
const MAX_PAGES_PER_WINDOW = 20;

/** ISO dates (YYYY-MM-DD), inclusive. At most 93 days, split into 31-day windows. */
export async function fetchPayPalStatement(getJson: GetJson, from: string, to: string): Promise<StatementLine[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("Choose a start and end date");
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T23:59:59Z`);
  if (!(end > start)) throw new Error("The end date must be after the start date");
  if (end - start > MAX_DAYS * DAY) throw new Error(`At most ${MAX_DAYS} days at a time`);
  const rows: TsTransaction[] = [];
  const seen = new Set<string>();
  for (let w = start; w <= end; w += 31 * DAY) {
    const wEnd = Math.min(end, w + 31 * DAY - 1000);
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
    for (let page = 1; page <= MAX_PAGES_PER_WINDOW; page++) {
      const path = `/v1/reporting/transactions?start_date=${encodeURIComponent(iso(w))}&end_date=${encodeURIComponent(iso(wEnd))}&fields=transaction_info,payer_info&page_size=500&page=${page}`;
      const r = await getJson(path);
      if (r.status === 403) throw new Error("PayPal refused Transaction Search (403). Turn on Transaction search for this app in the PayPal developer dashboard.");
      if (!r.ok) throw new Error(`PayPal Transaction Search failed: HTTP ${r.status}`);
      const body = r.body as { transaction_details?: TsTransaction[]; total_pages?: number };
      for (const t of body.transaction_details ?? []) {
        const id = t.transaction_info?.transaction_id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        rows.push(t);
      }
      if (!body.total_pages || page >= body.total_pages) break;
    }
  }
  return transactionsToStatementLines(rows);
}

/** The live fetcher: client-credentials token, then GETs against the configured PayPal environment. */
export async function livePayPalGetJson(clientId: string, clientSecret: string, env: "sandbox" | "live"): Promise<GetJson> {
  const { fetchPayPalAccessToken } = await import("./paypalAuth");
  const { token } = await fetchPayPalAccessToken(clientId, clientSecret, env);
  const base = env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  return async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  };
}

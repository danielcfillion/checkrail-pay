import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { xeroConnections } from "../db/schema";
import { XERO_API_BASE, XeroAuthError, refreshXeroToken, xeroAccessToken, xeroTimeout } from "./xeroAuth";

/**
 * Calls to the Xero Accounting API for one connected organisation.
 *
 *  - Rate limits (developer.xero.com/documentation/guides/oauth2/limits): 60 calls a minute per organisation. Calls
 *    are counted on the connection row in the database (one budget for every server process) and stop short of the
 *    limit; a 429 stores Retry-After on the connection and no call goes to that organisation until then.
 *  - Every call times out after 20 seconds.
 *  - A 401 refreshes the token once and repeats the call once.
 *  - Writes carry an Idempotency-Key (POST, PUT and PATCH; Xero keeps a key for 6 minutes), so a call repeated after
 *    a dropped connection returns the first answer instead of creating a second bill.
 *  - Every failure becomes an XeroApiError with a sentence a person can act on.
 */

export type XeroErrorKind = "rate_limited" | "auth" | "forbidden" | "validation" | "not_found" | "unavailable";

export class XeroApiError extends Error {
  constructor(
    message: string,
    readonly kind: XeroErrorKind,
    /** No definite answer from Xero: the write may or may not have happened. */
    readonly uncertain = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export const MINUTE_LIMIT = 60;
/** Leave room for a person's own clicks (reading the chart of accounts) inside the same minute. */
const MINUTE_BUDGET = MINUTE_LIMIT - 5;

/**
 * Take one call from this minute's budget, in one statement so two processes cannot both take the last one. A new
 * window starts when the last one is a minute old. Returns null when the call may go, else the seconds to wait.
 */
export function takeXeroCallSlot(db: Db, businessId: string, nowMs: number): number | null {
  const fresh = sql`(${xeroConnections.rateWindowStart} IS NULL OR ${xeroConnections.rateWindowStart} <= ${nowMs - 60_000})`;
  const res = db
    .update(xeroConnections)
    .set({
      rateWindowStart: sql`CASE WHEN ${fresh} THEN ${nowMs} ELSE ${xeroConnections.rateWindowStart} END`,
      rateWindowCalls: sql`CASE WHEN ${fresh} THEN 1 ELSE ${xeroConnections.rateWindowCalls} + 1 END`,
    })
    .where(and(eq(xeroConnections.businessId, businessId), sql`(${fresh} OR ${xeroConnections.rateWindowCalls} < ${MINUTE_BUDGET})`))
    .run();
  if (res.changes === 1) return null;
  const row = db.select({ start: xeroConnections.rateWindowStart }).from(xeroConnections).where(eq(xeroConnections.businessId, businessId)).get();
  return Math.max(1, Math.ceil(((row?.start ?? nowMs) + 60_000 - nowMs) / 1000));
}

export interface XeroRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // "/Invoices"
  query?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string;
}

export interface XeroClient {
  readonly tenantId: string;
  request<T>(req: XeroRequest): Promise<T>;
}

/** Xero's validation answer, as the sentences Xero wrote. */
export function xeroValidationMessage(json: unknown): string | null {
  const j = json as { Message?: string; Detail?: string; Elements?: Array<{ ValidationErrors?: Array<{ Message?: string }> }> } | null;
  const msgs = new Set<string>();
  for (const el of j?.Elements ?? []) for (const v of el.ValidationErrors ?? []) if (v.Message) msgs.add(v.Message);
  if (msgs.size) return [...msgs].join(" ");
  return j?.Detail ?? j?.Message ?? null;
}

export function createXeroClient(db: Db, businessId: string, tenantId: string, opts: { now?: () => number } = {}): XeroClient {
  const clock = opts.now ?? Date.now;
  async function send(req: XeroRequest, token: string): Promise<Response> {
    const url = new URL(`${XERO_API_BASE}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "xero-tenant-id": tenantId, Accept: "application/json" };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    if (req.idempotencyKey && req.method !== "GET" && req.method !== "DELETE") headers["Idempotency-Key"] = req.idempotencyKey;
    const wait = takeXeroCallSlot(db, businessId, clock());
    if (wait !== null) throw new XeroApiError(`Paused at Xero's limit of ${MINUTE_LIMIT} calls a minute. Sending again in ${wait} seconds.`, "rate_limited", false, wait);
    try {
      return await fetch(url, { method: req.method, headers, body: req.body === undefined ? undefined : JSON.stringify(req.body), signal: xeroTimeout() });
    } catch {
      throw new XeroApiError("Could not reach Xero. It will be tried again.", "unavailable", req.method !== "GET");
    }
  }

  return {
    tenantId,
    async request<T>(req: XeroRequest): Promise<T> {
      const nowMs = clock();
      const conn = db.select({ blockedUntil: xeroConnections.blockedUntil }).from(xeroConnections).where(eq(xeroConnections.businessId, businessId)).get();
      if (conn?.blockedUntil && Date.parse(conn.blockedUntil) > nowMs) {
        const wait = Math.ceil((Date.parse(conn.blockedUntil) - nowMs) / 1000);
        throw new XeroApiError(`Xero asked us to slow down. Sending again in ${wait} seconds.`, "rate_limited", false, wait);
      }

      let token: string;
      try {
        token = await xeroAccessToken(db, businessId, nowMs);
      } catch (e) {
        throw new XeroApiError((e as Error).message, "auth");
      }
      let res = await send(req, token);
      if (res.status === 401) {
        // Once: a token Xero no longer accepts (revoked early, clock skew) gets one refresh and one more try.
        try {
          token = await refreshXeroToken(db, businessId);
        } catch (e) {
          throw new XeroApiError(e instanceof XeroAuthError ? e.message : "Xero sign-in failed. Connect to Xero again from Settings.", "auth");
        }
        res = await send(req, token);
        if (res.status === 401) {
          db.update(xeroConnections).set({ status: "needs_reconnect", lastError: "Xero refused the connection. Connect to Xero again from Settings.", updatedAt: new Date(clock()).toISOString() }).where(eq(xeroConnections.businessId, businessId)).run();
          throw new XeroApiError("Xero refused the connection. Connect to Xero again from Settings.", "auth");
        }
      }
      if (res.status === 429) {
        const retry = Math.max(1, Number(res.headers.get("retry-after")) || 60);
        db.update(xeroConnections).set({ blockedUntil: new Date(clock() + retry * 1000).toISOString(), updatedAt: new Date(clock()).toISOString() }).where(eq(xeroConnections.businessId, businessId)).run();
        throw new XeroApiError(`Xero asked us to slow down (${res.headers.get("x-rate-limit-problem") ?? "rate limit"}). Sending again in ${retry} seconds.`, "rate_limited", false, retry);
      }
      const json = (await res.json().catch(() => null)) as unknown;
      if (res.ok) return json as T;
      if (res.status === 403) throw new XeroApiError("Xero refused this request: the connection may be missing a permission. Disconnect and connect to Xero again.", "forbidden");
      if (res.status === 404) throw new XeroApiError("Xero could not find that record.", "not_found");
      if (res.status >= 500) throw new XeroApiError(`Xero had a problem (HTTP ${res.status}). It will be tried again.`, "unavailable", req.method !== "GET");
      const said = xeroValidationMessage(json);
      throw new XeroApiError(said ? `Xero said: ${said}` : `Xero refused it (HTTP ${res.status}).`, "validation");
    },
  };
}

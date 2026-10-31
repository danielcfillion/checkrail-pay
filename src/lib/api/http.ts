import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb, type Db } from "../db";
import { apiIdempotency, apiKeyUsage } from "../db/schema";
import { newId, now } from "../domain/ids";
import { getBusiness } from "../queries";
import { clientIp, newThrottle, overLimit } from "../throttle";
import { authenticateApiKey, configuredApiKeys, hasScope, type ApiKey, type ApiScope } from "./keys";

/**
 * The shared front door of /api/v1: key, origin, throttles, scope, body and Idempotency-Key, in that order, and one
 * error shape for everything, {error: {code, message}}. The middleware does not run on these paths (src/middleware.ts);
 * the key is checked here.
 */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Array<{ field: string; message: string }>, public headers: Record<string, string> = {}) {
    super(message);
  }
}

export interface ApiResult { status: number; body: unknown }
export interface ApiContext { db: Db; key: ApiKey; body: unknown; url: URL }

const DEFAULT_RATE_LIMIT = 120; // calls a minute per key
const BAD_KEY_LIMIT = 20; // wrong keys per address per 15 minutes
const IDEMPOTENCY_TTL_MS = 7 * 86_400_000;
/** A claim still without an answer after this long belongs to a call that died. */
const ABANDONED_CLAIM_MS = 5 * 60_000;
let warnedMalformed = false;
function warnMalformed(): void {
  if (warnedMalformed) return;
  warnedMalformed = true;
  console.error("[checkrail] CHECKRAIL_API_KEYS is malformed (name:secret:scopes, comma separated); every API call is refused");
}
const perKey = newThrottle();
const badKeys = newThrottle();

/** Calls a minute each key may make: CHECKRAIL_API_RATE_LIMIT, else 120. */
export function apiRateLimit(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CHECKRAIL_API_RATE_LIMIT);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : DEFAULT_RATE_LIMIT;
}

/** Forget every counter. Tests only. */
export function resetApiThrottles(): void {
  perKey.clear();
  badKeys.clear();
}

export function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}, details?: ApiError["details"]): Response {
  return Response.json({ error: { code, message, ...(details?.length ? { details } : {}) } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

const WWW_AUTH = { "WWW-Authenticate": 'Bearer realm="Checkrail Pay API"' };

/** JSON with keys in a fixed order, so the same payload hashes the same however the caller ordered it. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** The body as text, or null as soon as it passes `limit` bytes; the rest is never read. */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function noteUse(db: Db, key: ApiKey, path: string): void {
  const ts = now();
  db.insert(apiKeyUsage).values({ keyName: key.name, lastUsedAt: ts, lastPath: path, calls: 1 })
    .onConflictDoUpdate({ target: apiKeyUsage.keyName, set: { lastUsedAt: ts, lastPath: path, calls: sql`${apiKeyUsage.calls} + 1` } })
    .run();
}

export interface HandleOptions {
  /** The scope this call needs. */
  scope: ApiScope;
  /** POST only: the largest body accepted, in bytes. */
  bodyLimit?: number;
  /** POST only: whether an Idempotency-Key header is required, honoured when sent, or ignored. */
  idempotency?: "required" | "optional";
}

/** Run one API call: every check first, then `fn`, with errors in the one shape. */
export async function handleApi(req: Request, opts: HandleOptions, fn: (ctx: ApiContext) => Promise<ApiResult> | ApiResult): Promise<Response> {
  const keys = configuredApiKeys();
  // A malformed key list refuses everything. The caller only learns that it is not let in; the owner sees why on the
  // Settings page and in the server log (review R1-9).
  if (keys === null) {
    warnMalformed();
    return errorResponse(401, "unauthorized", "This API key is not accepted", WWW_AUTH);
  }
  const url = new URL(req.url);
  // A browser page on another site must not drive the API with a visitor's network position.
  const origin = req.headers.get("origin");
  if (origin) {
    let same = false;
    try {
      same = new URL(origin).host === url.host;
    } catch {
      same = false;
    }
    if (!same) return errorResponse(403, "cross_origin", "Cross-origin calls are not accepted");
  }

  const header = req.headers.get("authorization");
  if (!header) return errorResponse(401, "unauthorized", "An API key is required (Authorization: Bearer <key>)", WWW_AUTH);
  const key = authenticateApiKey(header, keys);
  if (!key) {
    // Only wrong keys are throttled. The address may be a shared edge address, so a valid key always gets through:
    // someone guessing behind the same proxy cannot lock every integration out (review R1-4).
    const ip = clientIp(req.headers, process.env.CHECKRAIL_CLIENT_IP_HEADER);
    if (overLimit(badKeys, ip, BAD_KEY_LIMIT, 15 * 60_000)) return errorResponse(429, "too_many_bad_keys", "Too many wrong keys from this address; wait 15 minutes", { "Retry-After": "900" });
    return errorResponse(401, "unauthorized", "Unknown API key", WWW_AUTH);
  }
  if (overLimit(perKey, key.name, apiRateLimit(), 60_000)) return errorResponse(429, "rate_limited", `Slow down: at most ${apiRateLimit()} calls a minute per API key`, { "Retry-After": "60" });
  if (!hasScope(key, opts.scope)) return errorResponse(403, "insufficient_scope", `This API key does not have the ${opts.scope} scope`);

  const db = getDb();
  noteUse(db, key, `${req.method} ${url.pathname}`);

  let body: unknown = null;
  if (req.method === "POST") {
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return errorResponse(415, "unsupported_media_type", "Send application/json");
    const limit = opts.bodyLimit ?? 64 * 1024;
    // Refuse an oversized body before reading it, and stop reading one that grows past the limit.
    if (Number(req.headers.get("content-length") ?? 0) > limit) return errorResponse(413, "payload_too_large", `The body is over ${Math.round(limit / 1024)} KB`);
    const raw = await readCapped(req, limit);
    if (raw === null) return errorResponse(413, "payload_too_large", `The body is over ${Math.round(limit / 1024)} KB`);
    try {
      body = JSON.parse(raw);
    } catch {
      return errorResponse(400, "invalid_json", "The body is not valid JSON");
    }
  }

  const run = async (): Promise<ApiResult> => {
    try {
      return await fn({ db, key, body, url });
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: { error: { code: e.code, message: e.message, ...(e.details?.length ? { details: e.details } : {}) } } };
      console.error("[checkrail] api call failed", req.method, url.pathname, e);
      return { status: 500, body: { error: { code: "internal_error", message: "Checkrail could not complete this call. Nothing was paid. Try again, or ask a person." } } };
    }
  };
  const respond = (r: ApiResult, extra: Record<string, string> = {}) => Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store", ...extra } });

  if (req.method !== "POST" || !opts.idempotency) return respond(await run());

  // ---- Idempotency-Key ----
  const idem = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!idem) {
    if (opts.idempotency === "required") return errorResponse(400, "idempotency_key_required", "Send an Idempotency-Key header: your own id for this one call, 8 to 128 characters. A retry with the same key returns the first answer.");
    return respond(await run());
  }
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idem)) return errorResponse(400, "invalid_idempotency_key", "Idempotency-Key must be 8 to 128 letters, digits, dots, colons, dashes or underscores");
  const hash = createHash("sha256").update(`${req.method} ${url.pathname}\n${stable(body)}`).digest("hex");
  db.delete(apiIdempotency).where(lt(apiIdempotency.createdAt, new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString())).run();
  const prior = () => db.select().from(apiIdempotency).where(and(eq(apiIdempotency.keyName, key.name), eq(apiIdempotency.idemKey, idem))).get();
  const replayOrRefuse = (p: NonNullable<ReturnType<typeof prior>>): Response => {
    if (p.bodySha256 !== hash) return errorResponse(422, "idempotency_conflict", "This Idempotency-Key was already used with a different request. Use a new key for a new call.");
    if (p.status === null || p.responseJson === null) return errorResponse(409, "idempotency_in_progress", "A call with this Idempotency-Key is still running; ask again in a moment", { "Retry-After": "2" });
    return respond({ status: p.status, body: JSON.parse(p.responseJson) }, { "Idempotency-Replayed": "true" });
  };
  let existing = prior();
  // A claim that never got an answer is from a call that died (a crash or a restart mid-call). It no longer holds
  // the key; a request it did create is still found by the key itself (src/lib/api/requests.ts) (review R1-6a).
  if (existing && existing.status === null && Date.now() - Date.parse(existing.createdAt) > ABANDONED_CLAIM_MS) {
    db.delete(apiIdempotency).where(eq(apiIdempotency.id, existing.id)).run();
    existing = undefined;
  }
  if (existing) return replayOrRefuse(existing);
  const claimId = newId("idm");
  try {
    db.insert(apiIdempotency).values({ id: claimId, keyName: key.name, idemKey: idem, method: req.method, path: url.pathname, bodySha256: hash, status: null, responseJson: null, createdAt: now() }).run();
  } catch {
    // Another call with this key got in first.
    const raced = prior();
    if (raced) return replayOrRefuse(raced);
    throw new Error("Idempotency record could not be written");
  }
  const result = await run();
  // Only a success is kept: a refused or failed call leaves the key free for the corrected call.
  if (result.status >= 200 && result.status < 300) db.update(apiIdempotency).set({ status: result.status, responseJson: JSON.stringify(result.body) }).where(eq(apiIdempotency.id, claimId)).run();
  else db.delete(apiIdempotency).where(eq(apiIdempotency.id, claimId)).run();
  return respond(result);
}

/** Field-level validation errors, collected and thrown together as one 422. */
export class Problems {
  list: Array<{ field: string; message: string }> = [];
  add(field: string, message: string): void {
    if (this.list.length < 50) this.list.push({ field, message });
  }
  throwIfAny(): void {
    if (this.list.length) throw new ApiError(422, "validation_failed", this.list.length === 1 ? `${this.list[0].field}: ${this.list[0].message}` : `${this.list.length} fields are not valid; see details`, this.list);
  }
}

/** Refuse fields the endpoint does not know, so a misspelt or hopeful field ("approve", "paypal_email") is never silently dropped. */
export function onlyFields(p: Problems, obj: Record<string, unknown>, allowed: readonly string[], at = ""): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) p.add(`${at}${k}`, `is not a field this endpoint takes (allowed: ${allowed.join(", ")})`);
}

export const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The one business this Checkrail runs, or a 503 when none is set up yet. */
export function businessOf(db: Db) {
  const biz = getBusiness(db);
  if (!biz) throw new ApiError(503, "not_set_up", "No business is set up in this Checkrail yet");
  return biz;
}

/** A whole-number query parameter between 1 and `max`, or `fallback` when absent. */
export function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ApiError(422, "validation_failed", `${name} must be a whole number from 1 to ${max}`, [{ field: name, message: `must be a whole number from 1 to ${max}` }]);
  return n;
}

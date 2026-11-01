/**
 * Sandbox mode for the hosted judging demo: each browser gets its own copy of the seeded demo database, so one
 * judge's clicks never change another judge's story. This file is pure and runs on the edge (the middleware) and in
 * Node: settings, the cookie and header names, and the signed token. The pool of database copies is in pool.ts and
 * the per-request selection in server.ts.
 *
 *   CHECKRAIL_SANDBOX=1                 ask for it. Refused (the shared database stays) unless rails are simulated
 *                                       (RAIL_MODE=mock), the reader is the rule-based one (AI_MODE is not live) and
 *                                       nothing points at real money.
 *   CHECKRAIL_SANDBOX_MAX               most copies at once (default 50); when full, the one idle longest goes.
 *   CHECKRAIL_SANDBOX_TTL_MINUTES       a copy nobody has used for this long is deleted (default 120).
 *   CHECKRAIL_SANDBOX_SECRET            signs the cookie (at least 16 characters). Required in production: without it
 *                                       sandbox mode is refused. In development the server makes a random one per
 *                                       process at start (server.ts) when it is not set.
 */
import { realMoneyEnv } from "../basicAuth";
import { base64url, hmacSha256 } from "./hmac";

export const SANDBOX_COOKIE = "checkrail_sandbox";
/** Set by the middleware on every request it handles (any client copy is replaced), read by the database seam. */
export const SANDBOX_HEADER = "x-checkrail-sandbox";
export const SANDBOX_ID_RE = /^[a-f0-9]{32}$/;
/** How long the browser keeps the cookie, and how long the token inside it is valid. */
export const SANDBOX_COOKIE_MAX_AGE = 24 * 3600;
export const MIN_SANDBOX_SECRET = 16;

export const DEFAULT_SANDBOX_MAX = 50;
export const DEFAULT_SANDBOX_TTL_MINUTES = 120;

export type Env = Record<string, string | undefined>;

export interface SandboxSetting {
  /** CHECKRAIL_SANDBOX=1 was set. */
  requested: boolean;
  /** Requested and allowed: every browser gets its own copy. */
  on: boolean;
  /** Why it was refused, when requested but not allowed. */
  refused: string | null;
  max: number;
  ttlMinutes: number;
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Whether sandbox mode is on. Only ever with simulated rails and the rule-based reader: a copy per visitor of a
 * database that can reach a live rail or a paid model would multiply what one visitor can spend, so any live setting
 * refuses it.
 */
export function sandboxSetting(env: Env): SandboxSetting {
  const requested = env.CHECKRAIL_SANDBOX === "1";
  const max = positiveInt(env.CHECKRAIL_SANDBOX_MAX, DEFAULT_SANDBOX_MAX);
  const ttlMinutes = positiveInt(env.CHECKRAIL_SANDBOX_TTL_MINUTES, DEFAULT_SANDBOX_TTL_MINUTES);
  let refused: string | null = null;
  if (requested) {
    if ((env.RAIL_MODE || "mock") !== "mock") refused = "RAIL_MODE is not mock";
    else if (env.AI_MODE === "live") refused = "AI_MODE is live";
    else if (realMoneyEnv(env)) refused = "PAYPAL_ENV=live, STELLAR_NETWORK=public or WISE_ENV=live is set";
    else if (env.NODE_ENV === "production" && !sandboxKeyMaterial(env)) refused = `CHECKRAIL_SANDBOX_SECRET is not set (at least ${MIN_SANDBOX_SECRET} characters), which production requires`;
  }
  return { requested, on: requested && refused === null, refused, max, ttlMinutes };
}

/** The signing key: CHECKRAIL_SANDBOX_SECRET, or null when it is missing or too short. Never derived from other settings. */
export function sandboxKeyMaterial(env: Env): string | null {
  const set = env.CHECKRAIL_SANDBOX_SECRET?.trim();
  return set && set.length >= MIN_SANDBOX_SECRET ? set : null;
}

/** The message that is signed: the id and when the token expires. */
export const signedMessage = (id: string, exp: string) => `checkrail-sandbox:${id}.${exp}`;

/** A new random sandbox id: 16 bytes as hex. */
export function newSandboxId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder();
const sign = (id: string, exp: string, material: string) => base64url(hmacSha256(enc.encode(material), enc.encode(signedMessage(id, exp))));

/** "<id>.<expiry, seconds since 1970 in base 36>.<signature>": HMAC-SHA256 under the key, base64url. */
export function signSandboxId(id: string, material: string, nowMs: number = Date.now()): string {
  const exp = Math.floor(nowMs / 1000 + SANDBOX_COOKIE_MAX_AGE).toString(36);
  return `${id}.${exp}.${sign(id, exp, material)}`;
}

/** The id inside a token, or null when the token is malformed, expired or not signed with this key. */
export function verifySandboxToken(token: string | null | undefined, material: string | null, nowMs: number = Date.now()): string | null {
  if (!material || !token || token.length > 120) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  if (!SANDBOX_ID_RE.test(id) || !/^[a-z0-9]{1,10}$/.test(exp)) return null;
  if (parseInt(exp, 36) * 1000 <= nowMs) return null;
  return sameText(sign(id, exp, material), sig) ? id : null;
}

/** The id part of a well-formed token, unverified. */
export function idOf(token: string | null | undefined): string | null {
  const id = token?.split(".")[0] ?? "";
  return SANDBOX_ID_RE.test(id) ? id : null;
}

/** Compares every character, so timing does not show how much of a forged signature was right. */
export function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * The middleware's half: keep this browser's sandbox when its cookie is valid, otherwise start a new one. `fresh`
 * means the response must set the cookie. Null when there is no key to sign with (the server then refuses, see
 * server.ts, rather than falling back to the shared database).
 */
export function sandboxForRequest(cookie: string | undefined, env: Env, nowMs: number = Date.now()): { token: string; fresh: boolean } | null {
  const material = sandboxKeyMaterial(env);
  if (!material) return null;
  if (cookie && verifySandboxToken(cookie, material, nowMs)) return { token: cookie, fresh: false };
  return { token: signSandboxId(newSandboxId(), material, nowMs), fresh: true };
}

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
 *   CHECKRAIL_SANDBOX_SECRET            signs the cookie. Without it a key is derived from the login settings.
 */
import { realMoneyEnv } from "../basicAuth";
import { base64url, hmacSha256 } from "./hmac";

export const SANDBOX_COOKIE = "checkrail_sandbox";
/** Set by the middleware on every request it handles (any client copy is replaced), read by the database seam. */
export const SANDBOX_HEADER = "x-checkrail-sandbox";
export const SANDBOX_ID_RE = /^[a-f0-9]{32}$/;
/** How long the browser keeps the cookie. A copy deleted for being idle is made again, fresh, on the next visit. */
export const SANDBOX_COOKIE_MAX_AGE = 24 * 3600;

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
  }
  return { requested, on: requested && refused === null, refused, max, ttlMinutes };
}

/**
 * The signing key. A set secret wins; otherwise one is derived from settings the hosted demo already keeps secret
 * (the logins and the data key), so the edge and the Node server agree without sharing state.
 */
export function sandboxKeyMaterial(env: Env): string {
  const set = env.CHECKRAIL_SANDBOX_SECRET?.trim();
  if (set) return set;
  return ["derived", env.CHECKRAIL_USERS ?? "", env.CHECKRAIL_BASIC_AUTH ?? "", env.DUELINE_BASIC_AUTH ?? "", env.CHECKRAIL_DATA_KEY ?? ""].join("|");
}

/** The message that is signed for a sandbox id. */
export const signedMessage = (id: string) => `checkrail-sandbox:${id}`;

/** A new random sandbox id: 16 bytes as hex. */
export function newSandboxId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const enc = new TextEncoder();

/** "<id>.<signature>": HMAC-SHA256 of the id under the key, base64url. */
export function signSandboxId(id: string, material: string): string {
  return `${id}.${base64url(hmacSha256(enc.encode(material), enc.encode(signedMessage(id))))}`;
}

/** The id inside a token, or null when the token is malformed or not signed with this key. */
export function verifySandboxToken(token: string | null | undefined, material: string): string | null {
  const id = idOf(token);
  if (!id) return null;
  return sameText(signSandboxId(id, material), token!) ? id : null;
}

/** The id part of a well-formed token, unverified. */
export function idOf(token: string | null | undefined): string | null {
  if (!token || token.length > 100) return null;
  const dot = token.indexOf(".");
  const id = dot > 0 ? token.slice(0, dot) : "";
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
 * means the response must set the cookie.
 */
export function sandboxForRequest(cookie: string | undefined, env: Env): { token: string; fresh: boolean } {
  const material = sandboxKeyMaterial(env);
  if (cookie && verifySandboxToken(cookie, material)) return { token: cookie, fresh: false };
  return { token: signSandboxId(newSandboxId(), material), fresh: true };
}

import { createHash, timingSafeEqual } from "node:crypto";
import { realMoneyEnv } from "../basicAuth";

/**
 * Keys for other software (CHECKRAIL_API_KEYS): booking systems, ERPs, accounting tools. One entry per system, comma
 * separated, the same shape as agent keys:
 *
 *   name:secret:scopes      e.g.  bokun:9a1b...44:departures:write,  erp:7f3c...e1:requests:write+requests:read
 *
 * Scopes (joined with "+"):
 *   departures:write  send departures (the booking feed) and read them back. A departure with the rate card sets what a
 *                     job should cost, so give it only to the booking system itself.
 *   requests:write    put payment requests in the inbox. What it attaches is its own say-so: a person approves unless
 *                     the business's own records already support the payment.
 *   requests:attest   also have what it attaches count as the business's own records (a system of record). Needs
 *                     requests:write. Policy, caps, the cancel window and the re-check at release still apply.
 *   requests:read     read back the requests this key made: state, verdict, reasons, amounts, rail, settlement.
 *   vendors:read      look up suppliers by name: id, name, verified or not. Never payout details.
 * No scope approves, releases or sends a payment, or changes a supplier's payout details. An API key is not a login: it
 * opens only /api/v1.
 */

export const API_SCOPES = ["departures:write", "requests:write", "requests:attest", "requests:read", "vendors:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export interface ApiKey { name: string; scopes: ApiScope[]; digest: Buffer }

const MIN_SECRET = 24;
const MIN_SECRET_REAL_MONEY = 32;
const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** The configured API keys; [] when none; null when the setting is present but malformed (then every API call is refused). */
export function configuredApiKeys(env: Record<string, string | undefined> = process.env): ApiKey[] | null {
  const raw = env.CHECKRAIL_API_KEYS?.trim();
  if (!raw) return [];
  const min = realMoneyEnv(env) ? MIN_SECRET_REAL_MONEY : MIN_SECRET;
  const keys: ApiKey[] = [];
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    // Scopes contain colons themselves, so only the first two separate the name and the secret.
    const a = entry.indexOf(":");
    const b = a < 0 ? -1 : entry.indexOf(":", a + 1);
    if (a < 0 || b < 0) return null;
    const name = entry.slice(0, a);
    const secret = entry.slice(a + 1, b);
    const scopes = entry.slice(b + 1).split("+").map((s) => s.trim());
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name) || secret.length < min || /\s/.test(secret)) return null;
    if (!scopes.length || scopes.some((s) => !(API_SCOPES as readonly string[]).includes(s)) || new Set(scopes).size !== scopes.length) return null;
    if (scopes.includes("requests:attest") && !scopes.includes("requests:write")) return null;
    const d = digest(secret);
    if (keys.some((k) => k.name === name || k.digest.equals(d))) return null;
    keys.push({ name, scopes: scopes as ApiScope[], digest: d });
  }
  return keys;
}

/** The key behind an "Authorization: Bearer <secret>" header, compared in constant time over every key; null when none matches. */
export function authenticateApiKey(header: string | null | undefined, keys: ApiKey[]): ApiKey | null {
  const m = header?.match(/^Bearer\s+(\S{1,256})$/i);
  if (!m) return null;
  const d = digest(m[1]);
  let found: ApiKey | null = null;
  for (const k of keys) if (timingSafeEqual(k.digest, d)) found = k;
  return found;
}

export const hasScope = (key: ApiKey, scope: ApiScope) => key.scopes.includes(scope);

import { createHash, timingSafeEqual } from "node:crypto";
import { realMoneyEnv } from "../basicAuth";

/**
 * Keys for outside agents (CHECKRAIL_AGENT_KEYS). One entry per agent, comma separated:
 *
 *   name:secret:scopes      e.g.  claude-desktop:7f3c...e1:check+request,  bookings:9a1b...44:check+request+attest
 *
 * Scopes, from least to most trusted:
 *   check    ask whether a payment would pass, look up a payee, explain a rule
 *   request  also put a payment request in the inbox and read its status; what it attaches is its own say-so, so a
 *            person approves unless the business's own records already support the payment
 *   attest   also have what it attaches count as the business's own records, like any integration. Only for an agent
 *            that is a system of record (a booking platform's or dispatch system's own agent). Policy, caps, the cancel
 *            window and the re-check at release still apply; it can still never approve or send.
 * An agent key is not a login: it opens only the agent endpoints.
 */

export type AgentScope = "check" | "request" | "attest";
export interface AgentKey { name: string; scopes: AgentScope[]; digest: Buffer }

const MIN_SECRET = 24;
const MIN_SECRET_REAL_MONEY = 32;
const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** The configured agent keys; [] when none; null when the setting is present but malformed (then every agent call is refused). */
export function configuredAgentKeys(env: Record<string, string | undefined> = process.env): AgentKey[] | null {
  const raw = env.CHECKRAIL_AGENT_KEYS?.trim();
  if (!raw) return [];
  const min = realMoneyEnv(env) ? MIN_SECRET_REAL_MONEY : MIN_SECRET;
  const keys: AgentKey[] = [];
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const parts = entry.split(":");
    if (parts.length !== 3) return null;
    const [name, secret, scopeText] = parts;
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name) || secret.length < min || /\s/.test(secret)) return null;
    const scopes = scopeText.split("+").map((s) => s.trim());
    if (!scopes.length || scopes.some((s) => s !== "check" && s !== "request" && s !== "attest") || !scopes.includes("check")) return null;
    if (scopes.includes("attest") && !scopes.includes("request")) return null;
    if (keys.some((k) => k.name === name)) return null;
    keys.push({ name, scopes: scopes as AgentScope[], digest: digest(secret) });
  }
  return keys;
}

/** The agent behind an "Authorization: Bearer <secret>" header, compared in constant time; null when none matches. */
export function authenticateAgent(header: string | null | undefined, keys: AgentKey[]): AgentKey | null {
  const m = header?.match(/^Bearer\s+(\S{1,256})$/i);
  if (!m) return null;
  const d = digest(m[1]);
  let found: AgentKey | null = null;
  for (const k of keys) if (timingSafeEqual(k.digest, d)) found = k;
  return found;
}

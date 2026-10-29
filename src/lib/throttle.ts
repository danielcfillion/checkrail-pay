/** Fixed-window counters keyed by client address. In memory, per server process. */
export type Throttle = Map<string, { n: number; since: number }>;

/** Hard cap on tracked addresses, so a flood of made-up addresses cannot grow the map without bound. */
export const MAX_KEYS = 50_000;

export function newThrottle(): Throttle {
  return new Map();
}

/**
 * The client's address, from the one proxy hop this server is behind.
 *
 * A client can write any header it likes, so no header is trusted by default except the last X-Forwarded-For entry:
 * a proxy appends the address it saw, and only the entries before it can be forged. Behind Cloudflare (which
 * overwrites CF-Connecting-IP) set CHECKRAIL_CLIENT_IP_HEADER=cf-connecting-ip, and only if the origin is reachable
 * solely through Cloudflare. When that header is missing, the client falls back to the last forwarded address, and
 * a request with no address at all shares one key, which can only slow down anonymous traffic, never misidentify it.
 */
export function clientIp(h: Headers, trustedHeader?: string | null): string {
  const named = trustedHeader?.trim().toLowerCase();
  if (named) {
    const v = h.get(named)?.split(",").pop()?.trim();
    if (v) return v.slice(0, 64);
  }
  const forwarded = h.get("x-forwarded-for")?.split(",").pop()?.trim();
  return (forwarded || h.get("x-real-ip")?.trim() || "local").slice(0, 64);
}

/** Count one event for this key (or only look, with count=false); true when the key is over its limit in this window. */
export function overLimit(map: Throttle, key: string, limit: number, windowMs: number, at = Date.now(), count = true): boolean {
  if (map.size >= MAX_KEYS) {
    for (const [k, v] of map) if (at - v.since > windowMs) map.delete(k);
    // Still full of live windows: drop the oldest first (Map keeps insertion order), so memory stays bounded.
    for (const k of map.keys()) {
      if (map.size < MAX_KEYS) break;
      map.delete(k);
    }
  }
  const e = map.get(key);
  if (!e || at - e.since > windowMs) {
    if (count) {
      map.delete(key);
      map.set(key, { n: 1, since: at });
    }
    return false;
  }
  if (count) e.n++;
  return e.n > limit;
}

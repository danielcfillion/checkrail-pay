/** Fixed-window counters keyed by client address. In memory, per server process. */
export type Throttle = Map<string, { n: number; since: number }>;

export function newThrottle(): Throttle {
  return new Map();
}

/**
 * The client's address. Render sits behind Cloudflare, which sets True-Client-IP and CF-Connecting-IP; those win.
 * Otherwise the first X-Forwarded-For entry. A client can put a made-up first entry there, which lets it dodge the
 * throttle but never lock anyone else out; keying on a shared proxy address instead would let one guesser lock out
 * every judge.
 */
export function clientIp(h: Headers): string {
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (h.get("true-client-ip") ?? h.get("cf-connecting-ip") ?? (first || null) ?? h.get("x-real-ip") ?? "local").trim().slice(0, 64);
}

/** Count one event for this key (or only look, with count=false); true when the key is over its limit in this window. */
export function overLimit(map: Throttle, key: string, limit: number, windowMs: number, at = Date.now(), count = true): boolean {
  if (map.size > 10_000) for (const [k, v] of map) if (at - v.since > windowMs) map.delete(k);
  const e = map.get(key);
  if (!e || at - e.since > windowMs) {
    if (count) map.set(key, { n: 1, since: at });
    return false;
  }
  if (count) e.n++;
  return e.n > limit;
}

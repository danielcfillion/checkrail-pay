import { describe, it, expect } from "vitest";
import { MAX_KEYS, clientIp, newThrottle, overLimit } from "./throttle";

describe("throttle", () => {
  it("locks a key out after the limit and lets it back in after the window", () => {
    const t = newThrottle();
    for (let i = 0; i < 10; i++) expect(overLimit(t, "1.2.3.4", 10, 60_000, 1_000)).toBe(false);
    expect(overLimit(t, "1.2.3.4", 10, 60_000, 2_000)).toBe(true);
    expect(overLimit(t, "1.2.3.4", 10, 60_000, 3_000, false)).toBe(true);
    expect(overLimit(t, "5.6.7.8", 10, 60_000, 3_000, false)).toBe(false);
    expect(overLimit(t, "1.2.3.4", 10, 60_000, 62_000)).toBe(false);
  });

  it("looking does not count", () => {
    const t = newThrottle();
    for (let i = 0; i < 50; i++) overLimit(t, "a", 3, 60_000, 1_000, false);
    expect(overLimit(t, "a", 3, 60_000, 1_000)).toBe(false);
  });

  it("uses the last forwarded address, which the nearest proxy appended, not a client-written first one", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6" }))).toBe("6.6.6.6");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.1" }))).toBe("198.51.100.1");
    expect(clientIp(new Headers())).toBe("local");
  });

  it("ignores client-written Cloudflare and True-Client-IP headers unless the operator names one", () => {
    const h = new Headers({ "true-client-ip": "9.9.9.9", "cf-connecting-ip": "8.8.8.8", "x-forwarded-for": "203.0.113.7" });
    expect(clientIp(h)).toBe("203.0.113.7");
    expect(clientIp(h, "cf-connecting-ip")).toBe("8.8.8.8");
    expect(clientIp(h, "x-missing-header")).toBe("203.0.113.7");
  });

  it("keeps the tracked addresses bounded even when every entry is still inside its window", () => {
    const t = newThrottle();
    for (let i = 0; i < MAX_KEYS + 500; i++) overLimit(t, `flood-${i}`, 10, 60_000, 1_000);
    expect(t.size).toBeLessThanOrEqual(MAX_KEYS);
    // The newest address is still counted, so a real guesser is not forgotten.
    for (let i = 0; i < 10; i++) overLimit(t, "guesser", 10, 60_000, 2_000);
    expect(overLimit(t, "guesser", 10, 60_000, 2_000)).toBe(true);
  });
});

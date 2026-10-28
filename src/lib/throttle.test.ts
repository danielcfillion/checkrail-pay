import { describe, it, expect } from "vitest";
import { clientIp, newThrottle, overLimit } from "./throttle";

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

  it("prefers the address Cloudflare reports, then the first forwarded address", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 10.0.0.1", "true-client-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.1" }))).toBe("198.51.100.1");
    expect(clientIp(new Headers())).toBe("local");
  });
});

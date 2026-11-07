import { describe, expect, it } from "vitest";
import { chooseRoute, effectiveRate, senderOutlayMinor, TIE_BPS } from "./routing";
import type { RouteQuote, VendorPayoutProfile } from "./types";

const vendor = { id: "v", name: "Test Vendor", country: "PH", preferredRail: null } as unknown as VendorPayoutProfile;
const q = (o: Partial<RouteQuote>): RouteQuote =>
  ({ rail: "paypal", available: true, sendAmountMinor: 18_000, sendCurrency: "USD", feeMinor: 360, fxRate: "60", receiveAmountMinor: 1_093_131, receiveCurrency: "PHP", etaSeconds: 86_400, provider: "x", explanation: "", corridor: "US-PH", ...o }) as RouteQuote;

describe("routing on effective cost", () => {
  it("counts every rail's fee on top: the business pays it, the recipient gets the full amount", () => {
    expect(senderOutlayMinor(q({ rail: "paypal" }))).toBe(18_360);
    expect(senderOutlayMinor(q({ rail: "stellar", feeMinor: 707 }))).toBe(18_707);
    expect(senderOutlayMinor(q({ rail: "wise", feeMinor: 410 }))).toBe(18_410);
  });

  it("treats a gap under the tie threshold as a tie and picks PayPal", () => {
    const paypal = q({ rail: "paypal", receiveAmountMinor: 1_093_131, feeMinor: 360 });
    const stellar = q({ rail: "stellar", receiveAmountMinor: 1_115_670, feeMinor: 707, etaSeconds: 900 });
    const gap = Math.abs(effectiveRate(paypal) - effectiveRate(stellar)) / effectiveRate(stellar);
    expect(gap * 10_000).toBeLessThan(TIE_BPS);
    const d = chooseRoute(vendor, "US", [paypal, stellar]);
    expect(d.rail).toBe("paypal");
    expect(d.reason).toMatch(/Effectively equal cost/);
  });

  it("picks Stellar when it is clearly cheaper per unit spent", () => {
    const paypal = q({ rail: "paypal", sendAmountMinor: 75_000, feeMinor: 1_500, receiveAmountMinor: 4_554_713 });
    const stellar = q({ rail: "stellar", sendAmountMinor: 75_000, feeMinor: 1_341, receiveAmountMinor: 4_648_624, etaSeconds: 900 });
    const d = chooseRoute(vendor, "US", [paypal, stellar]);
    expect(d.rail).toBe("stellar");
    expect(d.reason).toMatch(/Stellar delivers/);
  });

  it("vendor preference still wins when that rail is available", () => {
    const v = { ...vendor, preferredRail: "stellar" } as VendorPayoutProfile;
    expect(chooseRoute(v, "US", [q({ rail: "paypal" }), q({ rail: "stellar", feeMinor: 698, receiveAmountMinor: 1_072_407 })]).rail).toBe("stellar");
  });
});

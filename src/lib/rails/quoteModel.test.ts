import { describe, it, expect } from "vitest";
import { quotePayPal, quoteStellar } from "./quoteModel";
import { applyRateMicro, bpsCeil, effectiveRateMicro, isValidAmountMinor, isValidSourceRef, microToDecimal, minorToDecimal, pctToBps } from "../domain/money";
import type { VendorPayoutProfile } from "../domain/types";

const vendor = (over: Partial<VendorPayoutProfile> = {}): VendorPayoutProfile => ({
  id: "v1", name: "Ana Reyes", country: "PH", preferredRail: null, paypalEmail: "ana@example.com", stellarAccount: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYM9F3H6VCC4DEMONSTRATION",
  bankCountry: "PH", bankCurrency: "PHP", bankLabel: "UnionBank ****0923", detailsHash: "h", verifiedAt: "2026-09-01T00:00:00Z", ...over,
});

describe("money helpers", () => {
  it("formats minor units exactly, with no float", () => {
    expect(minorToDecimal(18_000, 2)).toBe("180.00");
    expect(minorToDecimal(5, 2)).toBe("0.05");
    expect(minorToDecimal(1999, 7)).toBe("19.9900000");
    expect(minorToDecimal(Number.MAX_SAFE_INTEGER, 2)).toBe("90071992547409.91");
    expect(() => minorToDecimal(12.5, 2)).toThrow();
    expect(() => minorToDecimal(-1, 2)).toThrow();
  });
  it("rounds fees up and rates to nearest in integers", () => {
    expect(bpsCeil(18_000, 200)).toBe(360);
    expect(bpsCeil(18_001, 200)).toBe(361); // 360.02 rounds up
    expect(bpsCeil(1, 1)).toBe(1);
    expect(pctToBps(0.1)).toBe(10);
    expect(pctToBps(2.5)).toBe(250);
    const eff = effectiveRateMicro(62.607736, 100);
    expect(microToDecimal(eff)).toBe("61.981659");
    expect(applyRateMicro(73_675, eff)).toBe(4_566_499);
  });
  it("validates amounts and references", () => {
    expect(isValidAmountMinor(1)).toBe(true);
    for (const bad of [0, -1, 1.5, 1e21, 100_000_000_000_001, Number.NaN, "5", null]) expect(isValidAmountMinor(bad)).toBe(false);
    expect(isValidSourceRef("INV-2026-0152")).toBe(true);
    expect(isValidSourceRef("JOB/HG.4D#09:14")).toBe(true);
    for (const bad of ["", " INV", "A B", "A\nB", "<b>", "x".repeat(65), "-LEADING"]) expect(isValidSourceRef(bad)).toBe(false);
  });
});

describe("quotes (M4)", () => {
  it("keeps the demo figures exactly", () => {
    const pp = quotePayPal(vendor(), 18_000, "USD", "US");
    expect(pp.feeMinor).toBe(360);
    expect(pp.receiveAmountMinor).toBe(1_093_131);
    const st = quoteStellar(vendor(), 75_000, "USD", "US");
    expect(st.feeMinor).toBe(1_325);
    expect(st.receiveAmountMinor).toBe(4_566_499);
    expect(st.fxRate).toBe("61.981659");
  });

  it("flags the anchor leg as modelled, and only when there is one", () => {
    const ph = quoteStellar(vendor(), 75_000, "USD", "US");
    expect(ph.modelled).toBe(true);
    expect(ph.explanation).toMatch(/modelled estimates/);
    const us = quoteStellar(vendor({ country: "US", bankCountry: "US", bankCurrency: "USD" }), 75_000, "USD", "US");
    expect(us.available).toBe(true);
    expect(us.modelled).toBe(false);
    expect(us.receiveAmountMinor).toBe(75_000);
  });

  it("marks a quote unavailable instead of returning a negative or zero amount", () => {
    const tiny = quoteStellar(vendor(), 300, "USD", "US"); // $3 against a $5 fixed anchor fee
    expect(tiny.available).toBe(false);
    expect(tiny.receiveAmountMinor).toBe(0);
    expect(tiny.unavailableReason).toMatch(/too small/);
    const pp = quotePayPal(vendor(), 50, "USD", "US"); // $0.50 into PHP, minus the PHP 50 withdrawal fee
    expect(pp.available).toBe(false);
    expect(pp.receiveAmountMinor).toBe(0);
  });

  it("refuses non-integer, out-of-range and non-USD requests", () => {
    for (const amt of [12.5, 0, -100, 5_000_000_000]) {
      expect(quotePayPal(vendor(), amt, "USD", "US").available).toBe(false);
      expect(quoteStellar(vendor(), amt, "USD", "US").available).toBe(false);
    }
    expect(quotePayPal(vendor(), 18_000, "JPY", "US").available).toBe(false);
  });

  it("honours the anchor limit and the sender country", () => {
    expect(quoteStellar(vendor(), 100_001, "USD", "US").available).toBe(false);
    expect(quotePayPal(vendor(), 18_000, "USD", "GB").available).toBe(false); // no GB->PH corridor configured
  });
});

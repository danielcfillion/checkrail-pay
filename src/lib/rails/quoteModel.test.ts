import { describe, it, expect } from "vitest";
import { quotePayPal, quoteStellar, stellarGrossUpMinor } from "./quoteModel";
import { senderOutlayMinor } from "../domain/routing";
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
    expect(st.feeMinor).toBe(1_341); // grossed up: 763.41 sent, 13.41 of fees taken on the way, 750.00 delivered
    expect(st.receiveAmountMinor).toBe(4_648_624); // the full USD 750 converted
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

describe("Stellar: the business pays the fee, the supplier gets the full bill", () => {
  const taken = (sent: number) => Math.ceil(sent * 0.001) + 500 + Math.ceil(sent * 0.01); // swap 0.1% and anchor USD 5 + 1%, rounded up
  it("grosses up what is sent so the swap and anchor fees leave exactly the bill amount", () => {
    for (const amount of [18_000, 19_000, 42_500, 75_000, 98_000]) {
      const st = quoteStellar(vendor(), amount, "USD", "US");
      expect(st.available).toBe(true);
      const gross = st.sendAmountMinor + st.feeMinor;
      expect(gross - taken(gross)).toBe(amount);
      expect(stellarGrossUpMinor(amount, { networkFeeUsd: 0.000001, swapToUsdcPct: 0.1, anchorFeeFixedUsd: 5, anchorFeePct: 1 })).toBe(gross);
      // One cent less would leave the supplier short.
      expect(gross - 1 - taken(gross - 1)).toBeLessThan(amount);
    }
  });
  it("delivers the full amount converted, and the sender's outlay is amount plus fee, as on PayPal", () => {
    const st = quoteStellar(vendor(), 75_000, "USD", "US");
    expect(st.sendAmountMinor).toBe(75_000);
    expect(st.receiveAmountMinor).toBe(applyRateMicro(75_000, effectiveRateMicro(62.607736, 100)));
    expect(senderOutlayMinor(st)).toBe(76_341);
    expect(senderOutlayMinor(quotePayPal(vendor(), 75_000, "USD", "US"))).toBe(76_500);
    expect(st.explanation).toMatch(/Sender fee \$13\.41, paid on top/);
  });
  it("a wallet payout with no anchor has no fee to gross up", () => {
    const us = quoteStellar(vendor({ country: "US", bankCountry: "US", bankCurrency: "USD" }), 75_000, "USD", "US");
    expect(us.feeMinor).toBe(0);
    expect(us.receiveAmountMinor).toBe(75_000);
  });
  it("counts the anchor limit on the grossed-up amount", () => {
    expect(quoteStellar(vendor(), 98_000, "USD", "US").available).toBe(true);
    const near = quoteStellar(vendor(), 99_500, "USD", "US");
    expect(near.available).toBe(false);
    expect(near.unavailableReason).toMatch(/once its fee/);
  });
});

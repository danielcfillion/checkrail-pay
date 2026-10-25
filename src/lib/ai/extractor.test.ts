import { describe, it, expect } from "vitest";
import { extractAmount, extractReference, matchVendor } from "./extractor";

describe("extractAmount", () => {
  it("prefers the total over unit prices", () => {
    expect(extractAmount("van hire 3 days at USD 80, total USD 240.")).toEqual({ amountMinor: 24_000, currency: "USD" });
    expect(extractAmount("9 guests x 2 nights x USD 18 = USD 324.")).toEqual({ amountMinor: 32_400, currency: "USD" });
    expect(extractAmount("Van for the loop, total $960. He needs it urgently.")).toEqual({ amountMinor: 96_000, currency: "USD" });
  });
  it("falls back to the largest figure", () => {
    expect(extractAmount("3 days at USD 45/day, so USD 135")).toEqual({ amountMinor: 13_500, currency: "USD" });
  });
  it("handles symbols and thousands", () => {
    expect(extractAmount("around USD 1,240, invoice tomorrow")).toEqual({ amountMinor: 124_000, currency: "USD" });
    expect(extractAmount("₱9,000 please")).toEqual({ amountMinor: 900_000, currency: "PHP" });
  });
});

describe("extractReference", () => {
  it("finds job and invoice references", () => {
    expect(extractReference("pay JOB-HG4D-0921 now")).toBe("JOB-HG4D-0921");
    expect(extractReference("Invoice inv-2026-0152 attached")).toBe("INV-2026-0152");
    expect(extractReference("no ref here")).toBeNull();
  });
});

describe("hostile input does not stall the server (security audit F1)", () => {
  it("a long run of comma-separated zeros is read in linear time", () => {
    const t0 = Date.now();
    extractAmount("000,".repeat(160_000) + " USD");
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("vendor names with regex characters do not break matching", () => {
    const v = { id: "v", name: "Ana (Boats) + Co", country: "PH", preferredRail: null, paypalEmail: null, stellarAccount: null, bankCountry: null, bankCurrency: null, bankLabel: null, detailsHash: "h", verifiedAt: null };
    expect(() => matchVendor("pay ana (boats) + co", [v as never])).not.toThrow();
  });
});

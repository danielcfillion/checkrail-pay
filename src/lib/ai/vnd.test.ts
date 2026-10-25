import { describe, it, expect } from "vitest";
import { extractAmount } from "./extractor";

describe("local currency amounts", () => {
  it("reads VND written the Vietnamese way and the English way", () => {
    expect(extractAmount("Hoa don HS-1027: tong cong 10.800.000 VND")).toEqual({ amountMinor: 1_080_000_000, currency: "VND" });
    expect(extractAmount("Total 10,800,000đ for 12 guests")).toEqual({ amountMinor: 1_080_000_000, currency: "VND" });
    expect(extractAmount("Please pay ₫2.500.000 today")).toEqual({ amountMinor: 250_000_000, currency: "VND" });
    expect(extractAmount("Boat hire THB 4,500")).toEqual({ amountMinor: 450_000, currency: "THB" });
    expect(extractAmount("Guide fee ₱9,000")).toEqual({ amountMinor: 900_000, currency: "PHP" });
  });
});

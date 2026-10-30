import { describe, expect, it } from "vitest";
import { UNITS } from "../engine/rates";
import { parseStatedRates, statedRateAboveContract, statedRatesFor, UNIT_NAME, type VendorRate } from "./statedRate";

const usd = (units: Array<[string, number]>): VendorRate[] => units.map(([unit, rateMinor]) => ({ unit, rateMinor, currency: "USD", validFrom: "2026-01-01", validTo: null }));

describe("reading a stated unit price", () => {
  it.each([
    ["4 days at USD 220", { quantity: 4, unit: "day", unitMinor: 22_000, currency: "USD" }],
    ["Phuong Transport: 4 days at USD 220 = USD 880", { quantity: 4, unit: "day", unitMinor: 22_000, currency: "USD" }],
    ["4 x USD 220 per vehicle-day", { quantity: 4, unit: "vehicle_day", unitMinor: 22_000, currency: "USD" }],
    ["4 vehicle days @ USD 220.50", { quantity: 4, unit: "vehicle_day", unitMinor: 22_050, currency: "USD" }],
    ["3 days x USD 45 = USD 135", { quantity: 3, unit: "day", unitMinor: 4_500, currency: "USD" }],
    ["USD 220 per vehicle-day x 4", { quantity: 4, unit: "vehicle_day", unitMinor: 22_000, currency: "USD" }],
    ["24 guest-nights x $20", { quantity: 24, unit: "guest_night", unitMinor: 2_000, currency: "USD" }],
    ["24 guest nights at 450,000 VND", { quantity: 24, unit: "guest_night", unitMinor: 45_000_000, currency: "VND" }],
    ["12 pax at USD 1,200", { quantity: 12, unit: "guest", unitMinor: 120_000, currency: "USD" }],
    ["2 trips at USD 150 each", { quantity: 2, unit: "trip", unitMinor: 15_000, currency: "USD" }],
    ["4 days at USD 220 per vehicle-day", { quantity: 4, unit: "vehicle_day", unitMinor: 22_000, currency: "USD" }],
  ])("reads %s", (text, want) => {
    expect(parseStatedRates(text)).toEqual([want]);
  });

  it.each([
    "Please pay Phuong Transport USD 880 for 4 days of van hire, INV-2026-0152",
    "4 days for USD 880",
    "4 days = USD 880",
    "USD 880 for 4 days",
    "2 trips at USD 500 total",
    "Rate: USD 200 per vehicle-day",
    "4 vehicle-days",
    "4 days at 9am",
    "Trip HG-4D-0927, 12 guests, 4 days guiding, USD 135",
    "12 guests x 2 nights x USD 450,000",
    "4D3N package, departure 2026-10-04 at USD 880",
    "Pay USD 220 on day 4",
    "INV-4 days at the lodge",
    "",
  ])("leaves %s alone", (text) => {
    expect(parseStatedRates(text)).toEqual([]);
  });

  it("keeps its unit names in step with the rate card units", () => {
    expect(Object.keys(UNIT_NAME).sort()).toEqual([...UNITS].sort());
  });
});

describe("a stated price above the contract rate", () => {
  const phuong = usd([["vehicle_day", 20_000]]);
  const stated = (text: string) => parseStatedRates(text);

  it("finds USD 220 per vehicle-day against USD 200, with what the quantity costs over", () => {
    expect(statedRateAboveContract(stated("4 x USD 220 per vehicle-day"), phuong, "2026-10-29", 50)).toEqual({ quantity: 4, statedUnit: "vehicle_day", rateUnit: "vehicle_day", statedMinor: 22_000, rateMinor: 20_000, currency: "USD", overMinor: 8_000 });
  });

  it("reads a driver's 'days' as vehicle-days when he has no day rate", () => {
    const f = statedRateAboveContract(stated("4 days at USD 220 = USD 880"), phuong, "2026-10-29", 50)!;
    expect(f).toMatchObject({ statedUnit: "day", rateUnit: "vehicle_day", overMinor: 8_000 });
    // ... but not when he has a day rate of his own, which is then the one compared.
    expect(statedRateAboveContract(stated("4 days at USD 220"), usd([["day", 25_000], ["vehicle_day", 20_000]]), "2026-10-29", 50)).toBeNull();
  });

  it("stays quiet at or under the rate, within the tolerance, or with no card for that unit or currency", () => {
    expect(statedRateAboveContract(stated("4 x USD 200 per vehicle-day"), phuong, "2026-10-29", 50)).toBeNull();
    expect(statedRateAboveContract(stated("4 x USD 150 per vehicle-day"), phuong, "2026-10-29", 50)).toBeNull();
    expect(statedRateAboveContract(stated("4 x USD 200.90 per vehicle-day"), phuong, "2026-10-29", 50)).toBeNull(); // 0.45% over, tolerance 0.5%
    expect(statedRateAboveContract(stated("4 x USD 201.50 per vehicle-day"), phuong, "2026-10-29", 50)).not.toBeNull();
    expect(statedRateAboveContract(stated("12 guests at USD 90"), phuong, "2026-10-29", 50)).toBeNull();
    expect(statedRateAboveContract(stated("4 days at VND 9,000,000"), phuong, "2026-10-29", 50)).toBeNull();
    expect(statedRateAboveContract(stated("4 days at USD 220"), [], "2026-10-29", 50)).toBeNull();
  });

  it("uses the rate in force on the date, and an open-ended one when there is no date", () => {
    const rates: VendorRate[] = [
      { unit: "vehicle_day", rateMinor: 18_000, currency: "USD", validFrom: "2026-01-01", validTo: "2026-06-30" },
      { unit: "vehicle_day", rateMinor: 20_000, currency: "USD", validFrom: "2026-07-01", validTo: null },
    ];
    expect(statedRateAboveContract(stated("4 x USD 190 per vehicle-day"), rates, "2026-05-01", 50)?.rateMinor).toBe(18_000);
    expect(statedRateAboveContract(stated("4 x USD 190 per vehicle-day"), rates, "2026-10-01", 50)).toBeNull();
    expect(statedRateAboveContract(stated("4 x USD 190 per vehicle-day"), rates, null, 50)).toBeNull();
    expect(statedRateAboveContract(stated("4 x USD 190 per vehicle-day"), rates, "2025-12-01", 50)).toBeNull();
  });

  it("reports the line that is furthest over when there are several", () => {
    const f = statedRateAboveContract(stated("2 days at USD 230; 4 days at USD 220"), phuong, "2026-10-29", 50)!;
    expect(f.overMinor).toBe(8_000);
  });
});

describe("whose line it is", () => {
  const others = ["Maria Santos", "Linh Family Homestay"];

  it("ignores another vendor's line on a shared trip sheet", () => {
    const sheet = "HG-4D-1004 trip sheet\nMaria Santos: 4 days at USD 60\nPhuong Transport: 4 vehicle-days at USD 200";
    expect(statedRatesFor([sheet], "Phuong Transport", others).map((r) => r.unitMinor)).toEqual([20_000]);
    expect(statedRatesFor([sheet], "Maria Santos", ["Phuong Transport", "Linh Family Homestay"]).map((r) => r.unitMinor)).toEqual([6_000]);
  });

  it("takes an unnamed line when the text names nobody else, and not when it names another vendor in full", () => {
    expect(statedRatesFor(["4 days at USD 220"], "Phuong Transport", others)).toHaveLength(1);
    expect(statedRatesFor(["Maria Santos guided.\n4 days at USD 220"], "Phuong Transport", others)).toHaveLength(0);
  });
});

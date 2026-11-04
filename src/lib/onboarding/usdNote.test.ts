import { describe, expect, it } from "vitest";
import { usdEquivalentNote } from "./usdNote";

const row = (currency: string, stopped_minor: number, held_minor: number) => ({ category: "x", category_label: "x", currency, calls: 1, stopped_minor, held_minor, confirmed_minor: 0, fine_minor: 0, unreviewed_calls: 0 });

describe("usdEquivalentNote", () => {
  it("gives the two totals in dollars at the demo rate for a dong history", () => {
    // VND 40,200,000 and VND 244,800,000 at about 25,400 to the dollar.
    const note = usdEquivalentNote({ money_stopped: [row("VND", 4_020_000_000, 0), row("VND", 0, 24_480_000_000)] }, "2026-11-04");
    expect(note).toBe("Shown in VND. At Checkrail's demo rate of about 25,400 VND to USD, money stopped is about USD 1,583 and money that waited for a person is about USD 9,638.");
  });

  it("says nothing for dollars, for several currencies, or for a currency without a demo rate", () => {
    expect(usdEquivalentNote({ money_stopped: [row("USD", 100, 100)] }, "2026-11-04")).toBeNull();
    expect(usdEquivalentNote({ money_stopped: [row("VND", 100, 100), row("PHP", 100, 100)] }, "2026-11-04")).toBeNull();
    expect(usdEquivalentNote({ money_stopped: [row("EUR", 100, 100)] }, "2026-11-04")).toBeNull();
    expect(usdEquivalentNote({ money_stopped: [] }, "2026-11-04")).toBeNull();
  });
});

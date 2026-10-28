import { describe, expect, it } from "vitest";
import type { ObligationRow } from "@/lib/queries";
import type { PaymentPoint } from "@/lib/queries";
import { bookLineModel, describeLine, stationSummary } from "./checkline-model";
import { axisLabel, buckets, chooseStep, paymentDensity } from "./moneyout-model";
import { groupItems, NAV_GROUPS, PHONE_PRIMARY } from "./nav-model";

/** Mirrors NAV in Shell.tsx (a .tsx file the test runner cannot load). */
const NAV = ["/", "/obligations", "/runs", "/vendors", "/ledger", "/exceptions", "/close", "/accounting", "/books", "/audit", "/settings"].map((href) => ({ href, label: { "/": "Overview", "/obligations": "Inbox", "/exceptions": "Exceptions", "/runs": "Payment runs" }[href] ?? href, icon: "x" }));

const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 86_400_000;

function row(state: string, amountMinor: number, daysAgo = 0, currency = "USD"): ObligationRow {
  return { id: `o_${state}_${amountMinor}_${daysAgo}`, state, amountMinor, currency, updatedAt: new Date(NOW - daysAgo * DAY).toISOString(), vendorName: "V", sourceRef: "R" } as unknown as ObligationRow;
}

describe("BookLine model", () => {
  it("plots open items and only the last 7 days of settled ones", () => {
    const st = bookLineModel([row("awaiting_approval", 75000), row("settled", 18000, 2), row("settled", 50000, 20), row("cancelled", 1000)], "USD", NOW);
    expect(st[1].items).toHaveLength(1);
    expect(st[4].items).toHaveLength(1);
    expect(st[4].openMinor).toBe(18000);
    expect(st.flatMap((s) => s.items).some((r) => r.state === "cancelled")).toBe(false);
  });

  it("totals each station in the base currency and keeps blocked money apart", () => {
    const st = bookLineModel([row("awaiting_approval", 75000), row("awaiting_approval", 1_080_000_000, 0, "VND"), row("blocked", 96000), row("blocked", 18000)], "USD", NOW);
    expect(st[1].items).toHaveLength(2);
    expect(st[1].openMinor).toBe(75000 + Math.round(1_080_000_000 / 25_400));
    expect(st[1].broken).toHaveLength(2);
    expect(st[1].blockedMinor).toBe(114000);
    expect(stationSummary(1, st[1], "USD")).toMatch(/^Verified: 2 open, \$[\d,]+\.\d\d, 2 blocked, \$1,140\.00$/);
  });
});

describe("Money out chart", () => {
  const pts = (days: number[]): PaymentPoint[] => days.map((d, i) => ({ id: `p${i}`, vendorName: null, sourceRef: null, rail: "paypal", grossMinor: 10000, feeMinor: 100, currency: "USD", paidMinor: 10000, paidFeeMinor: 100, paidCurrency: "USD", settledAt: new Date(NOW - d * DAY).toISOString(), by: "person" }));

  it("labels the axis with the currency", () => {
    expect(axisLabel(80000, "USD")).toBe("$800");
    expect(axisLabel(125000, "USD")).toBe("$1,250");
    expect(axisLabel(80000, "SGD")).toBe("SGD 800");
  });

  it("bins weekly when fewer than 30% of days have payments", () => {
    const sparse = pts([1, 5, 9, 14, 20]);
    expect(paymentDensity(sparse, 30, NOW)).toBeLessThan(0.3);
    expect(chooseStep(sparse, 30, NOW)).toBe(7);
    const dense = pts(Array.from({ length: 12 }, (_, i) => i * 2));
    expect(chooseStep(dense, 30, NOW)).toBe(1);
    expect(chooseStep(dense, 30, NOW, 1400)).toBe(1);
    expect(chooseStep(dense, 30, NOW, 300)).toBe(7); // daily columns under 44px on a phone
    expect(chooseStep(dense, 7, NOW, 300)).toBe(1);
    expect(chooseStep(dense, 90, NOW, 300)).toBe(14);
  });

  it("weekly bins never count days outside the range", () => {
    const p = pts([29, 31, 33]);
    const weekly = buckets(p, 30, NOW, 7);
    expect(weekly).toHaveLength(5);
    expect(weekly.flatMap((b) => b.items).map((x) => x.id)).toEqual(["p0"]);
    expect(buckets(p, 30, NOW, 1).flatMap((b) => b.items)).toHaveLength(1);
  });
});

describe("Navigation", () => {
  it("puts every section in exactly one group, in the agreed order", () => {
    const groups = groupItems(NAV);
    expect(groups.map((g) => g.label)).toEqual(NAV_GROUPS.map((g) => g.label));
    expect(groups.flatMap((g) => g.items.map((i) => i.href)).sort()).toEqual(NAV.map((i) => i.href).sort());
    expect(groups[0].items.map((i) => i.label)).toEqual(["Overview", "Inbox", "Exceptions", "Payment runs"]);
  });

  it("leaves every section reachable on a phone: four in the bar, the rest under More", () => {
    const rest = NAV.filter((i) => !(PHONE_PRIMARY as readonly string[]).includes(i.href));
    expect(PHONE_PRIMARY).toHaveLength(4);
    expect(rest.length + PHONE_PRIMARY.length).toBe(NAV.length);
  });
});

describe("Check line description", () => {
  it("names every station so phone ticks without labels are still read out", () => {
    expect(describeLine("Blocked", 1, 1, "evidence says USD 800.00")).toBe("Blocked: at Verified, line broken at Verified, evidence says USD 800.00. Stations: Read, Verified (current), Routed, Paid, Reconciled.");
  });
});

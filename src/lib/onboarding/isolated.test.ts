import { describe, expect, it } from "vitest";
import { runRecheckIsolated } from "./isolated";

const payments = [
  { row: 2, date: "2026-06-01", payee: "Tam Motorbike Rental", amountMinor: 1_500_000, reference: "TAM-0601", description: "Bike hire" },
  { row: 3, date: "2026-06-03", payee: "Tam Motorbike Rental", amountMinor: 1_500_000, reference: "TAM-0601", description: "Bike hire again" },
];

describe("runRecheckIsolated", () => {
  it("re-checks in a child process and never moves this process's clock", async () => {
    const year = new Date().getFullYear();
    const seen: number[] = [];
    const tick = setInterval(() => seen.push(new Date().getFullYear(), new Date(Date.now()).getFullYear()), 5);
    try {
      const rows = await runRecheckIsolated({ config: { currency: "VND", country: "VN", payments: { file: "x.csv", columns: { date: "Date", payee: "Payee", amount: "Amount", reference: "Ref" } } } as never, payments });
      expect(rows).toHaveLength(2);
      expect(rows[1].category).toBe("duplicate");
    } finally {
      clearInterval(tick);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([year]));
  }, 60_000);

  it("reports a failure instead of hanging", async () => {
    await expect(runRecheckIsolated({ config: null as never, payments }, { timeoutMs: 30_000 })).rejects.toThrow();
  }, 60_000);
});

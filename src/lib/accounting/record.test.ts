import { describe, it, expect } from "vitest";
import { toCsv } from "./record";

describe("CSV export", () => {
  it("neutralises cells that a spreadsheet would run as a formula, and keeps negative numbers as numbers", () => {
    const csv = toCsv([{ description: '=HYPERLINK("http://x","click")', vendorName: "@SUM(A1)", feeAmount: "-12.50" } as never]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csv).toContain("'@SUM(A1)");
    expect(csv).toContain(",-12.50");
    expect(csv).not.toContain(",'-12.50");
  });
});

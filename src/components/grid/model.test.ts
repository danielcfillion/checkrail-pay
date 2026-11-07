import { describe, expect, it } from "vitest";
import {
  compareDayToIso,
  csvSafe,
  decidedByFor,
  decimalAmount,
  dueByIds,
  fundingByRail,
  ledgerCsvValue,
  ledgerTotals,
  reconStateFor,
  toLedgerRow,
  toPayableRow,
  toRunRow,
  totalRowsFor,
  type SettlementInput,
} from "./model";
import { ledgerCsv } from "./csv";

// 1 USD = 25,400 VND, as the server's default reference table.
const toBase = (minor: number, currency: string) => (currency === "VND" ? Math.round(minor / 25_400) : minor);

const settlement = (over: Partial<SettlementInput> = {}): SettlementInput => ({
  id: "stl_1",
  obligationId: "obl_1",
  vendorName: "Maria Santos",
  obligation: { sourceRef: "JOB-HG4D-0921" },
  grossMinor: 18_000,
  grossCurrency: "USD",
  feeMinor: 360,
  receivedMinor: 17_640,
  receivedCurrency: "USD",
  rail: "paypal",
  settledAt: "2026-10-11T23:39:39.981Z",
  reconciledAt: null,
  statementRef: null,
  externalId: "RGS5PUZPH4CNY",
  ...over,
});

describe("toLedgerRow", () => {
  it("maps a settlement to a plain grid row", () => {
    const r = toLedgerRow(settlement(), { toBase, starter: "user:rianne", accountingStatus: "exported" });
    expect(r).toMatchObject({
      id: "stl_1",
      obligationId: "obl_1",
      vendorName: "Maria Santos",
      sourceRef: "JOB-HG4D-0921",
      amountMinor: 18_000,
      feeMinor: 360,
      currency: "USD",
      baseMinor: 18_000,
      rail: "paypal",
      railLabel: "PayPal",
      settledAt: "2026-10-11T23:39:39.981Z",
      recon: "in_books",
      decidedKind: "person",
      decidedBy: "Rianne",
    });
  });

  it("converts the sort value to the base currency and fills gaps with words", () => {
    const r = toLedgerRow(settlement({ grossMinor: 2_540_000_00, grossCurrency: "vnd", vendorName: null, obligation: { sourceRef: null }, rail: "bank_file" }), { toBase });
    expect(r.currency).toBe("VND");
    expect(r.baseMinor).toBe(10_000); // VND 2,540,000 is USD 100.00
    expect(r.vendorName).toBe("Unknown vendor");
    expect(r.sourceRef).toBe("");
    expect(r.railLabel).toBe("Bank file");
    expect(r.decidedKind).toBe("unknown");
    expect(r.recon).toBe("open");
  });
});

describe("decidedByFor an integration", () => {
  it("labels a request from an API key as the integration, a machine, not 'not recorded' (review R1-8)", () => {
    expect(decidedByFor("api:erp")).toEqual({ kind: "agent", label: "Integration erp" });
  });
});

describe("reconStateFor and decidedByFor", () => {
  it("only calls a payment reconciled when a statement line matched it", () => {
    expect(reconStateFor("2026-10-20T00:00:00Z", "pending")).toBe("reconciled");
    expect(reconStateFor(null, "synced")).toBe("in_books");
    expect(reconStateFor(null, "exported")).toBe("in_books");
    expect(reconStateFor(null, "pending")).toBe("open");
    expect(reconStateFor(null, null)).toBe("open");
  });
  it("tells an agent from a person", () => {
    expect(decidedByFor("agent:autopilot")).toEqual({ kind: "agent", label: "Autopilot" });
    expect(decidedByFor("user:daniel")).toEqual({ kind: "person", label: "Daniel" });
    expect(decidedByFor(undefined)).toEqual({ kind: "unknown", label: "Not recorded" });
  });
});

describe("ledgerTotals", () => {
  it("totals each currency separately and never adds currencies together", () => {
    const rows = [
      toLedgerRow(settlement(), { toBase }),
      toLedgerRow(settlement({ id: "b", grossMinor: 50_000, feeMinor: 1_050, receivedMinor: 49_000 }), { toBase }),
      toLedgerRow(settlement({ id: "c", grossMinor: 22_966_400_00, grossCurrency: "VND", feeMinor: 0, receivedMinor: 22_966_400_00, receivedCurrency: "VND", rail: "bank_file" }), { toBase }),
    ];
    const t = ledgerTotals(rows);
    expect(t).toEqual([
      { currency: "USD", count: 2, amountMinor: 68_000, feeMinor: 1_410, receivedMinor: 66_640 },
      { currency: "VND", count: 1, amountMinor: 22_966_400_00, feeMinor: 0, receivedMinor: 22_966_400_00 },
    ]);
    const pinned = totalRowsFor(t);
    expect(pinned.map((p) => p.vendorName)).toEqual(["Total USD", "Total VND"]);
    expect(pinned[0].totalOf).toBe(2);
  });

  it("leaves received blank when it was paid out in another currency or is still pending", () => {
    const rows = [toLedgerRow(settlement({ receivedMinor: 1_035_000, receivedCurrency: "PHP" }), { toBase }), toLedgerRow(settlement({ id: "x" }), { toBase })];
    expect(ledgerTotals(rows)[0].receivedMinor).toBeNull();
    expect(ledgerTotals([toLedgerRow(settlement({ receivedMinor: null }), { toBase })])[0].receivedMinor).toBeNull();
  });
});

describe("csvSafe", () => {
  it("neutralises cells a spreadsheet would run as a formula", () => {
    expect(csvSafe("=HYPERLINK(\"http://x\",\"pay\")")).toBe("'=HYPERLINK(\"http://x\",\"pay\")");
    expect(csvSafe("+1+1")).toBe("'+1+1");
    expect(csvSafe("-2+3")).toBe("'-2+3");
    expect(csvSafe("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvSafe("\t=1")).toBe("'\t=1");
    // A leading CR is stripped by some spreadsheets, so the formula after it is neutralised too.
    expect(csvSafe("\r=1")).toBe("'\r'=1");
  });
  it("neutralises a formula that starts a later line inside the cell", () => {
    expect(csvSafe("Guide fee\n=1+1")).toBe("Guide fee\n'=1+1");
    expect(csvSafe("a\r\n@x")).toBe("a\r\n'@x");
  });
  it("leaves plain values, negative numbers and ISO dates alone", () => {
    expect(csvSafe("Maria Santos")).toBe("Maria Santos");
    expect(csvSafe("-12.50")).toBe("-12.50");
    expect(csvSafe("-3")).toBe("-3");
    expect(csvSafe("2026-10-11T23:39:39.981Z")).toBe("2026-10-11T23:39:39.981Z");
    expect(csvSafe(null)).toBe("");
    expect(csvSafe(undefined)).toBe("");
    expect(csvSafe(0)).toBe("0");
  });
});

describe("ledger CSV", () => {
  const row = toLedgerRow(settlement({ vendorName: "=cmd|' /C calc'!A0", obligation: { sourceRef: "@INV-1" } }), { toBase, starter: "agent:autopilot", accountingStatus: "synced" });

  it("exports ISO dates, plain decimals and words", () => {
    expect(ledgerCsvValue("settledAt", row)).toBe("2026-10-11T23:39:39.981Z");
    expect(ledgerCsvValue("amountMinor", row)).toBe("180.00");
    expect(ledgerCsvValue("feeMinor", row)).toBe("3.60");
    expect(ledgerCsvValue("receivedMinor", row)).toBe("176.40");
    expect(ledgerCsvValue("rail", row)).toBe("PayPal");
    expect(ledgerCsvValue("recon", row)).toBe("In the books");
    expect(ledgerCsvValue("decidedBy", row)).toBe("Autopilot");
  });

  it("neutralises vendor-written text in every cell", () => {
    expect(ledgerCsvValue("vendorName", row)).toBe("'=cmd|' /C calc'!A0");
    expect(ledgerCsvValue("sourceRef", row)).toBe("'@INV-1");
  });

  it("marks a received amount in another currency", () => {
    const php = toLedgerRow(settlement({ receivedMinor: 1_035_000, receivedCurrency: "PHP" }), { toBase });
    expect(ledgerCsvValue("receivedMinor", php)).toBe("10350.00 PHP");
  });

  it("writes a quoted file with a header row the same way the grid does", () => {
    const csv = ledgerCsv([row]).split("\r\n");
    expect(csv).toHaveLength(2);
    expect(csv[0].startsWith('"Settled at (ISO 8601, UTC)","Vendor","Reference","Currency","Amount"')).toBe(true);
    expect(csv[1]).toContain('"\'=cmd|\' /C calc\'!A0"');
    expect(csv[1].startsWith('"2026-10-11T23:39:39.981Z"')).toBe(true);
  });

  it("formats zero-decimal currencies without decimals", () => {
    expect(decimalAmount(22_966_400_00, "VND")).toBe("22966400");
    expect(decimalAmount(null, "USD")).toBe("");
  });
});

describe("compareDayToIso", () => {
  it("compares by the business-local day (Asia/Ho_Chi_Minh in tests)", () => {
    // 23:39 UTC on 11 Oct is 06:39 on 12 Oct in Hanoi.
    expect(compareDayToIso(new Date(2026, 9, 12), "2026-10-11T23:39:39.981Z")).toBe(0);
    expect(compareDayToIso(new Date(2026, 9, 13), "2026-10-11T23:39:39.981Z")).toBe(-1);
    expect(compareDayToIso(new Date(2026, 9, 11), "2026-10-11T23:39:39.981Z")).toBe(1);
    expect(compareDayToIso(new Date(2026, 9, 11), "")).toBe(-1);
  });
});

describe("payment run rows", () => {
  const today = "2026-10-29";
  const rows = [
    toPayableRow({ id: "a", vendorName: "Maria Santos", sourceRef: "JOB-1", amountMinor: 18_000, currency: "USD", dueDate: "2026-10-25", state: "approved", rail: "paypal", scheduled: false }, { toBase, today }),
    toPayableRow({ id: "b", vendorName: "Ana Reyes", sourceRef: "JOB-2", amountMinor: 75_000, currency: "usd", dueDate: "2026-11-02", state: "awaiting_approval", rail: "stellar", scheduled: false }, { toBase, today }),
    toPayableRow({ id: "c", vendorName: null, sourceRef: null, amountMinor: 2_296_640_000, currency: "VND", dueDate: null, state: "awaiting_approval", rail: "bank_file", scheduled: false }, { toBase, today }),
    toPayableRow({ id: "d", vendorName: "Jun M", sourceRef: "INV-9", amountMinor: 45_000, currency: "USD", dueDate: "2026-10-20", state: "approved", rail: "paypal", scheduled: true }, { toBase, today }),
  ];

  it("maps candidates to rows with status words and an overdue flag", () => {
    expect(rows[0]).toMatchObject({ overdue: true, statusLabel: "Approved", railLabel: "PayPal", baseMinor: 18_000 });
    expect(rows[1]).toMatchObject({ overdue: false, currency: "USD", statusLabel: "Waiting for approval" });
    expect(rows[2]).toMatchObject({ vendorName: "Unknown vendor", sourceRef: "", overdue: false, baseMinor: 90_419 });
    expect(rows[3].statusLabel).toBe("Approved, autopilot scheduled");
    expect(toPayableRow({ ...rows[0], vendorName: "x", rail: null }, { toBase, today }).railLabel).toBe("No rail");
  });

  it("totals the selection per rail and per currency", () => {
    const f = fundingByRail(rows);
    expect(f.count).toBe(4);
    expect(f.byRail.map((r) => [r.railLabel, r.count, r.totals])).toEqual([
      ["PayPal", 2, [{ currency: "USD", minor: 63_000 }]],
      ["Stellar", 1, [{ currency: "USD", minor: 75_000 }]],
      ["Bank file", 1, [{ currency: "VND", minor: 2_296_640_000 }]],
    ]);
    expect(f.totals).toEqual([
      { currency: "USD", minor: 138_000 },
      { currency: "VND", minor: 2_296_640_000 },
    ]);
    expect(fundingByRail([])).toEqual({ byRail: [], totals: [], count: 0 });
  });

  it("picks what is due by a date, leaving undated and autopilot-scheduled payments", () => {
    expect(dueByIds(rows, "2026-10-31")).toEqual(["a"]);
    expect(dueByIds(rows, "2026-11-30")).toEqual(["a", "b"]);
  });

  it("maps a run with its progress and a base-currency total for sorting", () => {
    const r = toRunRow({ id: "run_1", name: "Week of 27 Oct 2026", status: "released", createdBy: "user:rianne", createdAt: "2026-10-27T02:00:00Z", count: 3, paid: 2, withBank: 1, totals: [{ currency: "USD", minor: 63_000 }, { currency: "VND", minor: 2_540_000_00 }] }, { toBase });
    expect(r).toMatchObject({ statusLabel: "Released", createdBy: "Rianne", progress: "2 of 3 paid, 1 with the bank", baseTotalMinor: 73_000 });
    expect(toRunRow({ ...r, status: "draft", createdBy: "user:rianne", paid: 0, withBank: 0 }, { toBase }).progress).toBe("3");
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectColumns, type ImportSpec } from "@/lib/onboarding/detect";
import { DEMO_BANK_SPEC } from "@/lib/onboarding/seed";
import { SUPPORTED_CURRENCIES } from "@/lib/domain/money";
import { confidenceWord, estimateSeconds, guessCurrency, isOutgoing, missingFields, previewRows, readDate, setColumn, sharedColumns, shortDate, unmappedColumns } from "./import-model";

const FIXTURE = readFileSync(path.join(__dirname, "../../lib/onboarding/__fixtures__/vn-bank-export.csv"), "utf8");
const BASE: ImportSpec = { skipRows: 0, columns: { date: "Date", amount: "Amount", payee: "Payee" }, dateFormat: "DMY", outgoing: "any" };

describe("setColumn and missingFields", () => {
  it("points a field at a column and clears an optional one", () => {
    const s = setColumn(BASE, "reference", "Ref");
    expect(s.columns.reference).toBe("Ref");
    expect(BASE.columns.reference).toBeUndefined();
    expect("reference" in setColumn(s, "reference", "").columns).toBe(false);
  });

  it("keeps date and amount as strings, so an empty one reads as missing", () => {
    const s = setColumn(setColumn(BASE, "date", ""), "payee", "");
    expect(s.columns.date).toBe("");
    expect(missingFields(s)).toEqual(["date", "payee"]);
    expect(missingFields({ ...s, payeePattern: "to (.+)" })).toEqual(["date"]);
    expect(missingFields(BASE)).toEqual([]);
  });

  it("names columns no field reads, and columns two fields share", () => {
    expect(unmappedColumns(["Date", "Payee", "Amount", "Balance", ""], BASE)).toEqual(["Balance"]);
    expect(sharedColumns(setColumn(BASE, "description", "Payee"))).toEqual(["payee"]);
    expect(sharedColumns(BASE)).toEqual([]);
  });
});

describe("readDate", () => {
  it("reads each order and ignores a time after the date", () => {
    expect(readDate("03/08/2026 08:41:12", "DMY")).toBe("2026-08-03");
    expect(readDate("03/08/2026", "MDY")).toBe("2026-03-08");
    expect(readDate("2026-08-03", "DMY")).toBe("2026-08-03");
    expect(readDate("26.08.03", "YMD")).toBe("2026-08-03");
  });

  it("refuses a day that does not exist and text that is not a date", () => {
    expect(readDate("31/02/2026", "DMY")).toBeNull();
    expect(readDate("13/31/2026", "DMY")).toBeNull();
    expect(readDate("yesterday", "DMY")).toBeNull();
  });
});

describe("isOutgoing", () => {
  it("follows the mapping's rule for which rows are payments", () => {
    expect(isOutgoing("4.000.000", "any")).toBe(true);
    expect(isOutgoing("", "any")).toBe(false);
    expect(isOutgoing("0.00", "any")).toBe(false);
    expect(isOutgoing("-1,250.00", "negative")).toBe(true);
    expect(isOutgoing("(1,250.00)", "negative")).toBe(true);
    expect(isOutgoing("1,250.00", "negative")).toBe(false);
    expect(isOutgoing("USD -40.00", "positive")).toBe(false);
  });
});

describe("previewRows on the Vietnamese fixture", () => {
  const d = detectColumns(FIXTURE, { saved: DEMO_BANK_SPEC });

  it("reads the first rows as the mapping reads them, day first, with money in marked as not a payment", () => {
    const rows = previewRows(d.header, d.sample, d.spec);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ date: "2026-08-03", payee: "PHUONG TRANSPORT", amount: "4.000.000", reference: "FT26215001", payment: true });
    expect(rows[2].payment).toBe(false);
    expect(rows[2].payee).toBe("");
  });

  it("carries the sample's redaction through: no phone number survives", () => {
    const rows = previewRows(d.header, d.sample, d.spec);
    expect(rows[1].description).toContain("[number]");
    expect(JSON.stringify(rows)).not.toMatch(/0912/);
  });

  it("reads the same dates month first when the owner changes the order", () => {
    const rows = previewRows(d.header, d.sample, { ...d.spec, dateFormat: "MDY" });
    expect(rows[0].date).toBe("2026-03-08");
    expect(rows[3].date).toBe("2026-05-08");
  });

  it("detects dong from the Vietnamese headers", () => {
    expect(guessCurrency(d.header, d.sample, SUPPORTED_CURRENCIES, "USD")).toBe("VND");
  });
});

describe("guessCurrency", () => {
  it("takes one code named in the file, else the business's currency", () => {
    expect(guessCurrency(["Date", "Amount (PHP)"], [], SUPPORTED_CURRENCIES, "USD")).toBe("PHP");
    expect(guessCurrency(["Date", "Amount"], [["1/1/2026", "THB 400"]], SUPPORTED_CURRENCIES, "USD")).toBe("THB");
    expect(guessCurrency(["Date", "Amount"], [], SUPPORTED_CURRENCIES, "USD")).toBe("USD");
    expect(guessCurrency(["Date", "USD", "VND"], [], SUPPORTED_CURRENCIES, "THB")).toBe("THB");
    expect(guessCurrency(["Date", "Amount"], [], SUPPORTED_CURRENCIES, "EUR")).toBe("USD");
  });
});

describe("small words", () => {
  it("estimates about 40 seconds for 1,000 payments, 5 at least", () => {
    expect(estimateSeconds(1000)).toBe(40);
    expect(estimateSeconds(8)).toBe(5);
  });

  it("names confidence and short dates", () => {
    expect(confidenceWord(1)).toBe("high");
    expect(confidenceWord(0.7)).toBe("medium");
    expect(confidenceWord(0.3)).toBe("low");
    expect(shortDate("2026-08-03")).toBe("3 Aug 2026");
    expect(shortDate(null)).toBe("");
  });
});

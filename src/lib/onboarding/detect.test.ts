import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRows } from "../check/recheck";
import { detectColumns, fileSpecOf, findHeaderRow, foldHeader, guessDateOrder, headerSignature, sniffDelimiter, toCommaCsv, validateSpec } from "./detect";
import { DEMO_BANK_HEADER, DEMO_BANK_SPEC } from "./seed";

const VN = fs.readFileSync(path.join(__dirname, "__fixtures__", "vn-bank-export.csv"), "utf8");

describe("detecting a Vietnamese bank export", () => {
  const d = detectColumns(VN);

  it("finds the header below the bank's title lines and maps every column", () => {
    expect(d.skipRows).toBe(4);
    expect(d.header).toEqual(DEMO_BANK_HEADER);
    expect(d.spec.columns).toEqual({ date: "Ngày giao dịch", payee: "Tên người hưởng", amount: "Số tiền ghi nợ", reference: "Số tham chiếu", description: "Nội dung" });
    expect(d.amountLayout).toBe("debit_credit");
    expect(d.creditColumn).toBe("Số tiền ghi có");
    expect(d.spec.outgoing).toBe("any");
    expect(d.unmapped).toEqual(["STT", "Số tiền ghi có", "Số dư"]);
    expect(d.missing).toEqual([]);
  });

  it("reads the dates day first, sure of it because a day is over 12, and is fully confident", () => {
    expect(d.spec.dateFormat).toBe("DMY");
    expect(d.dateOrderCertain).toBe(true);
    expect(d.confidence).toBe(1);
    expect(d.dataRows).toBe(8);
  });

  it("matches the mapping the demo saved for this layout, so the same bank's next file maps itself", () => {
    expect(d.signature).toBe(headerSignature(DEMO_BANK_HEADER));
    expect(d.spec).toEqual(DEMO_BANK_SPEC);
  });

  it("removes phone and account numbers from the sample it shows", () => {
    expect(d.sample).toHaveLength(5);
    expect(JSON.stringify(d.sample)).not.toMatch(/0912|345 678|0011004455667/);
    expect(d.sample[1][7]).toContain("[number]");
  });

  it("produces a spec the re-check reads: money going out only, with dot thousands and times after the date", () => {
    const { rows, skipped } = readRows(toCommaCsv(VN).text, fileSpecOf("vn.csv", d.spec));
    expect(skipped).toEqual([]);
    expect(rows.map((r) => [r.row, r.date, r.payee, r.amountMinor])).toEqual([
      [6, "2026-08-03", "PHUONG TRANSPORT", 400_000_000],
      [7, "2026-08-04", "Linh Family Homestay", 540_000_000],
      [9, "2026-08-05", "Dao Mountain Lodge", 1_360_000_000],
      [10, "2026-08-05", "PHUONG TRANSPORT", 400_000_000],
      [11, "2026-08-13", "Tam Motorbike Rental", 720_000_000],
      [12, "2026-08-14", "PHUONG TRANSPORT", 400_000_000],
    ]);
  });

  it("uses a saved mapping as is, with full confidence", () => {
    const saved = { ...DEMO_BANK_SPEC, columns: { ...DEMO_BANK_SPEC.columns, reference: undefined }, dateFormat: "DMY" as const };
    const s = detectColumns(VN, { saved });
    expect(s.fromSaved).toBe(true);
    expect(s.confidence).toBe(1);
    expect(s.spec.columns.reference).toBeUndefined();
    expect(s.unmapped).toContain("Số tham chiếu");
  });

  it("ignores a saved mapping whose columns are not in this file", () => {
    const s = detectColumns(VN, { saved: { ...DEMO_BANK_SPEC, columns: { date: "Posting date", amount: "Debit" } } });
    expect(s.fromSaved).toBe(false);
  });
});

describe("detecting other layouts", () => {
  it("an English export with one signed amount column, month-first dates and a header on line 1", () => {
    const csv = "Date,Description,Amount,Balance,Reference,Payee\n10/02/2026,Van hire,-800.00,1200.00,INV-1,Phuong Transport\n10/15/2026,Client payment,2500.00,3700.00,,ACME\n";
    const d = detectColumns(csv);
    expect(d.skipRows).toBe(0);
    expect(d.spec.columns).toEqual({ date: "Date", amount: "Amount", payee: "Payee", reference: "Reference", description: "Description" });
    expect(d.amountLayout).toBe("signed");
    expect(d.spec.outgoing).toBe("negative");
    expect(d.spec.dateFormat).toBe("MDY");
    expect(d.dateOrderCertain).toBe(true);
    expect(d.unmapped).toEqual(["Balance"]);
  });

  it("English debit and credit columns, ISO dates", () => {
    const d = detectColumns("Posting Date,Details,Debit,Credit,Running Balance\n2026-10-02,Guide fee Maria,180.00,,500\n2026-10-03,Refund,,20.00,520\n");
    expect(d.spec.columns.amount).toBe("Debit");
    expect(d.creditColumn).toBe("Credit");
    expect(d.amountLayout).toBe("debit_credit");
    expect(d.spec.dateFormat).toBe("YMD");
    expect(d.spec.columns.description).toBe("Details");
  });

  it("a semicolon-separated Vietnamese export with comma decimals and no payee column", () => {
    const csv = "Ngày GD;Diễn giải;Phát sinh nợ;Phát sinh có;Số dư\n02/10/2026;CK cho TRAN VAN BINH xe HG-4D-1002;2.500.000,00;;10.000.000,00\n03/10/2026;Nhan tien;;1.000.000,00;11.000.000,00\n";
    expect(sniffDelimiter(csv)).toBe(";");
    const d = detectColumns(csv);
    expect(d.delimiter).toBe(";");
    expect(d.spec.columns).toEqual({ date: "Ngày GD", amount: "Phát sinh nợ", description: "Diễn giải" });
    expect(d.missing).toEqual(["payee"]);
    expect(d.dateOrderCertain).toBe(false);
    expect(d.spec.dateFormat).toBe("DMY");
    expect(d.confidence).toBeLessThan(0.8);
    const { rows } = readRows(toCommaCsv(csv).text, fileSpecOf("x.csv", { ...d.spec, payeePattern: "CK cho ([A-Z ]+?) xe" }));
    expect(rows.map((r) => [r.payee, r.amountMinor])).toEqual([["TRAN VAN BINH", 250_000_000]]);
  });

  it("does not take an English row number (No.) for a Vietnamese debit column", () => {
    const d = detectColumns("No.,Date,Payee,Amount\n1,02/10/2026,Maria Santos,-180.00\n");
    expect(d.spec.columns.amount).toBe("Amount");
    expect(d.unmapped).toEqual(["No."]);
  });

  it("finds nothing it can use in a file with no recognisable header, and says so", () => {
    const d = detectColumns("a,b,c\n1,2,3\n");
    expect(d.missing).toEqual(["date", "amount", "payee"]);
    expect(d.confidence).toBe(0);
  });
});

describe("helpers", () => {
  it("folds Vietnamese headers", () => {
    expect(foldHeader("Số tiền ghi nợ (VND)")).toBe("so tien ghi no vnd");
    expect(foldHeader("Đối tác")).toBe("doi tac");
  });
  it("guesses the date order from the values", () => {
    expect(guessDateOrder(["01/02/2026", "13/02/2026"])).toEqual({ order: "DMY", certain: true });
    expect(guessDateOrder(["02/13/2026"])).toEqual({ order: "MDY", certain: true });
    expect(guessDateOrder(["2026-02-13"])).toEqual({ order: "YMD", certain: true });
    expect(guessDateOrder(["01/02/2026"])).toEqual({ order: "DMY", certain: false });
  });
  it("picks the line that names the most columns as the header", () => {
    expect(findHeaderRow([["Statement"], ["Account", "x"], ["Date", "Amount", "Description"], ["1", "2", "3"]])).toBe(2);
  });
  it("gives the same signature to the same layout however it is spelled", () => {
    expect(headerSignature(["Ngày giao dịch", "Số tiền"])).toBe(headerSignature(["NGÀY GIAO DỊCH ", "số tiền"]));
    expect(headerSignature(["Date", "Amount"])).not.toBe(headerSignature(["Amount", "Date"]));
  });
});

describe("checking a mapping from the page", () => {
  const header = DEMO_BANK_HEADER;
  it("accepts the detected spec and drops unknown keys", () => {
    expect(validateSpec({ ...DEMO_BANK_SPEC, extra: "x" }, header)).toEqual(DEMO_BANK_SPEC);
  });
  it("refuses a column the file does not have, a missing amount, and no payee source", () => {
    expect(() => validateSpec({ ...DEMO_BANK_SPEC, columns: { ...DEMO_BANK_SPEC.columns, amount: "Amount" } }, header)).toThrow(/no column "Amount"/);
    expect(() => validateSpec({ ...DEMO_BANK_SPEC, columns: { date: "Ngày giao dịch" } }, header)).toThrow(/money paid out/);
    expect(() => validateSpec({ ...DEMO_BANK_SPEC, columns: { date: "Ngày giao dịch", amount: "Số tiền ghi nợ" } }, header)).toThrow(/payee/);
  });
  it("refuses patterns that are invalid, too long or can hang", () => {
    const base = { ...DEMO_BANK_SPEC, columns: { date: "Ngày giao dịch", amount: "Số tiền ghi nợ", description: "Nội dung" } };
    expect(validateSpec({ ...base, payeePattern: "CK (\\w+)" }, header).payeePattern).toBe("CK (\\w+)");
    expect(() => validateSpec({ ...base, payeePattern: "(" }, header)).toThrow(/not a valid/);
    expect(() => validateSpec({ ...base, payeePattern: "(a+)+$" }, header)).toThrow(/repeats a repeated group/);
    expect(() => validateSpec({ ...base, payeePattern: "x".repeat(121) }, header)).toThrow(/120 characters/);
  });
  it("refuses a bad date order, outgoing mode or header line", () => {
    expect(() => validateSpec({ ...DEMO_BANK_SPEC, dateFormat: "DDMM" }, header)).toThrow(/Date order/);
    expect(() => validateSpec({ ...DEMO_BANK_SPEC, outgoing: "out" }, header)).toThrow(/Outgoing/);
    expect(() => validateSpec({ ...DEMO_BANK_SPEC, skipRows: -1 }, header)).toThrow(/whole number/);
  });
});

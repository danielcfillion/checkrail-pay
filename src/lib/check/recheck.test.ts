import { describe, expect, it } from "vitest";
import { openTestDb, snapshotOf } from "../db";
import { auditEntries, obligations, paymentAttempts } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { evaluatePayment } from "./evaluate";
import { atTime, confirmedTotals, parseAmount, parseCsv, parseDate, readRows, redact, resultsCsv, runRecheck, totals, validateConfig, type RecheckConfig } from "./recheck";

const BANK = `Sao kê tài khoản,,,,
Từ 01/08/2026 đến 31/10/2026,,,,
Ngày giao dịch,Tên người hưởng,Số tiền ghi nợ,Số tiền ghi có,Nội dung
05/08/2026 09:12,TRAN VAN BINH,"2.500.000",,CK tien xe tour HG-0805 STK 0071009999999
06/08/2026,Hoa Mai Guesthouse,"1.800.000",,Phong tour HG-0805 sdt 0912 345 678
10/08/2026,,,"50.000.000",Khach thanh toan
12/08/2026,TRAN VAN BINH,"2.500.000",,CK tien xe tour HG-0805
20/08/2026,Tran Van Binh,"3.000.000",,Xe tour HG-0818
`;
const JOBS = `Ngày,Đối tác,Thành tiền,Mã tour,Ghi chú
04/08/2026,Tran Van Binh,2.500.000,HG-0805,Xe 16 cho 2 ngay
05/08/2026,Hoa Mai Guesthouse,1.800.000,HG-0805,6 khach 1 dem
19/08/2026,Tran Van Binh,2.500.000,HG-0818,Xe 16 cho 2 ngay
`;
const CONFIG: RecheckConfig = validateConfig({
  currency: "VND",
  country: "VN",
  payments: { file: "payments.private.csv", skipRows: 2, columns: { date: "Ngày giao dịch", payee: "Tên người hưởng", amount: "Số tiền ghi nợ", description: "Nội dung" }, referencePattern: "\\b(HG-\\d{4})\\b" },
  jobs: { file: "jobs.private.csv", columns: { date: "Ngày", payee: "Đối tác", amount: "Thành tiền", reference: "Mã tour", description: "Ghi chú" } },
  payeeAliases: { "TRAN VAN BINH": "Tran Van Binh" },
});

describe("reading bank and job files", () => {
  it("reads amounts the way Vietnamese and English exports write them", () => {
    expect(parseAmount("2.500.000")).toEqual({ minor: 250_000_000, negative: false });
    expect(parseAmount("2,500,000")?.minor).toBe(250_000_000);
    expect(parseAmount("2500000.00")?.minor).toBe(250_000_000);
    expect(parseAmount("1.234,50")?.minor).toBe(123_450);
    expect(parseAmount("-2.500.000 VND")).toEqual({ minor: 250_000_000, negative: true });
    expect(parseAmount("(180.00)")).toEqual({ minor: 18_000, negative: true });
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("n/a")).toBeNull();
  });

  it("reads day-first dates, ignores a time, and refuses impossible ones", () => {
    expect(parseDate("05/08/2026 09:12")).toBe("2026-08-05");
    expect(parseDate("2026-08-05")).toBe("2026-08-05");
    expect(parseDate("08/05/2026", "MDY")).toBe("2026-08-05");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("yesterday")).toBeNull();
  });

  it("removes account numbers, phone numbers and emails before anything is judged or written", () => {
    const out = redact("CK STK 0071009999999 sdt 0912 345 678 mail a.b@example.vn tour HG-0805 so tien 2.500.000");
    expect(out).not.toMatch(/0071009999999|0912|345 678|example\.vn/);
    expect(out).toContain("HG-0805");
    expect(out).toContain("2.500.000");
  });

  it("finds the header below a bank's title lines, keeps money going out, and applies aliases", () => {
    const { rows, skipped } = readRows(BANK, CONFIG.payments, CONFIG.payeeAliases);
    expect(rows.map((r) => [r.row, r.payee, r.amountMinor, r.reference])).toEqual([
      [4, "Tran Van Binh", 250_000_000, "HG-0805"],
      [5, "Hoa Mai Guesthouse", 180_000_000, "HG-0805"],
      [7, "Tran Van Binh", 250_000_000, "HG-0805"],
      [8, "Tran Van Binh", 300_000_000, "HG-0818"],
    ]);
    expect(skipped).toEqual([]);
    expect(rows.map((r) => r.description).join(" ")).not.toMatch(/0071009999999|0912/);
  });

  it("names the columns it has when a configured one is missing", () => {
    expect(() => readRows(BANK, { ...CONFIG.payments, columns: { ...CONFIG.payments.columns, amount: "Amount" } })).toThrow(/no column "Amount".*"Số tiền ghi nợ"/);
  });

  it("parses quoted CSV fields with commas, quotes and newlines", () => {
    expect(parseCsv('a,"b, c","d ""e""","f\ng"\r\n1,2,3,4')).toEqual([["a", "b, c", 'd "e"', "f\ng"], ["1", "2", "3", "4"]]);
  });
});

describe("the historical re-check", () => {
  it("finds the repeat payment and the overcharge, each judged on its own date", async () => {
    const pay = readRows(BANK, CONFIG.payments, CONFIG.payeeAliases).rows;
    const jobs = readRows(JOBS, CONFIG.jobs!, CONFIG.payeeAliases).rows;
    const rows = await runRecheck({ config: CONFIG, payments: pay, jobs });
    const by = Object.fromEntries(rows.map((r) => [r.row, r]));
    expect(by[4].category).toBe("clean");
    expect(by[7].category).toBe("duplicate");
    expect(by[7].duplicateOfRow).toBe(4);
    expect(by[7].reason).toContain("row 4");
    expect(by[8].category).toBe("overcharge");
    expect(by[8].overpaidMinor).toBe(50_000_000);
    const t = totals(rows);
    expect(t.duplicates).toEqual({ count: 1, minor: 250_000_000 });
    expect(t.overcharges).toEqual({ count: 1, overpaidMinor: 50_000_000 });
    expect(t.wouldHaveStoppedMinor).toBe(300_000_000);
  });

  it("never creates a payment attempt and leaves every replayed payment recorded as paid", async () => {
    const db = openTestDb();
    const pay = readRows(BANK, CONFIG.payments, CONFIG.payeeAliases).rows;
    await runRecheck({ config: CONFIG, payments: pay, jobs: readRows(JOBS, CONFIG.jobs!, CONFIG.payeeAliases).rows, db });
    expect(db.select().from(paymentAttempts).all()).toEqual([]);
    expect(db.select().from(obligations).all().map((o) => o.state)).toEqual(["settled", "settled", "settled", "settled"]);
  });

  it("an earlier payment more than 30 days back does not count as the same-amount repeat", async () => {
    const far = readRows(`Ngày giao dịch,Tên người hưởng,Số tiền ghi nợ,Nội dung\n01/08/2026,Tran Van Binh,2.500.000,xe\n15/09/2026,Tran Van Binh,2.500.000,xe\n`, { ...CONFIG.payments, skipRows: 0, referencePattern: undefined }).rows;
    const near = readRows(`Ngày giao dịch,Tên người hưởng,Số tiền ghi nợ,Nội dung\n01/08/2026,Tran Van Binh,2.500.000,xe\n15/08/2026,Tran Van Binh,2.500.000,xe\n`, { ...CONFIG.payments, skipRows: 0, referencePattern: undefined }).rows;
    const [farRows, nearRows] = [await runRecheck({ config: CONFIG, payments: far }), await runRecheck({ config: CONFIG, payments: near })];
    expect(farRows[1].rules).not.toContain("no_duplicate");
    expect(nearRows[1].rules).toContain("no_duplicate");
  });

  it("restores the real clock even when the work throws", async () => {
    const before = Date.now();
    await expect(atTime("2026-08-05T02:00:00Z", async () => {
      expect(new Date().toISOString()).toBe("2026-08-05T02:00:00.000Z");
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(Date.now()).toBeGreaterThanOrEqual(before);
    expect(new Date().getUTCFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it("public totals count only the flags a person confirmed", async () => {
    const pay = readRows(BANK, CONFIG.payments, CONFIG.payeeAliases).rows;
    const rows = await runRecheck({ config: CONFIG, payments: pay, jobs: readRows(JOBS, CONFIG.jobs!, CONFIG.payeeAliases).rows });
    const csv = resultsCsv(rows);
    expect(confirmedTotals(csv).confirmed.wouldHaveStoppedMinor).toBe(0);
    expect(confirmedTotals(csv).unreviewedFlags).toBe(2);
    const reviewed = csv.split("\n").map((l) => (l.includes(",duplicate,") ? l.replace(/,$/, ",yes") : l.includes(",overcharge,") ? l.replace(/,$/, ",no") : l)).join("\n");
    const t = confirmedTotals(reviewed);
    expect(t.confirmed.duplicates.minor).toBe(250_000_000);
    expect(t.confirmed.overcharges.count).toBe(0);
    expect(t.unreviewedFlags).toBe(0);
  });
});

describe("judging a payment on a copy of the books", () => {
  it("writes nothing to the real database and pays nothing", async () => {
    const db = openTestDb();
    await seedDemo(db);
    const before = { obligations: db.select().from(obligations).all().length, audit: db.select().from(auditEntries).all().length, attempts: db.select().from(paymentAttempts).all().length };
    const copy = snapshotOf(db);
    const r = await evaluatePayment(copy, { businessId: DEMO_BUSINESS_ID, payee: "Phuong Transport", amountMinor: 96_000, currency: "USD", reference: "INV-2026-0999", description: "Van for HG-4D-0927, total $960" });
    expect(r.verdict).not.toBe("pay");
    expect(db.select().from(obligations).all().length).toBe(before.obligations);
    expect(db.select().from(auditEntries).all().length).toBe(before.audit);
    expect(db.select().from(paymentAttempts).all().length).toBe(before.attempts);
    expect(copy.select().from(paymentAttempts).all().length).toBe(before.attempts);
  });

  it("blocks a job the books already show as paid, naming the rule", async () => {
    const db = openTestDb();
    await seedDemo(db);
    const r = await evaluatePayment(snapshotOf(db), { businessId: DEMO_BUSINESS_ID, payee: "Maria Santos", amountMinor: 18_000, currency: "USD", reference: "JOB-HG4D-0914", description: "Guide fee" });
    expect(r.verdict).toBe("block");
    expect(r.blocks.map((b) => b.rule)).toContain("no_duplicate");
    expect(r.summary).toMatch(/^Do not pay: /);
  });
});

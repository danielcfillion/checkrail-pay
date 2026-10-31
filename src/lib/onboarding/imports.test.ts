import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openTestDb } from "../db";
import { auditEntries, obligations, onboardingImports, onboardingMappings, onboardingResults, paymentAttempts, vendors } from "../db/schema";
import { config } from "../config";
import { detectColumns } from "./detect";
import { MAX_CSV_BYTES, MAX_DATA_ROWS, RECHECK_DAYS, checkSize, createImport, detectForBusiness, getImport, inWindow, listImports } from "./imports";
import { importCalls } from "./dashboard";
import { BIZ, addVendor, setUpBusiness } from "./testkit";

const VN = fs.readFileSync(path.join(__dirname, "__fixtures__", "vn-bank-export.csv"), "utf8");

describe("bringing in a bank export and re-checking it", async () => {
  const db = openTestDb();
  const people = setUpBusiness(db);
  addVendor(db, "ven_phuong", "Phuong Transport");
  const detected = detectForBusiness(db, BIZ, people.clerk, VN);
  const summary = await createImport(db, BIZ, people.clerk, { csv: VN, fileName: "sao ke 08.csv", currency: "VND", spec: detected.spec });

  it("stores the import with its totals: the repeat payment is caught and counted as money that would have been blocked", () => {
    expect(summary).toMatchObject({ status: "checked", currency: "VND", rowsRead: 6, rowsChecked: 6, rowsOutsideWindow: 0, payments: 6, periodFrom: "2026-08-03", periodTo: "2026-08-14", createdBy: "user:lan" });
    expect(summary.duplicates).toEqual({ count: 1, minor: 400_000_000 });
    expect(summary.wouldHaveBlockedMinor).toBe(400_000_000);
    expect(summary.blockedCount + summary.heldCount + summary.clearCount).toBe(6);
    expect(summary.fileName).toBe("sao ke 08.csv");
    expect(getImport(db, BIZ, summary.id)).toEqual(summary);
    expect(listImports(db, BIZ).map((i) => i.id)).toEqual([summary.id]);
  });

  it("lists the flagged calls of the import in file order, with the repeat naming the row it repeats", () => {
    const calls = importCalls(db, BIZ, summary.id);
    const dup = calls.find((c) => c.category === "duplicate")!;
    expect(dup).toMatchObject({ file_row: 10, payee: "PHUONG TRANSPORT", duplicate_of_row: 6, amount_minor: 400_000_000, currency: "VND" });
    expect(calls.map((c) => c.file_row)).toEqual([...calls.map((c) => c.file_row)].sort((a, b) => a - b));
    expect(db.select().from(onboardingResults).all()).toHaveLength(6);
  });

  it("saves the mapping for this layout, so the next upload of the same export maps itself", () => {
    expect(db.select().from(onboardingMappings).all()).toHaveLength(1);
    const again = detectForBusiness(db, BIZ, people.clerk, VN);
    expect(again.fromSaved).toBe(true);
    expect(again.confidence).toBe(1);
  });

  it("pays nothing and leaves the books alone: no payment request, no attempt, no new supplier", () => {
    expect(db.select().from(obligations).all()).toEqual([]);
    expect(db.select().from(paymentAttempts).all()).toEqual([]);
    expect(db.select().from(vendors).all().map((v) => v.id)).toEqual(["ven_phuong"]);
  });

  it("records the re-check in the audit log", () => {
    const row = db.select().from(auditEntries).all().find((a) => a.action === "onboarding.import_checked")!;
    expect(row.actor).toBe("user:lan");
    expect(JSON.parse(row.detailJson!)).toMatchObject({ importId: summary.id, payments: 6, duplicates: 1 });
  });

  it("runs with the rule-based reader and puts the configured reader back afterwards", async () => {
    const ai = config.ai as unknown as { mode: string };
    const prev = ai.mode;
    ai.mode = "live";
    try {
      const s = await createImport(db, BIZ, people.owner, { csv: VN, fileName: "again.csv", currency: "VND", spec: detected.spec });
      expect(s.status).toBe("checked");
      expect(ai.mode).toBe("live");
    } finally {
      ai.mode = prev;
    }
  });
});

describe("what an import refuses", () => {
  const db = openTestDb();
  const people = setUpBusiness(db);
  const spec = detectColumns(VN).spec;

  it("refuses people who may not bring in payments", async () => {
    await expect(createImport(db, BIZ, people.accountant, { csv: VN, fileName: "x.csv", currency: "VND", spec })).rejects.toThrow(/cannot bring in past payments/);
    await expect(createImport(db, BIZ, people.approver, { csv: VN, fileName: "x.csv", currency: "VND", spec })).rejects.toThrow(/cannot bring in past payments/);
    expect(() => detectForBusiness(db, BIZ, people.accountant, VN)).toThrow(/cannot bring in past payments/);
  });

  it("refuses a file over 5 MB, an empty file, and one with too many lines", async () => {
    expect(() => checkSize("x".repeat(MAX_CSV_BYTES + 1))).toThrow(/larger than 5 MB/);
    expect(() => checkSize("  ")).toThrow(/empty/);
    expect(() => checkSize(42)).toThrow(/did not arrive as text/);
    const big = "Ngày giao dịch,Tên người hưởng,Số tiền ghi nợ\n" + "01/08/2026,A,1.000\n".repeat(MAX_DATA_ROWS + 1);
    await expect(createImport(db, BIZ, people.clerk, { csv: big, fileName: "x.csv", currency: "VND", spec: { skipRows: 0, columns: { date: "Ngày giao dịch", payee: "Tên người hưởng", amount: "Số tiền ghi nợ" }, dateFormat: "DMY", outgoing: "any" } })).rejects.toThrow(/the most it may have is 20000/);
  });

  it("refuses an unsupported currency and a mapping that does not fit the file", async () => {
    await expect(createImport(db, BIZ, people.clerk, { csv: VN, fileName: "x.csv", currency: "EUR", spec })).rejects.toThrow(/Currency must be one of/);
    await expect(createImport(db, BIZ, people.clerk, { csv: VN, fileName: "x.csv", currency: "VND", spec: { ...spec, columns: { ...spec.columns, amount: "Amount" } } })).rejects.toThrow(/no column "Amount"/);
  });

  it("says so when no payment could be read, for example with the wrong date order", async () => {
    await expect(createImport(db, BIZ, people.clerk, { csv: VN, fileName: "x.csv", currency: "VND", spec: { ...spec, dateFormat: "YMD" } })).rejects.toThrow(/date could not be read/);
    expect(db.select().from(onboardingImports).all()).toEqual([]);
  });

  it("refuses more payments in the window than one re-check takes", async () => {
    const lines = Array.from({ length: 1001 }, (_, i) => `0${1 + (i % 9)}/10/2026,Supplier ${i},1.000.000`).join("\n");
    await expect(createImport(db, BIZ, people.clerk, { csv: `Ngày giao dịch,Tên người hưởng,Số tiền ghi nợ\n${lines}\n`, fileName: "x.csv", currency: "VND", spec: { skipRows: 0, columns: { date: "Ngày giao dịch", payee: "Tên người hưởng", amount: "Số tiền ghi nợ" }, dateFormat: "DMY", outgoing: "any" } })).rejects.toThrow(/1001 payments; one re-check takes 1000 at most/);
  });
});

describe("the 90-day window", () => {
  it("keeps the payments within 90 days of the latest one", () => {
    const row = (date: string) => ({ row: 2, date, payee: "A", amountMinor: 1, reference: null, description: "" });
    const { kept, outside } = inWindow([row("2026-10-31"), row("2026-08-03"), row("2026-08-02"), row("2026-05-01")]);
    expect(RECHECK_DAYS).toBe(90);
    expect(kept.map((r) => r.date)).toEqual(["2026-10-31", "2026-08-03"]);
    expect(outside).toBe(2);
  });
});

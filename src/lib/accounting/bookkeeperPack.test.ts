import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { accountingSyncs } from "../db/schema";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { approveObligation, confirmSettlement, executeObligation } from "../engine/orchestrator";
import { buildBookkeeperPack, currencyFormat, defaultPackPeriod, PACK_ROW_CAP, PACK_SHEETS } from "./bookkeeperPack";
import { localDateString } from "../format";
import { allRecords, SIMULATED_EXPLORER, toCsv } from "./record";
import { xeroBillRows } from "./xeroBills";

type Formula = { formula: string; result: number };

describe("bookkeeper pack (.xlsx)", () => {
  let db: Db;
  let wb: ExcelJS.Workbook;
  const LIVE_URL = "https://stellar.expert/explorer/testnet/tx/abc123";

  beforeAll(async () => {
    db = openTestDb();
    const { story } = await seedDemo(db);
    approveObligation(db, story.stellar, "user:daniel");
    await executeObligation(db, story.stellar, { actor: "user:minh" });
    await confirmSettlement(db, story.stellar, "test");
    // One Stellar payment as if it had run on testnet, so the pack has a real explorer link to make a hyperlink of.
    const hist = db.select().from(accountingSyncs).all().find((a) => JSON.parse(a.payloadJson!).reference === "JOB-PAL2D-0912")!;
    const p = JSON.parse(hist.payloadJson!);
    db.update(accountingSyncs).set({ payloadJson: JSON.stringify({ ...p, rail: "stellar", explorerUrl: LIVE_URL, railMode: "testnet" }) }).where(eq(accountingSyncs.id, hist.id)).run();
    const { buffer } = await buildBookkeeperPack(db, DEMO_BUSINESS_ID, { generatedAt: new Date("2026-11-03T10:00:00Z"), period: "all" });
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  });

  const header = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as unknown[]).slice(1) as string[];
  const col = (ws: ExcelJS.Worksheet, name: string) => header(ws).indexOf(name) + 1;

  it("has the cover, bills, payments and fees sheets, each with a frozen header, a filter and landscape fit-to-width printing", () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual([...PACK_SHEETS]);
    for (const name of ["Bills", "Payments", "Fees"]) {
      const ws = wb.getWorksheet(name)!;
      expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
      expect(ws.autoFilter).toBeTruthy();
      expect(ws.pageSetup).toMatchObject({ fitToPage: true, fitToWidth: 1, fitToHeight: 0 });
      expect(ws.getColumn(1).width).toBeGreaterThan(8);
    }
    expect(wb.getWorksheet("Bills")!.pageSetup.orientation).toBe("landscape");
    expect(wb.getWorksheet("Payments")!.pageSetup.orientation).toBe("landscape");
    expect(wb.getWorksheet("Cover")!.pageSetup.orientation).toBe("landscape");
  });

  it("the cover names the business, the period, what each sheet is, the totals and how to use it with Xero", () => {
    const cover = wb.getWorksheet("Cover")!;
    const text: string[] = [];
    cover.eachRow((r) => r.eachCell((c) => text.push(String(c.value instanceof Date ? "DATE" : c.value))));
    const all = text.join("\n");
    expect(all).toMatch(/Ridgeline Expeditions LLC/);
    expect(all).toMatch(/Period/);
    expect(cover.getCell("B4").value).toBeInstanceOf(Date);
    expect(cover.getCell("C4").value).toBeInstanceOf(Date);
    for (const s of ["Bills", "Payments", "Fees", "Totals", "Net paid (cash out)", "How to use with Xero"]) expect(all).toContain(s);
    expect(all).toMatch(/Import the bills CSV/);
    expect(all).toMatch(/match from the bank feed/);
    expect(all).toMatch(/Demo rate/);
    expect(all).toMatch(/simulated, not on chain/);
  });

  it("the Bills sheet holds the same rows as the Xero bills file, with readable headers, real dates and numbers", () => {
    const ws = wb.getWorksheet("Bills")!;
    expect(header(ws)).toEqual(["Contact", "Email", "Country", "Invoice number", "Invoice date", "Due date", "Description", "Quantity", "Amount", "Currency", "Account code", "Tax type", "Tracking category", "Tracking option"]);
    const file = xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: false }).rows;
    const invoices: string[] = [];
    for (let r = 2; r <= file.length + 1; r++) invoices.push(String(ws.getRow(r).getCell(4).value));
    // The same rows as the file, in invoice-date order (so a capped sheet drops the latest).
    expect([...invoices].sort()).toEqual(file.map((f) => String(f["*InvoiceNumber"])).sort());
    const dates = invoices.map((_, i) => (ws.getRow(i + 2).getCell(5).value as Date).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    const row = ws.getRow(invoices.indexOf("JOB-PAL3D-0927") + 2);
    expect(row.getCell(5).value).toBeInstanceOf(Date);
    expect(row.getCell(5).numFmt).toBe("d mmm yyyy");
    expect(row.getCell(9).value).toBe(750);
    expect(row.getCell(9).numFmt).toBe(currencyFormat("USD"));
    expect(row.getCell(11).value).toBe("310");
  });

  it("the Payments sheet: real dates, numeric amounts with currency formats, account code and name apart, who paid the fee, received and rate, and the explorer link", () => {
    const ws = wb.getWorksheet("Payments")!;
    for (const h of ["Payment date", "Amount (bill)", "Fee", "Fee paid by", "Net paid (cash out)", "Recipient received", "FX rate", "FX rate source", "Account code", "Account name", "Explorer"]) expect(header(ws)).toContain(h);
    const records = allRecords(db);
    const rows = records.length;
    const find = (ref: string) => {
      for (let r = 2; r <= rows + 1; r++) if (ws.getRow(r).getCell(col(ws, "Reference")).value === ref) return ws.getRow(r);
      throw new Error(ref);
    };
    const ana = find("JOB-PAL3D-0927");
    expect(ana.getCell(col(ws, "Payment date")).value).toBeInstanceOf(Date);
    expect(ana.getCell(col(ws, "Amount (bill)")).value).toBe(750);
    expect(ana.getCell(col(ws, "Fee")).value).toBe(13.41);
    expect(ana.getCell(col(ws, "Net paid (cash out)")).value).toBe(763.41);
    expect(ana.getCell(col(ws, "Net paid (cash out)")).numFmt).toBe(currencyFormat("USD"));
    expect(ana.getCell(col(ws, "Fee paid by")).value).toBe("Business");
    expect(ana.getCell(col(ws, "Recipient received")).value).toBe(46486.24);
    expect(ana.getCell(col(ws, "Recipient received")).numFmt).toBe(currencyFormat("PHP"));
    expect(typeof ana.getCell(col(ws, "FX rate")).value).toBe("number");
    expect(ana.getCell(col(ws, "Account code")).value).toBe("310");
    expect(ana.getCell(col(ws, "Account name")).value).toBe("Cost of Goods Sold");
    expect(ana.getCell(col(ws, "Explorer")).value).toBe(SIMULATED_EXPLORER);

    const linked = find("JOB-PAL2D-0912").getCell(col(ws, "Explorer"));
    expect(linked.value).toMatchObject({ text: "View transaction", hyperlink: LIVE_URL });
    expect(linked.hyperlink).toBe(LIVE_URL);

    const tam = find("INV-TAM-0834");
    expect(tam.getCell(col(ws, "Account code")).value).toBe("325");
    expect(tam.getCell(col(ws, "Account name")).value).toBe("Direct Expenses");

    // A past payment converted at a demo rate says so.
    const maria = find("JOB-HG4D-0914");
    expect(maria.getCell(col(ws, "FX rate source")).value).toBe("Demo rate");
  });

  it("the totals rows sum the data rows, by currency, as live formulas with their values", () => {
    const ws = wb.getWorksheet("Payments")!;
    const records = allRecords(db);
    const total = ws.getRow(records.length + 3);
    expect(total.getCell(col(ws, "Description")).value).toBe(`Total USD (${records.length} payments)`);
    const net = total.getCell(col(ws, "Net paid (cash out)")).value as Formula;
    expect(net.formula).toMatch(/^SUMIFS\(N2:N\d+,J2:J\d+,"USD"\)$/);
    const expected = records.filter((r) => r.grossCurrency === "USD").reduce((a, r) => a + Number(r.netPaid), 0);
    expect(net.result).toBeCloseTo(expected, 2);
    const fees = total.getCell(col(ws, "Fee")).value as Formula;
    expect(fees.result).toBeCloseTo(records.reduce((a, r) => a + Number(r.feeAmount), 0), 2);
    expect(total.getCell(col(ws, "Rail")).value).toBeNull();

    const bills = wb.getWorksheet("Bills")!;
    const file = xeroBillRows(db, DEMO_BUSINESS_ID, { onlyNew: false }).rows;
    const billTotal = bills.getRow(file.length + 3);
    // The count is in the label; the Quantity column stays empty on the totals row.
    expect(billTotal.getCell(7).value).toBe(`Total USD (${file.length} bills)`);
    expect(billTotal.getCell(8).value).toBeNull();
    const bt = billTotal.getCell(9).value as Formula;
    expect(bt.result).toBeCloseTo(file.reduce((a, r) => a + Number(r["*UnitAmount"]), 0), 2);
  });

  it("the Fees sheet totals fees by rail and month, and they add up to the payments' fees", () => {
    const ws = wb.getWorksheet("Fees")!;
    expect(header(ws)).toEqual(["Month", "Rail", "Currency", "Payments", "Amount paid", "Fees", "Fees as % of amount"]);
    const records = allRecords(db);
    const months = new Set(records.map((r) => `${r.paymentDate.slice(0, 7)}|${r.rail}`));
    let sum = 0;
    let n = 0;
    for (let r = 2; r <= months.size + 1; r++) {
      const row = ws.getRow(r);
      expect(row.getCell(1).value).toBeInstanceOf(Date);
      expect(row.getCell(1).numFmt).toBe("mmm yyyy");
      sum += row.getCell(6).value as number;
      n += row.getCell(4).value as number;
    }
    expect(n).toBe(records.length);
    expect(sum).toBeCloseTo(records.reduce((a, r) => a + Number(r.feeAmount), 0), 2);
    const total = ws.getRow(months.size + 3);
    expect(total.getCell(2).value).toBe("Total USD");
    expect((total.getCell(6).value as Formula).result).toBeCloseTo(sum, 2);
  });

  it("the settlement records CSV splits the account into code and name, says who paid the fee, and marks a simulated Stellar payment", () => {
    const csv = toCsv(allRecords(db));
    const [head, ...lines] = csv.trim().split("\n");
    const cols = head.split(",");
    expect(cols).toContain("accountName");
    expect(cols).toContain("feePaidBy");
    const cells = (line: string) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1].replace(/^"|"$/g, "").replace(/""/g, '"')).slice(0, cols.length);
    const ana = cells(lines.find((l) => l.startsWith("JOB-PAL3D-0927,"))!);
    expect(ana[cols.indexOf("accountCode")]).toBe("310");
    expect(ana[cols.indexOf("accountName")]).toBe("Cost of Goods Sold");
    expect(ana[cols.indexOf("feePaidBy")]).toBe("business");
    expect(ana[cols.indexOf("explorerUrl")]).toBe(SIMULATED_EXPLORER);
  });

  it("splits an older record's 'code name' account and treats its Stellar fee as borne by the recipient", async () => {
    const { forExport } = await import("./record");
    const old = forExport({ reference: "R", vendorName: "V", vendorCountry: "PH", description: "d", billDate: "2026-10-01", paymentDate: "2026-10-02", grossAmount: "750.00", grossCurrency: "USD", feeAmount: "13.25", feeCurrency: "USD", netPaid: "750.00", recipientReceived: null, recipientCurrency: null, fxRate: null, rail: "stellar", externalTransactionId: "X", explorerUrl: null, accountCode: "310 Cost of Goods Sold: Contract labour", obligationId: "o" });
    expect(old).toMatchObject({ accountCode: "310", accountName: "Cost of Goods Sold", feePaidBy: "recipient", explorerUrl: SIMULATED_EXPLORER });
  });

  it("defaults to this month and last month, by invoice date and payment date", async () => {
    expect(defaultPackPeriod("2026-11-03")).toEqual({ from: "2026-10-01", to: "2026-11-30" });
    expect(defaultPackPeriod("2026-01-15")).toEqual({ from: "2025-12-01", to: "2026-01-31" });
    const today = localDateString();
    const period = defaultPackPeriod(today);
    const { buffer, summary } = await buildBookkeeperPack(db, DEMO_BUSINESS_ID);
    expect([summary.periodFrom, summary.periodTo]).toEqual([period.from, period.to]);
    const inside = allRecords(db, DEMO_BUSINESS_ID).filter((r) => r.paymentDate >= period.from && r.paymentDate <= period.to);
    expect(summary.payments).toBe(inside.length);
    expect(summary.payments).toBeLessThan(allRecords(db, DEMO_BUSINESS_ID).length);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = book.getWorksheet("Payments")!;
    for (let r = 2; r <= inside.length + 1; r++) {
      const d = (ws.getRow(r).getCell(1).value as Date).toISOString().slice(0, 10);
      expect(d >= period.from && d <= period.to).toBe(true);
    }
    expect(String(book.getWorksheet("Cover")!.getCell("D4").value)).toMatch(/payments by payment date/);
    const custom = await buildBookkeeperPack(db, DEMO_BUSINESS_ID, { period: { from: "2026-09-01", to: "2026-09-30" } });
    expect(custom.summary.payments).toBe(allRecords(db, DEMO_BUSINESS_ID).filter((r) => r.paymentDate.startsWith("2026-09")).length);
  });

  it("caps each sheet at the row limit and says so on the cover, in red, with what was left out", async () => {
    const { buffer, summary } = await buildBookkeeperPack(db, DEMO_BUSINESS_ID, { period: "all", maxRows: 5 });
    expect(summary).toMatchObject({ bills: 5, payments: 5 });
    expect(summary.leftOut.payments).toBe(allRecords(db, DEMO_BUSINESS_ID).length - 5);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    const text: string[] = [];
    book.getWorksheet("Cover")!.eachRow((r) => r.eachCell((c) => text.push(String(c.value))));
    expect(text.join("\n")).toMatch(new RegExp(`at most 5 rows\\. This period has more, so ${summary.leftOut.bills} later bills and ${summary.leftOut.payments} later payments are left out`));
    expect(book.getWorksheet("Payments")!.getRow(8).getCell(7).value).toBe("Total USD (5 payments)");
    expect(PACK_ROW_CAP).toBe(5_000);
    // Under the cap, no such note.
    const full = await buildBookkeeperPack(db, DEMO_BUSINESS_ID, { period: "all" });
    expect(full.summary.leftOut).toEqual({ bills: 0, payments: 0 });
  });
});

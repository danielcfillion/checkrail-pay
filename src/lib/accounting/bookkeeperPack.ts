import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { businesses } from "../db/schema";
import { ZERO_DECIMAL_CURRENCIES } from "../domain/money";
import { formatDateTime } from "../format";
import { label as railLabel } from "../domain/routing";
import type { Rail } from "../domain/types";
import { allRecords, SIMULATED_EXPLORER } from "./record";
import { xeroBillRows } from "./xeroBills";

/**
 * The bookkeeper pack: one formatted workbook for the accountant, beside the CSV files. It is for reading and
 * checking, not for importing: the Xero bills CSV stays the import file, and payments are matched from the bank feed.
 *
 * Sheets: Cover (what is here, totals, how to use it with Xero), Bills (the same rows as the Xero bills file, every
 * agreed bill), Payments (one row per settled payment, from the settlement records) and Fees (by rail and month).
 * Dates are real dates, amounts are numbers with a currency format, the explorer link is a hyperlink.
 */

export const PACK_SHEETS = ["Cover", "Bills", "Payments", "Fees"] as const;
const DATE_FMT = "d mmm yyyy";
const HEAD_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF10233A" } };
const TOTAL_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDF0F2" } };

/** Excel number format for an amount in this currency: whole units for VND and the like, else two places. */
export function currencyFormat(currency: string): string {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? `#,##0 "${currency}";-#,##0 "${currency}"` : `#,##0.00 "${currency}";-#,##0.00 "${currency}"`;
}

/** "2026-10-12" as a date cell: midnight UTC, which Excel shows as that calendar day. */
function day(d: string | null | undefined): Date | null {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return new Date(`${d}T00:00:00.000Z`);
}

function num(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface Col {
  header: string;
  key: string;
  width: number;
  kind?: "date" | "money" | "rate" | "int";
}

/** Header row, widths, frozen header, filter, print setup: the same on every data sheet. */
function table(ws: ExcelJS.Worksheet, cols: Col[], landscape = true): void {
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = HEAD_FILL;
  head.alignment = { vertical: "middle", wrapText: true };
  head.height = 30;
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];
  ws.pageSetup = { orientation: landscape ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, printTitlesRow: "1:1", margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };
  ws.headerFooter = { oddFooter: "&L&A&RPage &P of &N" };
}

function filter(ws: ExcelJS.Worksheet, cols: number, lastRow: number): void {
  if (lastRow >= 2) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: lastRow, column: cols } };
}

/** Column letter for a 1-based index (1 to A, 27 to AA). */
function letter(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/**
 * Totals rows under a table, one per currency: SUMIFS over the data rows for each money column, with the computed
 * result stored too so a reader that does not recalculate still shows the figure.
 */
function totals(ws: ExcelJS.Worksheet, opts: { first: number; last: number; currencyCol: number; labelCol: number; sums: Array<{ col: number; values: Array<{ currency: string; value: number | null }> }>; countCol?: number }): number {
  const currencies = [...new Set(opts.sums.flatMap((s) => s.values.map((v) => v.currency)))].sort();
  let r = opts.last + 2;
  const cur = letter(opts.currencyCol);
  for (const c of currencies) {
    const row = ws.getRow(r);
    row.getCell(opts.labelCol).value = `Total ${c}`;
    row.getCell(opts.currencyCol).value = c;
    for (const s of opts.sums) {
      const col = letter(s.col);
      const result = s.values.filter((v) => v.currency === c).reduce((a, v) => a + (v.value ?? 0), 0);
      const cell = row.getCell(s.col);
      cell.value = { formula: `SUMIFS(${col}${opts.first}:${col}${opts.last},${cur}${opts.first}:${cur}${opts.last},"${c}")`, result: round(result, c) };
      cell.numFmt = currencyFormat(c);
    }
    if (opts.countCol) row.getCell(opts.countCol).value = { formula: `COUNTIFS(${cur}${opts.first}:${cur}${opts.last},"${c}")`, result: opts.sums[0]?.values.filter((v) => v.currency === c).length ?? 0 };
    row.font = { bold: true };
    row.eachCell((cell) => (cell.fill = TOTAL_FILL));
    r++;
  }
  return r - 1;
}

function round(v: number, currency: string): number {
  const f = ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 100;
  return Math.round(v * f) / f;
}

export interface PackSummary {
  business: string;
  periodFrom: string | null;
  periodTo: string | null;
  bills: number;
  payments: number;
}

/** Build the pack for everything on record. `generatedAt` is injectable so a test or a sample is reproducible. */
export async function buildBookkeeperPack(db: Db, businessId: string, opts: { generatedAt?: Date } = {}): Promise<{ buffer: Buffer; summary: PackSummary }> {
  const biz = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  const business = biz?.name ?? "Business";
  const generatedAt = opts.generatedAt ?? new Date();
  const bills = xeroBillRows(db, businessId, { onlyNew: false }).rows;
  const payments = allRecords(db).sort((a, b) => (a.paymentDate ?? "").localeCompare(b.paymentDate ?? "") || a.reference.localeCompare(b.reference));
  const dates = [...bills.map((b) => String(b["*InvoiceDate"] ?? "")), ...payments.map((p) => p.paymentDate)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const periodFrom = dates[0] ?? null;
  const periodTo = dates[dates.length - 1] ?? null;

  const wb = new ExcelJS.Workbook();
  wb.creator = "Checkrail Pay";
  wb.created = generatedAt;
  wb.modified = generatedAt;
  wb.title = `Bookkeeper pack, ${business}`;

  const cover = wb.addWorksheet("Cover", { properties: { tabColor: { argb: "FF10233A" } } });
  const billsWs = wb.addWorksheet("Bills");
  const payWs = wb.addWorksheet("Payments");
  const feesWs = wb.addWorksheet("Fees");

  // ---- Bills: the Xero bills file's rows, readable headers ----
  const billCols: Col[] = [
    { header: "Contact", key: "contact", width: 28 },
    { header: "Email", key: "email", width: 28 },
    { header: "Country", key: "country", width: 9 },
    { header: "Invoice number", key: "invoice", width: 18 },
    { header: "Invoice date", key: "invoiceDate", width: 13, kind: "date" },
    { header: "Due date", key: "dueDate", width: 13, kind: "date" },
    { header: "Description", key: "description", width: 46 },
    { header: "Quantity", key: "quantity", width: 9, kind: "int" },
    { header: "Amount", key: "amount", width: 16, kind: "money" },
    { header: "Currency", key: "currency", width: 10 },
    { header: "Account code", key: "accountCode", width: 13 },
    { header: "Tax type", key: "taxType", width: 13 },
    { header: "Tracking category", key: "trackingName", width: 16 },
    { header: "Tracking option", key: "trackingOption", width: 16 },
  ];
  table(billsWs, billCols);
  const billMoney: Array<{ currency: string; value: number | null }> = [];
  for (const b of bills) {
    const currency = String(b.Currency ?? "");
    const amount = num(b["*UnitAmount"]);
    billMoney.push({ currency, value: amount });
    const row = billsWs.addRow({ contact: b["*ContactName"], email: b.EmailAddress, country: b.POCountry, invoice: b["*InvoiceNumber"], invoiceDate: day(String(b["*InvoiceDate"] ?? "")), dueDate: day(String(b["*DueDate"] ?? "")), description: b.Description, quantity: num(b["*Quantity"]), amount, currency, accountCode: b["*AccountCode"] != null ? String(b["*AccountCode"]) : null, taxType: b["*TaxType"], trackingName: b.TrackingName1, trackingOption: b.TrackingOption1 });
    row.getCell("invoiceDate").numFmt = DATE_FMT;
    row.getCell("dueDate").numFmt = DATE_FMT;
    row.getCell("amount").numFmt = currencyFormat(currency);
  }
  const billsLast = bills.length + 1;
  filter(billsWs, billCols.length, billsLast);
  if (bills.length) totals(billsWs, { first: 2, last: billsLast, currencyCol: 10, labelCol: 7, sums: [{ col: 9, values: billMoney }], countCol: 8 });

  // ---- Payments: the settlement records ----
  const payCols: Col[] = [
    { header: "Payment date", key: "paymentDate", width: 13, kind: "date" },
    { header: "Bill date", key: "billDate", width: 13, kind: "date" },
    { header: "Due date", key: "dueDate", width: 13, kind: "date" },
    { header: "Reference", key: "reference", width: 18 },
    { header: "Vendor", key: "vendor", width: 26 },
    { header: "Country", key: "country", width: 9 },
    { header: "Description", key: "description", width: 42 },
    { header: "Rail", key: "rail", width: 10 },
    { header: "Amount (bill)", key: "gross", width: 15, kind: "money" },
    { header: "Currency", key: "currency", width: 10 },
    { header: "Fee", key: "fee", width: 13, kind: "money" },
    { header: "Fee paid by", key: "feePaidBy", width: 12 },
    { header: "Tax withheld", key: "withheld", width: 14, kind: "money" },
    { header: "Net paid (cash out)", key: "net", width: 17, kind: "money" },
    { header: "Recipient received", key: "received", width: 17, kind: "money" },
    { header: "Recipient currency", key: "receivedCurrency", width: 11 },
    { header: "FX rate", key: "fxRate", width: 11, kind: "rate" },
    { header: "FX rate source", key: "fxSource", width: 13 },
    { header: "Account code", key: "accountCode", width: 12 },
    { header: "Account name", key: "accountName", width: 34 },
    { header: "Departure", key: "departure", width: 13 },
    { header: "Tax type", key: "taxType", width: 12 },
    { header: "Transaction id", key: "txId", width: 26 },
    { header: "Explorer", key: "explorer", width: 24 },
    { header: "Xero", key: "xero", width: 16 },
    { header: "Checkrail id", key: "obligationId", width: 22 },
  ];
  table(payWs, payCols);
  const gross: Array<{ currency: string; value: number | null }> = [];
  const fees: Array<{ currency: string; value: number | null }> = [];
  const withheld: Array<{ currency: string; value: number | null }> = [];
  const net: Array<{ currency: string; value: number | null }> = [];
  for (const p of payments) {
    const cur = p.grossCurrency;
    gross.push({ currency: cur, value: num(p.grossAmount) });
    fees.push({ currency: p.feeCurrency || cur, value: num(p.feeAmount) });
    withheld.push({ currency: cur, value: num(p.withheldAmount) ?? 0 });
    net.push({ currency: cur, value: num(p.netPaid) });
    const row = payWs.addRow({
      paymentDate: day(p.paymentDate),
      billDate: day(p.billDate),
      dueDate: day(p.dueDate),
      reference: p.reference,
      vendor: p.vendorName,
      country: p.vendorCountry,
      description: p.description,
      rail: railLabel(p.rail as Rail),
      gross: num(p.grossAmount),
      currency: cur,
      fee: num(p.feeAmount),
      feePaidBy: p.feePaidBy === "recipient" ? "Recipient" : "Business",
      withheld: num(p.withheldAmount) ?? 0,
      net: num(p.netPaid),
      received: num(p.recipientReceived),
      receivedCurrency: p.recipientCurrency,
      fxRate: num(p.fxRate),
      fxSource: p.fxRate ? (p.fxRateSource === "demo" ? "Demo rate" : "Rail") : null,
      accountCode: p.accountCode,
      accountName: p.accountName || null,
      departure: p.departure ?? null,
      taxType: p.taxType ?? null,
      txId: p.externalTransactionId || null,
      explorer: null,
      xero: p.xeroPayment || null,
      obligationId: p.obligationId,
    });
    for (const k of ["paymentDate", "billDate", "dueDate"]) row.getCell(k).numFmt = DATE_FMT;
    for (const k of ["gross", "fee", "withheld", "net"]) row.getCell(k).numFmt = currencyFormat(cur);
    if (p.recipientCurrency) row.getCell("received").numFmt = currencyFormat(p.recipientCurrency);
    row.getCell("fxRate").numFmt = "0.000000";
    const ex = row.getCell("explorer");
    if (p.explorerUrl && /^https:\/\//.test(p.explorerUrl)) {
      ex.value = { text: "View transaction", hyperlink: p.explorerUrl, tooltip: p.explorerUrl };
      ex.font = { color: { argb: "FF0070E0" }, underline: true };
    } else if (p.explorerUrl === SIMULATED_EXPLORER) {
      ex.value = SIMULATED_EXPLORER;
      ex.font = { italic: true, color: { argb: "FF5B6B7C" } };
    }
  }
  const payLast = payments.length + 1;
  filter(payWs, payCols.length, payLast);
  if (payments.length) totals(payWs, { first: 2, last: payLast, currencyCol: 10, labelCol: 7, sums: [{ col: 9, values: gross }, { col: 11, values: fees }, { col: 13, values: withheld }, { col: 14, values: net }], countCol: 8 });

  // ---- Fees: by rail and month ----
  const feeCols: Col[] = [
    { header: "Month", key: "month", width: 12, kind: "date" },
    { header: "Rail", key: "rail", width: 12 },
    { header: "Currency", key: "currency", width: 10 },
    { header: "Payments", key: "count", width: 10, kind: "int" },
    { header: "Amount paid", key: "gross", width: 16, kind: "money" },
    { header: "Fees", key: "fees", width: 14, kind: "money" },
    { header: "Fees as % of amount", key: "pct", width: 13 },
  ];
  table(feesWs, feeCols, false);
  const groups = new Map<string, { month: string; rail: string; currency: string; count: number; gross: number; fees: number }>();
  for (const p of payments) {
    const month = (p.paymentDate ?? "").slice(0, 7);
    const key = `${month}|${p.rail}|${p.grossCurrency}`;
    const g = groups.get(key) ?? { month, rail: p.rail, currency: p.grossCurrency, count: 0, gross: 0, fees: 0 };
    g.count += 1;
    g.gross += num(p.grossAmount) ?? 0;
    g.fees += num(p.feeAmount) ?? 0;
    groups.set(key, g);
  }
  const feeRows = [...groups.values()].sort((a, b) => a.month.localeCompare(b.month) || a.rail.localeCompare(b.rail) || a.currency.localeCompare(b.currency));
  feeRows.forEach((g, i) => {
    const r = i + 2;
    const row = feesWs.addRow({ month: day(`${g.month}-01`), rail: railLabel(g.rail as Rail), currency: g.currency, count: g.count, gross: round(g.gross, g.currency), fees: round(g.fees, g.currency) });
    row.getCell("month").numFmt = "mmm yyyy";
    row.getCell("gross").numFmt = currencyFormat(g.currency);
    row.getCell("fees").numFmt = currencyFormat(g.currency);
    row.getCell("pct").value = { formula: `IF(E${r}=0,0,F${r}/E${r})`, result: g.gross ? g.fees / g.gross : 0 };
    row.getCell("pct").numFmt = "0.00%";
  });
  const feeLast = feeRows.length + 1;
  filter(feesWs, feeCols.length, feeLast);
  if (feeRows.length) {
    totals(feesWs, { first: 2, last: feeLast, currencyCol: 3, labelCol: 2, sums: [{ col: 5, values: feeRows.map((g) => ({ currency: g.currency, value: g.gross })) }, { col: 6, values: feeRows.map((g) => ({ currency: g.currency, value: g.fees })) }] });
    // Payments per currency: SUMIFS over the count column (the totals helper counts rows, not payments).
    let r = feeLast + 2;
    for (const c of [...new Set(feeRows.map((g) => g.currency))].sort()) {
      feesWs.getCell(r, 4).value = { formula: `SUMIFS(D2:D${feeLast},C2:C${feeLast},"${c}")`, result: feeRows.filter((g) => g.currency === c).reduce((a, g) => a + g.count, 0) };
      r++;
    }
  }

  // ---- Cover ----
  cover.columns = [{ width: 26 }, { width: 22 }, { width: 22 }, { width: 22 }, { width: 22 }];
  cover.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  const put = (r: number, values: Array<string | number | Date | null>, style?: Partial<ExcelJS.Style>) => {
    const row = cover.getRow(r);
    values.forEach((v, i) => (row.getCell(i + 1).value = v));
    if (style?.font) row.font = style.font;
    return row;
  };
  let r = 1;
  put(r++, ["Bookkeeper pack"], { font: { bold: true, size: 18 } });
  put(r++, [business], { font: { size: 13 } });
  r++;
  put(r, ["Period"]);
  cover.getCell(r, 2).value = day(periodFrom);
  cover.getCell(r, 3).value = day(periodTo);
  cover.getCell(r, 2).numFmt = DATE_FMT;
  cover.getCell(r, 3).numFmt = DATE_FMT;
  r++;
  put(r, ["Generated"]);
  cover.getCell(r, 2).value = formatDateTime(generatedAt.toISOString()); // in the business time zone, with its label: an Excel date has no zone
  r += 2;
  put(r++, ["What each sheet is"], { font: { bold: true } });
  put(r++, ["Bills", "Every agreed bill, the same rows as the Xero bills import file, with readable headers. For reading; import the bills CSV, not this sheet."]);
  put(r++, ["Payments", "One row per settled payment, from the settlement records: amount, fee and who paid it, net cash out, what the recipient received and at what rate, account, and the transaction and explorer link."]);
  put(r++, ["Fees", "Payment fees totalled by rail and month."]);
  r++;
  put(r++, ["Totals", "Currency", "Count", "Amount", "Fees"], { font: { bold: true } });
  const sumBy = (xs: Array<{ currency: string; value: number | null }>, c: string) => round(xs.filter((x) => x.currency === c).reduce((a, x) => a + (x.value ?? 0), 0), c);
  for (const c of [...new Set(billMoney.map((b) => b.currency))].sort()) {
    const row = put(r++, ["Bills", c, billMoney.filter((b) => b.currency === c).length, sumBy(billMoney, c), null]);
    row.getCell(4).numFmt = currencyFormat(c);
  }
  for (const c of [...new Set(gross.map((g) => g.currency))].sort()) {
    const row = put(r++, ["Payments", c, gross.filter((g) => g.currency === c).length, sumBy(gross, c), sumBy(fees, c)]);
    row.getCell(4).numFmt = currencyFormat(c);
    row.getCell(5).numFmt = currencyFormat(c);
  }
  for (const c of [...new Set(net.map((g) => g.currency))].sort()) {
    const row = put(r++, ["Net paid (cash out)", c, null, sumBy(net, c), null]);
    row.getCell(4).numFmt = currencyFormat(c);
  }
  r++;
  put(r++, ["How to use with Xero"], { font: { bold: true } });
  const how = [
    "1. Import the bills CSV (Accounting, Export new bills for Xero) in Xero: Business, Bills to pay, Import. Import each file once.",
    "2. Do not import this workbook or the settlement records CSV. Payments match from the bank feed: each Payments row is one bank line for its Net paid (cash out).",
    "3. The fee is paid by the business on top of the bill on every rail: the bill is the Amount, the fee is a separate spend to Bank Fees.",
    "4. Where Tax withheld is not zero, record it as a second payment on the bill from the tax withheld account.",
    "5. Rows whose Xero column starts with xero: are already in Xero through the live connection; enter only rows where it is blank.",
  ];
  for (const line of how) {
    put(r, [line]);
    cover.mergeCells(r, 1, r, 5);
    cover.getRow(r).alignment = { wrapText: true, vertical: "top" };
    cover.getRow(r).height = 30;
    r++;
  }
  if (payments.some((p) => p.fxRateSource === "demo") || payments.some((p) => p.explorerUrl === SIMULATED_EXPLORER)) {
    r++;
    put(r++, ["Demo data"], { font: { bold: true } });
    if (payments.some((p) => p.fxRateSource === "demo")) {
      put(r, ["FX rates marked Demo rate come from a small table of demo rates near real levels for each week, not from a provider. Live payments carry the rate the provider reported."]);
      cover.mergeCells(r, 1, r, 5);
      cover.getRow(r).alignment = { wrapText: true, vertical: "top" };
      cover.getRow(r).height = 30;
      r++;
    }
    if (payments.some((p) => p.explorerUrl === SIMULATED_EXPLORER)) {
      put(r, ["Stellar payments marked simulated, not on chain were made on the simulated rail and have no transaction on the Stellar network."]);
      cover.mergeCells(r, 1, r, 5);
      cover.getRow(r).alignment = { wrapText: true, vertical: "top" };
      r++;
    }
  }
  for (let i = 8; i <= 10; i++) {
    cover.mergeCells(i, 2, i, 5);
    cover.getRow(i).alignment = { wrapText: true, vertical: "top" };
    cover.getRow(i).height = 32;
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, summary: { business, periodFrom, periodTo, bills: bills.length, payments: payments.length } };
}


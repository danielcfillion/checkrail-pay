import { createHash } from "node:crypto";
import { parseAmount, parseCsv, parseDate, redact, type ColumnMap, type FileSpec } from "../check/recheck";

/**
 * Reading any bank's CSV export without asking the owner to configure it: which line is the header, which column is
 * the date, the payee, the money going out, the reference and the description, and which way round the dates are
 * written. English and Vietnamese headers ("Ngày giao dịch", "Số tiền ghi nợ", "Nội dung", "Số tham chiếu") and
 * split debit and credit columns are covered. The guess comes back with a confidence and the columns it did not use,
 * so the page can show it and let the owner correct it before anything runs.
 *
 * Pure: no database. src/lib/onboarding/imports.ts looks up a mapping saved for the same header signature first.
 */

/** How one file is read: what the re-check's FileSpec needs, without the file name. */
export interface ImportSpec {
  /** Lines above the header row (bank exports often start with the account name and period). */
  skipRows: number;
  columns: ColumnMap;
  dateFormat: "DMY" | "MDY" | "YMD";
  /** Which rows are money going out: any non-zero amount (a debit column), or only negative ones (one signed column). */
  outgoing: "any" | "negative" | "positive";
  /** When there is no payee column: a regular expression on the description whose first group is the payee. */
  payeePattern?: string;
  /** A regular expression on the description whose first group (or whole match) is the job or invoice reference. */
  referencePattern?: string;
}

export type Field = keyof ColumnMap;

export interface Detection {
  /** The separator the file uses. The text handed on is always comma-separated (see toCommaCsv). */
  delimiter: "," | ";" | "\t";
  skipRows: number;
  /** The header cells as written. */
  header: string[];
  /** Stable for the same export layout: the header cells, folded. Saved mappings are keyed on it. */
  signature: string;
  spec: ImportSpec;
  /** debit_credit: separate money-out and money-in columns; signed: one column, payments negative; unsigned: one column, all positive. */
  amountLayout: "debit_credit" | "signed" | "unsigned" | "none";
  /** The money-in column when the export splits them (not read: incoming money is not a supplier payment). */
  creditColumn: string | null;
  /** 0 to 1: how sure the guess is. 1 when a mapping saved for this layout was used. */
  confidence: number;
  /** Header cells no field was mapped to (balance, branch, row number and the like). */
  unmapped: string[];
  /** Required fields with no column: date and amount always, payee unless a payee pattern is given. */
  missing: Field[];
  /** False when no date in the file says which way round it is (every day and month 12 or under). */
  dateOrderCertain: boolean;
  /** The first rows under the header, with account numbers, phone numbers and emails removed. */
  sample: string[][];
  /** Rows under the header. */
  dataRows: number;
  /** True when the spec came from a mapping saved for this layout. */
  fromSaved: boolean;
}

/** Lower case, accents and đ folded, punctuation to spaces: "Số tiền ghi nợ" -> "so tien ghi no". */
export function foldHeader(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Words each field goes by. A one-word entry matches only a cell that is exactly that word ("Date", "Payee"); a longer
 * one matches a cell containing those words in that order ("Số tiền ghi nợ (VND)"). Bare "nợ" and "có" are left out:
 * "No." is a row number in English exports.
 */
const WORDS: Record<Field | "credit" | "debit" | "balance", string[]> = {
  date: ["ngay giao dich", "ngay gd", "ngay hach toan", "ngay hieu luc", "ngay thuc hien", "ngay chuyen", "ngay", "date", "transaction date", "posting date", "value date", "booking date", "trans date", "txn date"],
  debit: ["so tien ghi no", "ghi no", "phat sinh no", "so tien no", "so tien chi", "tien ra", "debit", "debit amount", "debits", "withdrawal", "withdrawals", "money out", "paid out", "amount out"],
  credit: ["so tien ghi co", "ghi co", "phat sinh co", "so tien co", "so tien thu", "tien vao", "credit", "credit amount", "credits", "deposit", "deposits", "money in", "paid in", "amount in"],
  amount: ["so tien giao dich", "so tien", "amount", "transaction amount", "gia tri", "value"],
  payee: ["ten nguoi huong", "nguoi huong", "ten nguoi nhan", "nguoi nhan", "ten doi ung", "ten tai khoan doi ung", "ten tk doi ung", "ten ben nhan", "ben nhan", "doi tac", "beneficiary", "beneficiary name", "payee", "payee name", "counterparty", "counterparty name", "recipient", "recipient name", "name"],
  reference: ["so tham chieu", "ma tham chieu", "so but toan", "ma giao dich", "so giao dich", "so ct", "so chung tu", "ma gd", "reference", "reference number", "reference no", "ref", "ref no", "transaction id", "transaction reference", "trace number", "so trace"],
  description: ["noi dung giao dich", "noi dung chuyen khoan", "noi dung", "dien giai", "mo ta", "chi tiet giao dich", "description", "details", "transaction details", "memo", "narrative", "remarks", "particulars"],
  balance: ["so du", "so du cuoi", "balance", "running balance", "closing balance"],
};

type Role = keyof typeof WORDS;

/** How well a header cell names a role: 3 and up for an exact name, 2 and up for the words inside it, 0 for none. */
function scoreCell(cell: string, role: Role): number {
  const f = foldHeader(cell);
  if (!f) return 0;
  const tokens = f.split(" ");
  let best = 0;
  for (const phrase of WORDS[role]) {
    const p = phrase.split(" ");
    if (f === phrase) best = Math.max(best, 3 + p.length / 10);
    else if (p.length > 1) {
      for (let i = 0; i + p.length <= tokens.length; i++) {
        if (p.every((w, j) => tokens[i + j] === w)) {
          best = Math.max(best, 2 + p.length / 10);
          break;
        }
      }
    }
  }
  return best;
}

const ROLES = Object.keys(WORDS) as Role[];

function cellsNamed(row: string[]): number {
  return row.filter((c) => ROLES.some((r) => scoreCell(c, r) > 0)).length;
}

/** The separator most lines agree on, counted outside quotes in the first lines of the file. */
export function sniffDelimiter(text: string): "," | ";" | "\t" {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  const count = (line: string, d: string) => {
    let n = 0;
    let quoted = false;
    for (const c of line) {
      if (c === '"') quoted = !quoted;
      else if (!quoted && c === d) n++;
    }
    return n;
  };
  let best: "," | ";" | "\t" = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t"] as const) {
    const counts = lines.map((l) => count(l, d));
    // Lines that have the separator at all, weighted by how many columns the commonest count gives.
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [cols, lineCount] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [0, 0];
    const score = lineCount * 100 + cols;
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}

/** RFC 4180 reading with any one-character separator (parseCsv in recheck.ts reads commas only). */
function parseWith(text: string, d: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === d) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The file as comma-separated text, whatever separator it came with, so the re-check's reader can take it as is. */
export function toCommaCsv(text: string): { text: string; delimiter: "," | ";" | "\t" } {
  const delimiter = sniffDelimiter(text);
  if (delimiter === ",") return { text, delimiter };
  return { text: parseWith(text, delimiter).map((r) => r.map(cell).join(",")).join("\n") + "\n", delimiter };
}

/** The header row: the first of the opening lines that names the most known columns (two at least). */
export function findHeaderRow(rows: string[][]): number {
  let best = -1;
  let bestScore = 1;
  rows.slice(0, 25).forEach((r, i) => {
    const s = cellsNamed(r);
    if (s > bestScore) [best, bestScore] = [i, s];
  });
  if (best >= 0) return best;
  // Nothing recognisable: the first line with three or more filled cells.
  const i = rows.findIndex((r) => r.filter((c) => c.trim()).length >= 3);
  return Math.max(0, i);
}

/** A signature of the export layout: the header cells, folded, in order. Same bank, same export, same signature. */
export function headerSignature(header: string[]): string {
  return createHash("sha256").update(header.map(foldHeader).join("|")).digest("hex").slice(0, 16);
}

/** Which way round the dates are written, from the values: a day over 12 settles it. Vietnamese exports default to day first. */
export function guessDateOrder(values: string[]): { order: ImportSpec["dateFormat"]; certain: boolean } {
  let dmy = false;
  let mdy = false;
  let ymd = false;
  for (const v of values) {
    const m = v.trim().match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/);
    if (!m) continue;
    if (m[1].length === 4) ymd = true;
    else if (Number(m[1]) > 12) dmy = true;
    else if (Number(m[2]) > 12) mdy = true;
  }
  if (ymd && !dmy && !mdy) return { order: "YMD", certain: true };
  if (dmy && !mdy) return { order: "DMY", certain: true };
  if (mdy && !dmy) return { order: "MDY", certain: true };
  return { order: "DMY", certain: false };
}

/**
 * Guess how to read a bank export. `saved` is a mapping stored for this layout (same signature): when its columns are
 * all in the header it is used as is, with confidence 1.
 */
/** A bank export has a dozen or two columns. Scoring is per cell, so a file with thousands would block the server. */
export const MAX_COLUMNS = 100;

/** Refuse a file whose rows are wider than any bank export, before anything scores its cells. */
export function checkWidth(rows: string[][], what = "The file"): void {
  const widest = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (widest > MAX_COLUMNS) throw new Error(`${what} has a row with ${widest} columns; a bank export has fewer than ${MAX_COLUMNS}. Check the file and the separator.`);
}

export function detectColumns(csv: string, opts: { saved?: ImportSpec | null } = {}): Detection {
  const { text, delimiter } = toCommaCsv(csv);
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("The file is empty");
  checkWidth(rows);
  const skipRows = findHeaderRow(rows);
  const header = rows[skipRows].map((h) => h.trim());
  const body = rows.slice(skipRows + 1);
  const signature = headerSignature(header);
  const sample = body.slice(0, 5).map((r) => header.map((_, i) => redact((r[i] ?? "").trim())));
  const values = (col: string | undefined) => {
    const i = col ? header.findIndex((h) => h.toLowerCase() === col.toLowerCase()) : -1;
    return i < 0 ? [] : body.slice(0, 500).map((r) => (r[i] ?? "").trim()).filter(Boolean);
  };

  if (opts.saved && savedFits(opts.saved, header)) {
    const spec = { ...opts.saved, skipRows };
    const used = new Set(Object.values(spec.columns).filter(Boolean).map((c) => c!.toLowerCase()));
    const credit = header.find((h) => scoreCell(h, "credit") > 0 && !used.has(h.toLowerCase())) ?? null;
    return {
      delimiter, skipRows, header, signature, spec,
      amountLayout: credit ? "debit_credit" : spec.outgoing === "negative" ? "signed" : "unsigned",
      creditColumn: credit,
      confidence: 1,
      unmapped: header.filter((h) => h && !used.has(h.toLowerCase())),
      missing: [],
      dateOrderCertain: true,
      sample,
      dataRows: body.length,
      fromSaved: true,
    };
  }

  // Every (role, column) pair with a score, best first; each column and each role used once.
  const pairs: Array<{ role: Role; col: number; score: number }> = [];
  header.forEach((h, col) => {
    for (const role of ROLES) {
      const score = scoreCell(h, role);
      if (score > 0) pairs.push({ role, col, score });
    }
  });
  pairs.sort((a, b) => b.score - a.score || a.col - b.col);
  const byRole = new Map<Role, number>();
  const usedCols = new Set<number>();
  for (const p of pairs) {
    if (byRole.has(p.role) || usedCols.has(p.col)) continue;
    // "Số tiền" next to a debit column is the same money: one amount source only.
    if (p.role === "amount" && byRole.has("debit")) continue;
    if (p.role === "debit" && byRole.has("amount")) continue;
    byRole.set(p.role, p.col);
    usedCols.add(p.col);
  }
  const name = (r: Role) => (byRole.has(r) ? header[byRole.get(r)!] : undefined);

  let amountLayout: Detection["amountLayout"] = "none";
  let amount = name("debit");
  let outgoing: ImportSpec["outgoing"] = "any";
  if (amount) amountLayout = byRole.has("credit") ? "debit_credit" : "unsigned";
  else if ((amount = name("amount"))) {
    const parsed = values(amount).map(parseAmount).filter((a): a is NonNullable<ReturnType<typeof parseAmount>> => a !== null && a.minor > 0);
    const negatives = parsed.filter((a) => a.negative).length;
    if (negatives > 0) {
      amountLayout = "signed";
      outgoing = "negative";
    } else amountLayout = "unsigned";
  }

  const columns: ColumnMap = { date: name("date") ?? "", amount: amount ?? "" };
  for (const f of ["payee", "reference", "description"] as const) {
    const n = name(f);
    if (n) columns[f] = n;
  }
  const order = guessDateOrder(values(columns.date));
  const missing: Field[] = [];
  if (!columns.date) missing.push("date");
  if (!columns.amount) missing.push("amount");
  if (!columns.payee) missing.push("payee");

  // Confidence: the fields found, and whether their values read.
  const dates = values(columns.date);
  const dateRate = dates.length ? dates.filter((d) => parseDate(d, order.order)).length / dates.length : 0;
  const amounts = values(columns.amount);
  const amountRate = amounts.length ? amounts.filter((a) => parseAmount(a) !== null).length / amounts.length : 0;
  let confidence = 0;
  if (columns.date) confidence += 0.25 + (dateRate >= 0.9 ? 0.05 : 0);
  if (columns.amount) confidence += 0.25 + (amountRate >= 0.9 ? 0.05 : 0);
  if (columns.payee) confidence += 0.2;
  if (columns.description) confidence += 0.1;
  if (columns.reference) confidence += 0.05;
  if (order.certain) confidence += 0.05;

  const mapped = new Set([columns.date, columns.amount, columns.payee, columns.reference, columns.description].filter(Boolean).map((c) => c!.toLowerCase()));
  return {
    delimiter,
    skipRows,
    header,
    signature,
    spec: { skipRows, columns, dateFormat: order.order, outgoing },
    amountLayout,
    creditColumn: name("credit") ?? null,
    confidence: Math.round(Math.min(1, confidence) * 100) / 100,
    unmapped: header.filter((h) => h && !mapped.has(h.toLowerCase())),
    missing,
    dateOrderCertain: order.certain,
    sample,
    dataRows: body.length,
    fromSaved: false,
  };
}

function savedFits(spec: ImportSpec, header: string[]): boolean {
  const have = new Set(header.map((h) => h.toLowerCase()));
  return Object.values(spec.columns).every((c) => !c || have.has(c.toLowerCase()));
}

// ---------- Checking a mapping that came from a page ----------


/**
 * Patterns (a regular expression that pulls the payee or reference out of the description) are for the command-line
 * re-check only, where the person running it wrote the pattern. In the app a pattern would run inside the server, and
 * no cheap check rules out every pattern that takes exponential time, so the app refuses them; the column mapper never
 * produces one.
 */
function checkPattern(p: unknown, what: string): string | undefined {
  if (p == null || p === "") return undefined;
  throw new Error(`A ${what} pattern is not accepted here. Choose the ${what} column instead.`);
}


/**
 * A mapping as the page sent it, checked against the file's header: every named column exists, there is a date and an
 * amount, and a payee column or a payee pattern. Returns a clean copy; unknown keys are dropped.
 */
export function validateSpec(raw: unknown, header: string[]): ImportSpec {
  if (!raw || typeof raw !== "object") throw new Error("The column mapping is missing");
  const r = raw as Record<string, unknown>;
  const cols = (r.columns ?? {}) as Record<string, unknown>;
  const have = new Map(header.map((h) => [h.trim().toLowerCase(), h.trim()]));
  const col = (k: Field, required: boolean): string | undefined => {
    const v = cols[k];
    if (v == null || v === "") {
      if (required) throw new Error(`Choose the column for the ${k === "amount" ? "money paid out" : k}`);
      return undefined;
    }
    if (typeof v !== "string" || v.length > 200) throw new Error(`The ${k} column name is not valid`);
    const found = have.get(v.trim().toLowerCase());
    if (!found) throw new Error(`The file has no column "${v.trim()}"`);
    return found;
  };
  const columns: ColumnMap = { date: col("date", true)!, amount: col("amount", true)! };
  for (const k of ["payee", "reference", "description"] as const) {
    const v = col(k, false);
    if (v) columns[k] = v;
  }
  const payeePattern = checkPattern(r.payeePattern, "payee");
  const referencePattern = checkPattern(r.referencePattern, "reference");
  if (!columns.payee && !payeePattern) throw new Error("Choose the payee column, or give a pattern that finds the payee in the description");
  if ((payeePattern || referencePattern) && !columns.description) throw new Error("A pattern reads the description: choose the description column too");
  const dateFormat = r.dateFormat ?? "DMY";
  if (dateFormat !== "DMY" && dateFormat !== "MDY" && dateFormat !== "YMD") throw new Error("Date order must be DMY, MDY or YMD");
  const outgoing = r.outgoing ?? "any";
  if (outgoing !== "any" && outgoing !== "negative" && outgoing !== "positive") throw new Error("Outgoing must be any, negative or positive");
  const skipRows = r.skipRows ?? 0;
  if (typeof skipRows !== "number" || !Number.isInteger(skipRows) || skipRows < 0 || skipRows > 50) throw new Error("Lines above the header must be a whole number from 0 to 50");
  return { skipRows, columns, dateFormat, outgoing, ...(payeePattern ? { payeePattern } : {}), ...(referencePattern ? { referencePattern } : {}) };
}

/** The re-check's FileSpec for a checked mapping. */
export function fileSpecOf(fileName: string, spec: ImportSpec): FileSpec {
  return { file: fileName, skipRows: spec.skipRows, columns: spec.columns, dateFormat: spec.dateFormat, outgoing: spec.outgoing, payeePattern: spec.payeePattern, referencePattern: spec.referencePattern };
}

import { eq } from "drizzle-orm";
import { openTestDb, type Db } from "../db";
import { businesses, obligations, vendors } from "../db/schema";
import { payoutHashOf } from "../engine/orchestrator";
import { DEFAULT_POLICY } from "../domain/types";
import { evaluatePayment, type CheckResult } from "./evaluate";

/**
 * The historical re-check: run a business's past supplier payments through the rules, in date order, as if each one
 * were being asked for that day, and count what would have been stopped.
 *
 * It works in a fresh in-memory database that exists only for the run. Each payment is judged on the date it was
 * made, then recorded as paid (because it was), so a later payment for the same job is judged against it. Nothing is
 * paid, nothing reaches a rail, and the real books are never opened.
 */

// ---------- Reading the files ----------

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. Tolerates a BOM and CRLF. */
export function parseCsv(text: string): string[][] {
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
    else if (c === ",") { row.push(field); field = ""; }
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

/**
 * An amount as a bank or a spreadsheet writes it, in hundredths (the app stores every currency that way).
 * Handles 2.500.000 and 2,500,000 (thousands), 2500000.00 and 1.234,50 (decimals), a leading minus, (brackets) and a
 * currency word. The last separator is a decimal point only when one or two digits follow it.
 */
export function parseAmount(raw: string | undefined): { minor: number; negative: boolean } | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[^\d.,-]/g, "");
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  if (s.endsWith("-")) { negative = true; s = s.slice(0, -1); }
  if (!/\d/.test(s) || /-/.test(s)) return null;
  const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let whole = s;
  let frac = "";
  if (last >= 0 && /^\d{1,2}$/.test(s.slice(last + 1))) {
    whole = s.slice(0, last);
    frac = s.slice(last + 1);
  }
  whole = whole.replace(/[.,]/g, "");
  if (!/^\d+$/.test(whole || "0")) return null;
  const minor = Number(whole || "0") * 100 + Number(frac.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(minor)) return null;
  return { minor, negative };
}

/** A date as written in the file, to YYYY-MM-DD. DMY is the Vietnamese default (31/10/2026); a time after it is ignored. */
export function parseDate(raw: string | undefined, order: "DMY" | "MDY" | "YMD" = "DMY"): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/);
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let y: number, mo: number, d: number;
  if (m[1].length === 4) [y, mo, d] = [a, b, c];
  else if (order === "MDY") [mo, d, y] = [a, b, c];
  else if (order === "YMD") [y, mo, d] = [a, b, c];
  else [d, mo, y] = [a, b, c];
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== d) return null;
  return iso;
}

/** Remove what must not leave the machine: email addresses and long digit runs (account numbers, phone numbers). */
export function redact(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/[^\s@<>"',;]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+?\d(?:[ .-]?\d){8,}/g, "[number]");
}

// ---------- Configuration ----------

export interface ColumnMap { date: string; payee?: string; amount: string; reference?: string; description?: string }
export interface FileSpec {
  file: string;
  /** Lines above the header row (bank exports often start with the account name and period). */
  skipRows?: number;
  columns: ColumnMap;
  dateFormat?: "DMY" | "MDY" | "YMD";
  /** Which rows are money going out: any non-zero amount, only negative ones, or only positive ones. */
  outgoing?: "any" | "negative" | "positive";
  /** When there is no payee column: a regular expression on the description whose first group is the payee. */
  payeePattern?: string;
  /** A regular expression on the description whose first group (or whole match) is the job or invoice reference. */
  referencePattern?: string;
}
export interface RecheckConfig {
  currency: string;
  country?: string;
  payments: FileSpec;
  jobs?: FileSpec & { matchWindowDays?: number };
  /** Spellings of the same supplier, to the one name to use: { "BANG PHAN XE": "Bang Phan" }. Case is ignored. */
  payeeAliases?: Record<string, string>;
}

export function validateConfig(raw: unknown): RecheckConfig {
  if (!raw || typeof raw !== "object") throw new Error("The config must be a JSON object");
  const c = raw as RecheckConfig;
  if (!/^[A-Z]{3}$/.test(c.currency ?? "")) throw new Error('"currency" must be a three-letter code such as "VND"');
  const spec = (s: FileSpec | undefined, name: string) => {
    if (!s || typeof s.file !== "string") throw new Error(`"${name}.file" is required`);
    if (!s.columns?.date || !s.columns?.amount) throw new Error(`"${name}.columns" needs at least "date" and "amount"`);
    if (!s.columns.payee && !s.payeePattern) throw new Error(`"${name}" needs a "payee" column or a "payeePattern"`);
    for (const p of [s.payeePattern, s.referencePattern]) if (p) new RegExp(p, "i");
  };
  spec(c.payments, "payments");
  if (c.jobs) spec(c.jobs, "jobs");
  return c;
}

// ---------- Rows ----------

export interface Row { row: number; date: string; payee: string; amountMinor: number; reference: string | null; description: string }

export interface RowProblem { row: number; problem: string }

/** Turn the file's rows into dated, positive amounts with a payee. Rows that cannot be read are listed, not guessed. */
export function readRows(csv: string, spec: FileSpec, aliases: Record<string, string> = {}): { rows: Row[]; skipped: RowProblem[] } {
  const all = parseCsv(csv).slice(spec.skipRows ?? 0);
  const [header, ...body] = all;
  if (!header) throw new Error(`${spec.file} has no header row`);
  const idx = (name: string | undefined) => {
    if (!name) return -1;
    const i = header.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
    if (i < 0) throw new Error(`${spec.file} has no column "${name}". Columns: ${header.map((h) => `"${h.trim()}"`).join(", ")}`);
    return i;
  };
  const col = { date: idx(spec.columns.date), payee: idx(spec.columns.payee), amount: idx(spec.columns.amount), reference: idx(spec.columns.reference), description: idx(spec.columns.description) };
  const payeeRe = spec.payeePattern ? new RegExp(spec.payeePattern, "i") : null;
  const refRe = spec.referencePattern ? new RegExp(spec.referencePattern, "i") : null;
  const alias = new Map(Object.entries(aliases).map(([k, v]) => [k.trim().toLowerCase(), v.trim()]));
  const rows: Row[] = [];
  const skipped: RowProblem[] = [];
  body.forEach((cells, n) => {
    const rowNo = (spec.skipRows ?? 0) + n + 2; // 1-based, counting the header
    const get = (i: number) => (i >= 0 ? (cells[i] ?? "").trim() : "");
    const amount = parseAmount(get(col.amount));
    if (!amount || amount.minor === 0) return; // blank or zero lines: balances, subtotals, incoming-only rows
    const out = spec.outgoing ?? "any";
    if ((out === "negative" && !amount.negative) || (out === "positive" && amount.negative)) return;
    const date = parseDate(get(col.date), spec.dateFormat ?? "DMY");
    if (!date) { skipped.push({ row: rowNo, problem: "date could not be read" }); return; }
    const description = redact(get(col.description));
    let payee = get(col.payee);
    if (!payee && payeeRe) payee = description.match(payeeRe)?.[1]?.trim() ?? "";
    payee = redact(payee).replace(/\s+/g, " ").trim();
    if (!payee) { skipped.push({ row: rowNo, problem: "no payee" }); return; }
    payee = alias.get(payee.toLowerCase()) ?? payee;
    let reference: string | null = get(col.reference) || null;
    if (!reference && refRe) { const m = description.match(refRe); reference = (m?.[1] ?? m?.[0] ?? "").trim() || null; }
    if (reference) reference = redact(reference).slice(0, 80);
    rows.push({ row: rowNo, date, payee: payee.slice(0, 80), amountMinor: amount.minor, reference, description: description.slice(0, 2000) });
  });
  return { rows, skipped };
}

// ---------- The replay ----------

/** Run `fn` with the clock set to `iso`, so every "now" the engine reads is that moment. Single-threaded scripts and tests only. */
export async function atTime<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const Real = globalThis.Date;
  const fixed = Real.parse(iso);
  class Fixed extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      else super(...(args as [string]));
    }
    static now() { return fixed; }
  }
  globalThis.Date = Fixed as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = Real;
  }
}

export type Category = "duplicate" | "overcharge" | "blocked_other" | "needs_a_look" | "clean";

export interface RecheckRow extends Row {
  category: Category;
  verdict: CheckResult["verdict"];
  reason: string;
  rules: string[];
  /** For an overcharge: the part above what the job record says. */
  overpaidMinor: number;
  /** For a duplicate: the file row of the payment it repeats. */
  duplicateOfRow: number | null;
  jobRows: number[];
}

const BUSINESS = "biz_recheck";

function setUp(db: Db, cfg: RecheckConfig, payees: string[]): Map<string, string> {
  const ts = new Date().toISOString();
  const country = (cfg.country ?? "VN").toUpperCase();
  // Review everything: the replay never pays, and a clean request still reads as clean in the rules.
  db.insert(businesses).values({ id: BUSINESS, name: "Re-check", baseCurrency: cfg.currency, country, policyJson: JSON.stringify({ ...DEFAULT_POLICY, autonomy: "review", allowedCorridors: [`${country}->${country}`] }), createdAt: ts }).run();
  const ids = new Map<string, string>();
  payees.forEach((name, i) => {
    // The suppliers were paid, so their details count as known and verified; how they were paid is not this run's question.
    // A distinct placeholder per supplier: the files say who was paid, not into which account, so no two may look shared.
    const payout = { paypalEmail: null, stellarAccount: null, bankLabel: `Bank account ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) || ""}`, bankCountry: country, bankCurrency: cfg.currency };
    const id = `ven_r${i}`;
    db.insert(vendors).values({ id, businessId: BUSINESS, name, role: "supplier", country, ...payout, detailsHash: payoutHashOf(payout), verifiedAt: ts, verifiedBy: "check", verificationMethod: "document", createdBy: "check", createdAt: ts }).run();
    ids.set(name.toLowerCase(), id);
  });
  return ids;
}

function categorise(r: CheckResult): { category: Category; reason: string } {
  const dup = r.blocks.find((b) => b.rule === "no_duplicate");
  if (dup) return { category: "duplicate", reason: dup.message };
  const over = r.blocks.find((b) => b.rule === "amount_matches_evidence" || b.rule === "expected_amount");
  if (over) return { category: "overcharge", reason: over.message };
  if (r.blocks.length) return { category: "blocked_other", reason: r.blocks[0].message };
  if (r.warnings.length) return { category: "needs_a_look", reason: r.warnings[0].message };
  return { category: "clean", reason: "Every rule passed" };
}

export interface RecheckInput { config: RecheckConfig; payments: Row[]; jobs?: Row[]; /** Tests only: the throwaway database to use. */ db?: Db }

export async function runRecheck(input: RecheckInput): Promise<RecheckRow[]> {
  const { config } = input;
  const db = input.db ?? openTestDb();
  const payments = [...input.payments].sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row);
  const jobs = input.jobs ?? [];
  const names = [...new Set([...payments, ...jobs].map((r) => r.payee))];
  setUp(db, config, names);
  const window = (config.jobs?.matchWindowDays ?? 7) * 86_400_000;
  const byDraft = new Map<string, number>();
  const out: RecheckRow[] = [];
  for (const [i, p] of payments.entries()) {
    // The job records for this payee, closest first: the same reference wins, else within the window.
    const mine = jobs
      .filter((j) => j.payee.toLowerCase() === p.payee.toLowerCase())
      .filter((j) => (p.reference && j.reference ? j.reference.toLowerCase() === p.reference.toLowerCase() : Math.abs(Date.parse(j.date) - Date.parse(p.date)) <= window))
      .sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(p.date)) - Math.abs(Date.parse(b.date) - Date.parse(p.date)))
      .slice(0, 3);
    const when = new Date(Date.parse(`${p.date}T02:00:00Z`) + i * 1000).toISOString();
    const result = await atTime(when, () =>
      evaluatePayment(db, {
        businessId: BUSINESS,
        payee: p.payee,
        amountMinor: p.amountMinor,
        currency: config.currency,
        reference: p.reference,
        description: p.description,
        evidence: mine.map((j) => ({ kind: "job_sheet", label: `Job record row ${j.row} for ${j.payee}`, amountMinor: j.amountMinor, currency: config.currency, reference: j.reference, excerpt: `${j.payee}. ${j.description}`.slice(0, 4000) })),
        evidenceSource: "system",
        actor: "check",
      }),
    );
    byDraft.set(result.draftId, p.row);
    // It was paid: record it as paid on that day, so the payments after it are judged against it.
    await atTime(when, async () => {
      db.update(obligations).set({ state: "settled", updatedAt: new Date().toISOString() }).where(eq(obligations.id, result.draftId)).run();
    });
    const { category, reason } = categorise(result);
    const dupOf = category === "duplicate" ? [...byDraft.entries()].find(([id]) => reason.includes(id))?.[1] ?? null : null;
    const matched = mine.length ? Math.max(...mine.map((j) => j.amountMinor)) : 0;
    out.push({
      ...p,
      category,
      verdict: result.verdict,
      reason: dupOf ? reason.replace(/obligation obl_[a-z0-9]+/, `row ${dupOf}`) : reason.replace(/obligation obl_[a-z0-9]+/g, "an earlier payment"),
      rules: [...result.blocks, ...result.warnings].map((r) => r.rule),
      overpaidMinor: category === "overcharge" && matched ? Math.max(0, p.amountMinor - matched) : 0,
      duplicateOfRow: dupOf,
      jobRows: mine.map((j) => j.row),
    });
  }
  return out;
}

// ---------- Totals and output ----------

export interface RecheckTotals {
  payments: number;
  totalMinor: number;
  duplicates: { count: number; minor: number };
  overcharges: { count: number; overpaidMinor: number };
  blockedOther: number;
  needsALook: { count: number; topReasons: Array<{ rule: string; count: number }> };
  clean: number;
  /** Duplicates in full plus the overpaid part of overcharges. */
  wouldHaveStoppedMinor: number;
}

export function totals(rows: Array<Pick<RecheckRow, "category" | "amountMinor" | "overpaidMinor" | "rules">>): RecheckTotals {
  const dup = rows.filter((r) => r.category === "duplicate");
  const over = rows.filter((r) => r.category === "overcharge");
  const look = rows.filter((r) => r.category === "needs_a_look");
  const reasonCount = new Map<string, number>();
  for (const r of look) for (const rule of new Set(r.rules)) reasonCount.set(rule, (reasonCount.get(rule) ?? 0) + 1);
  const dupMinor = dup.reduce((s, r) => s + r.amountMinor, 0);
  const overMinor = over.reduce((s, r) => s + r.overpaidMinor, 0);
  return {
    payments: rows.length,
    totalMinor: rows.reduce((s, r) => s + r.amountMinor, 0),
    duplicates: { count: dup.length, minor: dupMinor },
    overcharges: { count: over.length, overpaidMinor: overMinor },
    blockedOther: rows.filter((r) => r.category === "blocked_other").length,
    needsALook: { count: look.length, topReasons: [...reasonCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([rule, count]) => ({ rule, count })) },
    clean: rows.filter((r) => r.category === "clean").length,
    wouldHaveStoppedMinor: dupMinor + overMinor,
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const RESULT_COLUMNS = ["row", "date", "payee", "amount", "reference", "category", "reason", "overpaid", "duplicate_of_row", "job_rows", "confirmed"] as const;

/** The private detail file. "confirmed" is left blank for a person to write yes or no after reading each flagged line. */
export function resultsCsv(rows: RecheckRow[]): string {
  const lines = [RESULT_COLUMNS.join(",")];
  for (const r of rows) {
    lines.push([r.row, r.date, r.payee, (r.amountMinor / 100).toFixed(2), r.reference ?? "", r.category, r.reason, (r.overpaidMinor / 100).toFixed(2), r.duplicateOfRow ?? "", r.jobRows.join(" "), ""].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Totals from a reviewed results file, counting only lines a person marked confirmed. What goes public comes from here. */
export function confirmedTotals(csv: string): { reviewed: number; confirmed: RecheckTotals; unreviewedFlags: number } {
  const [header, ...body] = parseCsv(csv);
  const at = (name: string) => header.indexOf(name);
  const rows = body.map((c) => ({
    category: c[at("category")] as Category,
    amountMinor: parseAmount(c[at("amount")])?.minor ?? 0,
    overpaidMinor: parseAmount(c[at("overpaid")])?.minor ?? 0,
    rules: [] as string[],
    confirmed: (c[at("confirmed")] ?? "").trim().toLowerCase(),
  }));
  const flagged = rows.filter((r) => r.category === "duplicate" || r.category === "overcharge");
  const kept = rows.map((r) => (flagged.includes(r) && r.confirmed !== "yes" ? { ...r, category: "clean" as Category, overpaidMinor: 0 } : r));
  return { reviewed: flagged.filter((r) => r.confirmed === "yes" || r.confirmed === "no").length, confirmed: totals(kept), unreviewedFlags: flagged.filter((r) => r.confirmed !== "yes" && r.confirmed !== "no").length };
}

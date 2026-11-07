import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { businesses, onboardingImports, onboardingMappings, onboardingResults } from "../db/schema";
import { newId, now } from "../domain/ids";
import { audit } from "../domain/stateMachine";
import { SUPPORTED_CURRENCIES } from "../domain/money";
import { runRecheckIsolated } from "./isolated";
import { parseCsv, readRows, totals, type RecheckRow, type RecheckTotals, type Row, type RowProblem } from "../check/recheck";
import { requirePermission, type Actor } from "../engine/users";
import { checkWidth, detectColumns, fileSpecOf, headerSignature, toCommaCsv, validateSpec, type Detection, type ImportSpec } from "./detect";

/**
 * Import sessions: an owner uploads a bank export, confirms how to read it, and Checkrail re-checks the payments in
 * it as if each had been asked for on the day it was made. The re-check runs in a throwaway in-memory database
 * (src/lib/check/recheck.ts); the business's own books are only read for the mapping and written for the results.
 * Nothing here pays, schedules a payment or changes a rule.
 */

/** Largest upload accepted, in bytes. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
/** Most lines under the header a file may have. */
export const MAX_DATA_ROWS = 20_000;
/** Most payments one re-check judges (about 40 seconds of work at this size). */
export const MAX_RECHECK_ROWS = 1_000;
/** The re-check covers the last this-many days of the file, counted back from its latest payment. */
export const RECHECK_DAYS = 90;

export function checkSize(csv: unknown, what = "The file"): string {
  if (typeof csv !== "string") throw new Error(`${what} did not arrive as text`);
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) throw new Error(`${what} is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB. Export a shorter period.`);
  if (!csv.trim()) throw new Error(`${what} is empty`);
  return csv;
}

/** A mapping saved for this layout, or null. */
export function savedMapping(db: Db, businessId: string, signature: string): ImportSpec | null {
  const row = db.select().from(onboardingMappings).where(and(eq(onboardingMappings.businessId, businessId), eq(onboardingMappings.signature, signature))).get();
  return row ? (JSON.parse(row.specJson) as ImportSpec) : null;
}

/** Detect how to read a file, using the mapping saved for its layout when there is one. Reads only. */
export function detectForBusiness(db: Db, businessId: string, actor: Actor, csv: unknown): Detection {
  requirePermission(actor, "ingest", "bring in past payments");
  const text = checkSize(csv);
  const first = detectColumns(text);
  const saved = savedMapping(db, businessId, first.signature);
  return saved ? detectColumns(text, { saved }) : first;
}

function saveMapping(db: Db, businessId: string, by: string, header: string[], spec: ImportSpec): void {
  const signature = headerSignature(header);
  const ts = now();
  const existing = db.select().from(onboardingMappings).where(and(eq(onboardingMappings.businessId, businessId), eq(onboardingMappings.signature, signature))).get();
  if (existing) db.update(onboardingMappings).set({ specJson: JSON.stringify(spec), headerJson: JSON.stringify(header), usedCount: existing.usedCount + 1, updatedAt: ts }).where(eq(onboardingMappings.id, existing.id)).run();
  else db.insert(onboardingMappings).values({ id: newId("obm"), businessId, signature, headerJson: JSON.stringify(header), specJson: JSON.stringify(spec), usedCount: 1, createdBy: by, createdAt: ts, updatedAt: ts }).run();
}

const COUNTRY_OF: Record<string, string> = { VND: "VN", PHP: "PH", THB: "TH", USD: "US" };

export interface CreateImportInput {
  csv: string;
  fileName: string;
  currency: string;
  /** The mapping the owner confirmed (from detectColumns, possibly corrected). */
  spec: unknown;
  /** Other spellings of the same supplier: { "PHUONG TRANSPORT CO": "Phuong Transport" }. */
  aliases?: Record<string, string>;
  /** Optional job records (a booking or trip sheet export): payments are matched against them as evidence. */
  jobs?: { csv: string; fileName?: string; spec: unknown } | null;
  /** Save the mapping for the next upload with the same layout. Default true. */
  saveMapping?: boolean;
}

/** One import as the pages show it. JSON-safe. */
export interface ImportSummary {
  id: string;
  fileName: string;
  currency: string;
  status: "checked" | "failed";
  error: string | null;
  createdAt: string;
  createdBy: string;
  periodFrom: string | null;
  periodTo: string | null;
  rowsRead: number;
  rowsChecked: number;
  rowsOutsideWindow: number;
  skipped: RowProblem[];
  payments: number;
  totalMinor: number;
  /** Duplicates in full plus the overpaid part of overcharges (the re-check's wouldHaveStoppedMinor). */
  wouldHaveBlockedMinor: number;
  /** Paid twice, more than the job record, or blocked by another rule. */
  blockedCount: number;
  /** Held for a person to look at. */
  heldCount: number;
  clearCount: number;
  duplicates: { count: number; minor: number };
  overcharges: { count: number; overpaidMinor: number };
}

function cleanAliases(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Aliases must be pairs of names");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) {
    if (typeof v !== "string" || !k.trim() || !v.trim() || k.length > 120 || v.length > 120) throw new Error("Each alias must be a name of 120 characters at most");
    out[k] = v;
  }
  return out;
}

/** The text, its header row (at the mapping's line) and the number of lines under it, within the limits. */
function prepare(csv: unknown, what: string, skipRows: number): { text: string; header: string[]; dataRows: number } {
  const { text } = toCommaCsv(checkSize(csv, what));
  const rows = parseCsv(text);
  checkWidth(rows, what);
  const header = (rows[skipRows] ?? []).map((h) => h.trim());
  if (!header.length) throw new Error(`${what} has no header row on line ${skipRows + 1}`);
  const dataRows = rows.length - skipRows - 1;
  if (dataRows > MAX_DATA_ROWS) throw new Error(`${what} has ${dataRows} lines; the most it may have is ${MAX_DATA_ROWS}. Export a shorter period.`);
  return { text, header, dataRows };
}

/** The payments within RECHECK_DAYS of the latest one. */
export function inWindow(rows: Row[]): { kept: Row[]; outside: number } {
  if (!rows.length) return { kept: [], outside: 0 };
  const latest = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date);
  const cutoff = new Date(Date.parse(`${latest}T00:00:00Z`) - (RECHECK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const kept = rows.filter((r) => r.date >= cutoff);
  return { kept, outside: rows.length - kept.length };
}

/**
 * Create an import from a file and the mapping the owner confirmed, re-check its last 90 days, and store the results.
 * Throws with a message for the page when the file or mapping is not usable; a failure inside the re-check is stored
 * as a failed import and thrown.
 */
export async function createImport(db: Db, businessId: string, actor: Actor, input: CreateImportInput): Promise<ImportSummary> {
  requirePermission(actor, "ingest", "bring in past payments");
  const biz = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!biz) throw new Error("No such business");
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!SUPPORTED_CURRENCIES.includes(currency)) throw new Error(`Currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}`);
  const fileName = (typeof input.fileName === "string" && input.fileName.trim() ? input.fileName.trim() : "bank-export.csv").replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 120);
  const rawSkip = (input.spec as { skipRows?: unknown } | null)?.skipRows;
  const pay = prepare(input.csv, "The file", typeof rawSkip === "number" && Number.isInteger(rawSkip) && rawSkip >= 0 && rawSkip <= 50 ? rawSkip : 0);
  const spec = validateSpec(input.spec, pay.header);
  const aliases = cleanAliases(input.aliases);
  const { rows, skipped } = readRows(pay.text, fileSpecOf(fileName, spec), aliases);
  if (!rows.length) throw new Error(skipped.length ? `No payment could be read: ${skipped[0].problem} on line ${skipped[0].row}. Check the date order and the columns.` : "No money going out was found. Check the amount column and which rows are payments.");
  const { kept, outside } = inWindow(rows);
  if (kept.length > MAX_RECHECK_ROWS) throw new Error(`The last ${RECHECK_DAYS} days hold ${kept.length} payments; one re-check takes ${MAX_RECHECK_ROWS} at most. Upload a shorter period.`);

  let jobRows: Row[] | undefined;
  let jobsSpec: ReturnType<typeof fileSpecOf> | undefined;
  if (input.jobs) {
    const rawJobSkip = (input.jobs.spec as { skipRows?: unknown } | null)?.skipRows;
    const jobs = prepare(input.jobs.csv, "The job records file", typeof rawJobSkip === "number" && Number.isInteger(rawJobSkip) && rawJobSkip >= 0 && rawJobSkip <= 50 ? rawJobSkip : 0);
    jobsSpec = fileSpecOf(input.jobs.fileName ?? "jobs.csv", validateSpec(input.jobs.spec, jobs.header));
    jobRows = readRows(jobs.text, jobsSpec, aliases).rows;
  }

  const country = COUNTRY_OF[currency] ?? biz.country;
  let results: RecheckRow[];
  try {
    // In its own process: the re-check swaps the global clock per payment and reads with the rules only (isolated.ts).
    results = await runRecheckIsolated({ config: { currency, country, payments: fileSpecOf(fileName, spec), jobs: jobsSpec, payeeAliases: aliases }, payments: kept, jobs: jobRows });
  } catch (e) {
    const id = newId("obi");
    db.insert(onboardingImports).values({ id, businessId, fileName, currency, status: "failed", signature: headerSignature(pay.header), specJson: JSON.stringify(spec), rowsRead: rows.length, rowsChecked: 0, rowsOutsideWindow: outside, skippedJson: JSON.stringify(skipped.slice(0, 200)), error: (e as Error).message.slice(0, 500), createdBy: actor.id, createdAt: now() }).run();
    throw new Error(`The re-check could not finish: ${(e as Error).message}`);
  }
  const id = storeImport(db, { businessId, fileName, currency, header: pay.header, spec, rowsRead: rows.length, outside, skipped, results, createdBy: actor.id });
  if (input.saveMapping !== false) saveMapping(db, businessId, actor.id, pay.header, spec);
  return getImport(db, businessId, id)!;
}

export interface StoreImportInput {
  businessId: string;
  fileName: string;
  currency: string;
  header: string[];
  spec: ImportSpec;
  rowsRead: number;
  outside: number;
  skipped: RowProblem[];
  results: Array<Pick<RecheckRow, "row" | "date" | "payee" | "amountMinor" | "reference" | "category" | "verdict" | "reason" | "rules" | "overpaidMinor" | "duplicateOfRow">>;
  createdBy: string;
  /** Defaults to now. The demo seed passes past times. */
  createdAt?: string;
}

/** Write a checked import and its results in one transaction, and record it in the audit log. Returns the import id. */
export function storeImport(db: Db, s: StoreImportInput): string {
  const id = newId("obi");
  const createdAt = s.createdAt ?? now();
  const t = totals(s.results);
  const dates = s.results.map((r) => r.date).sort();
  db.transaction((tx) => {
    tx.insert(onboardingImports)
      .values({ id, businessId: s.businessId, fileName: s.fileName, currency: s.currency, status: "checked", signature: headerSignature(s.header), specJson: JSON.stringify(s.spec), rowsRead: s.rowsRead, rowsChecked: s.results.length, rowsOutsideWindow: s.outside, skippedJson: JSON.stringify(s.skipped.slice(0, 200)), periodFrom: dates[0] ?? null, periodTo: dates[dates.length - 1] ?? null, totalsJson: JSON.stringify(t), createdBy: s.createdBy, createdAt })
      .run();
    for (const r of s.results) {
      tx.insert(onboardingResults)
        .values({ id: newId("obr"), importId: id, businessId: s.businessId, row: r.row, date: r.date, payee: r.payee, amountMinor: r.amountMinor, currency: s.currency, reference: r.reference, category: r.category, verdict: r.verdict, reason: r.reason.slice(0, 500), rulesJson: JSON.stringify(r.rules), overpaidMinor: r.overpaidMinor, duplicateOfRow: r.duplicateOfRow })
        .run();
    }
  });
  audit(db, { obligationId: null, actor: s.createdBy, action: "onboarding.import_checked", detail: { importId: id, fileName: s.fileName, currency: s.currency, payments: t.payments, duplicates: t.duplicates.count, overcharges: t.overcharges.count, held: t.needsALook.count, clear: t.clean, wouldHaveStoppedMinor: t.wouldHaveStoppedMinor } });
  return id;
}

function summaryOf(row: typeof onboardingImports.$inferSelect): ImportSummary {
  const t = row.totalsJson ? (JSON.parse(row.totalsJson) as RecheckTotals) : null;
  return {
    id: row.id,
    fileName: row.fileName,
    currency: row.currency,
    status: row.status as ImportSummary["status"],
    error: row.error,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    rowsRead: row.rowsRead,
    rowsChecked: row.rowsChecked,
    rowsOutsideWindow: row.rowsOutsideWindow,
    skipped: JSON.parse(row.skippedJson) as RowProblem[],
    payments: t?.payments ?? 0,
    totalMinor: t?.totalMinor ?? 0,
    wouldHaveBlockedMinor: t?.wouldHaveStoppedMinor ?? 0,
    blockedCount: t ? t.duplicates.count + t.overcharges.count + t.blockedOther : 0,
    heldCount: t?.needsALook.count ?? 0,
    clearCount: t?.clean ?? 0,
    duplicates: t?.duplicates ?? { count: 0, minor: 0 },
    overcharges: t?.overcharges ?? { count: 0, overpaidMinor: 0 },
  };
}

export function getImport(db: Db, businessId: string, importId: string): ImportSummary | null {
  const row = db.select().from(onboardingImports).where(and(eq(onboardingImports.id, importId), eq(onboardingImports.businessId, businessId))).get();
  return row ? summaryOf(row) : null;
}

/** Newest first. */
export function listImports(db: Db, businessId: string, limit = 50): ImportSummary[] {
  return db.select().from(onboardingImports).where(eq(onboardingImports.businessId, businessId)).orderBy(desc(onboardingImports.createdAt)).limit(limit).all().map(summaryOf);
}

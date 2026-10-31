import type { Field, ImportSpec } from "@/lib/onboarding/detect";

/*
 * Pure helpers for the bank-file column mapper on "Bring in your data". Client-safe: no database, no Node modules.
 * The server reads the file again with the confirmed mapping (src/lib/onboarding/imports.ts); these only show the
 * owner how the mapping reads the first rows before anything runs.
 */

export interface MapField {
  key: Field;
  label: string;
  help: string;
  required: boolean;
}

export const MAP_FIELDS: readonly MapField[] = [
  { key: "date", label: "Date", help: "The day the money left", required: true },
  { key: "payee", label: "Payee", help: "Who was paid", required: true },
  { key: "amount", label: "Amount", help: "Money paid out", required: true },
  { key: "reference", label: "Reference", help: "Invoice or transfer number", required: false },
  { key: "description", label: "Description", help: "The transfer note", required: false },
];

export const DATE_ORDER_LABEL: Record<ImportSpec["dateFormat"], string> = {
  DMY: "Day first (31/10/2026)",
  MDY: "Month first (10/31/2026)",
  YMD: "Year first (2026-10-31)",
};

/** The spec with one field pointed at a column, or cleared (""). Date and amount stay as strings: the server checks them. */
export function setColumn(spec: ImportSpec, field: Field, column: string): ImportSpec {
  const columns = { ...spec.columns };
  if (field === "date" || field === "amount") columns[field] = column;
  else if (column) columns[field] = column;
  else delete columns[field];
  return { ...spec, columns };
}

/** Required fields with no column. Payee is not needed when a pattern finds it in the description. */
export function missingFields(spec: ImportSpec): Field[] {
  const out: Field[] = [];
  if (!spec.columns.date) out.push("date");
  if (!spec.columns.payee && !spec.payeePattern) out.push("payee");
  if (!spec.columns.amount) out.push("amount");
  return out;
}

/** Header cells no field reads, in file order. */
export function unmappedColumns(header: string[], spec: ImportSpec): string[] {
  const used = new Set(Object.values(spec.columns).filter(Boolean).map((c) => (c as string).toLowerCase()));
  return header.filter((h) => h.trim() && !used.has(h.toLowerCase()));
}

/** Two fields pointed at the same column: almost always a slip. */
export function sharedColumns(spec: ImportSpec): string[] {
  const seen = new Map<string, number>();
  for (const c of Object.values(spec.columns)) if (c) seen.set(c.toLowerCase(), (seen.get(c.toLowerCase()) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
}

function cell(header: string[], row: string[], column: string | undefined): string {
  if (!column) return "";
  const i = header.findIndex((h) => h.toLowerCase() === column.toLowerCase());
  return i < 0 ? "" : (row[i] ?? "").trim();
}

/** A date as written, read in the chosen order, to YYYY-MM-DD; a time after it is ignored. Null when it does not read. */
export function readDate(raw: string, order: ImportSpec["dateFormat"]): string | null {
  const m = raw.trim().match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/);
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let y: number, mo: number, d: number;
  if (m[1].length === 4 || order === "YMD") [y, mo, d] = [a, b, c];
  else if (order === "MDY") [mo, d, y] = [a, b, c];
  else [d, mo, y] = [a, b, c];
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.getUTCDate() !== d ? null : iso;
}

/** Whether an amount cell is money going out under the mapping's rule: any non-zero amount, or only negative or positive ones. */
export function isOutgoing(raw: string, outgoing: ImportSpec["outgoing"]): boolean {
  const s = raw.trim();
  if (!/[1-9]/.test(s)) return false;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[^\d.,()-]/g, "")) || /-$/.test(s);
  if (outgoing === "negative") return negative;
  if (outgoing === "positive") return !negative;
  return true;
}

export interface PreviewRow {
  dateRaw: string;
  /** The date as the chosen order reads it, or null. */
  date: string | null;
  payee: string;
  amount: string;
  reference: string;
  description: string;
  /** False for money coming in or an empty amount: the re-check skips those rows. */
  payment: boolean;
}

/** The redacted sample rows as the mapping reads them. */
export function previewRows(header: string[], sample: string[][], spec: ImportSpec): PreviewRow[] {
  return sample.map((r) => {
    const dateRaw = cell(header, r, spec.columns.date);
    const amount = cell(header, r, spec.columns.amount);
    return {
      dateRaw,
      date: dateRaw ? readDate(dateRaw, spec.dateFormat) : null,
      payee: cell(header, r, spec.columns.payee),
      amount,
      reference: cell(header, r, spec.columns.reference),
      description: cell(header, r, spec.columns.description),
      payment: isOutgoing(amount, spec.outgoing),
    };
  });
}

const CODES = ["VND", "USD", "PHP", "THB"];
/** Vietnamese bank headers (accents folded): "Số tiền", "Ngày giao dịch", "Nội dung", "ghi nợ". */
const VIETNAMESE = /\b(so tien|ngay giao dich|noi dung|ghi no|ghi co|nguoi huong|dien giai)\b/;

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();

/**
 * The currency a bank export is most likely in: a code named in the header or the first rows, else Vietnamese headers
 * mean dong, else the business's base currency. Only a supported currency is returned; the owner can change it.
 */
export function guessCurrency(header: string[], sample: string[][], supported: readonly string[], fallback: string): string {
  const text = [...header, ...sample.flat()].join(" ").toUpperCase();
  const named = CODES.filter((c) => supported.includes(c) && new RegExp(`\\b${c}\\b`).test(text));
  if (named.length === 1) return named[0];
  if (supported.includes("VND") && (/₫/.test(text) || VIETNAMESE.test(fold(header.join(" "))))) return "VND";
  return supported.includes(fallback) ? fallback : (supported[0] ?? fallback);
}

/** How long a re-check of this many rows takes, in whole seconds: about 40 ms a payment, 5 s at least. */
export function estimateSeconds(rows: number): number {
  return Math.max(5, Math.round(rows * 0.04));
}

export function confidenceWord(c: number): "high" | "medium" | "low" {
  return c >= 0.85 ? "high" : c >= 0.6 ? "medium" : "low";
}

/** "31 Oct 2026" from YYYY-MM-DD, in UTC so a bare date never shifts a day. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

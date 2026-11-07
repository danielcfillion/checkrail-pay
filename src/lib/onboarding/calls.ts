import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { onboardingImports, onboardingMarks, onboardingResults, rateCards, vendors } from "../db/schema";
import type { Category } from "../check/recheck";

/**
 * A "call" is what the re-check said about one past payment (one onboarding result row), with the owner's mark if
 * there is one. Every onboarding view (the calls list, readiness, the dashboard) reads calls through loadCalls, so
 * they agree on what counts.
 */

export type Mark = "right_catch" | "was_fine";
export const MARKS: readonly Mark[] = ["right_catch", "was_fine"];

export interface Call {
  id: string;
  importId: string;
  importCreatedAt: string;
  row: number;
  date: string;
  payee: string;
  payeeKey: string;
  amountMinor: number;
  currency: string;
  reference: string | null;
  category: Category;
  verdict: string;
  reason: string;
  /** Rule ids that did not pass, each once. */
  rules: string[];
  overpaidMinor: number;
  duplicateOfRow: number | null;
  mark: Mark | null;
  note: string | null;
  markedBy: string | null;
  markedAt: string | null;
}

/** Flagged: the re-check would have stopped it or held it for a person. These are the calls the owner marks. */
export const isFlagged = (c: Pick<Call, "category">) => c.category !== "clean";

/** A payee name for matching: accents folded, case and spacing ignored. "PHUONG  TRANSPORT" and "Phương Transport" match. */
export function payeeKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Monday of the week a YYYY-MM-DD date falls in (weeks start on Monday, UTC calendar days). */
export function weekStart(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Week of 12 Oct" */
export function weekLabel(monday: string): string {
  return `Week of ${Number(monday.slice(8, 10))} ${MONTHS[Number(monday.slice(5, 7)) - 1]}`;
}

/**
 * Every call from the business's checked imports. When two imports cover the same payment (the same file uploaded
 * twice, or overlapping periods), it counts once: the copy the owner marked, else the newest import's.
 */
export function loadCalls(db: Db, businessId: string, opts: { importId?: string } = {}): Call[] {
  const rows = db
    .select({ r: onboardingResults, createdAt: onboardingImports.createdAt, m: onboardingMarks })
    .from(onboardingResults)
    .innerJoin(onboardingImports, eq(onboardingImports.id, onboardingResults.importId))
    .leftJoin(onboardingMarks, eq(onboardingMarks.resultId, onboardingResults.id))
    .where(and(eq(onboardingResults.businessId, businessId), eq(onboardingImports.status, "checked"), opts.importId ? eq(onboardingResults.importId, opts.importId) : undefined))
    .all();
  const calls: Call[] = rows.map(({ r, createdAt, m }) => ({
    id: r.id,
    importId: r.importId,
    importCreatedAt: createdAt,
    row: r.row,
    date: r.date,
    payee: r.payee,
    payeeKey: payeeKey(r.payee),
    amountMinor: r.amountMinor,
    currency: r.currency,
    reference: r.reference,
    category: r.category as Category,
    verdict: r.verdict,
    reason: r.reason,
    rules: [...new Set(JSON.parse(r.rulesJson) as string[])],
    overpaidMinor: r.overpaidMinor,
    duplicateOfRow: r.duplicateOfRow,
    mark: (m?.mark as Mark | undefined) ?? null,
    note: m?.note ?? null,
    markedBy: m?.markedBy ?? null,
    markedAt: m?.markedAt ?? null,
  }));
  // One import's calls are its own: nothing to set aside.
  if (opts.importId) return calls.sort((a, b) => a.row - b.row);
  // The same payment in two imports: same day, payee, amount and reference, and the n-th such line in each file.
  const keyed = new Map<string, Call>();
  const seen = new Map<string, number>();
  const byImport = [...calls].sort((a, b) => a.importId.localeCompare(b.importId) || a.row - b.row);
  for (const c of byImport) {
    const base = `${c.date}|${c.payeeKey}|${c.amountMinor}|${c.currency}|${(c.reference ?? "").toLowerCase()}`;
    const n = (seen.get(`${c.importId}|${base}`) ?? 0) + 1;
    seen.set(`${c.importId}|${base}`, n);
    const key = `${base}|${n}`;
    const prev = keyed.get(key);
    if (!prev || better(c, prev)) keyed.set(key, c);
  }
  return [...keyed.values()].sort((a, b) => a.date.localeCompare(b.date) || a.importCreatedAt.localeCompare(b.importCreatedAt) || a.row - b.row);
}

function better(c: Call, prev: Call): boolean {
  if (Boolean(c.mark) !== Boolean(prev.mark)) return Boolean(c.mark);
  return c.importCreatedAt > prev.importCreatedAt;
}

export interface VendorInfo {
  id: string;
  name: string;
  verified: boolean;
  active: boolean;
  hasRateCard: boolean;
}

/** The business's suppliers by payee key, with what readiness needs to know about each. */
export function vendorIndex(db: Db, businessId: string): Map<string, VendorInfo> {
  const withRates = new Set(db.select({ v: rateCards.vendorId }).from(rateCards).where(eq(rateCards.businessId, businessId)).all().map((r) => r.v));
  const out = new Map<string, VendorInfo>();
  for (const v of db.select().from(vendors).where(eq(vendors.businessId, businessId)).all()) {
    out.set(payeeKey(v.name), { id: v.id, name: v.name, verified: Boolean(v.verifiedAt), active: v.status === "active", hasRateCard: withRates.has(v.id) });
  }
  return out;
}

/** Plain names for the categories the re-check sorts payments into. */
export const CATEGORY_LABEL: Record<Category, string> = {
  duplicate: "Paid twice",
  overcharge: "More than the job record",
  blocked_other: "Blocked by another rule",
  needs_a_look: "Held for a person",
  clean: "Clear",
};

/** Plain names for the rules, for the rule-hit list. Rules not listed here show their id with spaces. */
export const RULE_LABEL: Record<string, string> = {
  no_duplicate: "Already paid",
  amount_matches_evidence: "Amount matches the job record",
  expected_amount: "Amount matches the rate card",
  amount_sane: "Amount in line with past payments",
  stated_unit_rate: "Unit rate matches the contract",
  evidence_present: "Something shows the job",
  needs_evidence: "Evidence needed",
  evidence_provenance: "Evidence from the business, not only the supplier",
  evidence_names_vendor: "Evidence names the supplier",
  job_sheet: "Job record present",
  reference_present: "Reference present",
  reference_other_vendor: "Reference belongs to another supplier",
  reference_lookalike: "Reference looks like another one",
  recipient_verified: "Payout details verified",
  vendor_known: "Supplier on file",
  vendor_active: "Supplier active",
  payout_shared: "Account shared with another supplier",
  request_names_vendor: "Request names the supplier",
  ai_missing: "Details missing",
  ai_flag: "Something in the request needs a look",
  ai_confidence: "Reading was not sure",
  corridor_allowed: "Country and currency allowed",
  currency_supported: "Currency supported",
  amount_present: "Amount present",
  invoice_date: "Invoice date",
  short_pay: "Less than the invoice",
  purchase_order: "Purchase order",
  tax_form: "Tax form on file",
  tax_withholding: "Tax withheld",
  paypal_history: "Not already paid on PayPal",
};

export const ruleLabel = (rule: string) => RULE_LABEL[rule] ?? rule.replace(/_/g, " ");

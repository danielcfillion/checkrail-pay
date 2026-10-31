import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { auditEntries, businesses, obligations, onboardingImports, vendors } from "../db/schema";
import { effectiveAutonomy, type ApprovalPolicy } from "../domain/types";
import { toBaseOrZero } from "../fx";
import { isFlagged, loadCalls, vendorIndex, weekStart, type Call } from "./calls";

/**
 * Readiness for the next autonomy level: Review to Assist, then Assist to Autopilot. Four criteria, worked out from
 * the re-check calls, the owner's marks and the business's own records, with fixed thresholds. Autopilot also waits
 * for a number of weeks in Assist (the time gate), shown beside the four and not counted in them.
 *
 * It reports; it never changes the autonomy level or any other setting. The owner changes the level in Settings.
 *
 * The thresholds below are pending the owner's confirmation.
 */

/** Holds that turned out fine, as a share of the reviewed holds in a week: under this counts. */
export const FALSE_HOLD_TARGET = 0.1;
/** Consecutive weeks under FALSE_HOLD_TARGET needed. */
export const FALSE_HOLD_WEEKS = 2;
/** A week counts only when at least this many of its holds were reviewed. */
export const MIN_REVIEWED_PER_WEEK = 3;
/** Share of the spend in the re-checked payments going to suppliers with a rate card. */
export const RATE_CARD_COVERAGE_TARGET = 0.8;
/** Weeks in Assist before Autopilot. */
export const ASSIST_WEEKS_FOR_AUTOPILOT = 4;
/** Two payments with no reference, same supplier and amount, this many days apart or fewer, are the same payment. */
export const MISSED_DUPLICATE_DAYS = 3;

export type Level = "review" | "assist" | "autopilot";
export type CriterionId = "false_holds" | "suppliers_verified" | "no_missed_duplicate" | "rate_card_coverage" | "weeks_in_assist";

export interface Criterion {
  id: CriterionId;
  label: string;
  /** weeks: whole weeks; count: a number of things; share: 0 to 1. */
  unit: "weeks" | "count" | "share";
  value: number;
  target: number;
  met: boolean;
  /** One plain sentence: where it stands and what moves it. */
  line: string;
}

export interface Readiness {
  level: Level;
  nextLevel: Level | null;
  /** The four criteria, always in this order: false holds, suppliers verified, no missed duplicate, rate-card coverage. */
  criteria: Criterion[];
  /** Weeks in Assist, when the next level is Autopilot. Not counted in met and total. */
  gate: Criterion | null;
  met: number;
  total: number;
  /** Every criterion met, and the gate too when there is one. */
  ready: boolean;
  line: string;
}

export interface WeekStat {
  weekStart: string;
  /** Calls the re-check stopped or held that week (by payment date). */
  holds: number;
  reviewed: number;
  wasFine: number;
  rightCatch: number;
  /** wasFine / reviewed, or null when nothing was reviewed. */
  falseHoldRate: number | null;
  /** Reviewed enough (MIN_REVIEWED_PER_WEEK) and under FALSE_HOLD_TARGET. */
  underTarget: boolean;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Holds per week, from the first week with a call to the last, with no week skipped. */
export function weeklyFalseHolds(calls: Call[]): WeekStat[] {
  if (!calls.length) return [];
  const weeks = new Map<string, WeekStat>();
  const first = weekStart(calls[0].date);
  const last = weekStart(calls.reduce((m, c) => (c.date > m ? c.date : m), calls[0].date));
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += 7 * 86_400_000) {
    const w = new Date(t).toISOString().slice(0, 10);
    weeks.set(w, { weekStart: w, holds: 0, reviewed: 0, wasFine: 0, rightCatch: 0, falseHoldRate: null, underTarget: false });
  }
  for (const c of calls.filter(isFlagged)) {
    const s = weeks.get(weekStart(c.date))!;
    s.holds++;
    if (c.mark) s.reviewed++;
    if (c.mark === "was_fine") s.wasFine++;
    if (c.mark === "right_catch") s.rightCatch++;
  }
  for (const s of weeks.values()) {
    s.falseHoldRate = s.reviewed ? s.wasFine / s.reviewed : null;
    s.underTarget = s.reviewed >= MIN_REVIEWED_PER_WEEK && s.falseHoldRate !== null && s.falseHoldRate < FALSE_HOLD_TARGET;
  }
  return [...weeks.values()];
}

/**
 * Weeks in a row under target, counted back from the latest week reviewed enough. Weeks after it (not yet reviewed
 * enough, usually the current one) are skipped; a week before it that is not under target ends the run.
 */
export function consecutiveWeeksUnder(weeks: WeekStat[]): { run: number; latest: WeekStat | null } {
  let i = weeks.length - 1;
  while (i >= 0 && weeks[i].reviewed < MIN_REVIEWED_PER_WEEK) i--;
  const latest = i >= 0 ? weeks[i] : null;
  let run = 0;
  while (i >= 0 && weeks[i].underTarget) {
    run++;
    i--;
  }
  return { run, latest };
}

/**
 * Payments the re-check let through that repeat an earlier one: same supplier and amount, and the same reference, or
 * no reference on either and MISSED_DUPLICATE_DAYS days apart or fewer. An independent cross-check on the rules.
 */
export function missedDuplicates(calls: Call[]): Array<{ call: Call; earlier: Call }> {
  const out: Array<{ call: Call; earlier: Call }> = [];
  const sorted = [...calls].sort((a, b) => a.date.localeCompare(b.date) || a.row - b.row);
  sorted.forEach((c, i) => {
    if (c.category === "duplicate" || c.rules.includes("no_duplicate")) return;
    const earlier = sorted.slice(0, i).reverse().find((e) => {
      if (e.payeeKey !== c.payeeKey || e.amountMinor !== c.amountMinor || e.currency !== c.currency) return false;
      if (c.reference && e.reference) return c.reference.toLowerCase() === e.reference.toLowerCase();
      if (!c.reference && !e.reference) return (Date.parse(c.date) - Date.parse(e.date)) / 86_400_000 <= MISSED_DUPLICATE_DAYS;
      return false;
    });
    if (earlier) out.push({ call: c, earlier });
  });
  return out;
}

/**
 * Share of the re-checked spend going to suppliers with a rate card on file. In the payments' own currency when they
 * share one; otherwise in the base currency at reference rates.
 */
export function rateCardCoverage(db: Db, businessId: string, calls: Call[], base: string): { coveredMinor: number; totalMinor: number; currency: string; share: number; uncovered: Array<{ payee: string; minor: number }> } {
  const idx = vendorIndex(db, businessId);
  const currencies = new Set(calls.map((c) => c.currency));
  const currency = currencies.size === 1 ? [...currencies][0] : base;
  let covered = 0;
  let total = 0;
  const gaps = new Map<string, { payee: string; minor: number }>();
  for (const c of calls) {
    const m = c.currency === currency ? c.amountMinor : toBaseOrZero(c.amountMinor, c.currency, base);
    total += m;
    if (idx.get(c.payeeKey)?.hasRateCard) covered += m;
    else {
      const g = gaps.get(c.payeeKey) ?? { payee: idx.get(c.payeeKey)?.name ?? c.payee, minor: 0 };
      g.minor += m;
      gaps.set(c.payeeKey, g);
    }
  }
  return { coveredMinor: covered, totalMinor: total, currency, share: total ? covered / total : 0, uncovered: [...gaps.values()].sort((a, b) => b.minor - a.minor) };
}

/** The suppliers that have been paid (in the re-checked history or through Checkrail) and whether each is verified. */
export function paidSuppliers(db: Db, businessId: string, calls: Call[]): Array<{ name: string; verified: boolean }> {
  const idx = vendorIndex(db, businessId);
  const out = new Map<string, { name: string; verified: boolean }>();
  for (const c of calls) {
    const v = idx.get(c.payeeKey);
    out.set(v ? `v:${v.id}` : `p:${c.payeeKey}`, { name: v?.name ?? c.payee, verified: Boolean(v?.verified && v.active) });
  }
  const settled = db
    .select({ id: vendors.id, name: vendors.name, verifiedAt: vendors.verifiedAt, status: vendors.status })
    .from(obligations)
    .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(and(eq(obligations.businessId, businessId), eq(obligations.state, "settled")))
    .all();
  for (const v of settled) out.set(`v:${v.id}`, { name: v.name, verified: Boolean(v.verifiedAt) && v.status === "active" });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** When the business moved to its current level: the latest change to it in the audit log, else when onboarding began. */
function levelSince(db: Db, businessId: string, level: Level, businessCreatedAt: string): string {
  const changes = db.select({ at: auditEntries.createdAt, detail: auditEntries.detailJson }).from(auditEntries).where(eq(auditEntries.action, "autonomy.changed")).orderBy(desc(auditEntries.seq)).all();
  for (const c of changes) {
    const to = c.detail ? (JSON.parse(c.detail) as { to?: { autonomy?: string } }).to?.autonomy : undefined;
    if (to === level) return c.at;
  }
  const firstImport = db.select({ at: onboardingImports.createdAt }).from(onboardingImports).where(eq(onboardingImports.businessId, businessId)).orderBy(onboardingImports.createdAt).limit(1).get()?.at;
  return firstImport && firstImport < businessCreatedAt ? firstImport : businessCreatedAt;
}

const NEXT: Record<Level, Level | null> = { review: "assist", assist: "autopilot", autopilot: null };
const LEVEL_NAME: Record<Level, string> = { review: "Review", assist: "Assist", autopilot: "Autopilot" };

export function readiness(db: Db, businessId: string, opts: { now?: Date; calls?: Call[] } = {}): Readiness {
  const biz = db.select().from(businesses).where(eq(businesses.id, businessId)).get();
  if (!biz) throw new Error("No such business");
  const at = (opts.now ?? new Date()).getTime();
  const calls = opts.calls ?? loadCalls(db, businessId);
  const level = effectiveAutonomy(JSON.parse(biz.policyJson) as ApprovalPolicy) as Level;
  const nextLevel = NEXT[level];

  // 1. Holds that turned out fine.
  const weeks = weeklyFalseHolds(calls);
  const { run, latest } = consecutiveWeeksUnder(weeks);
  const holdsMet = run >= FALSE_HOLD_WEEKS;
  const holdsLine = !latest
    ? `Mark at least ${MIN_REVIEWED_PER_WEEK} held payments a week as right catch or was fine to measure this.`
    : holdsMet
      ? `Under ${pct(FALSE_HOLD_TARGET)} of reviewed holds were fine for ${run} weeks in a row (latest week: ${pct(latest.falseHoldRate ?? 0)}).`
      : `${pct(latest.falseHoldRate ?? 0)} of reviewed holds were fine in the latest week; it needs to be under ${pct(FALSE_HOLD_TARGET)} for ${FALSE_HOLD_WEEKS} weeks in a row (${run} so far).`;

  // 2. Every paid supplier verified.
  const suppliers = paidSuppliers(db, businessId, calls);
  const unverified = suppliers.filter((s) => !s.verified);
  const suppliersMet = suppliers.length > 0 && unverified.length === 0;
  const suppliersLine = !suppliers.length
    ? "No supplier has been paid yet. Bring in your past payments first."
    : suppliersMet
      ? `All ${suppliers.length} suppliers you pay have verified payout details.`
      : `${unverified.length} of ${suppliers.length} suppliers you pay ${unverified.length === 1 ? "is" : "are"} not verified: ${unverified.slice(0, 3).map((s) => s.name).join(", ")}${unverified.length > 3 ? " and others" : ""}.`;

  // 3. No duplicate the rules missed.
  const missed = missedDuplicates(calls);
  const dupMet = calls.length > 0 && missed.length === 0;
  const dupLine = !calls.length
    ? "Re-check your past payments to look for duplicates the rules would miss."
    : missed.length === 0
      ? `No repeat payment got past the rules in ${calls.length} re-checked payments.`
      : `${missed.length} repeat payment${missed.length === 1 ? "" : "s"} got past the rules, for example ${missed[0].call.payee} on ${missed[0].call.date}. Add the reference to the payment note so the check can see it.`;

  // 4. Rate-card coverage of spend.
  const cov = rateCardCoverage(db, businessId, calls, biz.baseCurrency);
  const covMet = cov.totalMinor > 0 && cov.share >= RATE_CARD_COVERAGE_TARGET;
  const covLine = !cov.totalMinor
    ? "Re-check your past payments to see how much of your spend has a rate card."
    : covMet
      ? `${pct(cov.share)} of your spend goes to suppliers with a rate card (target ${pct(RATE_CARD_COVERAGE_TARGET)}).`
      : `${pct(cov.share)} of your spend goes to suppliers with a rate card; the target is ${pct(RATE_CARD_COVERAGE_TARGET)}. The biggest gap: ${cov.uncovered[0]?.payee ?? "none"}.`;

  const criteria: Criterion[] = [
    { id: "false_holds", label: "Holds that turned out fine", unit: "weeks", value: run, target: FALSE_HOLD_WEEKS, met: holdsMet, line: holdsLine },
    { id: "suppliers_verified", label: "Every paid supplier verified", unit: "count", value: suppliers.length - unverified.length, target: suppliers.length, met: suppliersMet, line: suppliersLine },
    { id: "no_missed_duplicate", label: "No missed duplicate", unit: "count", value: missed.length, target: 0, met: dupMet, line: dupLine },
    { id: "rate_card_coverage", label: "Rate cards cover your spend", unit: "share", value: Math.round(cov.share * 1000) / 1000, target: RATE_CARD_COVERAGE_TARGET, met: covMet, line: covLine },
  ];

  let gate: Criterion | null = null;
  if (nextLevel === "autopilot") {
    const since = levelSince(db, businessId, "assist", biz.createdAt);
    const weeksIn = Math.max(0, Math.floor((at - Date.parse(since)) / (7 * 86_400_000)));
    const gateMet = weeksIn >= ASSIST_WEEKS_FOR_AUTOPILOT;
    gate = {
      id: "weeks_in_assist",
      label: `${ASSIST_WEEKS_FOR_AUTOPILOT} weeks in Assist`,
      unit: "weeks",
      value: weeksIn,
      target: ASSIST_WEEKS_FOR_AUTOPILOT,
      met: gateMet,
      line: gateMet ? `${weeksIn} weeks in Assist, enough for Autopilot.` : `${weeksIn} of ${ASSIST_WEEKS_FOR_AUTOPILOT} weeks in Assist before Autopilot.`,
    };
  }
  const met = criteria.filter((c) => c.met).length;
  const ready = Boolean(nextLevel) && met === criteria.length && (!gate || gate.met);
  const line = !nextLevel
    ? `On Autopilot. ${met} of ${criteria.length} checks hold.`
    : ready
      ? `Ready to move from ${LEVEL_NAME[level]} to ${LEVEL_NAME[nextLevel]}. The owner changes the level in Settings.`
      : `${met} of ${criteria.length} checks met for ${LEVEL_NAME[nextLevel]}${gate && !gate.met ? `, and ${gate.line.charAt(0).toLowerCase()}${gate.line.slice(1)}` : "."}`;
  return { level, nextLevel, criteria, gate, met, total: criteria.length, ready, line };
}

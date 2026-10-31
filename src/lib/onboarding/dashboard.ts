import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { businesses } from "../db/schema";
import type { Category } from "../check/recheck";
import { CATEGORY_LABEL, isFlagged, loadCalls, ruleLabel, weekLabel, weekStart, type Call } from "./calls";
import { listSuggestions } from "./calibration";
import { listImports } from "./imports";
import { FALSE_HOLD_TARGET, readiness, weeklyFalseHolds } from "./readiness";

/**
 * Data for "Your first weeks" (the AG Studio dashboard) and the re-check screens: one call returns every widget's rows
 * as plain arrays of flat, JSON-safe objects with stable snake_case field names, ready to hand to AG Studio as data
 * sources. Amounts are integer minor units (hundredths) with a currency code beside them; dates are YYYY-MM-DD; times
 * are ISO 8601 UTC; shares and rates are 0 to 1; a value that does not exist yet is null.
 *
 * readiness_summary (one row)
 *   level, next_level          "review" | "assist" | "autopilot"; next_level null on Autopilot
 *   met, total                 criteria met, out of 4 (the time gate is not counted)
 *   ready                      every criterion met, and the gate when there is one
 *   gate_weeks, gate_target    weeks in Assist and the weeks Autopilot needs; null unless the next level is Autopilot
 *   gate_met                   boolean or null
 *   line                       one plain sentence
 *
 * readiness (one row per criterion, then the gate)
 *   criterion_id               false_holds | suppliers_verified | no_missed_duplicate | rate_card_coverage | weeks_in_assist
 *   label, line                plain words
 *   unit                       "weeks" | "count" | "share"
 *   value, target              numbers in that unit
 *   met                        boolean
 *   counts_toward_gauge        true for the four criteria, false for the time gate
 *   position                   1 to 5, display order
 *
 * money_stopped (one row per category and currency, flagged calls only)
 *   category                   duplicate | overcharge | blocked_other | needs_a_look
 *   category_label             "Paid twice", "More than the job record", "Blocked by another rule", "Held for a person"
 *   currency
 *   calls                      how many
 *   stopped_minor              money that would not have left: duplicates and other blocks in full, overcharges' overpaid part; 0 for holds
 *   held_minor                 money that would have waited for a person (holds in full); 0 otherwise
 *   confirmed_minor            the part of stopped_minor and held_minor in calls marked right catch
 *   fine_minor                 the part in calls marked was fine
 *   unreviewed_calls           calls not marked yet
 *
 * weekly_false_holds (one row per week, by payment date, no week skipped)
 *   week_start                 Monday, YYYY-MM-DD
 *   week_label                 "Week of 12 Oct"
 *   holds, reviewed, was_fine, right_catch
 *   false_hold_rate            was_fine / reviewed, or null when none reviewed
 *   target_rate                0.1
 *   under_target               reviewed enough and under the target
 *
 * rule_hits (one row per rule that fired on a flagged call, most hits first)
 *   rule, rule_label
 *   hits                       flagged calls the rule fired on
 *   reviewed, right_catch, was_fine
 *   agreement_rate             right_catch / reviewed, or null when none reviewed
 *
 * calls (flagged calls, newest first, at most 500)
 *   call_id, import_id, file_row, date, week_start, payee, amount_minor, currency, reference
 *   category, category_label, verdict ("pay" | "hold" | "block"), reason
 *   rules                      rule ids, comma-separated
 *   overpaid_minor, duplicate_of_row
 *   mark                       "right_catch" | "was_fine" | null
 *   note, marked_by, marked_at
 *
 * imports (one row per upload, newest first: the re-check results screen)
 *   import_id, file_name, status ("checked" | "failed"), currency, created_at, created_by, period_from, period_to
 *   payments, total_minor, would_have_blocked_minor, blocked_count, held_count, clear_count
 *   duplicate_count, duplicate_minor, overcharge_count, overpaid_minor, rows_skipped, rows_outside_window
 *
 * suggestions (proposed first, then applied, then dismissed)
 *   suggestion_id, kind (rate_card | booking_feed | verify_supplier | retainer), kind_label, target, title, detail
 *   status                     "proposed" | "applied" | "dismissed"
 *   basis_count                marked calls it rests on
 *   proposed_unit, proposed_rate_minor, proposed_currency, proposed_valid_from    rate cards only, else null
 *   screen                     where the change itself is made, or null
 *   created_at, decided_by, decided_at
 */

export interface ReadinessSummaryRow { level: string; next_level: string | null; met: number; total: number; ready: boolean; gate_weeks: number | null; gate_target: number | null; gate_met: boolean | null; line: string }
export interface ReadinessRow { criterion_id: string; label: string; line: string; unit: string; value: number; target: number; met: boolean; counts_toward_gauge: boolean; position: number }
export interface MoneyStoppedRow { category: string; category_label: string; currency: string; calls: number; stopped_minor: number; held_minor: number; confirmed_minor: number; fine_minor: number; unreviewed_calls: number }
export interface WeeklyFalseHoldRow { week_start: string; week_label: string; holds: number; reviewed: number; was_fine: number; right_catch: number; false_hold_rate: number | null; target_rate: number; under_target: boolean }
export interface RuleHitRow { rule: string; rule_label: string; hits: number; reviewed: number; right_catch: number; was_fine: number; agreement_rate: number | null }
export interface CallRow { call_id: string; import_id: string; file_row: number; date: string; week_start: string; payee: string; amount_minor: number; currency: string; reference: string | null; category: string; category_label: string; verdict: string; reason: string; rules: string; overpaid_minor: number; duplicate_of_row: number | null; mark: string | null; note: string | null; marked_by: string | null; marked_at: string | null }
export interface ImportRow { import_id: string; file_name: string; status: string; currency: string; created_at: string; created_by: string; period_from: string | null; period_to: string | null; payments: number; total_minor: number; would_have_blocked_minor: number; blocked_count: number; held_count: number; clear_count: number; duplicate_count: number; duplicate_minor: number; overcharge_count: number; overpaid_minor: number; rows_skipped: number; rows_outside_window: number }
export interface SuggestionRow { suggestion_id: string; kind: string; kind_label: string; target: string; title: string; detail: string; status: string; basis_count: number; proposed_unit: string | null; proposed_rate_minor: number | null; proposed_currency: string | null; proposed_valid_from: string | null; screen: string | null; created_at: string; decided_by: string | null; decided_at: string | null }

export interface DashboardData {
  readiness_summary: ReadinessSummaryRow[];
  readiness: ReadinessRow[];
  money_stopped: MoneyStoppedRow[];
  weekly_false_holds: WeeklyFalseHoldRow[];
  rule_hits: RuleHitRow[];
  calls: CallRow[];
  imports: ImportRow[];
  suggestions: SuggestionRow[];
}

export const CALLS_LIMIT = 500;
const round = (x: number | null, places = 3) => (x === null ? null : Math.round(x * 10 ** places) / 10 ** places);

/** What each flagged call stops, holds, or neither, in its own currency. */
function stoppedOf(c: Call): { stopped: number; held: number } {
  if (c.category === "duplicate" || c.category === "blocked_other") return { stopped: c.amountMinor, held: 0 };
  if (c.category === "overcharge") return { stopped: c.overpaidMinor, held: 0 };
  if (c.category === "needs_a_look") return { stopped: 0, held: c.amountMinor };
  return { stopped: 0, held: 0 };
}

export function moneyStopped(calls: Call[]): MoneyStoppedRow[] {
  const order: Category[] = ["duplicate", "overcharge", "blocked_other", "needs_a_look"];
  const rows = new Map<string, MoneyStoppedRow>();
  for (const c of calls.filter(isFlagged)) {
    const k = `${c.category}|${c.currency}`;
    const r = rows.get(k) ?? { category: c.category, category_label: CATEGORY_LABEL[c.category], currency: c.currency, calls: 0, stopped_minor: 0, held_minor: 0, confirmed_minor: 0, fine_minor: 0, unreviewed_calls: 0 };
    const { stopped, held } = stoppedOf(c);
    r.calls++;
    r.stopped_minor += stopped;
    r.held_minor += held;
    if (c.mark === "right_catch") r.confirmed_minor += stopped + held;
    else if (c.mark === "was_fine") r.fine_minor += stopped + held;
    else r.unreviewed_calls++;
    rows.set(k, r);
  }
  return [...rows.values()].sort((a, b) => order.indexOf(a.category as Category) - order.indexOf(b.category as Category) || a.currency.localeCompare(b.currency));
}

export function ruleHits(calls: Call[]): RuleHitRow[] {
  const rows = new Map<string, RuleHitRow>();
  for (const c of calls.filter(isFlagged)) {
    for (const rule of c.rules) {
      const r = rows.get(rule) ?? { rule, rule_label: ruleLabel(rule), hits: 0, reviewed: 0, right_catch: 0, was_fine: 0, agreement_rate: null };
      r.hits++;
      if (c.mark) r.reviewed++;
      if (c.mark === "right_catch") r.right_catch++;
      if (c.mark === "was_fine") r.was_fine++;
      rows.set(rule, r);
    }
  }
  for (const r of rows.values()) r.agreement_rate = r.reviewed ? round(r.right_catch / r.reviewed) : null;
  return [...rows.values()].sort((a, b) => b.hits - a.hits || a.rule.localeCompare(b.rule));
}

export function callRow(c: Call): CallRow {
  return {
    call_id: c.id,
    import_id: c.importId,
    file_row: c.row,
    date: c.date,
    week_start: weekStart(c.date),
    payee: c.payee,
    amount_minor: c.amountMinor,
    currency: c.currency,
    reference: c.reference,
    category: c.category,
    category_label: CATEGORY_LABEL[c.category],
    verdict: c.verdict,
    reason: c.reason,
    rules: c.rules.join(", "),
    overpaid_minor: c.overpaidMinor,
    duplicate_of_row: c.duplicateOfRow,
    mark: c.mark,
    note: c.note,
    marked_by: c.markedBy,
    marked_at: c.markedAt,
  };
}

/** Every widget's rows for one business. Reads only. */
export function onboardingDashboard(db: Db, businessId: string, opts: { now?: Date } = {}): DashboardData {
  if (!db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).get()) throw new Error("No such business");
  const calls = loadCalls(db, businessId);
  const r = readiness(db, businessId, { now: opts.now, calls });
  const readinessRows: ReadinessRow[] = [...r.criteria, ...(r.gate ? [r.gate] : [])].map((c, i) => ({ criterion_id: c.id, label: c.label, line: c.line, unit: c.unit, value: c.value, target: c.target, met: c.met, counts_toward_gauge: c.id !== "weeks_in_assist", position: i + 1 }));
  return {
    readiness_summary: [{ level: r.level, next_level: r.nextLevel, met: r.met, total: r.total, ready: r.ready, gate_weeks: r.gate?.value ?? null, gate_target: r.gate?.target ?? null, gate_met: r.gate ? r.gate.met : null, line: r.line }],
    readiness: readinessRows,
    money_stopped: moneyStopped(calls),
    weekly_false_holds: weeklyFalseHolds(calls).map((w) => ({ week_start: w.weekStart, week_label: weekLabel(w.weekStart), holds: w.holds, reviewed: w.reviewed, was_fine: w.wasFine, right_catch: w.rightCatch, false_hold_rate: round(w.falseHoldRate), target_rate: FALSE_HOLD_TARGET, under_target: w.underTarget })),
    rule_hits: ruleHits(calls),
    calls: calls.filter(isFlagged).reverse().slice(0, CALLS_LIMIT).map(callRow),
    imports: listImports(db, businessId).map((i) => ({
      import_id: i.id,
      file_name: i.fileName,
      status: i.status,
      currency: i.currency,
      created_at: i.createdAt,
      created_by: i.createdBy,
      period_from: i.periodFrom,
      period_to: i.periodTo,
      payments: i.payments,
      total_minor: i.totalMinor,
      would_have_blocked_minor: i.wouldHaveBlockedMinor,
      blocked_count: i.blockedCount,
      held_count: i.heldCount,
      clear_count: i.clearCount,
      duplicate_count: i.duplicates.count,
      duplicate_minor: i.duplicates.minor,
      overcharge_count: i.overcharges.count,
      overpaid_minor: i.overcharges.overpaidMinor,
      rows_skipped: i.skipped.length,
      rows_outside_window: i.rowsOutsideWindow,
    })),
    suggestions: listSuggestions(db, businessId).map((s) => ({
      suggestion_id: s.id,
      kind: s.kind,
      kind_label: s.kindLabel,
      target: s.target,
      title: s.title,
      detail: s.detail,
      status: s.status,
      basis_count: s.basisCount,
      proposed_unit: s.proposed?.unit ?? null,
      proposed_rate_minor: s.proposed?.rateMinor ?? null,
      proposed_currency: s.proposed?.currency ?? null,
      proposed_valid_from: s.proposed?.validFrom ?? null,
      screen: s.screen,
      created_at: s.createdAt,
      decided_by: s.decidedBy,
      decided_at: s.decidedAt,
    })),
  };
}

/** The flagged calls of one import, in file order: the list the owner marks on the re-check screen. */
export function importCalls(db: Db, businessId: string, importId: string): CallRow[] {
  return loadCalls(db, businessId, { importId }).filter(isFlagged).map(callRow);
}

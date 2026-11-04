/**
 * AG Studio data sources for "Your first weeks" (/onboarding/dashboard), built from onboardingDashboard() in
 * src/lib/onboarding/dashboard.ts. One table per array there, with the same snake_case field ids, so a widget, the
 * report state and Studio's agent all speak the backend's names.
 *
 * Money: the backend sends integer minor units (always hundredths) with a currency beside them. Studio shows numbers
 * as they are, so every *_minor field becomes a major-unit field here (stopped_minor -> stopped) and the minor field
 * is dropped. The amounts are formatted in the business's currency (VND has no minor unit in display). Rows are never
 * converted between currencies; the descriptions tell the agent to filter by currency before summing when there is
 * more than one.
 *
 * Pure: no Studio runtime import, so it is tested in node.
 */
import type { AgDataSourcesDefinition, AgExpressionFieldDefinition, AgFieldDefinition, AgFormat, AgRelationDefinition } from "ag-studio";
import type { DashboardData } from "@/lib/onboarding/dashboard";
import { currencyDecimals } from "@/lib/format";

export const CALENDAR_ID = "calendar";

/** Integer minor units (hundredths, whatever the currency) to a display amount. */
export const toMajor = (minor: number | null | undefined): number | null => (minor === null || minor === undefined ? null : minor / 100);

/** The currency the dashboard's money is shown in: the first one in the data, else USD. */
export function displayCurrency(data: Pick<DashboardData, "money_stopped" | "calls" | "imports">): string {
  return data.money_stopped[0]?.currency ?? data.calls[0]?.currency ?? data.imports[0]?.currency ?? "USD";
}

/** Every currency the money rows use. More than one means sums must be filtered by currency first. */
export function currenciesIn(data: Pick<DashboardData, "money_stopped" | "calls" | "imports">): string[] {
  return [...new Set([...data.money_stopped.map((r) => r.currency), ...data.calls.map((r) => r.currency), ...data.imports.map((r) => r.currency)])].sort();
}

/** Studio number format string for a currency: '"VND "#,##0' or '"USD "#,##0.00'. Quoted, so letters stay literal. */
export function moneyFormatString(currency: string): string {
  const code = currency.toUpperCase().replace(/[^A-Z]/g, "");
  return `"${code} "#,##0${currencyDecimals(code) ? ".00" : ""}`;
}

/**
 * The same amounts shortened for tiles and chart labels: "VND 244.8M" for a currency with no minor unit, whose figures run to
 * nine digits and overflow a bar chart or a narrow tile. Currencies with cents keep the full figure, which fits.
 */
export function moneyFormatCompact(currency: string): Intl.NumberFormat | string {
  const code = currency.toUpperCase().replace(/[^A-Z]/g, "");
  if (currencyDecimals(code) !== 0) return moneyFormatString(code);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "code", notation: "compact", maximumFractionDigits: 1 });
  } catch {
    return moneyFormatString(code);
  }
}

/** Display names for the readiness levels. */
export const LEVEL_LABEL: Record<string, string> = { review: "Review", assist: "Assist", autopilot: "Autopilot" };

const MARK_LABEL: Record<string, string> = { right_catch: "Right catch", was_fine: "Was fine" };
const VERDICT_LABEL: Record<string, string> = { pay: "Clear", hold: "Held", block: "Blocked" };

// --- Field helpers ------------------------------------------------------------------------------------------------

type Spec = { id: string; name: string; format: AgFormat; description?: string; hide?: boolean; money?: boolean; percent?: boolean };

const f = (id: string, name: string, format: AgFormat, description?: string, extra: Partial<Spec> = {}): Spec => ({ id, name, format, description, ...extra });
const hidden = (id: string, name: string, format: AgFormat = "textFormat"): Spec => ({ id, name, format, hide: true });
const money = (id: string, name: string, description?: string): Spec => ({ id, name, format: "currencyFormat", description, money: true });
const share = (id: string, name: string, description?: string): Spec => ({ id, name, format: "percentageFormat", description, percent: true });

function fields(specs: Spec[], currency: string, compact = false): AgFieldDefinition[] {
  return specs.map(({ id, name, format, description, hide, money: isMoney, percent }) => ({
    id,
    name,
    format,
    ...(description && { description }),
    ...(hide && { hide }),
    ...(isMoney && { formatOptions: { format: compact ? moneyFormatCompact(currency) : moneyFormatString(currency) } }),
    ...(percent && { formatOptions: { format: "0%" } }),
    // "25 Oct 2026", as elsewhere in the app, not the browser's numeric short date.
    ...(format === "dateFormat" && { formatOptions: { format: "d mmm yyyy" } }),
    ...(format === "dateTimeFormat" && { formatOptions: { format: "d mmm yyyy, hh:mm" } }),
  }));
}

const sumOf = (id: string) => ({ id, aggregation: "sum" as const });

const ratio = (id: string, name: string, description: string, numerator: string, denominator: string): AgExpressionFieldDefinition => ({
  id,
  name,
  description,
  format: "percentageFormat",
  formatOptions: { format: "0%" },
  isMeasure: true,
  expression: { operator: "divide", inputs: [sumOf(numerator), sumOf(denominator)] },
});

// --- Field specs per table (exported so tests and the report can check ids) ---------------------------------------

export const FIELDS = {
  readiness_summary: [
    f("level", "Current level", "textFormat", "review, assist or autopilot: how much Checkrail does on its own today."),
    f("level_label", "Current level name", "textFormat"),
    f("next_level", "Next level", "textFormat", "The level this readiness is measured against; empty once on Autopilot."),
    f("next_level_label", "Next level name", "textFormat"),
    f("met", "Checks met", "integerFormat", "Readiness checks met, out of total. The time gate is not counted."),
    f("total", "Checks in total", "integerFormat"),
    f("ready", "Ready", "booleanFormat", "Every check met, and the time gate when there is one."),
    f("gate_weeks", "Weeks in Assist", "integerFormat"),
    f("gate_target", "Weeks Autopilot needs", "integerFormat"),
    f("gate_met", "Time gate met", "booleanFormat"),
    f("line", "Summary", "textFormat", "One plain sentence on where the business stands."),
  ],
  readiness: [
    hidden("criterion_id", "Check ID"),
    f("label", "Check", "textFormat", "Name of the readiness check."),
    f("line", "Where it stands", "textFormat", "One plain sentence: the current value against the target, and what is missing."),
    f("unit", "Unit", "textFormat", "weeks, count or share (0 to 1)."),
    f("value", "Value", "decimalFormat", "Current value, in the unit."),
    f("target", "Target", "decimalFormat", "Value needed, in the unit."),
    f("met", "Met", "booleanFormat"),
    f("counts_toward_gauge", "Counts toward the gauge", "booleanFormat", "True for the four checks; false for the time gate (weeks in Assist)."),
    f("position", "Order", "integerFormat"),
  ],
  money_stopped: [
    hidden("category", "Reason ID"),
    f("category_label", "Reason", "textFormat", "Why Checkrail stopped or held the payments."),
    f("currency", "Currency", "textFormat"),
    f("calls", "Payments flagged", "integerFormat"),
    money("stopped", "Money stopped", "Money that would not have left: paid-twice and other blocks in full, the overpaid part of overcharges. 0 for holds."),
    money("held", "Money held for a person", "Money that waited for a person to look (holds in full). 0 for blocks."),
    money("confirmed", "Confirmed right", "The part of stopped and held money in calls the owner marked a right catch."),
    money("fine", "Turned out fine", "The part of stopped and held money in calls the owner marked as fine."),
    f("unreviewed_calls", "Not reviewed yet", "integerFormat", "Flagged payments the owner has not marked yet."),
  ],
  weekly_false_holds: [
    f("week_start", "Week starting", "dateFormat", "Monday of the week, by payment date."),
    f("week_label", "Week", "textFormat"),
    f("holds", "Holds", "integerFormat", "Payments held for a person that week."),
    f("reviewed", "Holds reviewed", "integerFormat"),
    f("was_fine", "Holds that were fine", "integerFormat", "Holds the owner marked as fine: Checkrail held a good payment."),
    f("right_catch", "Holds that were right", "integerFormat"),
    share("false_hold_rate", "Holds that turned out fine", "was_fine / reviewed for the week; empty when none were reviewed. Lower is better."),
    share("target_rate", "Target", "The most holds that may turn out fine: 10%."),
    f("under_target", "Under target", "booleanFormat", "Enough holds reviewed and under the 10% target."),
  ],
  rule_hits: [
    hidden("rule", "Rule ID"),
    f("rule_label", "Rule", "textFormat", "The check that fired, in plain words."),
    f("hits", "Times", "integerFormat", "Times the rule fired: flagged payments it fired on."),
    f("reviewed", "Reviewed", "integerFormat"),
    f("right_catch", "You agreed", "integerFormat", "Times the owner marked the call a right catch."),
    f("was_fine", "You disagreed", "integerFormat", "Times the owner marked the payment as fine."),
    share("agreement_rate", "Agreement", "right_catch / reviewed for the rule; empty when none reviewed."),
  ],
  calls: [
    hidden("call_id", "Call ID"),
    hidden("import_id", "Import ID"),
    f("file_row", "Row in file", "integerFormat"),
    f("date", "Payment date", "dateFormat"),
    f("week_start", "Week starting", "dateFormat"),
    f("payee", "Supplier", "textFormat", "Who the payment was to."),
    money("amount", "Amount"),
    f("currency", "Currency", "textFormat"),
    f("reference", "Reference", "textFormat"),
    hidden("category", "Reason ID"),
    f("category_label", "Reason", "textFormat", "Paid twice, more than the job record, blocked by another rule, or held for a person."),
    f("verdict", "Call", "textFormat", "pay, hold or block."),
    f("verdict_label", "Checkrail's call", "textFormat", "Clear, Held or Blocked."),
    f("reason", "Why", "textFormat"),
    f("rules", "Rules that fired", "textFormat", "Rule ids, comma separated; see the rule hits table for names."),
    money("overpaid", "Overpaid part"),
    money("stopped", "Money stopped", "What this call stopped: the full amount when paid twice or blocked, the overpaid part of an overcharge, 0 for a hold. Sum it by supplier for money stopped by supplier."),
    money("held", "Money held for a person", "The full amount when the call was a hold, else 0. Never add it to stopped."),
    f("mark", "Owner's mark", "textFormat", "right_catch, was_fine, or empty when not reviewed."),
    f("mark_label", "Your verdict", "textFormat", "Right catch, Was fine, or Not reviewed."),
    f("reviewed", "Reviewed (1 or 0)", "integerFormat", "1 when the owner marked the call; sum it to count reviewed calls."),
    f("was_fine", "Was fine (1 or 0)", "integerFormat", "1 when the owner marked the payment fine; sum it to count holds that turned out fine."),
    f("right_catch", "Right catch (1 or 0)", "integerFormat", "1 when the owner agreed with the call."),
    f("note", "Note", "textFormat"),
    f("duplicate_of_row", "Paid before in row", "integerFormat", "For a payment paid twice, the row in the file that paid it first."),
    f("marked_by", "Marked by", "textFormat"),
    f("marked_at", "Marked", "dateTimeFormat"),
  ],
  imports: [
    hidden("import_id", "Import ID"),
    f("file_name", "File", "textFormat"),
    f("status", "Import status", "textFormat"),
    f("currency", "Import currency", "textFormat"),
    f("created_at", "Uploaded", "dateTimeFormat"),
    f("created_by", "Uploaded by", "textFormat"),
    f("period_from", "From", "dateFormat"),
    f("period_to", "To", "dateFormat"),
    f("payments", "Payments re-checked", "integerFormat"),
    money("total", "Total paid"),
    money("would_have_blocked", "Would have blocked"),
    f("blocked_count", "Blocked", "integerFormat"),
    f("held_count", "Held", "integerFormat"),
    f("clear_count", "Clear", "integerFormat"),
    f("duplicate_count", "Paid twice", "integerFormat"),
    money("duplicate_amount", "Paid twice, amount"),
    f("overcharge_count", "Overcharges", "integerFormat"),
    money("overpaid", "Overpaid"),
    f("rows_skipped", "Rows skipped", "integerFormat"),
    f("rows_outside_window", "Rows outside the window", "integerFormat"),
  ],
  suggestions: [
    hidden("suggestion_id", "Suggestion ID"),
    hidden("kind", "Kind ID"),
    f("kind_label", "Kind", "textFormat"),
    f("target", "For", "textFormat", "The supplier or setting it is about."),
    f("title", "Suggestion", "textFormat"),
    f("detail", "Detail", "textFormat"),
    f("status", "Suggestion status", "textFormat", "proposed, applied or dismissed."),
    f("basis_count", "Based on calls", "integerFormat", "Marked calls the suggestion rests on."),
    f("proposed_unit", "Rate unit", "textFormat"),
    money("proposed_rate", "Proposed rate"),
    f("proposed_currency", "Rate currency", "textFormat"),
    f("proposed_valid_from", "Rate valid from", "dateFormat"),
    f("screen", "Where to make the change", "textFormat"),
    f("created_at", "Suggested", "dateTimeFormat"),
    f("decided_by", "Decided by", "textFormat"),
    f("decided_at", "Decided", "dateTimeFormat"),
  ],
} satisfies Record<keyof DashboardData, Spec[]>;

export type TableId = keyof typeof FIELDS;

/** "money_stopped.stopped": the id a widget or the report uses for a field. */
export const fieldId = (table: TableId, id: string) => `${table}.${id}`;

// --- Rows ---------------------------------------------------------------------------------------------------------

/**
 * What one flagged call stopped or held, in major units: the same split as money_stopped in
 * src/lib/onboarding/dashboard.ts (paid twice and other blocks in full, the overpaid part of an overcharge, holds in
 * full as held), so a sum by supplier agrees with the totals by reason.
 */
export function callMoney(category: string, amountMinor: number, overpaidMinor: number): { stopped: number; held: number } {
  if (category === "duplicate" || category === "blocked_other") return { stopped: amountMinor / 100, held: 0 };
  if (category === "overcharge") return { stopped: overpaidMinor / 100, held: 0 };
  if (category === "needs_a_look") return { stopped: 0, held: amountMinor / 100 };
  return { stopped: 0, held: 0 };
}

/** The rows each table holds: the backend's rows with money in major units and a few plain labels added. */
export function studioRows(data: DashboardData) {
  return {
    readiness_summary: data.readiness_summary.map((r) => ({
      ...r,
      level_label: LEVEL_LABEL[r.level] ?? r.level,
      next_level_label: r.next_level ? (LEVEL_LABEL[r.next_level] ?? r.next_level) : null,
    })),
    readiness: data.readiness.map((r) => ({ ...r })),
    money_stopped: data.money_stopped.map(({ stopped_minor, held_minor, confirmed_minor, fine_minor, ...r }) => ({
      ...r,
      stopped: toMajor(stopped_minor),
      held: toMajor(held_minor),
      confirmed: toMajor(confirmed_minor),
      fine: toMajor(fine_minor),
    })),
    weekly_false_holds: data.weekly_false_holds.map((r) => ({ ...r })),
    rule_hits: data.rule_hits.map((r) => ({ ...r })),
    calls: data.calls.map(({ amount_minor, overpaid_minor, ...r }) => ({
      ...r,
      amount: toMajor(amount_minor),
      overpaid: toMajor(overpaid_minor),
      ...callMoney(r.category, amount_minor, overpaid_minor),
      verdict_label: VERDICT_LABEL[r.verdict] ?? r.verdict,
      mark_label: r.mark ? (MARK_LABEL[r.mark] ?? r.mark) : "Not reviewed",
      reviewed: r.mark ? 1 : 0,
      was_fine: r.mark === "was_fine" ? 1 : 0,
      right_catch: r.mark === "right_catch" ? 1 : 0,
    })),
    imports: data.imports.map(({ total_minor, would_have_blocked_minor, duplicate_minor, overpaid_minor, ...r }) => ({
      ...r,
      total: toMajor(total_minor),
      would_have_blocked: toMajor(would_have_blocked_minor),
      duplicate_amount: toMajor(duplicate_minor),
      overpaid: toMajor(overpaid_minor),
    })),
    suggestions: data.suggestions.map(({ proposed_rate_minor, ...r }) => ({ ...r, proposed_rate: toMajor(proposed_rate_minor) })),
  };
}

// --- Descriptions (they feed Studio's agent) ----------------------------------------------------------------------

const DESCRIPTIONS: Record<TableId, { name: string; description: string }> = {
  readiness_summary: {
    name: "Readiness summary",
    description: "One row: the business's current level (Review, Assist or Autopilot), the next level, how many of the 4 readiness checks are met, whether the time gate (weeks in Assist) is met, and one plain sentence. Use it to answer 'am I ready?'.",
  },
  readiness: {
    name: "Readiness checks",
    description: "One row per readiness check for the next level, then the time gate (weeks in Assist). Each has a plain line saying where it stands and what is missing. Rows with counts_toward_gauge false are the time gate, not a check. The unmet rows answer 'why am I not ready yet?'.",
  },
  money_stopped: {
    name: "Money stopped",
    description: "Flagged payments by reason: what Checkrail stopped (would not have left) and what it held for a person, with the parts the owner confirmed right or marked fine. Held money is not stopped money: never add the two together.",
  },
  weekly_false_holds: {
    name: "Weekly holds that turned out fine",
    description: "One row per week (by payment date, no week skipped): holds, how many the owner reviewed, and the share that turned out fine (false_hold_rate) against the 10% target. A week with nothing reviewed has an empty rate. Lower is better.",
  },
  rule_hits: {
    name: "Rule hits",
    description: "One row per rule that fired on a flagged payment, most hits first, with how often the owner agreed. Low agreement on a rule means it holds good payments and may need a rate card, a booking feed or a verified supplier.",
  },
  calls: {
    name: "Flagged payments",
    description: "Every payment Checkrail flagged when re-checking the business's bank history, newest first: supplier (payee), amount, Checkrail's call, why, the rules that fired, and the owner's verdict. Sum was_fine by payee to find which supplier causes most holds that turned out fine.",
  },
  imports: {
    name: "Re-checks",
    description: "One row per bank export uploaded and re-checked: the period, payments, totals and what would have been blocked or held.",
  },
  suggestions: {
    name: "Suggestions",
    description: "Changes Checkrail proposes from the owner's marks (a rate card, a booking feed, verifying a supplier, a retainer), with status proposed, applied or dismissed. Only the owner can apply one, on the screen named.",
  },
};

/** Every table's AG Studio definition, with relationships, the payment-date calendar and three ratio measures. */
export function buildOnboardingStudioData(data: DashboardData, opts: { today?: string } = {}): AgDataSourcesDefinition {
  const currency = displayCurrency(data);
  const currencies = currenciesIn(data);
  const rows = studioRows(data);
  const dates = data.calls.map((c) => c.date).filter(Boolean).sort();
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  const relationships: AgRelationDefinition[] = [
    { id: "call-import", source: { tableId: "calls", fieldId: "import_id" }, target: { tableId: "imports", fieldId: "import_id" }, type: "many-to-one" },
    { id: "calls-date-calendar", source: { tableId: "calls", fieldId: "date" }, target: { calendarId: CALENDAR_ID } },
  ];

  return {
    description:
      "Checkrail checks every supplier payment before money moves. This is one business's first weeks with it: its bank history was re-checked, the owner marked Checkrail's calls right or fine, and readiness measures when Checkrail may do more on its own. " +
      `Money is shown in ${currency}` +
      (currencies.length > 1 ? `; rows are in ${currencies.join(", ")} and are never converted, so filter by currency before summing money.` : ".") +
      " Nothing here can change a rule or pay anyone.",
    sources: (Object.keys(FIELDS) as TableId[]).map((id) => ({
      id,
      name: DESCRIPTIONS[id].name,
      description: DESCRIPTIONS[id].description,
      data: rows[id] as Record<string, string | number | boolean | null>[],
      // Totals feed tiles and charts, so they are shortened; the payment list keeps every figure whole.
      fields: fields(FIELDS[id], currency, id === "money_stopped" || id === "imports"),
    })),
    relationships,
    calendars: [
      {
        id: CALENDAR_ID,
        label: "Payment calendar",
        range: { from: { type: "date", value: dates[0] ?? today }, to: { type: "date", value: dates.at(-1) ?? today } },
        fragments: ["year", "quarter", "month", "week", "day", "dayOfWeek"],
      },
    ],
    expressions: [
      ratio("false_hold_share", "Holds that turned out fine (share)", "Reviewed flagged payments the owner marked fine, out of all reviewed. Group by supplier to see who causes most.", "calls.was_fine", "calls.reviewed"),
      ratio("rule_agreement", "You agreed", "How often the owner agreed with a rule (marked its call a right catch), out of the calls reviewed.", "rule_hits.right_catch", "rule_hits.reviewed"),
      ratio("weekly_false_hold_share", "Weekly holds that turned out fine (share)", "Holds marked fine out of holds reviewed, across the weeks shown.", "weekly_false_holds.was_fine", "weekly_false_holds.reviewed"),
    ],
  };
}

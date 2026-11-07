import { describe, expect, it } from "vitest";
import { openTestDb } from "../db";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { CALLS_LIMIT, importCalls, moneyStopped, onboardingDashboard, ruleHits } from "./dashboard";
import { loadCalls } from "./calls";
import { BIZ, addImport, addRateCard, addVendor, setUpBusiness } from "./testkit";

/** The field names each data source promises (documented at the top of dashboard.ts). Changing one breaks AG Studio. */
const FIELDS = {
  readiness_summary: ["level", "next_level", "met", "total", "ready", "gate_weeks", "gate_target", "gate_met", "line"],
  readiness: ["criterion_id", "label", "line", "unit", "value", "target", "met", "counts_toward_gauge", "position"],
  money_stopped: ["category", "category_label", "currency", "calls", "stopped_minor", "held_minor", "confirmed_minor", "fine_minor", "unreviewed_calls"],
  weekly_false_holds: ["week_start", "week_label", "holds", "reviewed", "was_fine", "right_catch", "false_hold_rate", "target_rate", "under_target"],
  rule_hits: ["rule", "rule_label", "hits", "reviewed", "right_catch", "was_fine", "agreement_rate"],
  calls: ["call_id", "import_id", "file_row", "date", "week_start", "payee", "amount_minor", "currency", "reference", "category", "category_label", "verdict", "reason", "rules", "overpaid_minor", "duplicate_of_row", "mark", "note", "marked_by", "marked_at"],
  imports: ["import_id", "file_name", "status", "currency", "created_at", "created_by", "period_from", "period_to", "payments", "total_minor", "would_have_blocked_minor", "blocked_count", "held_count", "clear_count", "duplicate_count", "duplicate_minor", "overcharge_count", "overpaid_minor", "rows_skipped", "rows_outside_window"],
  suggestions: ["suggestion_id", "kind", "kind_label", "target", "title", "detail", "status", "basis_count", "proposed_unit", "proposed_rate_minor", "proposed_currency", "proposed_valid_from", "screen", "created_at", "decided_by", "decided_at"],
} as const;

describe("the dashboard data", async () => {
  const db = openTestDb();
  await seedDemo(db);
  const data = onboardingDashboard(db, DEMO_BUSINESS_ID);

  it("has exactly the documented data sources, each with exactly the documented fields", () => {
    expect(Object.keys(data).sort()).toEqual(Object.keys(FIELDS).sort());
    for (const [source, fields] of Object.entries(FIELDS)) {
      const rows = data[source as keyof typeof data] as object[];
      expect(rows.length, source).toBeGreaterThan(0);
      for (const r of rows) expect(Object.keys(r), source).toEqual([...fields]);
    }
  });

  it("is flat and JSON-safe: every value a string, number, boolean or null, and it survives a round trip", () => {
    for (const rows of Object.values(data)) for (const r of rows as Array<Record<string, unknown>>) for (const v of Object.values(r)) expect(v === null || ["string", "number", "boolean"].includes(typeof v)).toBe(true);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });

  it("never shows an em dash or the word obligation", () => {
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/\u2014/);
    expect(text).not.toMatch(/obligation/i);
  });

  it("lists calls newest first and readiness in display order with the gate last", () => {
    const dates = data.calls.map((c) => c.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(data.readiness.map((r) => r.position)).toEqual([1, 2, 3, 4, 5]);
    expect(data.readiness.map((r) => r.counts_toward_gauge)).toEqual([true, true, true, true, false]);
  });

  it("re-check totals per import add up", () => {
    for (const i of data.imports) expect(i.blocked_count + i.held_count + i.clear_count).toBe(i.payments);
  });
});

describe("the widgets' sums", () => {
  const db = openTestDb();
  setUpBusiness(db);
  addVendor(db, "ven_p", "Phuong Transport");
  addRateCard(db, "ven_p");
  const id = addImport(db, [
    { date: "2026-10-05", payee: "Phuong Transport", amount: 400, ref: "A" },
    { date: "2026-10-06", payee: "Phuong Transport", amount: 400, ref: "A", cat: "duplicate", rules: ["no_duplicate"], dupOf: 2, mark: "right_catch" },
    { date: "2026-10-07", payee: "Phuong Transport", amount: 500, cat: "overcharge", rules: ["amount_matches_evidence"], overpaid: 100, mark: "was_fine" },
    { date: "2026-10-08", payee: "Phuong Transport", amount: 300, cat: "needs_a_look", rules: ["evidence_present", "amount_sane"] },
    { date: "2026-10-09", payee: "Phuong Transport", amount: 200, cat: "blocked_other", rules: ["reference_other_vendor"], mark: "right_catch" },
  ]);
  const calls = loadCalls(db, BIZ);

  it("money stopped: duplicates and other blocks in full, overcharges' overpaid part, holds as held", () => {
    expect(moneyStopped(calls).map((r) => [r.category, r.calls, r.stopped_minor, r.held_minor, r.confirmed_minor, r.fine_minor, r.unreviewed_calls])).toEqual([
      ["duplicate", 1, 400, 0, 400, 0, 0],
      ["overcharge", 1, 100, 0, 0, 100, 0],
      ["blocked_other", 1, 200, 0, 200, 0, 0],
      ["needs_a_look", 1, 0, 300, 0, 0, 1],
    ]);
  });

  it("rule hits with agreement: right catches over reviewed, null when none reviewed", () => {
    const by = Object.fromEntries(ruleHits(calls).map((r) => [r.rule, r]));
    expect(by.no_duplicate).toMatchObject({ hits: 1, reviewed: 1, right_catch: 1, agreement_rate: 1, rule_label: "Already paid" });
    expect(by.amount_matches_evidence).toMatchObject({ hits: 1, reviewed: 1, was_fine: 1, agreement_rate: 0 });
    expect(by.evidence_present).toMatchObject({ hits: 1, reviewed: 0, agreement_rate: null });
  });

  it("an import's calls are its flagged rows in file order", () => {
    expect(importCalls(db, BIZ, id).map((c) => c.file_row)).toEqual([3, 4, 5, 6]);
    expect(importCalls(db, "biz_other", id)).toEqual([]);
  });

  it("caps the calls table", () => {
    expect(CALLS_LIMIT).toBe(500);
  });

  it("refuses an unknown business", () => {
    expect(() => onboardingDashboard(db, "biz_nope")).toThrow(/No such business/);
  });
});

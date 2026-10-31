import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb } from "../db";
import { auditEntries, obligations, onboardingImports, onboardingSuggestions, paymentAttempts, rateCards } from "../db/schema";
import { DEMO_BUSINESS_ID, resetDemo, seedDemo } from "../demo/seed";
import { resolveActor } from "../engine/users";
import { applySuggestion } from "./calibration";
import { onboardingDashboard } from "./dashboard";
import { readiness } from "./readiness";
import { ONBOARDING_SEED } from "./seed";

describe("the demo's onboarding data", async () => {
  const db = openTestDb();
  await seedDemo(db);
  const data = onboardingDashboard(db, DEMO_BUSINESS_ID);

  it("has imports, calls, marks and suggestions, so no widget is empty", () => {
    expect(data.imports).toHaveLength(ONBOARDING_SEED.imports);
    expect(data.imports.reduce((n, i) => n + i.payments, 0)).toBe(ONBOARDING_SEED.payments);
    expect(data.calls).toHaveLength(ONBOARDING_SEED.flagged);
    expect(data.calls.filter((c) => c.mark)).toHaveLength(ONBOARDING_SEED.marked);
    for (const k of ["readiness", "money_stopped", "weekly_false_holds", "rule_hits", "calls", "imports", "suggestions"] as const) expect(data[k].length).toBeGreaterThan(0);
    expect(data.suggestions.filter((s) => s.status === "proposed").map((s) => s.title).sort()).toEqual(["Add a rate card for Dao Mountain Lodge", "Add a rate card for Tam Motorbike Rental"]);
    expect(data.suggestions.filter((s) => s.status === "applied").map((s) => s.kind)).toEqual(["booking_feed"]);
  });

  it("reads 3 of 4 for the next level: rate-card coverage is the one missing", () => {
    expect(data.readiness_summary[0]).toMatchObject({ met: ONBOARDING_SEED.readinessMet, total: ONBOARDING_SEED.readinessTotal, ready: false, level: "assist", next_level: "autopilot" });
    const by = Object.fromEntries(data.readiness.map((r) => [r.criterion_id, r]));
    expect(by.false_holds).toMatchObject({ met: true, value: 2 });
    expect(by.suppliers_verified.met).toBe(true);
    expect(by.no_missed_duplicate).toMatchObject({ met: true, value: 0 });
    expect(by.rate_card_coverage.met).toBe(false);
    expect(by.rate_card_coverage.value).toBeGreaterThan(0.45);
    expect(by.rate_card_coverage.value).toBeLessThan(0.55);
    expect(by.weeks_in_assist.counts_toward_gauge).toBe(false);
  });

  it("shows the false-hold rate falling to zero for the last two weeks", () => {
    const marked = data.weekly_false_holds.filter((w) => w.reviewed > 0).map((w) => w.false_hold_rate);
    expect(marked).toEqual([0.75, 0.5, 0.25, 0.2, 0, 0]);
    expect(data.weekly_false_holds).toHaveLength(12);
  });

  it("applying the proposed Dao rate card lifts coverage past 80% and the gauge to 4 of 4", () => {
    const copy = openTestDb();
    return seedDemo(copy).then(() => {
      const dao = copy.select().from(onboardingSuggestions).all().find((s) => s.title.includes("Dao"))!;
      applySuggestion(copy, DEMO_BUSINESS_ID, resolveActor(copy, DEMO_BUSINESS_ID, "minh", "approver"), dao.id);
      expect(copy.select().from(rateCards).where(eq(rateCards.vendorId, "ven_dao")).all()).toHaveLength(1);
      const r = readiness(copy, DEMO_BUSINESS_ID);
      expect(r.criteria.find((c) => c.id === "rate_card_coverage")!.met).toBe(true);
      expect(r.met).toBe(4);
      // Every hour of the week the seed ran in: the Assist gate holds, so 4 of 4 always means ready.
      const monday = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) - ((new Date().getUTCDay() + 6) % 7) * 86_400_000;
      for (let h = 0; h < 7 * 24; h += 1) {
        const at = readiness(copy, DEMO_BUSINESS_ID, { now: new Date(monday + h * 3600_000 + 60_000) });
        expect(at.gate?.met).toBe(true);
        expect(at.ready).toBe(true);
      }
    });
  });

  it("logs the applied suggestion and each import in the audit log, and creates no payment", () => {
    const actions = db.select().from(auditEntries).all().map((a) => a.action);
    expect(actions.filter((a) => a === "onboarding.import_checked")).toHaveLength(ONBOARDING_SEED.imports);
    expect(actions.filter((a) => a === "onboarding.suggestion_applied")).toHaveLength(1);
    const before = { obligations: db.select().from(obligations).all().length, attempts: db.select().from(paymentAttempts).all().length };
    onboardingDashboard(db, DEMO_BUSINESS_ID);
    expect({ obligations: db.select().from(obligations).all().length, attempts: db.select().from(paymentAttempts).all().length }).toEqual(before);
  });

  it("is wiped by the demo reset", () => {
    const copy = openTestDb();
    return seedDemo(copy).then(() => {
      resetDemo(copy);
      expect(copy.select().from(onboardingImports).all()).toEqual([]);
      expect(copy.select().from(onboardingSuggestions).all()).toEqual([]);
    });
  });
});

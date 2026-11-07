import { describe, expect, it } from "vitest";
import { openTestDb } from "../db";
import { obligations } from "../db/schema";
import { audit } from "../domain/stateMachine";
import { weekStart } from "./calls";
import type { Line } from "./testkit";
import { BIZ, addImport, addRateCard, addVendor, setUpBusiness } from "./testkit";
import { ASSIST_WEEKS_FOR_AUTOPILOT, FALSE_HOLD_TARGET, FALSE_HOLD_WEEKS, MIN_REVIEWED_PER_WEEK, MISSED_DUPLICATE_DAYS, RATE_CARD_COVERAGE_TARGET, consecutiveWeeksUnder, missedDuplicates, readiness, weeklyFalseHolds } from "./readiness";
import { loadCalls } from "./calls";

const HOLD = { cat: "needs_a_look" as const, rules: ["evidence_present"] };
/** A week of holds on the Monday given: `fine` marked was fine, `right` marked right catch, `open` not marked. */
const week = (monday: string, fine: number, right: number, open = 0, payee = "Phuong Transport"): Line[] => [
  ...Array.from({ length: fine }, (): Line => ({ date: monday, payee, ...HOLD, mark: "was_fine" })),
  ...Array.from({ length: right }, (): Line => ({ date: monday, payee, ...HOLD, mark: "right_catch" })),
  ...Array.from({ length: open }, (): Line => ({ date: monday, payee, ...HOLD })),
];

function base(policy = {}, createdAt?: string) {
  const db = openTestDb();
  const people = setUpBusiness(db, policy, createdAt);
  addVendor(db, "ven_phuong", "Phuong Transport");
  addRateCard(db, "ven_phuong");
  return { db, people };
}

const crit = (db: ReturnType<typeof openTestDb>, id: string, now = new Date("2026-10-31T12:00:00Z")) => readiness(db, BIZ, { now }).criteria.find((c) => c.id === id)!;

describe("the thresholds", () => {
  it("are the ones the owner is asked to confirm", () => {
    expect([FALSE_HOLD_TARGET, FALSE_HOLD_WEEKS, MIN_REVIEWED_PER_WEEK, RATE_CARD_COVERAGE_TARGET, ASSIST_WEEKS_FOR_AUTOPILOT, MISSED_DUPLICATE_DAYS]).toEqual([0.1, 2, 3, 0.8, 4, 3]);
  });
});

describe("with no history at all", () => {
  it("meets nothing and says what to do first", () => {
    const db = openTestDb();
    setUpBusiness(db, { autonomy: "review" });
    const r = readiness(db, BIZ);
    expect(r).toMatchObject({ level: "review", nextLevel: "assist", met: 0, total: 4, ready: false, gate: null });
    expect(r.criteria.map((c) => c.id)).toEqual(["false_holds", "suppliers_verified", "no_missed_duplicate", "rate_card_coverage"]);
    expect(r.criteria.every((c) => c.line.length > 10 && !/\u2014/.test(c.line))).toBe(true);
  });
});

describe("holds that turned out fine", () => {
  it("needs two weeks in a row under 10%: one is not enough", () => {
    const { db } = base();
    addImport(db, [...week("2026-10-12", 2, 2), ...week("2026-10-19", 0, 4)]);
    expect(crit(db, "false_holds")).toMatchObject({ met: false, value: 1, target: 2 });
    addImport(db, week("2026-10-26", 0, 3));
    expect(crit(db, "false_holds")).toMatchObject({ met: true, value: 2 });
  });

  it("exactly 10% is not under 10%", () => {
    const { db } = base();
    addImport(db, [...week("2026-10-19", 1, 9), ...week("2026-10-26", 0, 3)]);
    const weeks = weeklyFalseHolds(loadCalls(db, BIZ));
    expect(weeks.map((w) => [w.falseHoldRate, w.underTarget])).toEqual([[0.1, false], [0, true]]);
    expect(crit(db, "false_holds").met).toBe(false);
  });

  it("a week with fewer than 3 reviewed holds does not count, and one at the end (still being reviewed) is skipped", () => {
    const { db } = base();
    addImport(db, [...week("2026-10-12", 0, 3), ...week("2026-10-19", 0, 3), ...week("2026-10-26", 0, 2, 5)]);
    const weeks = weeklyFalseHolds(loadCalls(db, BIZ));
    expect(weeks.map((w) => w.reviewed)).toEqual([3, 3, 2]);
    expect(consecutiveWeeksUnder(weeks)).toMatchObject({ run: 2, latest: { weekStart: "2026-10-19" } });
    expect(crit(db, "false_holds").met).toBe(true);
  });

  it("a week in the middle that was barely reviewed breaks the run", () => {
    const { db } = base();
    addImport(db, [...week("2026-10-05", 0, 3), ...week("2026-10-12", 0, 1), ...week("2026-10-19", 0, 3)]);
    expect(crit(db, "false_holds").value).toBe(1);
  });

  it("weeks with no calls at all appear, empty, so the chart has no gaps", () => {
    const { db } = base();
    addImport(db, [...week("2026-09-28", 1, 2), ...week("2026-10-19", 0, 3)]);
    expect(weeklyFalseHolds(loadCalls(db, BIZ)).map((w) => [w.weekStart, w.holds])).toEqual([["2026-09-28", 3], ["2026-10-05", 0], ["2026-10-12", 0], ["2026-10-19", 3]]);
    expect(weekStart("2026-10-25")).toBe("2026-10-19");
  });
});

describe("every paid supplier verified", () => {
  it("is met when every supplier in the history and every one paid through Checkrail is verified", () => {
    const { db } = base();
    addImport(db, [{ date: "2026-10-05", payee: "PHUONG  TRANSPORT" }]);
    expect(crit(db, "suppliers_verified")).toMatchObject({ met: true, value: 1, target: 1 });
  });

  it("is not met for a payee who is not on the supplier list", () => {
    const { db } = base();
    addImport(db, [{ date: "2026-10-05", payee: "Phuong Transport" }, { date: "2026-10-06", payee: "Hoa Mai Guesthouse" }]);
    const c = crit(db, "suppliers_verified");
    expect(c).toMatchObject({ met: false, value: 1, target: 2 });
    expect(c.line).toMatch(/1 of 2 suppliers you pay is not verified: Hoa Mai Guesthouse/);
  });

  it("is not met for an unverified or blocked supplier, including one only paid through Checkrail", () => {
    const { db } = base();
    addImport(db, [{ date: "2026-10-05", payee: "Phuong Transport" }]);
    addVendor(db, "ven_lan", "Lan Boats", { verified: false });
    db.insert(obligations).values({ id: "obl_x", businessId: BIZ, vendorId: "ven_lan", state: "settled", sourceType: "invoice", rawInput: "x", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }).run();
    expect(crit(db, "suppliers_verified").met).toBe(false);
    const db2 = base().db;
    addVendor(db2, "ven_blk", "Blocked Co", { status: "blocked" });
    addImport(db2, [{ date: "2026-10-05", payee: "Blocked Co" }]);
    expect(crit(db2, "suppliers_verified").met).toBe(false);
  });
});

describe("no missed duplicate", () => {
  it("finds a repeat the rules let through: same supplier, amount and reference", () => {
    const { db } = base();
    addImport(db, [{ date: "2026-10-05", payee: "Phuong Transport", ref: "INV-1" }, { date: "2026-10-20", payee: "Phuong Transport", ref: "inv-1" }]);
    expect(crit(db, "no_missed_duplicate")).toMatchObject({ met: false, value: 1, target: 0 });
    expect(missedDuplicates(loadCalls(db, BIZ))[0].earlier.date).toBe("2026-10-05");
  });

  it("without references, counts a repeat within 3 days, not 4", () => {
    const near = base().db;
    addImport(near, [{ date: "2026-10-05", payee: "Phuong Transport", ref: null }, { date: "2026-10-08", payee: "Phuong Transport", ref: null }]);
    expect(crit(near, "no_missed_duplicate").value).toBe(1);
    const far = base().db;
    addImport(far, [{ date: "2026-10-05", payee: "Phuong Transport", ref: null }, { date: "2026-10-09", payee: "Phuong Transport", ref: null }]);
    expect(crit(far, "no_missed_duplicate")).toMatchObject({ met: true, value: 0 });
  });

  it("does not count a repeat the rules caught, or different amounts or references", () => {
    const { db } = base();
    addImport(db, [
      { date: "2026-10-05", payee: "Phuong Transport", ref: "INV-1" },
      { date: "2026-10-06", payee: "Phuong Transport", ref: "INV-1", cat: "duplicate", rules: ["no_duplicate"], dupOf: 2 },
      { date: "2026-10-06", payee: "Phuong Transport", ref: "INV-2" },
      { date: "2026-10-06", payee: "Phuong Transport", ref: "INV-1", amount: 5 },
    ]);
    expect(crit(db, "no_missed_duplicate").met).toBe(true);
  });

  it("counts the same payment uploaded twice once", () => {
    const { db } = base();
    const lines: Line[] = [{ date: "2026-10-05", payee: "Phuong Transport", ref: "INV-1" }];
    addImport(db, lines, "2026-10-10T00:00:00Z");
    addImport(db, lines, "2026-10-11T00:00:00Z");
    expect(loadCalls(db, BIZ)).toHaveLength(1);
    expect(crit(db, "no_missed_duplicate").met).toBe(true);
  });
});

describe("rate-card coverage", () => {
  it("80% exactly is met; just under is not", () => {
    const { db } = base();
    addVendor(db, "ven_dao", "Dao Mountain Lodge");
    addImport(db, [{ date: "2026-10-05", payee: "Phuong Transport", amount: 800_000_000 }, { date: "2026-10-06", payee: "Dao Mountain Lodge", amount: 200_000_000 }]);
    expect(crit(db, "rate_card_coverage")).toMatchObject({ met: true, value: 0.8, target: 0.8 });
    const under = base().db;
    addVendor(under, "ven_dao", "Dao Mountain Lodge");
    addImport(under, [{ date: "2026-10-05", payee: "Phuong Transport", amount: 799_000_000 }, { date: "2026-10-06", payee: "Dao Mountain Lodge", amount: 201_000_000 }]);
    const c = crit(under, "rate_card_coverage");
    expect(c.met).toBe(false);
    expect(c.line).toMatch(/The biggest gap: Dao Mountain Lodge/);
  });
});

describe("the level and the time gate", () => {
  it("from Review, the next level is Assist and there is no time gate", () => {
    const { db } = base({ autonomy: "review" });
    expect(readiness(db, BIZ)).toMatchObject({ level: "review", nextLevel: "assist", gate: null });
  });

  it("from Assist, Autopilot waits 4 weeks counted from the change to Assist in the audit log", () => {
    const { db } = base({ autonomy: "assist" });
    audit(db, { obligationId: null, actor: "user:daniel", action: "autonomy.changed", detail: { from: { autonomy: "review" }, to: { autonomy: "assist" } } });
    const changedAt = Date.now();
    const at = (days: number) => readiness(db, BIZ, { now: new Date(changedAt + days * 86_400_000) }).gate!;
    expect(at(27)).toMatchObject({ id: "weeks_in_assist", value: 3, target: 4, met: false });
    expect(at(28.1)).toMatchObject({ value: 4, met: true });
  });

  it("without a recorded change, counts from the first import or the business's start, whichever is earlier", () => {
    const { db } = base({ autonomy: "assist" });
    addImport(db, [{ date: "2026-07-01", payee: "Phuong Transport" }], "2026-07-02T00:00:00.000Z");
    expect(readiness(db, BIZ, { now: new Date("2026-07-31T00:00:00Z") }).gate!.value).toBe(4);
  });

  it("is ready only when all four criteria and the gate are met; the gate is never counted in the four", () => {
    const { db } = base({ autonomy: "assist" }, "2026-09-01T00:00:00.000Z");
    addImport(db, [...week("2026-10-19", 0, 3), ...week("2026-10-26", 0, 3)], "2026-09-01T00:00:00.000Z");
    const early = readiness(db, BIZ, { now: new Date("2026-09-20T00:00:00Z") });
    expect(early).toMatchObject({ met: 4, total: 4, ready: false });
    expect(early.gate!.met).toBe(false);
    expect(early.line).toMatch(/^4 of 4 checks met for Autopilot, and 2 of 4 weeks in Assist/);
    const later = readiness(db, BIZ, { now: new Date("2026-11-01T00:00:00Z") });
    expect(later).toMatchObject({ met: 4, ready: true });
    expect(later.line).toMatch(/^Ready to move from Assist to Autopilot/);
  });

  it("on Autopilot there is no next level and it is never 'ready'", () => {
    const { db } = base({ autonomy: "autopilot" });
    expect(readiness(db, BIZ)).toMatchObject({ level: "autopilot", nextLevel: null, ready: false, gate: null });
  });
});

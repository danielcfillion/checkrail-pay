import { describe, expect, it } from "vitest";
import { falseHoldCaption, falseHoldPoints, percent, plot, shortWeek, targetOf, underTargetStreak, yMax, type FalseHoldWeek } from "./falseHolds";

const week = (start: string, reviewed: number, rate: number | null, under = false): FalseHoldWeek => ({ week_start: start, week_label: `Week of ${start.slice(8)} Oct`, reviewed, false_hold_rate: rate, target_rate: 0.1, under_target: under });

const ROWS = [week("2026-09-28", 0, null), week("2026-10-05", 5, 0.2), week("2026-10-12", 3, 0, true), week("2026-10-19", 3, 0, true)];

describe("holds that turned out fine", () => {
  it("plots only weeks someone reviewed, oldest first, at most eight", () => {
    const pts = falseHoldPoints([...ROWS].reverse());
    expect(pts.map((p) => p.week_start)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    const many = Array.from({ length: 12 }, (_, i) => week(`2026-${String(1 + i).padStart(2, "0")}-01`, 1, 0.5));
    expect(falseHoldPoints(many)).toHaveLength(8);
    expect(falseHoldPoints(many)[0].week_start).toBe("2026-05-01");
  });

  it("counts the weeks in a row under target, from the latest back", () => {
    expect(underTargetStreak(ROWS)).toBe(2);
    expect(underTargetStreak([week("2026-10-05", 3, 0, true), week("2026-10-12", 3, 0.5)])).toBe(0);
    expect(underTargetStreak([])).toBe(0);
    // Counted like readiness: a thin trailing week is skipped, and a week between runs that nobody reviewed ends the run.
    expect(underTargetStreak([week("2026-10-05", 3, 0, true), week("2026-10-12", 3, 0, true), week("2026-10-19", 2, 0, true)])).toBe(2);
    expect(underTargetStreak([week("2026-10-05", 3, 0, true), week("2026-10-12", 1, null), week("2026-10-19", 3, 0, true)])).toBe(1);
  });

  it("says it plainly", () => {
    expect(falseHoldCaption(ROWS, 0.1)).toBe("Under the 10% target for 2 weeks in a row.");
    expect(falseHoldCaption(ROWS.slice(0, 3), 0.1)).toBe("Under the 10% target last week. Autopilot needs 2 weeks in a row.");
    expect(falseHoldCaption(ROWS.slice(0, 2), 0.1)).toMatch(/^Not under the 10% target last week/);
    expect(falseHoldCaption([], 0.1)).toMatch(/^Mark a few held payments/);
    for (const c of [falseHoldCaption([], 0.1), falseHoldCaption(ROWS, 0.1)]) expect(c).not.toMatch(/\u2014/);
  });
  it("uses the same weekly review minimum as the readiness check", async () => {
    const { MIN_REVIEWED_PER_WEEK: readinessMin } = await import("../onboarding/readiness");
    const { MIN_REVIEWED_PER_WEEK } = await import("./falseHolds");
    expect(MIN_REVIEWED_PER_WEEK).toBe(readinessMin);
  });

  it("scales the axis to leave room above the highest point and the target", () => {
    expect(yMax(falseHoldPoints(ROWS), 0.1)).toBe(0.3);
    expect(yMax([], 0.1)).toBe(0.3);
    expect(yMax(falseHoldPoints([week("2026-10-05", 4, 0.75)]), 0.1)).toBe(0.8);
    expect(yMax(falseHoldPoints([week("2026-10-05", 4, 1)]), 0.1)).toBe(1);
  });

  it("puts the target line between the axis ends and the points inside the box", () => {
    const box = { width: 300, height: 160, left: 30, right: 10, top: 10, bottom: 20 };
    const p = plot(falseHoldPoints(ROWS), 0.1, box);
    expect(p.targetY).toBeGreaterThan(box.top);
    expect(p.targetY).toBeLessThan(box.height - box.bottom);
    expect(p.points[0].x).toBe(30);
    expect(p.points.at(-1)!.x).toBe(290);
    expect(p.points.at(-1)!.y).toBe(140);
    expect(p.path.startsWith("M 30 ")).toBe(true);
    expect(p.ticks.map((t) => t.value)).toEqual([0, 0.15, 0.3]);
  });

  it("formats weeks and shares the way the rest of the app does", () => {
    expect(shortWeek("Week of 12 Oct")).toBe("12 Oct");
    expect(percent(0.062)).toBe("6%");
    expect(targetOf(ROWS)).toBe(0.1);
    expect(targetOf([])).toBe(0.1);
  });
});

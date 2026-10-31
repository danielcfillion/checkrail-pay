import { describe, expect, it } from "vitest";
import { GAUGE_START, GAUGE_SWEEP, arcLength, arcPath, dashOffset, easeOutCubic, gaugeFraction, notchAngles, polar, tween } from "./gauge";

describe("the readiness gauge's maths", () => {
  it("reads criteria met as a share of the total, clamped, and never NaN", () => {
    expect(gaugeFraction(3, 4)).toBe(0.75);
    expect(gaugeFraction(4, 4)).toBe(1);
    expect(gaugeFraction(0, 4)).toBe(0);
    expect(gaugeFraction(5, 4)).toBe(1);
    expect(gaugeFraction(-1, 4)).toBe(0);
    expect(gaugeFraction(0, 0)).toBe(0);
    expect(gaugeFraction(Number.NaN, 4)).toBe(0);
  });

  it("puts 0 degrees at 12 o'clock and runs clockwise", () => {
    expect(polar(50, 50, 10, 0)).toEqual({ x: 50, y: 40 });
    expect(polar(50, 50, 10, 90)).toEqual({ x: 60, y: 50 });
    expect(polar(50, 50, 10, 180)).toEqual({ x: 50, y: 60 });
  });

  it("draws a 240 degree arc, symmetric about the top, with the large-arc flag set", () => {
    expect(GAUGE_START).toBe(-120);
    const d = arcPath(80, 80, 60, GAUGE_START, GAUGE_START + GAUGE_SWEEP);
    const [, x1, y1, , , , , large, sweep, x2, y2] = d.split(" ");
    expect(Number(x1) + Number(x2)).toBeCloseTo(160, 3);
    expect(y1).toBe(y2);
    expect([large, sweep]).toEqual(["1", "1"]);
    expect(arcPath(80, 80, 60, 0, 90).split(" ")[7]).toBe("0");
  });

  it("shows exactly the met share of the arc through the dash offset", () => {
    const len = arcLength(60, 240);
    expect(len).toBeCloseTo((2 * Math.PI * 60 * 2) / 3, 6);
    expect(dashOffset(len, 0)).toBeCloseTo(len, 2);
    expect(dashOffset(len, 1)).toBe(0);
    expect(dashOffset(len, 0.75)).toBeCloseTo(len / 4, 2);
    expect(dashOffset(len, 2)).toBe(0);
  });

  it("notches the arc between criteria: three notches for four checks, none for one", () => {
    expect(notchAngles(4)).toEqual([-60, 0, 60]);
    expect(notchAngles(2)).toEqual([0]);
    expect(notchAngles(1)).toEqual([]);
    expect(notchAngles(0)).toEqual([]);
  });

  it("fills on an ease-out curve that starts at the old value and lands exactly on the new one", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(tween(0, 0.75, 0)).toBe(0);
    expect(tween(0, 0.75, 600)).toBe(0.75);
    expect(tween(0, 0.75, 10_000)).toBe(0.75);
    expect(tween(0.5, 0.25, 300)).toBeLessThan(0.5);
    expect(tween(0, 1, 100, 0)).toBe(1);
  });
});

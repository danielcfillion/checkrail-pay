/**
 * Geometry and timing for the readiness gauge (a 240 degree arc with a gap at the bottom). Pure, so it is tested in
 * node. Angles are degrees clockwise from 12 o'clock.
 */

export const GAUGE_SWEEP = 240;
export const GAUGE_START = -GAUGE_SWEEP / 2;
/** How long the arc takes to fill, and the curve it fills on. */
export const GAUGE_DURATION_MS = 600;

/** Criteria met as a share of the total, clamped to 0..1. No criteria reads as 0, never NaN. */
export function gaugeFraction(met: number, total: number): number {
  if (!Number.isFinite(met) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, met / total));
}

/** A point on the circle at `angle` degrees clockwise from 12 o'clock. */
export function polar(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { x: round(cx + r * Math.cos(rad)), y: round(cy + r * Math.sin(rad)) };
}

/** SVG path for an arc from `start` to `end` degrees (clockwise). */
export function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const a = polar(cx, cy, r, start);
  const b = polar(cx, cy, r, end);
  const large = Math.abs(end - start) > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`;
}

/** Length of an arc of `sweep` degrees. */
export const arcLength = (r: number, sweep: number) => (2 * Math.PI * r * sweep) / 360;

/** stroke-dashoffset that shows `fraction` of an arc of `length`. */
export const dashOffset = (length: number, fraction: number) => round(length * (1 - Math.min(1, Math.max(0, fraction))));

/** Angles of the notches between criteria: one fewer than the total, evenly spaced along the sweep. */
export function notchAngles(total: number, start = GAUGE_START, sweep = GAUGE_SWEEP): number[] {
  if (!Number.isFinite(total) || total < 2) return [];
  const n = Math.floor(total);
  return Array.from({ length: n - 1 }, (_, i) => round(start + (sweep * (i + 1)) / n));
}

/** Ease-out cubic: fast start, gentle landing. */
export const easeOutCubic = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** The fraction to draw `elapsed` ms into an animation from `from` to `to`. */
export function tween(from: number, to: number, elapsed: number, duration = GAUGE_DURATION_MS): number {
  if (duration <= 0 || elapsed >= duration) return to;
  return from + (to - from) * easeOutCubic(elapsed / duration);
}

function round(x: number) {
  return Math.round(x * 1000) / 1000;
}

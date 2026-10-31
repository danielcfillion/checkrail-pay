/**
 * The model behind "Holds that turned out fine": which weeks to plot, the scale, and the plain caption. Pure, so it
 * is tested in node. Rows are weekly_false_holds from onboardingDashboard(); a week nobody reviewed has a null rate
 * and is not plotted (an empty week is not a 0% week).
 */

export interface FalseHoldWeek {
  week_start: string;
  week_label: string;
  reviewed: number;
  false_hold_rate: number | null;
  target_rate: number;
  under_target: boolean;
}

export interface FalseHoldPoint {
  week_start: string;
  label: string;
  rate: number;
  under: boolean;
}

export const DEFAULT_TARGET = 0.1;
/** At most this many weeks are drawn: the latest ones. */
export const MAX_WEEKS = 8;

/** "Week of 12 Oct" -> "12 Oct". */
export const shortWeek = (label: string) => label.replace(/^Week of\s+/i, "");

/** "6%" for 0.06; whole percentages, since a week rarely has more than a dozen holds. */
export const percent = (rate: number) => `${Math.round(rate * 100)}%`;

export function falseHoldPoints(rows: FalseHoldWeek[], max = MAX_WEEKS): FalseHoldPoint[] {
  return [...rows]
    .sort((a, b) => a.week_start.localeCompare(b.week_start))
    .filter((r) => r.reviewed > 0 && r.false_hold_rate !== null && Number.isFinite(r.false_hold_rate))
    .slice(-max)
    .map((r) => ({ week_start: r.week_start, label: shortWeek(r.week_label), rate: r.false_hold_rate as number, under: r.under_target }));
}

/** The target the rows carry (they all carry the same one), or 10%. */
export const targetOf = (rows: FalseHoldWeek[]) => rows.find((r) => Number.isFinite(r.target_rate))?.target_rate ?? DEFAULT_TARGET;

/** A week counts once this many holds in it were reviewed. Same as MIN_REVIEWED_PER_WEEK in lib/onboarding/readiness.ts. */
export const MIN_REVIEWED_PER_WEEK = 3;

/**
 * Weeks in a row under target, counted exactly as the readiness check counts them (consecutiveWeeksUnder): trailing
 * weeks not yet reviewed enough are skipped, then the run counts back until a week that is not under target, so the
 * chart's caption and the gauge never disagree.
 */
export function underTargetStreak(rows: FalseHoldWeek[]): number {
  const weeks = [...rows].sort((a, b) => a.week_start.localeCompare(b.week_start));
  let i = weeks.length - 1;
  while (i >= 0 && weeks[i].reviewed < MIN_REVIEWED_PER_WEEK) i--;
  let n = 0;
  while (i >= 0 && weeks[i].under_target) {
    n++;
    i--;
  }
  return n;
}

/** Top of the y axis: room above the highest point and the target, on a 10% step. */
export function yMax(points: FalseHoldPoint[], target: number): number {
  const top = Math.max(target * 2, ...points.map((p) => p.rate));
  return Math.min(1, Math.ceil((top + 0.0001) * 10) / 10);
}

/** One plain sentence under the chart. */
export function falseHoldCaption(rows: FalseHoldWeek[], target: number): string {
  const t = percent(target);
  if (!rows.some((r) => r.reviewed >= MIN_REVIEWED_PER_WEEK)) return `Mark a few held payments to see how often a hold turns out fine. The target is under ${t}.`;
  const streak = underTargetStreak(rows);
  if (streak >= 2) return `Under the ${t} target for ${streak} weeks in a row.`;
  if (streak === 1) return `Under the ${t} target last week. Autopilot needs 2 weeks in a row.`;
  return `Not under the ${t} target last week: some holds were good payments, or too few were reviewed.`;
}

/** Plot coordinates for a chart of `width` x `height` with the given insets. */
export function plot(points: FalseHoldPoint[], target: number, box: { width: number; height: number; left: number; right: number; top: number; bottom: number }) {
  const top = yMax(points, target);
  const w = Math.max(1, box.width - box.left - box.right);
  const h = Math.max(1, box.height - box.top - box.bottom);
  const x = (i: number) => box.left + (points.length <= 1 ? w / 2 : (w * i) / (points.length - 1));
  const y = (rate: number) => box.top + h * (1 - Math.min(1, Math.max(0, rate / top)));
  const xy = points.map((p, i) => ({ ...p, x: round(x(i)), y: round(y(p.rate)) }));
  const path = xy.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  return { top, points: xy, path, targetY: round(y(target)), ticks: [0, top / 2, top].map((v) => ({ value: v, y: round(y(v)) })) };
}

function round(x: number) {
  return Math.round(x * 100) / 100;
}

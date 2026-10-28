/** Pure helpers for the Money out chart: binning, density, axis. Usable from server, client and tests. */
import type { PaymentPoint } from "@/lib/queries";

export type Range = 7 | 30 | 90;
/** Bin width in days. */
export type Step = 1 | 7 | 14;
export type Bucket = { key: string; label: string; long: string; start: number; end: number; paypal: number; stellar: number; bank: number; fee: number; items: PaymentPoint[] };

export const railKey = (rail: string): "paypal" | "stellar" | "bank" => (rail === "paypal" ? "paypal" : rail === "stellar" ? "stellar" : "bank");
export const sumRails = (b: { paypal: number; stellar: number; bank: number }) => b.paypal + b.stellar + b.bank;
export const DAY = 86_400_000;
export const H = 220;
export const PAD = { top: 12, right: 8, bottom: 26, left: 52 };
export const PAD_PHONE = { top: 12, right: 4, bottom: 26, left: 40 };
/** Smallest comfortable touch width for one column. */
export const HIT = 44;

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export const fmtDay = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Whole days in the range that saw at least one payment, as a share of the range. */
export function paymentDensity(points: PaymentPoint[], range: Range, now: number): number {
  const from = startOfDay(now) - (range - 1) * DAY;
  const days = new Set<number>();
  for (const p of points) {
    const t = new Date(p.settledAt).getTime();
    if (t >= from && t < startOfDay(now) + DAY) days.add(startOfDay(t));
  }
  return days.size / range;
}

/**
 * Daily columns, or weekly ones when the days are sparse (under 30% of days in the range have a payment), when the
 * range is 90 days, or when a column would be narrower than a thumb (`innerWidth` / columns < 44px). A 7-day range
 * always stays daily; weeks widen to fortnights only when weekly columns would still be too narrow.
 */
export function chooseStep(points: PaymentPoint[], range: Range, now: number, innerWidth = Infinity): Step {
  if (range === 7) return 1;
  const fits = (step: number) => innerWidth / Math.ceil(range / step) >= HIT;
  if (range === 30 && paymentDensity(points, range, now) >= 0.3 && fits(1)) return 1;
  return fits(7) ? 7 : 14;
}

export function buckets(points: PaymentPoint[], range: Range, now: number, step: Step = range === 90 ? 7 : 1): Bucket[] {
  const count = Math.ceil(range / step);
  const lastStart = startOfDay(now) - (step - 1) * DAY;
  // The first week is clipped to the range, so "last 30 days" never counts 35.
  const rangeStart = startOfDay(now) - (range - 1) * DAY;
  const out: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const end = lastStart - i * step * DAY + step * DAY;
    const start = Math.max(rangeStart, end - step * DAY);
    out.push({ key: String(start), label: fmtDay(start), long: end - start === DAY ? fmtDay(start) : `${fmtDay(start)} to ${fmtDay(end - DAY)}`, start, end, paypal: 0, stellar: 0, bank: 0, fee: 0, items: [] });
  }
  for (const p of points) {
    const t = new Date(p.settledAt).getTime();
    const b = out.find((x) => t >= x.start && t < x.end);
    if (!b) continue;
    b[railKey(p.rail)] += p.grossMinor;
    b.fee += p.feeMinor;
    b.items.push(p);
  }
  return out;
}

const SYMBOL: Record<string, string> = { USD: "$", PHP: "₱", VND: "₫", THB: "฿", EUR: "€", GBP: "£", CAD: "CA$" };
/** "$800", "$1,250", "$2.5": whole units with the currency, for the y-axis. */
export function axisLabel(minor: number, currency: string): string {
  const cur = currency.toUpperCase();
  const body = (minor / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return SYMBOL[cur] ? `${SYMBOL[cur]}${body}` : `${cur} ${body}`;
}

/** Clean axis ceiling and ticks: 0 / 250 / 500 style steps in whole currency units. */
export function axis(maxMinor: number): number[] {
  const max = Math.max(maxMinor / 100, 1);
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 100));
  return ticks;
}


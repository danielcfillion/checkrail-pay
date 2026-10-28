import { mulDivCeil } from "./domain/money";

/**
 * Reference exchange rates for turning an amount owed in one currency into the business's base currency, so
 * thresholds, approval limits, caps and totals mean the same thing whatever the invoice says. These do not set
 * what a vendor receives: the rail's own quote does that at payment time.
 *
 * Units of each currency per 1 USD. Override with FX_RATES='{"VND":25450,"PHP":57.9}' and FX_RATES_AS_OF.
 */
const DEFAULT_PER_USD: Record<string, number> = { USD: 1, VND: 25_400, PHP: 57.5, THB: 33.6 };
const DEFAULT_AS_OF = "2026-10-20";

function table(): Record<string, number> {
  const raw = process.env.FX_RATES;
  if (!raw) return DEFAULT_PER_USD;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = { ...DEFAULT_PER_USD };
    for (const [k, v] of Object.entries(parsed)) if (/^[A-Z]{3}$/.test(k) && typeof v === "number" && v > 0 && Number.isFinite(v)) out[k] = v;
    out.USD = 1;
    return out;
  } catch {
    return DEFAULT_PER_USD;
  }
}

export function fxAsOf(): string {
  return process.env.FX_RATES_AS_OF || DEFAULT_AS_OF;
}

export function hasRate(currency: string, base: string): boolean {
  const t = table();
  return currency in t && base in t;
}

/** Units of `to` per 1 unit of `from`. */
export function rate(from: string, to: string): number | null {
  const t = table();
  if (!(from in t) || !(to in t)) return null;
  return t[to] / t[from];
}

/**
 * The amount in the base currency, rounded up: a limit or cap compared with it is never undercounted by rounding.
 * Returns null when there is no rate, so callers decide (policy blocks).
 */
export function toBaseMinor(amountMinor: number, currency: string, base: string): number | null {
  if (currency === base) return amountMinor;
  const t = table();
  if (!(currency in t) || !(base in t)) return null;
  // amount * (base per USD) / (currency per USD), in integers scaled by 1e6.
  const num = BigInt(Math.round(t[base] * 1_000_000));
  const den = BigInt(Math.round(t[currency] * 1_000_000));
  return Number(mulDivCeil(BigInt(amountMinor), num, den));
}

/** For totals on screens: missing rates count as zero rather than breaking the page. */
export function toBaseOrZero(amountMinor: number, currency: string | null, base: string): number {
  return currency ? (toBaseMinor(amountMinor, currency, base) ?? 0) : 0;
}

export function fxTable(): Array<{ currency: string; perUsd: number }> {
  return Object.entries(table()).map(([currency, perUsd]) => ({ currency, perUsd }));
}

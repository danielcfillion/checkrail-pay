/**
 * Integer money helpers. Every amount in Checkrail Pay is an integer count of minor
 * units (cents). Rates are held as integer basis points or micro-units so no
 * float ever touches a payable amount.
 */

/** Currencies the rails can pay today. Both adapters assume two decimal places. */
export const SUPPORTED_CURRENCIES: readonly string[] = ["USD"];

/** Upper bound for a single obligation (USD 10,000,000.00). Anything larger is almost certainly a parsing error or an attack. */
export const MAX_AMOUNT_MINOR = 1_000_000_000;

export function isValidAmountMinor(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= MAX_AMOUNT_MINOR;
}

/** Business reference: letters, digits and . _ / # : - only, 1 to 64 chars. Safe to put in a memo or an email. */
export const SOURCE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/#:-]{0,63}$/;

export function isValidSourceRef(s: unknown): s is string {
  return typeof s === "string" && SOURCE_REF_RE.test(s);
}

/** Strip anything that is not a safe reference character. Used when composing memos. */
export function safeRefForMemo(s: string): string {
  return s.replace(/[^A-Za-z0-9._/#:-]/g, "");
}

/** Percentage (for example 2.5) to integer basis points (250). */
export function pctToBps(pct: number): number {
  return Math.round(pct * 100);
}

/** Round-half-up of a * b / d for non-negative bigints. */
export function mulDivRound(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d / BigInt(2)) / d;
}

/** Ceiling of a * b / d for non-negative bigints. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - BigInt(1)) / d;
}

/** amountMinor * bps / 10000, rounded up (fees round against the sender, never in their favour). */
export function bpsCeil(amountMinor: number, bps: number): number {
  return Number(mulDivCeil(BigInt(amountMinor), BigInt(bps), BigInt(10_000)));
}

/** 1 unit of the sender currency in micro-units of the recipient currency, after a spread given in basis points. */
export function effectiveRateMicro(midRate: number, spreadBps: number): bigint {
  const mid = BigInt(Math.round(midRate * 1_000_000));
  return mulDivRound(mid, BigInt(10_000 - spreadBps), BigInt(10_000));
}

/** amountMinor * rate (micro), rounded to the nearest minor unit. */
export function applyRateMicro(amountMinor: number, rateMicro: bigint): number {
  return Number(mulDivRound(BigInt(amountMinor), rateMicro, BigInt(1_000_000)));
}

export function microToDecimal(micro: bigint): string {
  const whole = micro / BigInt(1_000_000);
  const frac = (micro % BigInt(1_000_000)).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

/** Minor units (cents) to a fixed-decimal string with `decimals` places, without going through a float. */
export function minorToDecimal(minor: number, decimals: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error(`Invalid amount: ${minor}`);
  const whole = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  return `${whole}.${cents}${"0".repeat(Math.max(0, decimals - 2))}`;
}

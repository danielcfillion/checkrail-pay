import type { Rail, RouteQuote, VendorPayoutProfile } from "./types";

export interface RoutingDecision {
  rail: Rail | null;
  reason: string;
  quotes: RouteQuote[];
}

/**
 * Static routing rule. Deliberately not an "engine": with two rails the right
 * answer is a readable rule plus the numbers that justify it. The comparison
 * is shown to the operator; this function only picks a default.
 *
 * Order of precedence:
 *   1. Vendor preference, if that rail is available.
 *   2. Domestic obligations go PayPal when available (familiar, instant, no FX).
 *   3. Cross-border: compare what the recipient gets per unit the sender actually spends
 *      (PayPal's fee is charged on top, Stellar's is taken out of the amount, so delivered
 *      amount alone is not comparable). A difference under TIE_BPS is a tie, and ties go to
 *      PayPal because it is the rail whose whole path is executed end to end today.
 *   4. Whatever is available.
 *   5. Nothing available: hold with the reasons.
 */
/** Differences in effective rate below this many basis points count as a tie. */
export const TIE_BPS = 50;

/** What the sender spends for this quote: PayPal charges its fee on top, Stellar's fee comes out of the amount. */
export function senderOutlayMinor(q: Pick<RouteQuote, "rail" | "sendAmountMinor" | "feeMinor">): number {
  return q.rail === "paypal" ? q.sendAmountMinor + q.feeMinor : q.sendAmountMinor;
}

/** Recipient-currency units delivered per 1.00 of sender currency spent. */
export function effectiveRate(q: Pick<RouteQuote, "rail" | "sendAmountMinor" | "feeMinor" | "receiveAmountMinor">): number {
  const outlay = senderOutlayMinor(q);
  return outlay > 0 ? q.receiveAmountMinor / outlay : 0;
}

export function chooseRoute(
  vendor: VendorPayoutProfile,
  businessCountry: string,
  quotes: RouteQuote[]
): RoutingDecision {
  const byRail = Object.fromEntries(quotes.map((q) => [q.rail, q])) as Partial<Record<Rail, RouteQuote>>;
  const available = quotes.filter((q) => q.available);

  if (vendor.preferredRail && byRail[vendor.preferredRail]?.available) {
    return { rail: vendor.preferredRail, reason: `${label(vendor.preferredRail)} is ${vendor.name}'s stated preference.`, quotes };
  }

  if (available.length === 0) {
    const why = quotes.map((q) => `${label(q.rail)}: ${q.unavailableReason ?? "unavailable"}`).join("; ");
    return { rail: null, reason: `No supported route. ${why}`, quotes };
  }

  const domestic = vendor.country === businessCountry;
  if (domestic && byRail.paypal?.available) {
    return { rail: "paypal", reason: "Domestic payment; PayPal delivers instantly with no FX.", quotes };
  }

  if (available.length === 1) {
    const only = available[0];
    const other = quotes.find((q) => q.rail !== only.rail);
    return {
      rail: only.rail,
      reason: `${label(only.rail)} is the only supported route${other ? ` (${label(other.rail)}: ${other.unavailableReason ?? "unavailable"})` : ""}.`,
      quotes,
    };
  }

  // Both available: compare delivered amount per unit the sender spends.
  const pp = byRail.paypal!;
  const st = byRail.stellar!;
  const rp = effectiveRate(pp);
  const rs = effectiveRate(st);
  const gapBps = Math.round((Math.abs(rp - rs) / Math.max(rp, rs, 1e-9)) * 10_000);
  const fmtRate = (r: number) => r.toFixed(2);
  if (gapBps < TIE_BPS) {
    return {
      rail: "paypal",
      reason: `Effectively equal cost: ${pp.receiveCurrency} ${fmtRate(rp)} per ${pp.sendCurrency} spent on PayPal against ${fmtRate(rs)} on Stellar (${(gapBps / 100).toFixed(2)}% apart). PayPal wins the tie because its whole path runs end to end today${st.etaSeconds < pp.etaSeconds ? "; Stellar is faster" : ""}.`,
      quotes,
    };
  }
  const best = rp > rs ? pp : st;
  const other = best === pp ? st : pp;
  const etaNote = best.etaSeconds < other.etaSeconds ? " and settles faster" : best.etaSeconds > other.etaSeconds ? ` (${label(other.rail)} is faster)` : "";
  return {
    rail: best.rail,
    reason: `${label(best.rail)} delivers ${(gapBps / 100).toFixed(1)}% more per ${best.sendCurrency} spent (${best.receiveCurrency} ${fmtRate(effectiveRate(best))} against ${fmtRate(effectiveRate(other))}) to ${vendor.name}${etaNote}.`,
    quotes,
  };
}

export function label(rail: Rail): string {
  return rail === "paypal" ? "PayPal" : "Stellar";
}


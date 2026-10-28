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

/** What the sender spends for this quote: Stellar's fee comes out of the amount; every other rail charges it on top. */
export function senderOutlayMinor(q: Pick<RouteQuote, "rail" | "sendAmountMinor" | "feeMinor">): number {
  return q.rail === "stellar" ? q.sendAmountMinor : q.sendAmountMinor + q.feeMinor;
}

/** Recipient-currency units delivered per 1.00 of sender currency spent. */
export function effectiveRate(q: Pick<RouteQuote, "rail" | "sendAmountMinor" | "feeMinor" | "receiveAmountMinor">): number {
  const outlay = senderOutlayMinor(q);
  return outlay > 0 ? q.receiveAmountMinor / outlay : 0;
}

/**
 * Who wins a tie: the rails whose whole path Checkrail Pay runs end to end come first. PayPal, then Wise (a real
 * local bank deposit), then the bank file (a person must upload it), then Stellar (whose bank off-ramp is modelled).
 */
const TIE_ORDER: Rail[] = ["paypal", "wise", "bank_file", "stellar"];

export function chooseRoute(vendor: VendorPayoutProfile, businessCountry: string, quotes: RouteQuote[]): RoutingDecision {
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
    const others = quotes.filter((q) => q.rail !== only.rail && !q.available);
    return {
      rail: only.rail,
      reason: `${label(only.rail)} is the only supported route${others.length ? ` (${others.map((o) => `${label(o.rail)}: ${o.unavailableReason ?? "unavailable"}`).join("; ")})` : ""}.`,
      quotes,
    };
  }

  // Several available: compare what the vendor receives per unit the sender spends. Within TIE_BPS is a tie.
  const ranked = [...available].sort((a, b) => effectiveRate(b) - effectiveRate(a));
  const top = effectiveRate(ranked[0]);
  const tied = ranked.filter((q) => Math.round(((top - effectiveRate(q)) / Math.max(top, 1e-9)) * 10_000) < TIE_BPS);
  const fmtRate = (r: number) => (r >= 100 ? r.toLocaleString("en-US", { maximumFractionDigits: 0 }) : r.toFixed(2));
  if (tied.length > 1) {
    const pick = [...tied].sort((a, b) => TIE_ORDER.indexOf(a.rail) - TIE_ORDER.indexOf(b.rail))[0];
    const faster = tied.filter((q) => q.etaSeconds < pick.etaSeconds).map((q) => label(q.rail));
    return {
      rail: pick.rail,
      reason: `Effectively equal cost across ${tied.map((q) => label(q.rail)).join(" and ")} (${pick.receiveCurrency} ${fmtRate(effectiveRate(pick))} per ${pick.sendCurrency} spent). ${label(pick.rail)} wins the tie because more of its path runs end to end${faster.length ? `; ${faster.join(" and ")} ${faster.length === 1 ? "is" : "are"} faster` : ""}.`,
      quotes,
    };
  }
  const best = ranked[0];
  const next = ranked[1];
  const gapBps = Math.round(((effectiveRate(best) - effectiveRate(next)) / Math.max(effectiveRate(best), 1e-9)) * 10_000);
  const etaNote = best.etaSeconds < next.etaSeconds ? " and settles faster" : best.etaSeconds > next.etaSeconds ? ` (${label(next.rail)} is faster)` : "";
  return {
    rail: best.rail,
    reason: `${label(best.rail)} delivers ${(gapBps / 100).toFixed(1)}% more per ${best.sendCurrency} spent than ${label(next.rail)} (${best.receiveCurrency} ${fmtRate(effectiveRate(best))} against ${fmtRate(effectiveRate(next))}) to ${vendor.name}${etaNote}.`,
    quotes,
  };
}

export function label(rail: Rail): string {
  return rail === "paypal" ? "PayPal" : rail === "stellar" ? "Stellar" : rail === "wise" ? "Wise" : "Bank file";
}

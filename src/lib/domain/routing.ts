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
 *   3. Cross-border: the rail that delivers more to the recipient wins; ties go to the faster one.
 *   4. Whatever is available.
 *   5. Nothing available: hold with the reasons.
 */
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

  // Both available: compare delivered amount in the recipient's currency.
  const sorted = [...available].sort((a, b) => {
    if (b.receiveAmountMinor !== a.receiveAmountMinor) return b.receiveAmountMinor - a.receiveAmountMinor;
    return a.etaSeconds - b.etaSeconds;
  });
  const best = sorted[0];
  const runnerUp = sorted[1];
  const delta = best.receiveAmountMinor - runnerUp.receiveAmountMinor;
  const pct = runnerUp.receiveAmountMinor > 0 ? ((delta / runnerUp.receiveAmountMinor) * 100).toFixed(1) : "0.0";
  const etaNote = best.etaSeconds < runnerUp.etaSeconds ? " and settles faster" : best.etaSeconds > runnerUp.etaSeconds ? ` (${label(runnerUp.rail)} is faster)` : "";
  return {
    rail: best.rail,
    reason: `${label(best.rail)} delivers ${fmtMinor(delta, best.receiveCurrency)} more (${pct}%) to ${vendor.name}${etaNote}.`,
    quotes,
  };
}

export function label(rail: Rail): string {
  return rail === "paypal" ? "PayPal" : "Stellar";
}

function fmtMinor(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

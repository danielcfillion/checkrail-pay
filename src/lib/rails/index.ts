import type { PaymentRail, Rail } from "../domain/types";
import { config } from "../config";
import { MockPayPalRail, MockStellarRail } from "./mock";
import { PayPalRail } from "./paypal";
import { StellarRail } from "./stellar";

let registry: Record<Rail, PaymentRail> | null = null;

/**
 * Rail registry. In mock mode everything is deterministic and offline.
 *
 * In live mode there is NO fallback: a rail with missing or invalid credentials
 * throws. A silent fallback to the mock would "settle" obligations with fake
 * hashes while no money moved.
 */
export function getRails(): Record<Rail, PaymentRail> {
  if (registry) return registry;
  if (config.rails.mode !== "live") {
    registry = { paypal: new MockPayPalRail(), stellar: new MockStellarRail() };
    return registry;
  }
  // Constructors throw on missing or invalid credentials; that is deliberate, see above.
  registry = { paypal: new PayPalRail(), stellar: new StellarRail() };
  return registry;
}

export function railModes(): Record<Rail, string> {
  const r = getRails();
  return { paypal: r.paypal.mode, stellar: r.stellar.mode };
}

/** For tests. */
export function resetRails(): void {
  registry = null;
}

/** For tests: install specific rail implementations. */
export function setRailsForTest(rails: Record<Rail, PaymentRail>): void {
  registry = rails;
}

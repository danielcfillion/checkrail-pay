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
  // The only exception is an explicit, visible opt-in: STELLAR_RAIL=mock keeps Stellar simulated
  // (labelled "Simulated, not on chain") so PayPal can be tested alone. Never implicit.
  const paypal = new PayPalRail();
  const stellar = process.env.STELLAR_RAIL === "mock" ? new MockStellarRail() : new StellarRail();
  registry = { paypal, stellar };
  return registry;
}

export function railModes(): Record<Rail, string> {
  const r = getRails();
  return { paypal: r.paypal.mode, stellar: r.stellar.mode };
}

/**
 * Run `fn` with the mock rails installed, whatever RAIL_MODE says, then put the real registry back.
 * For the demo seed only: its month of "history" must never send real payments. Settlements made this
 * way carry the mock adapter's mode ("mock") on the attempt row, so they are visibly simulated.
 */
export async function withMockRails<T>(fn: () => Promise<T>): Promise<T> {
  const previous = registry;
  registry = { paypal: new MockPayPalRail(), stellar: new MockStellarRail() };
  try {
    return await fn();
  } finally {
    registry = previous;
  }
}

/** For tests. */
export function resetRails(): void {
  registry = null;
}

/** For tests: install specific rail implementations. */
export function setRailsForTest(rails: Record<Rail, PaymentRail>): void {
  registry = rails;
}

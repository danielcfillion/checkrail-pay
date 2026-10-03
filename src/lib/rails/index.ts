import type { PaymentRail, Rail } from "../domain/types";
import { config } from "../config";
import { MockPayPalRail, MockStellarRail } from "./mock";

let registry: Record<Rail, PaymentRail> | null = null;

/**
 * Rail registry. In mock mode everything is deterministic and offline.
 * In live mode a rail that is missing credentials falls back to its mock
 * and the fallback is reported in `railModes()` so the UI can show it honestly.
 */
export function getRails(): Record<Rail, PaymentRail> {
  if (registry) return registry;
  if (config.rails.mode !== "live") {
    registry = { paypal: new MockPayPalRail(), stellar: new MockStellarRail() };
    return registry;
  }
  // Lazy require so mock-mode builds never load the live SDKs.
  let paypal: PaymentRail;
  let stellar: PaymentRail;
  try {
    const { PayPalRail } = require("./paypal") as typeof import("./paypal");
    paypal = new PayPalRail();
  } catch (e) {
    console.warn(`[rails] PayPal live unavailable, using mock: ${(e as Error).message}`);
    paypal = new MockPayPalRail();
  }
  try {
    const { StellarRail } = require("./stellar") as typeof import("./stellar");
    stellar = new StellarRail();
  } catch (e) {
    console.warn(`[rails] Stellar live unavailable, using mock: ${(e as Error).message}`);
    stellar = new MockStellarRail();
  }
  registry = { paypal, stellar };
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

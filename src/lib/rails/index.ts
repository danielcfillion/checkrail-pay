import type { PaymentRail, Rail, RouteQuote } from "../domain/types";
import { config } from "../config";
import { getDb } from "../db";
import { MockPayPalRail, MockStellarRail, MockWiseRail } from "./mock";
import { PayPalRail } from "./paypal";
import { StellarRail } from "./stellar";
import { WiseRail } from "./wise";
import { BankFileRail } from "./bankFile";
import { corridorKey } from "./corridors";

let registry: Record<Rail, PaymentRail> | null = null;

/**
 * A rail that is not connected in live mode. It quotes "unavailable" with the reason and refuses to pay: never a
 * silent mock standing in for a real provider.
 */
class UnconfiguredRail implements PaymentRail {
  readonly mode = "live" as const;
  constructor(readonly rail: Rail, private readonly reason: string) {}
  async quote(i: { vendor: { country: string }; amountMinor: number; currency: string; businessCountry: string }): Promise<RouteQuote> {
    return { rail: this.rail, available: false, unavailableReason: this.reason, sendAmountMinor: i.amountMinor, sendCurrency: i.currency, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: i.currency, etaSeconds: 0, corridor: corridorKey(i.businessCountry, i.vendor.country), provider: this.rail, explanation: "" };
  }
  async execute(): Promise<never> {
    throw new Error(this.reason);
  }
  async getStatus(): Promise<never> {
    throw new Error(this.reason);
  }
}

function mockRegistry(): Record<Rail, PaymentRail> {
  return { paypal: new MockPayPalRail(), stellar: new MockStellarRail(), wise: new MockWiseRail(), bank_file: new BankFileRail(() => getDb()) };
}

/**
 * Rail registry. In mock mode everything is deterministic and offline.
 *
 * In live mode there is NO fallback: PayPal and Stellar with missing or invalid credentials throw. A silent
 * fallback to the mock would "settle" obligations with fake hashes while no money moved. Wise, being optional,
 * shows as not connected instead. The bank file is the same in both modes: it only writes a file.
 */
export function getRails(): Record<Rail, PaymentRail> {
  if (registry) return registry;
  if (config.rails.mode !== "live") {
    registry = mockRegistry();
    return registry;
  }
  // Constructors throw on missing or invalid credentials; that is deliberate, see above.
  // The only exception is an explicit, visible opt-in: STELLAR_RAIL=mock keeps Stellar simulated
  // (labelled "Simulated, not on chain") so PayPal can be tested alone. Never implicit.
  const paypal = new PayPalRail();
  const stellar = process.env.STELLAR_RAIL === "mock" ? new MockStellarRail() : new StellarRail();
  const wiseToken = process.env.WISE_API_TOKEN?.trim();
  const wise =
    process.env.WISE_RAIL === "mock"
      ? new MockWiseRail()
      : wiseToken
        ? new WiseRail({ token: wiseToken, profileId: process.env.WISE_PROFILE_ID ?? "", env: process.env.WISE_ENV === "live" ? "live" : "sandbox" })
        : new UnconfiguredRail("wise", "Wise is not connected (set WISE_API_TOKEN and WISE_PROFILE_ID)");
  registry = { paypal, stellar, wise, bank_file: new BankFileRail(() => getDb()) };
  return registry;
}

export function railModes(): Record<Rail, string> {
  const r = getRails();
  const wise = r.wise instanceof UnconfiguredRail ? "not connected" : r.wise.mode;
  return { paypal: r.paypal.mode, stellar: r.stellar.mode, wise, bank_file: r.bank_file.mode === "live" ? "file" : "file (demo)" };
}

/**
 * Run `fn` with the mock rails installed, whatever RAIL_MODE says, then put the real registry back.
 * For the demo seed only: its month of "history" must never send real payments. Settlements made this
 * way carry the mock adapter's mode ("mock") on the attempt row, so they are visibly simulated.
 */
export async function withMockRails<T>(fn: () => Promise<T>): Promise<T> {
  const previous = registry;
  registry = mockRegistry();
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

/** For tests: install specific rail implementations; any rail left out is the mock. */
export function setRailsForTest(rails: Partial<Record<Rail, PaymentRail>>): void {
  registry = { ...mockRegistry(), ...rails };
}

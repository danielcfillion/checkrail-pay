/**
 * Corridor fee model used by the quote engine in mock mode and as the
 * estimate layer in live mode (live rails replace estimates with provider
 * quotes where the provider offers one).
 *
 * Numbers come from docs/CORRIDOR_BENCHMARK.md (2026-10-03). Estimates are
 * flagged there. Update that document first, then this file.
 */

export interface CorridorParams {
  recipientCurrency: string;
  midRate: number; // 1 USD -> recipientCurrency
  paypal: {
    available: boolean;
    unavailableReason?: string;
    feePct: number;
    feeFlatUsd: number;
    feeCapUsd: number;
    fxSpreadPct: number;
    withdrawalFeeLocal: number; // minor units of recipient currency
    withdrawalFeeLocalThreshold: number; // minor units; fee waived at or above
    etaSeconds: number;
    provider: string;
  };
  stellar: {
    available: boolean;
    unavailableReason?: string;
    asset: "PYUSD";
    swapToUsdcPct: number;
    networkFeeUsd: number;
    anchor: string | null;
    anchorFeePct: number;
    anchorFeeFixedUsd: number;
    anchorMaxUsd: number | null;
    fxSpreadPct: number;
    etaSeconds: number;
    provider: string;
  };
}

export const CORRIDORS: Record<string, CorridorParams> = {
  "US->PH": {
    recipientCurrency: "PHP",
    midRate: 62.607736,
    paypal: {
      available: true,
      feePct: 2.0,
      feeFlatUsd: 0,
      feeCapUsd: 20,
      fxSpreadPct: 3.0,
      withdrawalFeeLocal: 5_000, // PHP 50.00
      withdrawalFeeLocalThreshold: 700_000, // PHP 7,000.00
      etaSeconds: 172_800,
      provider: "PayPal Payouts (international)",
    },
    stellar: {
      available: true,
      asset: "PYUSD",
      swapToUsdcPct: 0.1,
      networkFeeUsd: 0.000001,
      anchor: "PeraHub (PETNET Inc.)",
      anchorFeePct: 1.0,
      anchorFeeFixedUsd: 5.0,
      anchorMaxUsd: 1_000,
      fxSpreadPct: 1.0,
      etaSeconds: 900,
      provider: "Stellar PYUSD via PeraHub (SEP-31)",
    },
  },
  "US->US": {
    recipientCurrency: "USD",
    midRate: 1,
    paypal: {
      available: true,
      feePct: 0,
      feeFlatUsd: 0.25,
      feeCapUsd: 0.25,
      fxSpreadPct: 0,
      withdrawalFeeLocal: 0,
      withdrawalFeeLocalThreshold: 0,
      etaSeconds: 60,
      provider: "PayPal Payouts (domestic, API rate)",
    },
    stellar: {
      available: true,
      asset: "PYUSD",
      swapToUsdcPct: 0,
      networkFeeUsd: 0.000001,
      anchor: null,
      anchorFeePct: 0,
      anchorFeeFixedUsd: 0,
      anchorMaxUsd: null,
      fxSpreadPct: 0,
      etaSeconds: 10,
      provider: "Stellar PYUSD to recipient wallet",
    },
  },
  "US->VN": {
    recipientCurrency: "VND",
    midRate: 25_400,
    paypal: {
      available: true,
      feePct: 2.0,
      feeFlatUsd: 0,
      feeCapUsd: 20,
      fxSpreadPct: 3.5,
      withdrawalFeeLocal: 0,
      withdrawalFeeLocalThreshold: 0,
      etaSeconds: 259_200,
      provider: "PayPal Payouts (international)",
    },
    stellar: {
      available: false,
      unavailableReason: "No licensed VND off-ramp; Vietnam Law 71/2025 does not recognise crypto as a means of payment",
      asset: "PYUSD",
      swapToUsdcPct: 0,
      networkFeeUsd: 0,
      anchor: null,
      anchorFeePct: 0,
      anchorFeeFixedUsd: 0,
      anchorMaxUsd: null,
      fxSpreadPct: 0,
      etaSeconds: 0,
      provider: "Stellar",
    },
  },
};

export function corridorKey(from: string, to: string): string {
  return `${from}->${to}`;
}

export function getCorridor(from: string, to: string): CorridorParams | null {
  return CORRIDORS[corridorKey(from, to)] ?? null;
}

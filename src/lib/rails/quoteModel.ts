import type { RouteQuote, VendorPayoutProfile } from "../domain/types";
import { getCorridor, corridorKey } from "./corridors";
import { SUPPORTED_CURRENCIES, applyRateMicro, bpsCeil, effectiveRateMicro, isValidAmountMinor, microToDecimal, pctToBps } from "../domain/money";

/**
 * Pure quote arithmetic shared by mock and live adapters.
 * All money in integer minor units. Fees are basis-point integer maths rounded up;
 * recipient amounts are rate-multiplied in BigInt and rounded to the nearest minor unit.
 */

export function quotePayPal(vendor: VendorPayoutProfile, amountMinor: number, currency: string, businessCountry: string): RouteQuote {
  const key = corridorKey(businessCountry, vendor.country);
  const c = getCorridor(businessCountry, vendor.country);
  const base = {
    rail: "paypal" as const,
    sendAmountMinor: amountMinor,
    sendCurrency: currency,
    corridor: key,
  };
  if (!c || !c.paypal.available) {
    return { ...base, available: false, unavailableReason: c?.paypal.unavailableReason ?? `No PayPal corridor configured for ${key}`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c?.recipientCurrency ?? currency, etaSeconds: 0, provider: "PayPal", explanation: "" };
  }
  if (!isValidAmountMinor(amountMinor) || !SUPPORTED_CURRENCIES.includes(currency)) {
    return { ...base, available: false, unavailableReason: `Cannot quote ${currency} ${amountMinor}: amount must be a positive whole number of cents in ${SUPPORTED_CURRENCIES.join("/")}`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: c.paypal.provider, explanation: "" };
  }
  if (!vendor.paypalEmail) {
    return { ...base, available: false, unavailableReason: `${vendor.name} has no PayPal account on file`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: c.paypal.provider, explanation: "" };
  }
  const p = c.paypal;
  // Fee: flat plus a percentage (rounded up), capped. All integer cents.
  const feeMinor = Math.min(Math.round(p.feeCapUsd * 100), Math.round(p.feeFlatUsd * 100) + bpsCeil(amountMinor, pctToBps(p.feePct)));
  const rateMicro = effectiveRateMicro(c.midRate, pctToBps(p.fxSpreadPct));
  let receiveMinor = applyRateMicro(amountMinor, rateMicro);
  if (p.withdrawalFeeLocal > 0 && receiveMinor < p.withdrawalFeeLocalThreshold) receiveMinor -= p.withdrawalFeeLocal;
  if (receiveMinor <= 0) {
    return { ...base, available: false, unavailableReason: `Amount is too small: the recipient would receive nothing after fees`, feeMinor, fxRate: microToDecimal(rateMicro), receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: p.etaSeconds, provider: p.provider, explanation: "" };
  }
  const explanation =
    c.recipientCurrency === currency
      ? `Sender fee ${usd(feeMinor)}; recipient receives the full amount in PayPal balance.`
      : `Sender fee ${usd(feeMinor)} (${p.feePct}% capped at $${p.feeCapUsd}). Recipient converts at ${(Number(rateMicro) / 1_000_000).toFixed(4)} (${p.fxSpreadPct}% below mid ${c.midRate.toFixed(4)})${p.withdrawalFeeLocal > 0 ? `, bank withdrawal fee applies under ${c.recipientCurrency} ${(p.withdrawalFeeLocalThreshold / 100).toLocaleString()}` : ""}.`;
  return {
    ...base,
    available: true,
    feeMinor,
    fxRate: microToDecimal(rateMicro),
    receiveAmountMinor: receiveMinor,
    receiveCurrency: c.recipientCurrency,
    etaSeconds: p.etaSeconds,
    provider: p.provider,
    explanation,
  };
}

export function quoteStellar(vendor: VendorPayoutProfile, amountMinor: number, currency: string, businessCountry: string): RouteQuote {
  const key = corridorKey(businessCountry, vendor.country);
  const c = getCorridor(businessCountry, vendor.country);
  const base = {
    rail: "stellar" as const,
    sendAmountMinor: amountMinor,
    sendCurrency: currency,
    corridor: key,
  };
  if (!c || !c.stellar.available) {
    return { ...base, available: false, unavailableReason: c?.stellar.unavailableReason ?? `No Stellar anchor configured for ${key}`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c?.recipientCurrency ?? currency, etaSeconds: 0, provider: "Stellar", explanation: "" };
  }
  if (!isValidAmountMinor(amountMinor) || !SUPPORTED_CURRENCIES.includes(currency)) {
    return { ...base, available: false, unavailableReason: `Cannot quote ${currency} ${amountMinor}: amount must be a positive whole number of cents in ${SUPPORTED_CURRENCIES.join("/")}`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: c.stellar.provider, explanation: "" };
  }
  const s = c.stellar;
  const needsAnchor = c.recipientCurrency !== "USD";
  // Until the anchor leg (SEP-31) is built, the adapter can only pay a Stellar wallet, so a wallet is
  // required on every corridor. The quote must never say "available" for a payment execute() cannot make.
  if (!vendor.stellarAccount) {
    return { ...base, available: false, unavailableReason: `${vendor.name} has no Stellar wallet on file${needsAnchor ? " (bank payout via the anchor is not built yet)" : ""}`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: s.provider, explanation: "" };
  }
  if (needsAnchor && !vendor.bankCountry) {
    return { ...base, available: false, unavailableReason: `${vendor.name} has no bank payout details for the anchor`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: s.provider, explanation: "" };
  }
  if (s.anchorMaxUsd && amountMinor > s.anchorMaxUsd * 100) {
    return { ...base, available: false, unavailableReason: `Above anchor limit of $${s.anchorMaxUsd} per transfer (${s.anchor})`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: s.provider, explanation: "" };
  }
  // Fees in integer cents, rounded up. The network fee is a fraction of a cent and rounds to zero.
  const swapCost = bpsCeil(amountMinor, pctToBps(s.swapToUsdcPct));
  const anchorFee = Math.round(s.anchorFeeFixedUsd * 100) + bpsCeil(amountMinor, pctToBps(s.anchorFeePct));
  const feeMinor = Math.round(s.networkFeeUsd * 100) + swapCost + anchorFee;
  const netMinor = amountMinor - feeMinor;
  const rateMicro = effectiveRateMicro(c.midRate, pctToBps(s.fxSpreadPct));
  const receiveMinor = netMinor > 0 ? applyRateMicro(netMinor, rateMicro) : 0;
  if (receiveMinor <= 0) {
    return { ...base, available: false, unavailableReason: `Amount is too small: fees of ${usd(feeMinor)} leave nothing for the recipient`, feeMinor, fxRate: microToDecimal(rateMicro), receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: s.etaSeconds, provider: s.provider, explanation: "" };
  }
  const explanation = needsAnchor
    ? `PYUSD on Stellar, swapped to USDC (${s.swapToUsdcPct}%), off-ramped by ${s.anchor} ($${s.anchorFeeFixedUsd} + ${s.anchorFeePct}%, ${s.fxSpreadPct}% below mid). Network fee under one cent. Recipient sees a ${c.recipientCurrency} bank deposit. The swap, off-ramp and ${c.recipientCurrency} figures are modelled estimates: Checkrail Pay sends PYUSD on Stellar and does not execute the anchor leg yet.`
    : `PYUSD on Stellar delivered to the recipient's wallet. Network fee under one cent; no FX.`;
  return {
    ...base,
    available: true,
    feeMinor,
    fxRate: microToDecimal(rateMicro),
    receiveAmountMinor: receiveMinor,
    receiveCurrency: c.recipientCurrency,
    etaSeconds: s.etaSeconds,
    provider: s.provider,
    explanation,
    modelled: needsAnchor,
  };
}

function usd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

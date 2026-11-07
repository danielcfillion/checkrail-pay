import type { RouteQuote, VendorPayoutProfile } from "../domain/types";
import { getCorridor, corridorKey } from "./corridors";
import { BASE_AMOUNT_LIMIT_MINOR, SUPPORTED_CURRENCIES, applyRateMicro, bpsCeil, effectiveRateMicro, isValidAmountMinor, microToDecimal, pctToBps } from "../domain/money";

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
  if (!isValidAmountMinor(amountMinor) || amountMinor > BASE_AMOUNT_LIMIT_MINOR || currency !== "USD" || !SUPPORTED_CURRENCIES.includes(currency)) {
    return { ...base, available: false, unavailableReason: currency !== "USD" ? `PayPal payouts are sent in USD; this invoice is in ${currency}` : "Amount must be a positive whole number of cents, up to USD 10,000,000", feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: c.paypal.provider, explanation: "" };
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
  if (!isValidAmountMinor(amountMinor) || amountMinor > BASE_AMOUNT_LIMIT_MINOR || currency !== "USD" || !SUPPORTED_CURRENCIES.includes(currency)) {
    return { ...base, available: false, unavailableReason: currency !== "USD" ? `Stellar sends PYUSD, a US dollar coin; this invoice is in ${currency}` : "Amount must be a positive whole number of cents, up to USD 10,000,000", feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: c.stellar.provider, explanation: "" };
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
  // The business pays the fee, as on every rail: the recipient gets the full amount and the sender's cash out is the
  // amount plus the fee. The swap and the anchor take their fees from what passes through them and cannot be told to
  // deliver a net figure, so the PYUSD to send is grossed up until what is left after their fees is the full amount.
  const rateMicro = effectiveRateMicro(c.midRate, pctToBps(s.fxSpreadPct));
  const grossMinor = stellarGrossUpMinor(amountMinor, s);
  const feeMinor = grossMinor - amountMinor;
  if (s.anchorMaxUsd && grossMinor > s.anchorMaxUsd * 100) {
    return { ...base, available: false, unavailableReason: `Above anchor limit of $${s.anchorMaxUsd} per transfer once its fee of ${usd(feeMinor)} is added (${s.anchor})`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: s.provider, explanation: "" };
  }
  // Fees larger than the payment itself: the route works, but no one should choose it.
  if (feeMinor > amountMinor) {
    return { ...base, available: false, unavailableReason: `Amount is too small: fees of ${usd(feeMinor)} would be more than the amount`, feeMinor, fxRate: microToDecimal(rateMicro), receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: s.etaSeconds, provider: s.provider, explanation: "" };
  }
  const receiveMinor = applyRateMicro(amountMinor, rateMicro);
  const explanation = needsAnchor
    ? `Sender fee ${usd(feeMinor)}, paid on top: PYUSD on Stellar is sent grossed up so that after the swap to USDC (${s.swapToUsdcPct}%) and the off-ramp by ${s.anchor} ($${s.anchorFeeFixedUsd} + ${s.anchorFeePct}%, ${s.fxSpreadPct}% below mid) the recipient receives the full amount as a ${c.recipientCurrency} bank deposit. Network fee under one cent. The swap, off-ramp and ${c.recipientCurrency} figures are modelled estimates: Checkrail Pay sends PYUSD on Stellar and does not execute the anchor leg yet.`
    : `PYUSD on Stellar delivered to the recipient's wallet in full. Network fee under one cent; no FX.`;
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

/**
 * The PYUSD to send so that the recipient is left with `amountMinor` after the swap and anchor fees, which are taken
 * from what is sent (percentages rounded up, plus the anchor's fixed fee). The smallest such amount, found by
 * iterating gross = amount + fee(gross) from below; the fee only grows with the gross, so this settles in a few steps.
 */
export function stellarGrossUpMinor(amountMinor: number, s: { networkFeeUsd: number; swapToUsdcPct: number; anchorFeeFixedUsd: number; anchorFeePct: number }): number {
  const fee = (g: number) => Math.round(s.networkFeeUsd * 100) + bpsCeil(g, pctToBps(s.swapToUsdcPct)) + Math.round(s.anchorFeeFixedUsd * 100) + bpsCeil(g, pctToBps(s.anchorFeePct));
  let gross = amountMinor + fee(amountMinor);
  for (let i = 0; i < 64; i++) {
    const next = amountMinor + fee(gross);
    if (next <= gross) break;
    gross = next;
  }
  while (gross - fee(gross) < amountMinor) gross += 1; // never short, whatever the rounding
  return gross;
}

function usd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

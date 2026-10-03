import type { RouteQuote, VendorPayoutProfile } from "../domain/types";
import { getCorridor, corridorKey } from "./corridors";

/**
 * Pure quote arithmetic shared by mock and live adapters.
 * All money in integer minor units. Rates as JS numbers, rounded at the end.
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
  if (!vendor.paypalEmail) {
    return { ...base, available: false, unavailableReason: `${vendor.name} has no PayPal account on file`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: c.paypal.provider, explanation: "" };
  }
  const p = c.paypal;
  const senderFeeUsd = Math.min(p.feeCapUsd, p.feeFlatUsd + (amountMinor / 100) * (p.feePct / 100));
  const feeMinor = Math.round(senderFeeUsd * 100);
  const effectiveRate = c.midRate * (1 - p.fxSpreadPct / 100);
  let receiveMinor = Math.round(amountMinor * effectiveRate);
  if (p.withdrawalFeeLocal > 0 && receiveMinor < p.withdrawalFeeLocalThreshold) receiveMinor -= p.withdrawalFeeLocal;
  const explanation =
    c.recipientCurrency === currency
      ? `Sender fee ${usd(feeMinor)}; recipient receives the full amount in PayPal balance.`
      : `Sender fee ${usd(feeMinor)} (${p.feePct}% capped at $${p.feeCapUsd}). Recipient converts at ${effectiveRate.toFixed(4)} (${p.fxSpreadPct}% below mid ${c.midRate.toFixed(4)})${p.withdrawalFeeLocal > 0 ? `, bank withdrawal fee applies under ${c.recipientCurrency} ${(p.withdrawalFeeLocalThreshold / 100).toLocaleString()}` : ""}.`;
  return {
    ...base,
    available: true,
    feeMinor,
    fxRate: effectiveRate.toFixed(6),
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
  const s = c.stellar;
  const needsAnchor = c.recipientCurrency !== "USD";
  if (needsAnchor && !vendor.bankCountry) {
    return { ...base, available: false, unavailableReason: `${vendor.name} has no bank payout details for the anchor`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: s.provider, explanation: "" };
  }
  if (!needsAnchor && !vendor.stellarAccount) {
    return { ...base, available: false, unavailableReason: `${vendor.name} has no Stellar wallet on file`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: s.provider, explanation: "" };
  }
  const amountUsd = amountMinor / 100;
  if (s.anchorMaxUsd && amountUsd > s.anchorMaxUsd) {
    return { ...base, available: false, unavailableReason: `Above anchor limit of $${s.anchorMaxUsd} per transfer (${s.anchor})`, feeMinor: 0, fxRate: "0", receiveAmountMinor: 0, receiveCurrency: c.recipientCurrency, etaSeconds: 0, provider: s.provider, explanation: "" };
  }
  const swapCost = amountUsd * (s.swapToUsdcPct / 100);
  const anchorFee = s.anchorFeeFixedUsd + amountUsd * (s.anchorFeePct / 100);
  const totalFeeUsd = s.networkFeeUsd + swapCost + anchorFee;
  const feeMinor = Math.round(totalFeeUsd * 100);
  const netUsd = amountUsd - totalFeeUsd;
  const effectiveRate = c.midRate * (1 - s.fxSpreadPct / 100);
  const receiveMinor = Math.round(netUsd * 100 * effectiveRate);
  const explanation = needsAnchor
    ? `PYUSD on Stellar, swapped to USDC (${s.swapToUsdcPct}%), off-ramped by ${s.anchor} ($${s.anchorFeeFixedUsd} + ${s.anchorFeePct}%, ${s.fxSpreadPct}% below mid). Network fee under one cent. Recipient sees a ${c.recipientCurrency} bank deposit.`
    : `PYUSD on Stellar delivered to the recipient's wallet. Network fee under one cent; no FX.`;
  return {
    ...base,
    available: true,
    feeMinor,
    fxRate: effectiveRate.toFixed(6),
    receiveAmountMinor: receiveMinor,
    receiveCurrency: c.recipientCurrency,
    etaSeconds: s.etaSeconds,
    provider: s.provider,
    explanation,
  };
}

function usd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

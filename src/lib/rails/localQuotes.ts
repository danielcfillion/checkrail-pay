import type { RouteQuote, VendorPayoutProfile } from "../domain/types";
import { applyRateMicro, bpsCeil, isValidAmountMinor, microToDecimal } from "../domain/money";
import { rate, toBaseMinor } from "../fx";
import { corridorKey } from "./corridors";

/**
 * Quotes for the two local-bank rails. Pure arithmetic, shared by the mock and live adapters; the live Wise adapter
 * takes Wise's own quote again at payment time, so these are what the operator compares routes by, not a promise.
 *
 * Wise: pays a local bank account at the mid-market rate and charges a visible fee (a percentage plus a fixed part).
 * Bank file: a domestic VND transfer in the business's own bulk-payment file; the bank charges the interbank fee.
 */

/** Wise pays into these countries' banks, in these currencies. */
export const WISE_TARGETS: Record<string, string> = { VN: "VND", PH: "PHP", TH: "THB", US: "USD" };

/** Modelled Wise pricing per target currency (published price list, rounded): percentage, fixed part in USD, typical arrival. */
const WISE_PRICING: Record<string, { pct: number; fixedUsd: number; etaSeconds: number; note: string }> = {
  VND: { pct: 0.62, fixedUsd: 0.95, etaSeconds: 86_400, note: "usually next business day" },
  PHP: { pct: 0.51, fixedUsd: 0.75, etaSeconds: 900, note: "InstaPay, usually minutes" },
  THB: { pct: 0.55, fixedUsd: 0.9, etaSeconds: 86_400, note: "usually next business day" },
  USD: { pct: 0.3, fixedUsd: 0.45, etaSeconds: 86_400, note: "ACH, one to two business days" },
};

/** Napas 247 interbank transfer fee charged by Vietnamese corporate banking, in VND. Same-bank transfers are free. */
const NAPAS_FEE_VND = 5_500;

const unavailable = (rail: "wise" | "bank_file", provider: string, amountMinor: number, currency: string, corridor: string, reason: string): RouteQuote => ({
  rail,
  available: false,
  unavailableReason: reason,
  sendAmountMinor: amountMinor,
  sendCurrency: currency,
  feeMinor: 0,
  fxRate: "0",
  receiveAmountMinor: 0,
  receiveCurrency: currency,
  etaSeconds: 0,
  corridor,
  provider,
  explanation: "",
});

function bankDetailsMissing(vendor: VendorPayoutProfile): string | null {
  if (!vendor.hasBankAccount) return `${vendor.name} has no full bank account number on file`;
  if (!vendor.bankCode) return `${vendor.name} has no bank code on file`;
  if (!vendor.accountHolder) return `${vendor.name} has no account holder name on file`;
  return null;
}

export function quoteWise(vendor: VendorPayoutProfile, amountMinor: number, currency: string, businessCountry: string): RouteQuote {
  const corridor = corridorKey(businessCountry, vendor.country);
  const target = vendor.bankCountry ? WISE_TARGETS[vendor.bankCountry] : undefined;
  if (!isValidAmountMinor(amountMinor)) return unavailable("wise", "Wise", amountMinor, currency, corridor, "Amount is not valid");
  const missing = bankDetailsMissing(vendor);
  if (missing) return unavailable("wise", "Wise", amountMinor, currency, corridor, missing);
  if (!target) return unavailable("wise", "Wise", amountMinor, currency, corridor, `Wise local payouts to ${vendor.bankCountry ?? "this country"} are not set up`);
  if (currency !== target && currency !== "USD") return unavailable("wise", "Wise", amountMinor, currency, corridor, `Wise pays this vendor in ${target}; the invoice is in ${currency}`);
  const p = WISE_PRICING[target];
  const fixed = toBaseMinor(Math.round(p.fixedUsd * 100), "USD", currency);
  const mid = rate(currency, target);
  if (fixed === null || mid === null) return unavailable("wise", "Wise", amountMinor, currency, corridor, `No reference rate for ${currency}`);
  const feeMinor = fixed + bpsCeil(amountMinor, Math.round(p.pct * 100));
  const rateMicro = BigInt(Math.round(mid * 1_000_000));
  const receiveAmountMinor = currency === target ? amountMinor : applyRateMicro(amountMinor, rateMicro);
  return {
    rail: "wise",
    available: true,
    sendAmountMinor: amountMinor,
    sendCurrency: currency,
    feeMinor,
    fxRate: currency === target ? "1" : microToDecimal(rateMicro),
    receiveAmountMinor,
    receiveCurrency: target,
    etaSeconds: p.etaSeconds,
    corridor,
    provider: "Wise",
    explanation: `Wise pays ${vendor.bankCode} ${target} account${currency === target ? "" : ` at the mid-market rate`}; fee ${p.pct}% plus about USD ${p.fixedUsd.toFixed(2)}, charged on top. Arrival ${p.note}. Modelled from Wise's price list; Wise's own quote is taken at payment.`,
    modelled: true,
  };
}

export function bankFileSource(): string | null {
  const v = process.env.BANK_FILE_SOURCE_ACCOUNT?.trim();
  return v ? v.slice(0, 60) : null;
}

export function quoteBankFile(vendor: VendorPayoutProfile, amountMinor: number, currency: string, businessCountry: string): RouteQuote {
  const corridor = corridorKey(businessCountry, vendor.country);
  const provider = "Bank file (Napas 247)";
  if (!isValidAmountMinor(amountMinor)) return unavailable("bank_file", provider, amountMinor, currency, corridor, "Amount is not valid");
  if (currency !== "VND") return unavailable("bank_file", provider, amountMinor, currency, corridor, "The bank file pays VND only");
  if (vendor.bankCountry !== "VN") return unavailable("bank_file", provider, amountMinor, currency, corridor, `${vendor.name} has no Vietnamese bank account`);
  const missing = bankDetailsMissing(vendor);
  if (missing) return unavailable("bank_file", provider, amountMinor, currency, corridor, missing);
  const source = bankFileSource();
  if (!source) return unavailable("bank_file", provider, amountMinor, currency, corridor, "No Vietnamese company bank account is set up to pay from (BANK_FILE_SOURCE_ACCOUNT)");
  const sameBank = source.toUpperCase().startsWith(`${vendor.bankCode!.toUpperCase()} `) || source.toUpperCase() === vendor.bankCode!.toUpperCase();
  const feeMinor = sameBank ? 0 : NAPAS_FEE_VND * 100;
  return {
    rail: "bank_file",
    available: true,
    sendAmountMinor: amountMinor,
    sendCurrency: currency,
    feeMinor,
    fxRate: "1",
    receiveAmountMinor: amountMinor,
    receiveCurrency: "VND",
    etaSeconds: 4 * 3600,
    corridor,
    provider,
    explanation: `Added to the bulk-payment file for ${source}. Someone uploads the file in corporate banking; the vendor is paid the same day. ${sameBank ? "Same bank, no fee." : `Interbank fee VND ${NAPAS_FEE_VND.toLocaleString("en-US")}.`}`,
  };
}

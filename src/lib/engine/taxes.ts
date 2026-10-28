import { and, eq, gte, lt, ne } from "drizzle-orm";
import type { Db } from "../db";
import { obligations, settlements, vendors } from "../db/schema";
import type { ApprovalPolicy } from "../domain/types";
import { fmt } from "../domain/policy";
import { toBaseMinor } from "../fx";
import { bpsCeil } from "../domain/money";

/**
 * Tax on payments to vendors: which form must be on file, and what to keep back for the tax office.
 *
 * - United States: a US payee gives a W-9; without one, 24% backup withholding. A foreign payee gives a W-8BEN
 *   (individual) or W-8BEN-E (entity) and nothing is withheld for work done abroad. US payees paid USD 2,000 or more
 *   in a year get a 1099-NEC (the threshold for payments from 2026 on).
 * - Vietnam, when the business pays as a Vietnamese entity: 10% personal income tax from an individual paid
 *   VND 2,000,000 or more, unless they gave a commitment form 08/CK-TNCN.
 * - Philippines, when the business pays as a Philippine entity: expanded withholding tax at the payee's rate (the
 *   accountant sets it per vendor: 1%, 2%, 5%, 10% or 15% by kind of payee and income).
 *
 * Only which form is on file and when is stored, never a tax identification number. Guidance, not tax advice: the
 * accountant sets the rules for the business.
 */

export const TAX_FORMS = ["w9", "w8ben", "w8bene", "vn_08", "none"] as const;
export const TAX_FORM_LABEL: Record<string, string> = { w9: "W-9", w8ben: "W-8BEN", w8bene: "W-8BEN-E", vn_08: "Commitment 08/CK-TNCN", none: "None" };
export const US_1099_THRESHOLD_MINOR = 200_000;
const VN_PIT_THRESHOLD_VND_MINOR = 200_000_000; // VND 2,000,000

export interface Withholding {
  rule: "us_backup" | "vn_pit" | "ph_ewt";
  bps: number;
  withheldMinor: number;
  reason: string;
}

type V = { country: string; taxType: string | null; taxForm: string | null; withholdingBps: number | null };

export function withholdingFor(policy: ApprovalPolicy, businessCountry: string, vendor: V, amountMinor: number, currency: string): Withholding | null {
  if (businessCountry === "US" && vendor.country === "US" && vendor.taxForm !== "w9") {
    return { rule: "us_backup", bps: 2_400, withheldMinor: bpsCeil(amountMinor, 2_400), reason: `No W-9 on file: 24% backup withholding (${fmt(bpsCeil(amountMinor, 2_400), currency)}) goes to the IRS, not the vendor` };
  }
  if (policy.withholdVnPit && vendor.country === "VN" && vendor.taxType === "individual" && vendor.taxForm !== "vn_08") {
    const vnd = currency === "VND" ? amountMinor : toBaseMinor(amountMinor, currency, "VND");
    if (vnd !== null && vnd >= VN_PIT_THRESHOLD_VND_MINOR) {
      const w = bpsCeil(amountMinor, 1_000);
      return { rule: "vn_pit", bps: 1_000, withheldMinor: w, reason: `Individual paid VND 2,000,000 or more: 10% personal income tax (${fmt(w, currency)}) is withheld and declared` };
    }
  }
  if (policy.withholdPhEwt && vendor.country === "PH" && vendor.withholdingBps && vendor.withholdingBps > 0) {
    const w = bpsCeil(amountMinor, vendor.withholdingBps);
    return { rule: "ph_ewt", bps: vendor.withholdingBps, withheldMinor: w, reason: `Expanded withholding tax at ${(vendor.withholdingBps / 100).toFixed(0)}% (${fmt(w, currency)}); issue BIR Form 2307 to the payee` };
  }
  return null;
}

/** A warning when the form the rules need is missing. A US business paying a foreign payee needs a W-8 on file. */
export function taxFormWarning(businessCountry: string, vendor: V & { name: string }): string | null {
  if (businessCountry === "US" && vendor.country !== "US" && !["w8ben", "w8bene"].includes(vendor.taxForm ?? "")) return `No W-8BEN or W-8BEN-E on file for ${vendor.name}; collect it before paying a foreign payee`;
  return null;
}

/** US payees paid enough this year to need a 1099-NEC, and whether their W-9 is on file. */
export function form1099Report(db: Db, businessId: string, year: number) {
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const rows = db
    .select({ vendorId: vendors.id, name: vendors.name, taxForm: vendors.taxForm, amount: settlements.grossMinor, withheld: obligations.withheldMinor, currency: settlements.grossCurrency })
    .from(settlements)
    .innerJoin(obligations, eq(obligations.id, settlements.obligationId))
    .innerJoin(vendors, eq(vendors.id, obligations.vendorId))
    .where(and(eq(obligations.businessId, businessId), eq(vendors.country, "US"), gte(settlements.settledAt, from), lt(settlements.settledAt, to), ne(obligations.state, "refunded")))
    .all();
  const by = new Map<string, { vendorId: string; name: string; taxForm: string | null; paidMinor: number; withheldMinor: number }>();
  for (const r of rows) {
    if (r.currency !== "USD") continue;
    const x = by.get(r.vendorId) ?? { vendorId: r.vendorId, name: r.name, taxForm: r.taxForm, paidMinor: 0, withheldMinor: 0 };
    x.paidMinor += r.amount + (r.withheld ?? 0);
    x.withheldMinor += r.withheld ?? 0;
    by.set(r.vendorId, x);
  }
  return [...by.values()].map((x) => ({ ...x, needs1099: x.paidMinor >= US_1099_THRESHOLD_MINOR })).sort((a, b) => b.paidMinor - a.paidMinor);
}

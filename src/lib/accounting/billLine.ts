import { ZERO_DECIMAL_CURRENCIES } from "../domain/money";

/**
 * What a bill looks like in the books, in one place. The Xero bills file and the settlement CSV both describe the same
 * purchase, so they take the description, the account and the number format from here: the bookkeeper matches one to the
 * other, and a difference between them is a reclassification by hand every month.
 */

const ROLE_WORD: Record<string, string> = { guide: "Guiding", driver: "Transport", homestay: "Accommodation", hotel: "Accommodation", creator: "Content", restaurant: "Meals" };

/** A short, clean line for the accountant: what it was, for which departure. Never the raw chat text. */
export function describeBill(role: string, reference: string, departure: string | null, kind?: string): string {
  const what = kind === "advance" ? "Cash advance" : kind === "credit_note" ? "Credit note" : `${ROLE_WORD[role] ?? "Supplier"} services`;
  return `${what} ${reference}${departure ? `, departure ${departure}` : ""}`;
}

/** An advance is money the guide holds until receipts come in: a prepayment, not an expense. */
export function advancesAccount(): string {
  return process.env.XERO_ADVANCES_ACCOUNT || "620";
}

/**
 * Default account by role, used when the vendor has no code of its own. Guides are contract labour (310); transport,
 * vehicle and motorbike rental (the driver role: vans, boats, bikes) is vehicle hire (320); homestays and hotels are
 * accommodation (325, moved off 320 when 320 became vehicle hire).
 */
const ROLE_ACCOUNT: Record<string, string> = { guide: "310", driver: "320", homestay: "325", hotel: "325", creator: "400" };

/** The account code a bill is posted to: the vendor's own when set, a prepayment for an advance, else one by role. Code only. */
export function accountCodeFor(role: string, override: string | null, kind?: string): string {
  if (kind === "advance") return advancesAccount();
  if (override) return override.trim().split(/\s+/)[0] || override;
  return ROLE_ACCOUNT[role] ?? "429";
}

const ACCOUNT_NAMES: Record<string, string> = { "310": "Cost of Goods Sold: Contract labour", "320": "Cost of Goods Sold: Transport and vehicle hire", "325": "Cost of Goods Sold: Accommodation", "400": "Advertising and marketing", "429": "General expenses", "620": "Prepayments" };

/** The usual name of a code we set by default ("Cost of Goods Sold: Contract labour"), or "" for any other code. */
export function accountName(code: string): string {
  return ACCOUNT_NAMES[code] ?? "";
}

/** "310 Cost of Goods Sold: Contract labour": the code the Xero file carries, with its usual name when we know it. */
export function accountLabel(code: string): string {
  return ACCOUNT_NAMES[code] ? `${code} ${ACCOUNT_NAMES[code]}` : code;
}

/** A stored amount (hundredths) as the file shows it: whole units for a currency without decimals, else two places. */
export function majorText(minor: number, currency: string): string {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? String(Math.round(minor / 100)) : (minor / 100).toFixed(2);
}

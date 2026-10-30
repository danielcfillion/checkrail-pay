import { namesVendor, namesVendorFully } from "./vendorNames";

/**
 * A unit price an invoice or request states against the vendor's contract rate: "4 days at USD 220", "4 x USD 220 per
 * vehicle-day". Pure: text and rate cards in, a finding out. Reading a price out of free text is fuzzy, so this only
 * reads a clear pattern (a whole quantity, a unit, a price and a currency together), never a total, and leaves
 * anything else alone.
 */

export type RateUnit = "day" | "vehicle_day" | "guest_night" | "room_night" | "guest" | "trip";

/** The words an invoice uses for each unit a rate card is kept in (see UNITS in engine/rates.ts). */
const UNIT_PATTERNS: Array<[RateUnit, string]> = [
  ["vehicle_day", "vehicle[- ]days?"],
  ["guest_night", "guest[- ]nights?"],
  ["room_night", "room[- ]nights?"],
  ["day", "days?"],
  ["guest", "guests?|pax"],
  ["trip", "trips?"],
];
const UNIT = `(${UNIT_PATTERNS.map(([, p]) => `(?:${p})`).join("|")})`;

export const UNIT_NAME: Record<RateUnit, string> = { day: "day", vehicle_day: "vehicle-day", guest_night: "guest-night", room_night: "room-night", guest: "guest", trip: "trip" };

function unitOf(word: string): RateUnit | null {
  const w = word.toLowerCase();
  for (const [unit, pattern] of UNIT_PATTERNS) if (new RegExp(`^(?:${pattern})$`, "i").test(w)) return unit;
  return null;
}

export interface StatedRate {
  quantity: number;
  unit: RateUnit;
  unitMinor: number;
  currency: string;
}

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const CODES = "USD|VND|PHP|THB";
const SYMBOLS: Record<string, string> = { $: "USD", "₱": "PHP", "฿": "THB" };

/** Every price in the text becomes "\u0001CUR:minor\u0001", so the patterns below read prices as one token. */
function tokenisePrices(text: string): string {
  const token = (cur: string, num: string) => `\u0001${cur}:${Math.round(Number(num.replace(/,/g, "")) * 100)}\u0001`;
  return text
    .replace(new RegExp(String.raw`\b(${CODES})\s?${NUMBER}(?![\d,])`, "gi"), (_, cur: string, num: string) => token(cur.toUpperCase(), num))
    .replace(new RegExp(String.raw`([$₱฿])\s?${NUMBER}(?![\d,])`, "g"), (_, sym: string, num: string) => token(SYMBOLS[sym], num))
    .replace(new RegExp(String.raw`(?<![\w.,])${NUMBER}\s?(${CODES})\b`, "gi"), (_, num: string, cur: string) => token(cur.toUpperCase(), num));
}

const PRICE = String.raw`\u0001([A-Z]{3}):(\d+)\u0001`;
// Not a price per unit when it is followed by "total", "all in" and the like.
const NOT_TOTAL = String.raw`(?!\s*(?:in\s+)?(?:total|all|altogether|combined|overall))`;
const QTY = String.raw`(?<![\w.,/-])(\d{1,5})`;
const AT = String.raw`\s*(?:@|×|\bx\b|\bat\b)\s*`;
const PER = String.raw`\s*(?:\bper\b|/|\ba\b)\s*`;

const PATTERNS: Array<{ re: RegExp; q: number; u: number | null; pu: number | null; cur: number; amt: number }> = [
  // "4 days at USD 220", "4 vehicle-days x USD 220", optionally "... per vehicle-day"
  { re: new RegExp(`${QTY}\\s*${UNIT}${AT}${PRICE}${NOT_TOTAL}(?:${PER}${UNIT})?`, "gi"), q: 1, u: 2, cur: 3, amt: 4, pu: 5 },
  // "4 x USD 220 per vehicle-day"
  { re: new RegExp(`${QTY}${AT}${PRICE}${NOT_TOTAL}${PER}${UNIT}`, "gi"), q: 1, u: null, cur: 2, amt: 3, pu: 4 },
  // "USD 220 per vehicle-day x 4", "USD 220/day for 4 days"
  { re: new RegExp(`${PRICE}${PER}${UNIT}\\s*(?:@|×|\\bx\\b|\\bfor\\b|\\bover\\b)\\s*(\\d{1,5})(?![\\d,.])`, "gi"), q: 4, u: null, cur: 1, amt: 2, pu: 3 },
];

/** Every unit price the text states in a clear pattern. Prices without a unit or a quantity, and totals, are not read. */
export function parseStatedRates(text: string): StatedRate[] {
  const t = tokenisePrices(text);
  const out: StatedRate[] = [];
  for (const p of PATTERNS) {
    for (const m of t.matchAll(p.re)) {
      const quantity = Number(m[p.q]);
      const unit = unitOf(m[p.pu ?? p.u!] ?? m[p.u!]);
      const unitMinor = Number(m[p.amt]);
      if (!unit || !Number.isInteger(quantity) || quantity < 1 || quantity > 10_000 || !Number.isSafeInteger(unitMinor) || unitMinor <= 0) continue;
      if (!out.some((o) => o.quantity === quantity && o.unit === unit && o.unitMinor === unitMinor && o.currency === m[p.cur].toUpperCase())) out.push({ quantity, unit, unitMinor, currency: m[p.cur].toUpperCase() });
    }
  }
  return out;
}

/**
 * The unit prices stated in these texts that belong to this vendor. A trip sheet often lists several vendors' lines, so
 * a line that names another known vendor and not this one is left out, as is any line of a text that names another
 * vendor in full when the line itself does not name this one.
 */
export function statedRatesFor(texts: string[], vendorName: string, otherVendorNames: string[]): StatedRate[] {
  const out: StatedRate[] = [];
  for (const text of texts) {
    if (!text) continue;
    const othersInText = otherVendorNames.some((n) => namesVendorFully(text, n));
    for (const line of text.split(/\r?\n|;|\|/)) {
      const rates = parseStatedRates(line);
      if (!rates.length) continue;
      const namesUs = namesVendor(line, vendorName, otherVendorNames);
      const namesOther = otherVendorNames.some((n) => namesVendorFully(line, n));
      if (namesOther && !namesUs) continue;
      if (othersInText && !namesUs) continue;
      out.push(...rates);
    }
  }
  return out;
}

export interface VendorRate {
  unit: string;
  rateMinor: number;
  currency: string;
  validFrom: string;
  validTo: string | null;
}

export interface StatedRateFinding {
  quantity: number;
  /** The unit as the invoice says it, and the unit of the contract rate it was compared with (a driver's "days" are vehicle-days). */
  statedUnit: RateUnit;
  rateUnit: RateUnit;
  statedMinor: number;
  rateMinor: number;
  currency: string;
  /** What the quantity costs over the contract rate. */
  overMinor: number;
}

/**
 * The stated price that is furthest above the contract rate, when one is above it by more than the tolerance. The rate is
 * the vendor's card for the same unit and currency in force on `onDate` (a vehicle-day card also answers "days" when the
 * vendor has no day card). A unit the vendor has no card for, or another currency, is not compared.
 */
export function statedRateAboveContract(stated: StatedRate[], rates: VendorRate[], onDate: string | null, toleranceBps: number): StatedRateFinding | null {
  const inForce = rates.filter((r) => (onDate ? r.validFrom <= onDate && (!r.validTo || r.validTo >= onDate) : !r.validTo));
  let worst: StatedRateFinding | null = null;
  for (const s of stated) {
    const same = inForce.filter((r) => r.unit === s.unit && r.currency === s.currency).sort((a, b) => b.validFrom.localeCompare(a.validFrom));
    const alias = s.unit === "day" && same.length === 0 ? inForce.filter((r) => r.unit === "vehicle_day" && r.currency === s.currency) : [];
    const card = same[0] ?? (alias.length === 1 ? alias[0] : null);
    if (!card) continue;
    const slack = Math.floor((card.rateMinor * toleranceBps) / 10_000);
    if (s.unitMinor <= card.rateMinor + slack) continue;
    const overMinor = (s.unitMinor - card.rateMinor) * s.quantity;
    if (!worst || overMinor > worst.overMinor) worst = { quantity: s.quantity, statedUnit: s.unit, rateUnit: card.unit as RateUnit, statedMinor: s.unitMinor, rateMinor: card.rateMinor, currency: s.currency, overMinor };
  }
  return worst;
}

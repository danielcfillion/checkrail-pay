import { namesVendorFully } from "../domain/vendorNames";
import type { AiInterpretation, EvidenceItem, VendorPayoutProfile } from "../domain/types";

/**
 * Rule-based obligation extractor. Used in AI_MODE=mock and as the safety
 * net when the model call fails. Produces the same AiInterpretation shape the
 * model produces, so the policy engine does not care which one ran.
 */

const CURRENCY_WORDS: Record<string, string> = { "$": "USD", usd: "USD", "us$": "USD", php: "PHP", "₱": "PHP", vnd: "VND", "₫": "VND", eur: "EUR", "€": "EUR", gbp: "GBP", "£": "GBP" };

export function extractAmount(text: string, defaultCurrency?: string): { amountMinor: number; currency: string; assumedCurrency?: boolean } | null {
  // e.g. "$180", "USD 1,240.50", "180 USD", "PHP 9,000", "₱9,000". Commas are only thousands separators
  // (exactly three digits follow), and a number glued to an identifier ("INV-K-77", "HG-4D-0914") is not an
  // amount. When a request lists several figures prefer, in order: "balance due" / "amount due" / "total" / "=",
  // else the largest.
  const num = "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?";
  const re = new RegExp(`(?<![A-Za-z0-9-])(?:(\\$|US\\$|USD|PHP|₱|VND|₫|EUR|€|GBP|£)\\s?${num}|${num}\\s?(USD|PHP|VND|EUR|GBP))(?![A-Za-z0-9-])`, "gi");
  const found: Array<{ amountMinor: number; currency: string; index: number }> = [];
  for (const m of text.matchAll(re)) {
    const symbol = (m[1] ?? m[6] ?? "").toLowerCase();
    const whole = (m[2] ?? m[4] ?? "").replace(/,/g, "");
    const frac = m[3] ?? m[5] ?? "";
    const value = Number.parseFloat(frac ? `${whole}.${frac}` : whole);
    if (!Number.isFinite(value) || value <= 0) continue;
    found.push({ amountMinor: Math.round(value * 100), currency: CURRENCY_WORDS[symbol] ?? symbol.toUpperCase(), index: m.index ?? 0 });
  }
  if (found.length === 0) {
    // Chat shorthand: "send maria 180", "pay him 1,200 today". Only with a verb in front, a plain figure
    // (no identifier glued on), and a default currency to assume. Flagged so confidence drops.
    if (!defaultCurrency) return null;
    const m = text.match(/\b(?:send|pay|transfer|wire|owe|owes|give)\b[^0-9\n]{0,24}?(?<![A-Za-z0-9-])(\d{1,3}(?:,\d{3})+|\d{2,6})(?:\.(\d{1,2}))?(?![A-Za-z0-9-])/i);
    if (!m) return null;
    const value = Number.parseFloat(`${m[1].replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`);
    return value > 0 ? { amountMinor: Math.round(value * 100), currency: defaultCurrency, assumedCurrency: true } : null;
  }
  const lead = (f: { index: number }) => text.slice(Math.max(0, f.index - 24), f.index);
  const due = found.find((f) => /(balance due|amount due|net due|please pay|pay)[^0-9$]{0,12}$/i.test(lead(f)));
  const total = due ?? found.find((f) => /(total|=|sum)[^0-9$]{0,12}$/i.test(lead(f)));
  const pick = total ?? found.reduce((a, b) => (b.amountMinor > a.amountMinor ? b : a));
  return { amountMinor: pick.amountMinor, currency: pick.currency };
}

export function extractReference(text: string): string | null {
  const m = text.match(/\b((?:INV|JOB|BK|PO|REF|TRIP|TOUR)-[A-Z0-9-]{3,})\b/i);
  return m ? m[1].toUpperCase() : null;
}

export function extractDueDate(text: string): string | null {
  const iso = text.match(/\b(20[0-9]{2}-[01][0-9]-[0-3][0-9])\b/);
  if (iso) return iso[1];
  if (/\b(today|asap|immediately)\b/i.test(text)) return new Date().toISOString().slice(0, 10);
  const m = text.match(/\bnet\s?(\d{1,3})\b/i);
  if (m) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + Number(m[1]));
    return d.toISOString().slice(0, 10);
  }
  return null;
}

export function matchVendor(text: string, vendors: VendorPayoutProfile[]): VendorPayoutProfile | null {
  const lower = text.toLowerCase();
  let best: { v: VendorPayoutProfile; score: number } | null = null;
  for (const v of vendors) {
    const parts = v.name.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
    const full = lower.includes(v.name.toLowerCase()) ? 3 : 0;
    const partial = parts.filter((p) => lower.includes(p)).length;
    const score = full + partial;
    if (score > 0 && (!best || score > best.score)) best = { v, score };
  }
  if (best && best.score >= 2) return best.v;
  // A single distinctive name part ("maria", "phuong") is enough when exactly one vendor has it.
  const singles = vendors.filter((v) => v.name.toLowerCase().split(/\s+/).some((p) => p.length >= 3 && new RegExp(`\\b${p}\\b`, "i").test(lower)));
  return singles.length === 1 ? singles[0] : null;
}

export function interpretWithRules(input: {
  rawInput: string;
  sourceType: string;
  vendors: VendorPayoutProfile[];
  evidence: EvidenceItem[];
  baseCurrency?: string;
}): AiInterpretation {
  const { rawInput, vendors, evidence } = input;
  let money = extractAmount(rawInput, input.baseCurrency ?? "USD");
  let ref = extractReference(rawInput);
  const adopted: string[] = [];
  // When the request text carries no figure but exactly one attached record does (an uploaded invoice is the
  // request), take the amount from the record and say so. Policy still checks it against that same record.
  const amounts = evidence.filter((e) => e.amountMinor != null && e.currency);
  if (!money && amounts.length === 1) {
    money = { amountMinor: amounts[0].amountMinor!, currency: amounts[0].currency! };
    adopted.push(`Amount taken from ${amounts[0].label}; the request text states none`);
  }
  if (!ref) {
    const refs = Array.from(new Set(evidence.map((e) => e.reference).filter((r): r is string => Boolean(r) && !/^AGR-/i.test(r!))));
    if (refs.length === 1) {
      ref = refs[0].toUpperCase();
      adopted.push(`Reference ${ref} taken from ${evidence.find((e) => e.reference?.toUpperCase() === ref)!.label}`);
    }
  }
  // The covering message often says only "invoice attached, please pay". Then the vendor comes from the attached
  // records, but only when exactly one known vendor is named there. Policy still checks the record names the payee.
  let vendor = matchVendor(rawInput, vendors);
  // A document names many people (the guide, the guesthouse, the driver): only a full-name match is considered, only
  // when exactly one vendor matches, and policy still makes a person confirm the payee (request_names_vendor).
  if (!vendor && evidence.length) {
    const named = vendors.filter((v) => evidence.some((e) => namesVendorFully(`${e.label} ${e.excerpt ?? ""}`, v.name)));
    if (named.length === 1) {
      vendor = named[0];
      // Policy's request_names_vendor rule raises the warning for this case, for every reader, so it is a note here.
      adopted.push(`Vendor ${vendor.name} read from the attached record; the request text names no one`);
    }
  }
  const dueDate = extractDueDate(rawInput);
  const flags: string[] = [];
  const missing: string[] = [];
  let confidence = 55;

  if (vendor) confidence += 15;
  else missing.push("a recognisable vendor name");
  if (money && !money.assumedCurrency) confidence += 15;
  else if (money) {
    confidence += 5;
    flags.push(`No currency given; assumed ${money.currency}`);
  } else missing.push("an amount and currency");
  if (ref) confidence += 10;
  else missing.push("an invoice, job or booking reference");

  // Compare against evidence
  const evidenced = evidence.filter((e) => e.amountMinor != null);
  if (money && evidenced.length > 0) {
    const same = evidenced.find((e) => e.currency === money.currency && e.amountMinor === money.amountMinor);
    if (same) {
      confidence += 5;
    } else {
      const byRef = ref ? evidenced.find((e) => e.reference && e.reference.toUpperCase() === ref) : undefined;
      const e = byRef ?? [...evidenced].sort((a, b) => Math.abs((a.amountMinor ?? 0) - money.amountMinor) - Math.abs((b.amountMinor ?? 0) - money.amountMinor))[0];
      const diff = money.amountMinor - (e.amountMinor ?? 0);
      flags.push(`Requested amount differs from ${e.label} by ${e.currency} ${(Math.abs(diff) / 100).toFixed(2)} (${diff > 0 ? "higher" : "lower"})`);
      confidence -= 25;
    }
    const withRefs = evidence.filter((e) => e.reference);
    if (ref && withRefs.length > 0 && !withRefs.some((e) => e.reference!.toUpperCase() === ref)) {
      flags.push(`Reference ${ref} does not appear on any attached record (found ${withRefs.map((e) => e.reference).join(", ")})`);
    }
  } else if (money && evidenced.length === 0 && evidence.length === 0) {
    missing.push("supporting evidence (job sheet, contract or invoice)");
  }

  if (/\b(urgent|asap|today|now|immediately)\b/i.test(rawInput)) {
    flags.push("Urgency language in the request; treat as a social-engineering signal, not a reason to skip checks");
    confidence -= 5;
  }
  if (/\b(new|changed|updated|different)\s+(bank|account|paypal|details)\b/i.test(rawInput)) {
    flags.push("Request mentions changed payout details; reverify the recipient out of band");
    confidence -= 20;
  }

  // Figures and vendors taken from the attached record are information, not concerns: policy checks each one
  // against that record and the request (amount_matches_evidence, evidence_names_vendor, request_names_vendor).
  confidence = Math.max(5, Math.min(98, confidence));

  const descr = describe(rawInput, vendor, money, ref);
  const summary = vendor && money
    ? `${vendor.name} is owed ${money.currency} ${(money.amountMinor / 100).toFixed(2)}${ref ? ` for ${ref}` : ""}${dueDate ? `, due ${dueDate}` : ""}. ${flags.length === 0 ? "The request matches the attached evidence." : `${flags.length} concern${flags.length === 1 ? "" : "s"} noted.`}`
    : `Could not fully determine the obligation from the input. ${missing.length ? `Missing: ${missing.join(", ")}.` : ""}`;

  return {
    vendorName: vendor?.name ?? null,
    vendorId: vendor?.id ?? null,
    amountMinor: money?.amountMinor ?? null,
    currency: money?.currency ?? null,
    description: descr,
    sourceRef: ref,
    dueDate,
    summary,
    confidence,
    flags,
    missing,
    notes: adopted,
  };
}

function describe(raw: string, vendor: VendorPayoutProfile | null, money: { amountMinor: number; currency: string } | null, ref: string | null): string {
  const firstLine = raw.split(/\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? raw;
  const trimmed = firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine;
  if (vendor && money) return `${vendor.name}${ref ? ` (${ref})` : ""}: ${trimmed}`;
  return trimmed;
}

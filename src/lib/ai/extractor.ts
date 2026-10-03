import type { AiInterpretation, EvidenceItem, VendorPayoutProfile } from "../domain/types";

/**
 * Rule-based obligation extractor. Used in AI_MODE=mock and as the safety
 * net when the model call fails. Produces the same AiInterpretation shape the
 * model produces, so the policy engine does not care which one ran.
 */

const CURRENCY_WORDS: Record<string, string> = { "$": "USD", usd: "USD", "us$": "USD", php: "PHP", "₱": "PHP", vnd: "VND", "₫": "VND", eur: "EUR", "€": "EUR", gbp: "GBP", "£": "GBP" };

export function extractAmount(text: string): { amountMinor: number; currency: string } | null {
  // e.g. "$180", "USD 1,240.50", "180 USD", "PHP 9,000", "₱9,000". When a request lists several
  // figures (unit rate, days, total) prefer the one introduced by "total" or "=", else the largest.
  const re = /(?:(\$|US\$|USD|PHP|₱|VND|₫|EUR|€|GBP|£)\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?))|(?:([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s?(USD|PHP|VND|EUR|GBP))/gi;
  const found: Array<{ amountMinor: number; currency: string; index: number }> = [];
  for (const m of text.matchAll(re)) {
    const symbol = (m[1] ?? m[4] ?? "").toLowerCase();
    const num = (m[2] ?? m[3] ?? "").replace(/,/g, "");
    const value = Number.parseFloat(num);
    if (!Number.isFinite(value)) continue;
    found.push({ amountMinor: Math.round(value * 100), currency: CURRENCY_WORDS[symbol] ?? symbol.toUpperCase(), index: m.index ?? 0 });
  }
  if (found.length === 0) return null;
  const total = found.find((f) => /(total|=|sum|amount due)[^0-9$]{0,12}$/i.test(text.slice(Math.max(0, f.index - 16), f.index)));
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
  return best && best.score >= 2 ? best.v : null;
}

export function interpretWithRules(input: {
  rawInput: string;
  sourceType: string;
  vendors: VendorPayoutProfile[];
  evidence: EvidenceItem[];
}): AiInterpretation {
  const { rawInput, vendors, evidence } = input;
  const money = extractAmount(rawInput);
  const ref = extractReference(rawInput);
  const vendor = matchVendor(rawInput, vendors);
  const dueDate = extractDueDate(rawInput);
  const flags: string[] = [];
  const missing: string[] = [];
  let confidence = 55;

  if (vendor) confidence += 15;
  else missing.push("a recognisable vendor name");
  if (money) confidence += 15;
  else missing.push("an amount and currency");
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
  };
}

function describe(raw: string, vendor: VendorPayoutProfile | null, money: { amountMinor: number; currency: string } | null, ref: string | null): string {
  const firstLine = raw.split(/\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? raw;
  const trimmed = firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine;
  if (vendor && money) return `${vendor.name}${ref ? ` (${ref})` : ""}: ${trimmed}`;
  return trimmed;
}

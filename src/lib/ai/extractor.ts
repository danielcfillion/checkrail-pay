import { fmt } from "../domain/policy";
import { namesVendorFully } from "../domain/vendorNames";
import type { AiInterpretation, EvidenceItem, VendorPayoutProfile } from "../domain/types";

/**
 * Rule-based obligation extractor. Used in AI_MODE=mock and as the safety
 * net when the model call fails. Produces the same AiInterpretation shape the
 * model produces, so the policy engine does not care which one ran.
 */

const CURRENCY_WORDS: Record<string, string> = { "$": "USD", usd: "USD", "us$": "USD", php: "PHP", "₱": "PHP", vnd: "VND", "₫": "VND", "đ": "VND", thb: "THB", "฿": "THB", eur: "EUR", "€": "EUR", gbp: "GBP", "£": "GBP" };

/** Requests longer than this are read from their first part only: no real payment request is longer. */
export const MAX_REQUEST_CHARS = 20_000;

export function extractAmount(text: string, defaultCurrency?: string): { amountMinor: number; currency: string; assumedCurrency?: boolean } | null {
  text = text.slice(0, MAX_REQUEST_CHARS);
  const found = findAmounts(text);
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
  // A deposit request names two figures, the deposit and the total; the deposit is what is asked for now.
  // An invoice stating its balance due ("less deposit USD 200, balance due USD 480") is asking for the balance.
  const part = due ? null : depositIn(text, found);
  if (part) return { amountMinor: part.amountMinor, currency: part.currency };
  const total = due ?? found.find((f) => /(total|=|sum)[^0-9$]{0,12}$/i.test(lead(f)));
  const pick = total ?? found.reduce((a, b) => (b.amountMinor > a.amountMinor ? b : a));
  return { amountMinor: pick.amountMinor, currency: pick.currency };
}

type Found = { amountMinor: number; currency: string; index: number; length: number };

const DEPOSIT_WORD = /\b(deposit|down ?payment|dat coc|đặt cọc|advance payment)\b/i;

/** The figure a deposit request asks for now: the one next to the word "deposit", or a stated percentage of the total. */
function depositIn(text: string, found: Found[]): Found | null {
  if (!DEPOSIT_WORD.test(text) || /\b(less|minus|after|paid|received)\s+(the\s+)?(deposit|down ?payment)\b/i.test(text)) return null;
  // "deposit USD 425" first; "USD 425 deposit" only if no figure follows the word.
  const near = found.find((f) => DEPOSIT_WORD.test(text.slice(Math.max(0, f.index - 20), f.index))) ?? found.find((f) => /^\s*(\(?\d{1,2}\s?%\)?\s*)?(deposit|down ?payment)/i.test(text.slice(f.index + f.length, f.index + f.length + 20)));
  if (near) return near;
  const pct = text.match(/(\d{1,2})\s?%\s*(?:deposit|down ?payment)/i);
  if (pct && found.length) {
    const total = found.reduce((a, b) => (b.amountMinor > a.amountMinor ? b : a));
    return { ...total, amountMinor: Math.round((total.amountMinor * Number(pct[1])) / 100) };
  }
  return null;
}

/** Is this request a deposit against a larger total, or the balance after one? */
export function paymentPartOf(text: string, amountMinor: number, currency: string, evidenceTotals: number[]): { kind: "deposit" | "balance" | "part"; ofTotalMinor: number | null } | null {
  const found = findAmounts(text.slice(0, MAX_REQUEST_CHARS)).filter((f) => f.currency === currency);
  const largest = Math.max(0, ...found.map((f) => f.amountMinor), ...evidenceTotals);
  const depositPaid = /\b(less|minus|after|paid|received)\s+(the\s+)?(deposit|down ?payment)\b/i.test(text);
  if (DEPOSIT_WORD.test(text) && !depositPaid && largest > amountMinor) return { kind: "deposit", ofTotalMinor: largest };
  if (depositPaid && largest > amountMinor) return { kind: "balance", ofTotalMinor: largest };
  if (/\b(pay|settle|send)\b[^.\n]{0,20}\b(remaining |the )?balance\b|\bbalance (payment|due|owing)\b|\bremaining balance\b/i.test(text)) return { kind: "balance", ofTotalMinor: largest > amountMinor ? largest : null };
  if (/\b(part|partial) payment\b/i.test(text) && largest > amountMinor) return { kind: "part", ofTotalMinor: largest };
  return null;
}

/** Every amount stated in a text, with its currency, in the order written. */
export function amountsIn(text: string): Array<{ amountMinor: number; currency: string }> {
  return findAmounts(text.slice(0, MAX_REQUEST_CHARS)).sort((a, b) => a.index - b.index).map(({ amountMinor, currency }) => ({ amountMinor, currency }));
}

function findAmounts(text: string): Found[] {
  // e.g. "$180", "USD 1,240.50", "180 USD", "PHP 9,000", "₱9,000". Commas are only thousands separators
  // (exactly three digits follow), and a number glued to an identifier ("INV-K-77", "HG-4D-0914") is not an
  // amount. When a request lists several figures prefer, in order: "balance due" / "amount due" / "total" / "=",
  // else the largest.
  // Linear by construction: a match cannot start right after a digit, comma or dot (so it never restarts inside a
  // long run like "000,000,000,..."), and plain digit runs are bounded. The old form was quadratic in the input.
  const num = "(\\d{1,3}(?:,\\d{3}){1,6}|\\d{1,12})(?:\\.(\\d{1,2}))?";
  const re = new RegExp(`(?<![A-Za-z0-9,.-])(?:(\\$|US\\$|USD|PHP|₱|VND|₫|THB|฿|EUR|€|GBP|£)\\s?${num}|${num}\\s?(USD|PHP|VND|₫|đ|THB|฿|EUR|GBP))(?![A-Za-z0-9-]|[.,]\\d)`, "gi");
  const found: Found[] = [];
  for (const m of text.matchAll(re)) {
    const symbol = (m[1] ?? m[6] ?? "").toLowerCase();
    const whole = (m[2] ?? m[4] ?? "").replace(/,/g, "");
    const frac = m[3] ?? m[5] ?? "";
    const value = Number.parseFloat(frac ? `${whole}.${frac}` : whole);
    if (!Number.isFinite(value) || value <= 0) continue;
    found.push({ amountMinor: Math.round(value * 100), currency: CURRENCY_WORDS[symbol] ?? symbol.toUpperCase(), index: m.index ?? 0, length: m[0].length });
  }
  // Vietnamese invoices group thousands with dots: "2.500.000 VND", "10.800.000đ". Only for VND, which has no
  // decimals, so a dot there can never be a decimal point.
  const vnd = /(?<![A-Za-z0-9,.-])(?:(?:VND|₫)\s?(\d{1,3}(?:\.\d{3}){1,4})|(\d{1,3}(?:\.\d{3}){1,4})\s?(?:VND|₫|đ|đồng|dong))(?![A-Za-z0-9-])/gi;
  for (const m of text.matchAll(vnd)) {
    const value = Number((m[1] ?? m[2] ?? "").replace(/\./g, ""));
    if (Number.isFinite(value) && value > 0) found.push({ amountMinor: value * 100, currency: "VND", index: m.index ?? 0, length: m[0].length });
  }
  return found;
}

export function extractReference(text: string): string | null {
  const m = text.match(/\b((?:INV|JOB|BK|PO|REF|TRIP|TOUR)-[A-Z0-9-]{3,})\b/i);
  return m ? m[1].toUpperCase() : null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const month = (w: string): number | undefined => MONTHS[w.slice(0, 4).toLowerCase()] ?? MONTHS[w.slice(0, 3).toLowerCase()];
const pad = (n: number) => String(n).padStart(2, "0");
function ymd(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}
/** One date at the start of `s`: 2026-10-22, 22 October 2026, October 22, 2026, 22/10/2026 (day first), ngay 22 thang 10 nam 2026. */
function dateAt(s: string): string | null {
  let m = s.match(/^(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})/);
  if (m && month(m[2])) return ymd(+m[3], month(m[2])!, +m[1]);
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})/);
  if (m && month(m[1])) return ymd(+m[3], month(m[1])!, +m[2]);
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](20\d{2})/);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = s.match(/^(?:ng[aà]y\s+)?(\d{1,2})\s+th[aá]ng\s+(\d{1,2})\s+n[aă]m\s+(20\d{2})/i);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  return null;
}
function labelled(text: string, label: RegExp): string | null {
  for (const m of text.matchAll(label)) {
    const d = dateAt(text.slice((m.index ?? 0) + m[0].length).trimStart());
    if (d) return d;
  }
  return null;
}
export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * The invoice's own dates, read from the request and its documents: when it was issued, when it is due, and its
 * terms. "Net 14" counts from the invoice date when there is one, else from `today` (the business's local date).
 * A bare word like "today" is not a due date; it is pressure (see the urgency check).
 */
export function extractInvoiceDates(text: string, today: string): { invoiceDate: string | null; dueDate: string | null; termsDays: number | null } {
  const invoiceDate = labelled(text, /\b(?:invoice\s+date|date\s+of\s+issue|issued(?:\s+on)?|dated|date|ng[aà]y\s+(?:l[aậ]p|h[oó]a\s+đ[oơ]n))\s*[:\-]?\s*/gi) ?? labelled(text, /\bng[aà]y\s+(?=\d)/gi);
  const terms = text.match(/\b(?:net|terms?:?\s*(?:net)?)\s?(\d{1,3})(?:\s*days?)?\b/i) ?? text.match(/\b(?:within|in)\s+(\d{1,3})\s+days\b/i);
  const termsDays = terms ? Math.min(365, Number(terms[1])) : null;
  const explicit = labelled(text, /\b(?:due\s+date|due(?:\s+(?:on|by))?|payable\s+by|pay\s+by|please\s+pay\s+by|h[aạ]n\s+thanh\s+to[aá]n)\s*[:\-]?\s*/gi);
  const dueDate = explicit ?? (termsDays != null ? addDays(invoiceDate ?? today, termsDays) : null);
  return { invoiceDate, dueDate, termsDays };
}

export function extractDueDate(text: string, today = new Date().toISOString().slice(0, 10)): string | null {
  return extractInvoiceDates(text, today).dueDate;
}

export function matchVendor(text: string, vendors: VendorPayoutProfile[]): VendorPayoutProfile | null {
  const lower = text.slice(0, MAX_REQUEST_CHARS).toLowerCase();
  const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const singles = vendors.filter((v) => v.name.toLowerCase().split(/\s+/).some((p) => p.length >= 3 && new RegExp(`\\b${esc(p)}\\b`, "i").test(lower)));
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
  const paymentPart = money ? paymentPartOf(rawInput, money.amountMinor, money.currency, evidenced.filter((e) => e.currency === money.currency).map((e) => e.amountMinor!)) : null;
  if (paymentPart?.kind === "deposit" && paymentPart.ofTotalMinor) adopted.push(`Deposit of ${fmt(money!.amountMinor, money!.currency)} against a total of ${fmt(paymentPart.ofTotalMinor, money!.currency)}; the balance is a separate payment`);
  else if (paymentPart?.kind === "balance") adopted.push("Balance payment: checked against what is still open on the invoice");
  if (money && evidenced.length > 0) {
    const same = evidenced.find((e) => e.currency === money.currency && e.amountMinor === money.amountMinor);
    if (same || (paymentPart && evidenced.some((e) => e.currency === money.currency && (e.amountMinor ?? 0) > money.amountMinor))) {
      confidence += 5;
    } else {
      const byRef = ref ? evidenced.find((e) => e.reference && e.reference.toUpperCase() === ref) : undefined;
      const e = byRef ?? [...evidenced].sort((a, b) => Math.abs((a.amountMinor ?? 0) - money.amountMinor) - Math.abs((b.amountMinor ?? 0) - money.amountMinor))[0];
      const diff = money.amountMinor - (e.amountMinor ?? 0);
      flags.push(`Requested amount differs from ${e.label} by ${fmt(Math.abs(diff), e.currency!)} (${diff > 0 ? "higher" : "lower"})`);
      confidence -= 25;
    }
    const withRefs = evidence.filter((e) => e.reference);
    if (ref && withRefs.length > 0 && !withRefs.some((e) => e.reference!.toUpperCase() === ref)) {
      flags.push(`Reference ${ref} does not appear on any attached record (found ${withRefs.map((e) => e.reference).join(", ")})`);
    }
  } else if (money && evidenced.length === 0 && evidence.length === 0) {
    missing.push("supporting evidence (job sheet, contract or invoice)");
  }

  // Pressure words, not scheduling words: "deposit due now" or "balance due today" on an invoice is a due date.
  // An amount or a percentage may sit between them: "50% deposit USD 425 now", "balance of VND 2.000.000 due today".
  const pressure = rawInput.replace(/\b(due|payable|balance|deposit)\b[^.;!\n]{0,30}?\b(now|today)\b/gi, "");
  if (/\b(urgent|urgently|asap|today|now|immediately)\b/i.test(pressure)) {
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
    ? `${vendor.name} is owed ${fmt(money.amountMinor, money.currency)}${ref ? ` for ${ref}` : ""}${dueDate ? `, due ${dueDate}` : ""}. ${flags.length === 0 ? "The request matches the attached evidence." : `${flags.length} concern${flags.length === 1 ? "" : "s"} noted.`}`
    : `Could not fully read the request. ${missing.length ? `Missing: ${missing.join(", ")}.` : ""}`;

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
    paymentPart,
  };
}

function describe(raw: string, vendor: VendorPayoutProfile | null, money: { amountMinor: number; currency: string } | null, ref: string | null): string {
  const firstLine = raw.split(/\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? raw;
  const trimmed = firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine;
  if (vendor && money) return `${vendor.name}${ref ? ` (${ref})` : ""}: ${trimmed}`;
  return trimmed;
}

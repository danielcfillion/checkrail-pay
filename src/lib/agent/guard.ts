import { and, desc, eq, gte, like, or } from "drizzle-orm";
import { snapshotOf, type Db } from "../db";
import { agentChecks, agentMandates, agentOffers, obligations, vendors } from "../db/schema";
import { getBusiness } from "../queries";
import { newId, now } from "../domain/ids";
import { SUPPORTED_CURRENCIES, ZERO_DECIMAL_CURRENCIES, isValidSourceRef } from "../domain/money";
import { bareKey, canonicalRef, jobKeys, jobOfRef, sourceRefKeys } from "../domain/ids";
import { distinctiveWords, isGenericWord, normaliseName } from "../domain/vendorNames";
import { amountsIn } from "../ai/extractor";
import { TRANSITIONS, effectiveAutonomy, type ObligationState } from "../domain/types";
import { transition } from "../domain/stateMachine";
import { AGENT_FLAG_PREFIX, SPREAD_LIMIT, ingestObligation, outsideBillMatch, previewPolicy, supplierBillReview } from "../engine/orchestrator";
import { formatMoney } from "../format";
import { evaluatePayment, verdictOf, type Verdict } from "../check/evaluate";
import { isSupplierKey, type AgentKey } from "./keys";
import { guideFor } from "./rules";
import { BILL_NEUTRAL } from "../api/redact";
import { outsideView, type RequestStatus } from "../api/view";
import { AgentInputError } from "./errors";
import { assessProvenance, PROVENANCE_HINT, validateProvenance } from "./provenance";
import { loadMandate, outOfScope, spentUnder, type MandateRow } from "./mandates";
import { counterOfferFrom, offerForAgent, offerOnObligation, recordOffer, supplierLabel, type CounterOffer } from "./offers";

/**
 * The agent guard: what outside agents may ask Checkrail, and nothing more.
 *
 *  - check_payment judges a payment on an in-memory copy of the books (snapshotOf). It cannot change the books and
 *    cannot pay: the only write it makes is one row in agent_checks saying who asked what and what was answered.
 *  - request_payment puts a request in the inbox exactly as a clerk would. Policy and the business's autonomy setting
 *    decide what happens next; an agent can never approve, release or send. What it attaches counts as its own say-so,
 *    unless the owner gave its key the attest scope (a system of record), when it counts like any integration's records.
 *  - payment_status, lookup_payee and explain_rule only read.
 *
 * Everything an agent sends is data. The payee, amount, currency and reference the agent sends as fields are the
 * request: the reader never replaces them, so a verdict covers exactly what was sent. When the
 * agent's own text disagrees with its fields, a person looks (a hold), and the agent is told not to change a field to
 * match.
 * Messages coming back are trimmed, carry no internal ids, emails, account numbers or other suppliers' names, because
 * they can quote what a supplier wrote and the calling agent will read them.
 */

export { AgentInputError };

const EVIDENCE_KINDS = ["contract", "booking", "job_sheet", "invoice", "message", "photo", "receipt", "purchase_order"] as const;
const PROBE_WINDOW_MS = 15 * 60_000;
const PROBE_DISTINCT_AMOUNTS = 3;

export interface PaymentArgs {
  payee: string;
  amount: string | number;
  currency: string;
  reference?: string | null;
  description?: string | null;
  evidence?: Array<{ kind: string; label: string; amount?: string | number | null; reference?: string | null; excerpt?: string | null }>;
}

// ---------- Input ----------

function text(v: unknown, name: string, max: number, required = false): string | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new AgentInputError(`${name} is required`);
    return null;
  }
  if (typeof v !== "string") throw new AgentInputError(`${name} must be a string`);
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (t.length > max) throw new AgentInputError(`${name} must be at most ${max} characters`);
  return t;
}

/** "960", "960.50", 960, "2,500,000" or "2500000" to hundredths. Nothing looser: an agent states amounts exactly. */
export function amountToMinor(v: unknown, name = "amount"): number {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(2) : "") : typeof v === "string" ? v.trim() : "";
  const m = s.match(/^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new AgentInputError(`${name} must be a positive number such as "960.00" (no currency symbol)`);
  const minor = Number(m[1].replace(/,/g, "")) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new AgentInputError(`${name} must be more than zero`);
  return minor;
}

/** A reference as references are written: letters, digits and . _ / # : - only, no spaces or line breaks. */
function refText(v: unknown, name: string): string | null {
  const t = text(v, name, 64);
  if (t !== null && !isValidSourceRef(t)) throw new AgentInputError(`${name} must be letters and digits, with only . _ / # : - between them (no spaces), as on the invoice or job sheet`);
  return t;
}

export function validatePaymentArgs(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new AgentInputError("Arguments must be an object");
  const a = raw as Record<string, unknown>;
  const payee = text(a.payee, "payee", 80, true)!;
  const currency = (text(a.currency, "currency", 3, true) ?? "").toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) throw new AgentInputError(`currency must be one of ${SUPPORTED_CURRENCIES.join(", ")}`);
  const amountMinor = amountToMinor(a.amount);
  // VND has no smaller unit: "4320000.50" is a typo, not an amount.
  const whole = (minor: number | null, name: string) => {
    if (minor != null && ZERO_DECIMAL_CURRENCIES.has(currency) && minor % 100 !== 0) throw new AgentInputError(`${name} must be a whole number of ${currency}`);
    return minor;
  };
  whole(amountMinor, "amount");
  const reference = refText(a.reference, "reference");
  const description = text(a.description, "description", 2000);
  const evRaw = a.evidence ?? [];
  if (!Array.isArray(evRaw) || evRaw.length > 10) throw new AgentInputError("evidence must be a list of at most 10 records");
  const evidence = evRaw.map((e, i) => {
    if (!e || typeof e !== "object") throw new AgentInputError(`evidence[${i}] must be an object`);
    const r = e as Record<string, unknown>;
    const kind = text(r.kind, `evidence[${i}].kind`, 20, true)!;
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) throw new AgentInputError(`evidence[${i}].kind must be one of ${EVIDENCE_KINDS.join(", ")}`);
    return {
      kind,
      label: text(r.label, `evidence[${i}].label`, 200, true)!,
      amountMinor: whole(r.amount == null || r.amount === "" ? null : amountToMinor(r.amount, `evidence[${i}].amount`), `evidence[${i}].amount`),
      currency,
      reference: refText(r.reference, `evidence[${i}].reference`),
      excerpt: text(r.excerpt, `evidence[${i}].excerpt`, 2000),
    };
  });
  return { payee, amountMinor, currency, reference, description, evidence };
}

// ---------- Who and what the agent meant ----------

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The supplier the agent named: exact name, the contact email on file, or else the one supplier whose name is the same
 * once accents and punctuation are set aside ("Huong Giang Boats" for "Hương Giang Boats"). Never the
 * PayPal email.
 */
function vendorNamed(db: Db, businessId: string, payee: string) {
  const all = db.select().from(vendors).where(eq(vendors.businessId, businessId)).all();
  const want = norm(payee);
  const exact = all.find((v) => norm(v.name) === want || (v.email ?? "").toLowerCase() === want);
  if (exact) return exact;
  const folded = normaliseName(payee);
  const same = folded ? all.filter((v) => normaliseName(v.name) === folded) : [];
  return same.length === 1 ? same[0] : null;
}

/** Units a count can be of: "2 days", "9 guests", "x 2". */
const COUNT_RE = /(?<![\p{L}\p{N}.,/-])(\d{1,3})\s*(?:days?|nights?|guests?|pax|people|persons?|adults?|children|kids|vehicles?|vans?|cars?|bikes?|boats?|rooms?|hours?|trips?|departures?|seats?|porters?|guides?)\b|\bx\s*(\d{1,3})(?!\p{N}|[.,]\p{N})|(?<![\p{L}\p{N}.,/-])(\d{1,3})\s*x\b/giu;
/** A figure labelled as paid already, a deposit or taken off. */
const SUBTRACTED = /(deposit|paid|less|minus|discount|credit|advance|already)/i;
/** A figure the text asks to be paid now: right after "pay", "please pay", "balance due", "amount due". */
const ASKED = /(?:please pay|pay|balance due|amount due|now due)[^0-9$₱₫฿]{0,12}$/i;
/** A figure labelled as the total. */
const TOTALLED = /(?:total|sum|=)[^0-9$₱₫฿]{0,12}$/i;
/** A figure that is a rate: "USD 95 a day", "USD 95/day", "USD 18 per guest", "at USD 95", "x USD 18", "@ USD 18". */
const RATE_AFTER = /^\s*(?:\/\s*\p{L}|per\b|a\s+(?:day|night|guest|person|pax|head|trip|hour|vehicle)\b|each\b)/iu;
const RATE_BEFORE = /(?:@|\bx|\bat)\s*$/i;
/** A figure added on: "plus USD 10", "+ USD 10", "and a USD 10 boat fee". */
const ADDED_BEFORE = /(?:\bplus|\+|\band(?:\s+an?)?)\s*$/i;

type Stated = { amountMinor: number; currency: string; index: number; length: number };

/**
 * Does the amount sent follow from the figures stated?
 * The figures it may start from are the one the text asks to pay when there is one, else any. From those: the figure
 * itself, a rate times counts stated with a unit, then plus a figure added on ("plus", "+"), less a figure labelled as
 * a deposit, paid or a discount, less a stated discount percentage, or a stated percentage of it (a deposit). A part
 * never exceeds a figure labelled as the total. Numbers in references and dates are not counts.
 */
function amountFollows(sent: number, stated: Stated[], text: string): boolean {
  const before = (x: Stated, n = 24) => text.slice(Math.max(0, x.index - n), x.index);
  const after = (x: Stated, n = 24) => text.slice(x.index + x.length, x.index + x.length + n);
  if (stated.some((x) => TOTALLED.test(before(x)) && sent > x.amountMinor)) return false;
  const asked = stated.filter((x) => ASKED.test(before(x)));
  const bases = asked.length ? asked : stated;
  let rest = text;
  for (const x of [...stated].sort((p, q) => q.index - p.index)) rest = `${rest.slice(0, x.index)} ${rest.slice(x.index + x.length)}`;
  // Each stated count is used once: "USD 95 a day for 2 days" is 2 days, never 2 x 2.
  const counts = [...rest.matchAll(COUNT_RE)].map((m) => Number(m[1] ?? m[2] ?? m[3])).filter((n) => n >= 1 && n <= 366).slice(0, 6);
  const products = new Set<number>();
  for (let mask = 1; mask < 1 << counts.length; mask++) products.add(counts.reduce((acc, n, i) => (mask & (1 << i) ? acc * n : acc), 1));
  const values: Array<{ v: number; from: Stated }> = [];
  for (const b of bases) {
    values.push({ v: b.amountMinor, from: b });
    if (RATE_AFTER.test(after(b)) || RATE_BEFORE.test(before(b, 6))) for (const n of products) values.push({ v: b.amountMinor * n, from: b });
  }
  const taken = stated.filter((x) => SUBTRACTED.test(`${before(x, 20)} ${after(x, 20)}`));
  // A figure labelled as paid is never added on, whatever joins it ("and USD 190 already paid").
  const added = stated.filter((x) => !taken.includes(x) && (ADDED_BEFORE.test(before(x, 12)) || /^\s*(?:\p{L}+\s+){0,2}fee\b/iu.test(after(x))));
  // Percentages up to 100 only: a "200% surcharge" is a penalty clause, not the payment. Withholding and other
  // deductions take a percentage off.
  const pcts = [...text.matchAll(/(\d{1,3})\s?%/g)].map((m) => ({ p: Number(m[1]), off: /less|minus|discount|off\b|deduct|withh?old/i.test(text.slice(Math.max(0, m.index! - 16), m.index! + m[0].length + 24)) })).filter(({ p }) => p > 0 && p <= 100);
  for (const { v, from } of values) {
    if (v === sent) return true;
    if (added.some((y) => y !== from && v + y.amountMinor === sent)) return true;
    if (taken.some((y) => y !== from && v - y.amountMinor === sent)) return true;
    if (pcts.some(({ p, off }) => Math.round((v * (off ? 100 - p : p)) / 100) === sent)) return true;
  }
  return false;
}

/** The leading letters of a reference in its comparison form ("ceb" of CEB-2D-1024 and of JOB-CEB3D-1102). */
const familyOf = (ref: string) => (canonicalRef(ref) ?? "").match(/^\p{L}+/u)?.[0] ?? "";

/**
 * Phrases that say who is to be paid. "Send", "transfer" and "wire" count only with money before "to" ("transfer USD 190
 * to"), so "send the receipt to Maria" and "transfer to Maria's boat" do not; "credit" only as "credit (it) to".
 */
const PAY_PHRASE = /\b(?:pay(?:\s+out)?|paid to|payable to|payee|recipient|remit(?:\s+to)?|beneficiary(?:\s+is)?|credit(?:\s+it)?\s+to|owed to|settle with|thanh\s+to[aá]n\s+cho|tr[aả]\s+cho|chuy[eể]n\s+(?:kho[aả]n\s+|ti[eề]n\s+)?cho|payment\s+(?:goes\s+)?to|(?:money|funds|payment)\s+goes\s+to|send\s+(?:this|it)\s+to|(?:send|transfer|release|wire)\b[^.;!?\n]{0,30}?(?:\d|USD|PHP|VND|THB|EUR|\$|₱|money|payment|funds|fee|balance|\bit\b)[^.;!?\n]{0,10}?\b(?:to|into)|deposit\b[^.;!?\n]{0,30}?\binto)\b/giu;

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where the agent's own description disagrees with the fields it sent: one sentence per field, or none. Only the
 * description is read, never the header Checkrail writes from the fields. It disagrees when:
 *  - any paying phrase names, in the same clause, a supplier who is not the payee ("do not pay Rosa; pay Maria
 *    instead", "transfer USD 190 to Maria", "pay Rosa's partner Maria"), or, with no paying phrase, the words name
 *    other suppliers and never the payee;
 *  - it states amounts, in any currency, and the amount sent does not follow from them (see amountFollows);
 *  - it names another job of the same kind as the reference sent (CEB-3D-1102 for CEB-2D-1024), however written.
 * Text is read after NFKC with zero-width characters removed, so full-width or hidden letters change nothing.
 * Disagreement is a hold for a person, never a reason to change a field.
 */
function disagreementsOf(db: Db, businessId: string, asked: { id: string; name: string } | null, a: ReturnType<typeof validatePaymentArgs>): string[] {
  if (!a.description) return [];
  const d = a.description.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "");
  const parts: string[] = [];
  const names = db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.businessId, businessId)).all();
  const wordsOf = (v: { id: string; name: string }) => distinctiveWords(v.name, names.filter((o) => o.id !== v.id).map((o) => o.name));
  const mentionAt = (text: string, v: { id: string; name: string }): number => {
    const t = ` ${normaliseName(text)} `;
    const full = normaliseName(v.name);
    const hits = [full && t.indexOf(` ${full} `), ...wordsOf(v).map((w) => t.indexOf(` ${w} `))].filter((i): i is number => typeof i === "number" && i >= 0);
    return hits.length ? Math.min(...hits) : -1;
  };
  // A possessive names someone else's thing ("Rosa's partner", "Maria's boat"), not the payee, unless it is an account.
  const possessive = (text: string, v: { id: string; name: string }) =>
    [v.name, ...wordsOf(v)].some((w) => new RegExp(`(?<![\\p{L}])${escapeRe(w)}['’]s\\b(?!\\s+(?:paypal\\s+)?(?:account|wallet|paypal|bank))`, "iu").test(text));
  const payees = new Set<string>();
  // Who agreed or confirmed is not who is paid: "as agreed with Maria", "confirmed by Maria", "as Maria confirmed" are
  // taken out before reading who a paying phrase names. Only these, not a bare comma or "as", so "Pay, as agreed,
  // Maria Santos" and "Pay the fee as invoiced to Maria Santos" still name Maria.
  const attribution = /\b(?:as\s+)?(?:agreed|confirmed|approved|arranged|signed|checked|noted)\s+(?:with|by)\s+[^,.;!?\n]*|\bas\s+(?:[\p{L}'’]+\s+){1,3}(?:confirmed|agreed|said|approved|noted|checked)\b|\bas\s+(?:agreed|confirmed|noted)\b|\baccording\s+to\s+[^,.;!?\n]*/giu;
  const dPay = d.replace(attribution, " ");
  for (const m of dPay.matchAll(PAY_PHRASE)) {
    // The clause after the phrase, up to a full stop or a semicolon; the first supplier named in it is who is paid.
    const clause = dPay.slice(m.index! + m[0].length).split(/[.;!?\n]/)[0].slice(0, 80);
    const hit = names.map((v) => ({ v, at: mentionAt(clause, v) })).filter((x) => x.at >= 0 && !possessive(clause, x.v)).sort((x, y) => x.at - y.at)[0];
    if (hit) payees.add(hit.v.id);
  }
  // "Maria Santos should be paid": the last supplier named before the passive.
  for (const m of dPay.matchAll(/\b(?:should|must|will|is\s+to|needs?\s+to|to)\s+be\s+paid\b/gi)) {
    const clause = dPay.slice(0, m.index!).split(/[.;!?\n]/).pop() ?? "";
    const hit = names.map((v) => ({ v, at: mentionAt(clause, v) })).filter((x) => x.at >= 0).sort((x, y) => y.at - x.at)[0];
    if (hit) payees.add(hit.v.id);
  }
  // Another supplier named with a payout word in the same clause ("to Maria Santos's PayPal") asks to pay them.
  for (const clause of d.split(/[.;!?\n]/)) {
    if (!/\b(?:paypal|account|wallet|bank|iban|stellar)\b/i.test(clause)) continue;
    for (const v of names) if (v.id !== asked?.id && mentionAt(clause, v) >= 0 && new RegExp(`${escapeRe(v.name)}(?:['’]s)?\\s+(?:\\p{L}+\\s+)?(?:paypal|account|wallet|bank)`, "iu").test(clause)) payees.add(v.id);
  }
  const otherPayee = names.find((v) => payees.has(v.id) && v.id !== asked?.id);
  const mentioned = names.filter((v) => mentionAt(d, v) >= 0);
  if (otherPayee) parts.push(`it asks to pay ${otherPayee.name}, not the payee sent`);
  else if (payees.size === 0 && mentioned.length > 0 && !mentioned.some((v) => v.id === asked?.id)) parts.push(`it names ${mentioned[0].name} and not the payee sent`);
  // Amounts are read with supplier names taken out, so "Please pay Rosa Villanueva USD 190" is an asked figure.
  let dAmt = d;
  for (const v of [...names].sort((x, y) => y.name.length - x.name.length)) dAmt = dAmt.replace(new RegExp(escapeRe(v.name), "giu"), " ");
  const stated: Stated[] = amountsIn(dAmt);
  // "pay 95 only": a figure right after "pay" with no currency is in the currency sent.
  for (const m of dAmt.matchAll(/\bpay\s+(\d{1,3}(?:,\d{3})+|\d{2,9})(?:\.(\d{1,2}))?(?![\d.,]|\s*(?:%|days?|nights?|guests?|pax|people|persons?)\b)/gi)) {
    const minor = Number(m[1].replace(/,/g, "")) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
    const at = m.index! + m[0].indexOf(m[1]);
    stated.push({ amountMinor: minor, currency: a.currency, index: at, length: m.index! + m[0].length - at });
  }
  // "total 190": a total with no currency is in the currency sent.
  for (const m of dAmt.matchAll(/\btotal\s*[:=]?\s*(\d{1,3}(?:,\d{3})+|\d{2,9})(?:\.(\d{1,2}))?(?!\d|[.,]\d|\s*(?:%|\p{L}))/giu)) {
    const minor = Number(m[1].replace(/,/g, "")) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
    const at = m.index! + m[0].indexOf(m[1]);
    if (!stated.some((x) => x.index === at)) stated.push({ amountMinor: minor, currency: a.currency, index: at, length: m.index! + m[0].length - at });
  }
  stated.sort((x, y) => x.index - y.index);
  if (stated.length > 0) {
    const same = stated.filter((x) => x.currency === a.currency);
    if (same.length === 0 || !amountFollows(a.amountMinor, same, dAmt)) parts.push(`it states ${[...new Set(stated.map((x) => formatMoney(x.amountMinor, x.currency, { code: true })))].slice(0, 3).join(", ")}, not the ${formatMoney(a.amountMinor, a.currency, { code: true })} sent`);
  }
  if (a.reference) {
    const sent = new Set([...sourceRefKeys(a.reference), ...jobKeys(a.reference)].filter((k) => k.startsWith("~")));
    // Job identifiers however typed: the dashed ones jobKeys finds, and unseparated runs of letters and three or more
    // digits like CEB3D1102 (not "CEB 2 day" or "Inv 1 of 2").
    const loose = (d.match(/\b\p{L}{2,6}[-_./]?\d[\p{L}\p{N}]*(?:[-_./]\p{L}*\d[\p{L}\p{N}]*)*\b/gu) ?? []).filter((x) => (x.match(/\d/g) ?? []).length >= 3);
    const ids = [...new Set([...jobKeys(d).filter((k) => !k.startsWith("~")), ...loose])];
    const same = (k: string) => [...sourceRefKeys(k), ...jobKeys(k)].some((x) => x.startsWith("~") && sent.has(x));
    const family = familyOf(a.reference);
    const other = family ? ids.find((k) => familyOf(k) === family && !same(k)) : undefined;
    if (other && !ids.some(same)) parts.push(`it names ${other.toUpperCase()}, not the reference ${a.reference} sent`);
  }
  return parts.map((p) => `${AGENT_FLAG_PREFIX}: ${p}. A person confirms which is right`);
}

/**
 * The probe key: the supplier Checkrail resolved (else the name as normalised), the currency and the reference. Trying
 * amount after amount for one job is looking for the line; a batch of different jobs is not.
 */
const probeKeyOf = (vendorId: string | null | undefined, payee: string, currency: string, reference: string | null) =>
  `${vendorId ? `ven:${vendorId}` : `name:${normaliseName(payee)}`}|${currency}|${jobOfRef(reference) ?? (reference ?? "").toLowerCase()}`;

/** Every comparison form of a reference, as the duplicate check sees it, so a probe is caught under any spelling. */
const probeForms = (reference: string | null) => new Set([...sourceRefKeys(reference), ...jobKeys(reference)].map(bareKey).filter((k) => k.length >= 3));

function probing(db: Db, agent: AgentKey, key: string, amountMinor: number, reference: string | null = null): number {
  const head = key.slice(0, key.lastIndexOf("|") + 1);
  const mine = probeForms(reference);
  const recent = db.select({ amountMinor: agentChecks.amountMinor, payeeKey: agentChecks.payeeKey, reference: agentChecks.reference }).from(agentChecks)
    .where(and(eq(agentChecks.agent, agent.name), like(agentChecks.payeeKey, `${head}%`), gte(agentChecks.createdAt, new Date(Date.now() - PROBE_WINDOW_MS).toISOString())))
    .all()
    .filter((x) => x.payeeKey === key || (mine.size > 0 && [...probeForms(x.reference)].some((f) => mine.has(f))));
  return new Set([...recent.map((x) => x.amountMinor), amountMinor]).size;
}

/** Different references this agent asked about for this supplier in the last ten minutes, this one aside. */
function referenceSpread(db: Db, agent: AgentKey, key: string, reference: string | null): number {
  const head = key.slice(0, key.indexOf("|") + 1);
  const mine = (reference ?? "").trim().toUpperCase();
  const rows = db.select({ reference: agentChecks.reference }).from(agentChecks)
    .where(and(eq(agentChecks.agent, agent.name), like(agentChecks.payeeKey, `${head}%`), gte(agentChecks.createdAt, new Date(Date.now() - 10 * 60_000).toISOString())))
    .all();
  return new Set(rows.map((r) => (r.reference ?? "").trim().toUpperCase()).filter((r) => r && r !== mine)).size;
}

/**
 * The request text Checkrail keeps and reads: a header written from the fields, amount first and the supplier by the
 * name on file, then the agent's own words quoted, never mistaken for ours. The agent's
 * name is not in it: a name like "tour-desk" would read as a reference. The audit log records who asked.
 */
function requestTextFor(kind: string, payeeName: string, a: ReturnType<typeof validatePaymentArgs>): string {
  const head = `[Outside agent ${kind}] Pay ${formatMoney(a.amountMinor, a.currency, { code: true })} to ${payeeName}${a.reference ? ` for ${a.reference}` : ""}.`;
  return a.description ? `${head} The request as the agent received it: "${a.description.replace(/\s+/g, " ").replace(/"/g, "'")}"` : head;
}

// ---------- Output ----------

/** What an agent attaches is its own say-so ("operator"), unless the owner made it a system of record ("attest"). */
export function evidenceSourceOf(agent: AgentKey): "system" | "operator" {
  return agent.scopes.includes("attest") ? "system" : "operator";
}

/** A word as redaction compares it, in any script: compatibility forms and accents set aside, case ignored. */
const foldWord = (w: string) => w.normalize("NFKD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase();
const wordsIn = (s: string) => [...s.matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, w: foldWord(m[0]) })).filter((t) => t.w.length > 0);

/**
 * What goes back to an agent: no internal ids, no emails, account numbers or payout addresses, no other supplier's
 * name, no runaway length. `others` are the names of suppliers the agent did not ask about; `keep` the
 * one it did. Names are matched as whole words in any script with accents set aside, and a distinctive part of a
 * name ("Maria" of "Maria Santos") counts too; the payee asked about is never cut. Reference-shaped
 * tokens ("INV-2026-000123") keep their digits.
 */
export function clean(message: string, others: string[] = [], keep: string | null = null): string {
  let out = message
    .normalize("NFKC")
    .replace(/obligation obl_[a-z0-9]+/gi, "an earlier payment")
    .replace(/\bobl_[a-z0-9]+/gi, "an earlier payment")
    .replace(/[^\s@<>"',;()]+@[^\s@<>"',;()]+\.[^\s@<>"',;().]{2,}/gu, "the payee's PayPal account")
    .replace(/[^\s*@<>"',;()]+\*[^\s*@<>"',;()]+\.[^\s*@<>"',;().]{2,}/gu, "[payout account]")
    .replace(/\b[GM][A-Z0-9]{34,75}\b/g, "[payout account]")
    .replace(/\b(?:IBAN|Iban|iban)\s*:?\s*[A-Za-z]{2}\d{2}(?:[\s-]?[0-9A-Z]){10,32}/g, "[payout account]")
    // An IBAN as banks write it, in groups of four (an unspaced PO number is a reference, not an account).
    .replace(/\b[A-Z]{2}\d{2}(?:[ -][A-Z0-9]{4}){2,7}(?:[ -][A-Z0-9]{1,4})?\b/g, "[payout account]")
    .replace(/\b(?:acct|account|acc\.?|a\/c)(?:\b|(?<=\.))(?:\s+(?:no\.?|number|ending(?:\s+in)?|#))?\s*[:#]?\s*\d[\d -]{2,}\d/gi, "[payout account]")
    .replace(/(?:\*{2,}|•{2,}|·{2,}|…|\.{3}|\b[xX]{3,})[-\s]?\d{2,}/g, "[payout account]")
    .replace(/\bending(?:\s+in)?\s+\d{4}\b/gi, "[payout account]")
    .replace(/(?<![\p{L}\p{N}-])\+?\d(?:[ .-]?\d){8,}(?![\p{L}\p{N}])/gu, "[number]");
  const keepWords = keep ? wordsIn(keep).map((t) => t.w) : [];
  const fulls = others.map((n) => wordsIn(n).map((t) => t.w)).filter((ws) => ws.join("").length >= 3).sort((x, y) => y.length - x.length);
  const otherWordSets = others.map((n) => wordsIn(n).map((t) => t.w));
  const parts = new Set(otherWordSets.flat().filter((w) => [...w].length >= 3 && !keepWords.includes(w) && !isGenericWord(w)));
  if (fulls.length || parts.size) {
    // A word inside a reference ("TAM" of INV-TAM-0834) is part of the reference, not a name: it stays.
    const inRef = [...out.matchAll(/[\p{L}\p{N}]+(?:[-_/.][\p{L}\p{N}]+)+/gu)].filter((m) => /\d/.test(m[0])).map((m) => [m.index!, m.index! + m[0].length] as const);
    const tokens = wordsIn(out).filter((t) => !inRef.some(([a, b]) => t.start >= a && t.end <= b));
    // The payee asked about is never cut: another supplier called "Rosa" leaves "Rosa Villanueva" whole.
    const kept = new Set<number>();
    for (let i = 0; keepWords.length && i < tokens.length; i++) if (keepWords.every((w, j) => tokens[i + j]?.w === w)) keepWords.forEach((_, j) => kept.add(i + j));
    const spans: Array<[number, number]> = [];
    for (let i = 0; i < tokens.length; i++) {
      if (kept.has(i)) continue;
      const full = fulls.find((f) => f.every((w, j) => tokens[i + j]?.w === w && !kept.has(i + j)));
      if (full) {
        spans.push([tokens[i].start, tokens[i + full.length - 1].end]);
        i += full.length - 1;
      } else if (parts.has(tokens[i].w)) spans.push([tokens[i].start, tokens[i].end]);
    }
    for (const [a, b] of spans.reverse()) out = `${out.slice(0, a)}another supplier${out.slice(b)}`;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * A rule's message as an agent may read it. That a reference is on another supplier's payment is enough for an agent
 * to stop; which supplier, and how far that payment got, would let an agent map who was paid for what.
 */
function forAgent(rule: string, message: string, supplier = false): string {
  if (rule === "reference_other_vendor") return "This reference is also on a payment to another supplier; a person checks who did the job";
  // The duplicate check names the other payment: its id, state, date and amounts. An agent is told only that there is
  // one, never what state it is in or when it moved.
  if (rule === "no_duplicate") return duplicateForAgent(message);
  // A supplier's agent attaches its own records: they are its say-so, not a clerk's typing (review AF-7). They are
  // stored as operator rows so they can never set a bill ceiling (AG-5); see SUPPLIER_EVIDENCE below.
  if (supplier && rule === "evidence_provenance") return "The records attached are the supplier's own say-so; a person checks them against the business's records";
  return message;
}

/** The duplicate check's finding, by kind, without anything about the other payment. */
function duplicateForAgent(message: string): string {
  if (message.startsWith("Shares booking or order ")) return "Shares booking or order with another payment to this supplier; a person confirms this is another part of the job, not the same one again";
  if (message.startsWith("Same amount as ")) return "Same amount as another payment to this supplier in the last 30 days; a person confirms this is a different job";
  if (message.startsWith("Same job as ")) return "Same job as another payment to this supplier";
  if (/^Reference \S+ was already used/.test(message)) return "This reference was already used by another payment to this supplier";
  return "This matches another payment to this supplier";
}

/**
 * How a supplier key's attachments are stored: "operator", not "vendor". Policy and every independence test treat both
 * as say-so, but the bill-ceiling guard in engine/orchestrator.ts (linkToBill, review AG-5) excludes only "operator"
 * rows of an outside agent, so a "vendor" row from a supplier's agent could set the total for later payments. Storing
 * them as "vendor" needs that money-path line changed first; until then the agent layer and the request page label them
 * as the supplier's say-so (review AF-7).
 */
export const SUPPLIER_EVIDENCE = "operator" as const;

function otherNames(db: Db, businessId: string, keep: Array<string | null | undefined>): string[] {
  const kept = new Set(keep.filter(Boolean).map((n) => norm(n!)));
  return db.select({ name: vendors.name }).from(vendors).where(eq(vendors.businessId, businessId)).all().map((v) => v.name).filter((n) => !kept.has(norm(n)));
}

function nextSteps(verdict: Verdict, failed: Array<{ rule: string }>): string[] {
  if (verdict === "pay") return ["Clear by this business's rules. Use request_payment to have Checkrail send it, or continue with the payment step your business set up for you."];
  const steps = [...new Set(failed.map((f) => guideFor(f.rule).clear))];
  if (verdict === "block") steps.push("Do not pay this through any other tool. Tell the person who asked what the message says.");
  else steps.push("If a person should decide, use request_payment: it goes to their inbox and nothing is sent without them.");
  return steps.slice(0, 6);
}

function businessOf(db: Db) {
  const biz = getBusiness(db);
  if (!biz) throw new AgentInputError("No business is set up in this Checkrail");
  return biz;
}

function paypalTxnIn(messages: string[]): string | null {
  for (const m of messages) {
    const hit = m.match(/PayPal transaction ([A-Z0-9]{8,24})/);
    if (hit) return hit[1];
  }
  return null;
}

function log(db: Db, row: Omit<typeof agentChecks.$inferInsert, "id" | "createdAt">): string {
  const id = newId("agc");
  db.insert(agentChecks).values({ ...row, id, createdAt: now() }).run();
  return id;
}

// ---------- check_payment ----------

export interface CheckAnswer {
  check_id: string;
  verdict: Verdict;
  summary: string;
  payee: string | null;
  amount: string;
  reference: string | null;
  blocks: Array<{ rule: string; message: string }>;
  warnings: Array<{ rule: string; message: string }>;
  next_steps: string[];
  paypal_transaction_id: string | null;
  /** The owner's autonomy setting; null for a supplier's agent, which is not told the business's settings. */
  autonomy: string | null;
  checked_at: string;
  note: string;
  /** Only when the agent sent no provenance: that it may. */
  provenance_hint?: string;
  /** Only for a supplier's agent blocked for more than the evidence or rate card supports. */
  counter_offer?: CounterOffer;
}

/** Rule ids for what the agent layer itself decided from provenance. */
const PROVENANCE_HOLD_RULE = "agent_provenance";
const PROVENANCE_REFUSAL_RULE = "provenance_payout_change";

/**
 * A supplier key's own supplier, and refusal of any payee that is not it. The refusal is logged (a supplier's agent
 * reaching for another supplier is worth an owner's eye) and says nothing about who the payee is.
 */
function supplierGate(db: Db, agent: AgentKey, biz: { id: string }, a: ReturnType<typeof validatePaymentArgs>, tool: string, extra: Partial<typeof agentChecks.$inferInsert> = {}): void {
  if (!isSupplierKey(agent)) return;
  const own = db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, agent.vendorId), eq(vendors.businessId, biz.id))).get();
  if (!own) throw new AgentInputError("This supplier key's supplier is not on file with this business. Ask the business to check the key.");
  const asked = vendorNamed(db, biz.id, a.payee);
  if (asked?.id === own.id) return;
  const summary = "A supplier's agent may only ask about payments to its own supplier.";
  log(db, { businessId: biz.id, agent: agent.name, tool, verdict: "refused", payee: a.payee, payeeKey: probeKeyOf(null, a.payee, a.currency, a.reference), amountMinor: a.amountMinor, currency: a.currency, reference: a.reference, summary, rulesJson: null, obligationId: null, idempotencyKey: null, ...extra });
  throw new AgentInputError(`Refused, and nothing was created: ${summary} This key acts for one supplier.`);
}

/** What a supplier's agent is told to do next: the business's own guidance on its rules stays with the business. */
function supplierSteps(verdict: Verdict, offer: CounterOffer | undefined): string[] {
  if (offer) return ["Accept the offer with accept_offer: a request at the offered amount goes to the business, and its rules and approval still apply.", "Or dispute it with dispute_offer, giving your reason and records: a person at the business reads them."];
  if (verdict === "block") return ["This payment cannot go ahead as sent. Contact the business about it."];
  if (verdict === "hold") return ["A person at the business decides. Use request_payment to put it in front of them."];
  return ["Clear by the business's checks. Use request_payment to put it in front of them."];
}

/**
 * Judge on a copy of the books, with the agent's fields fixed and any disagreement in its text as a hold. `holds` are
 * concerns the agent layer raised before judging (provenance); they go first, so the cap on concerns never drops them.
 */
async function judge(db: Db, agent: AgentKey, biz: { id: string }, a: ReturnType<typeof validatePaymentArgs>, kind: string, holds: string[] = []) {
  const asked = vendorNamed(db, biz.id, a.payee);
  const concerns = [...holds, ...disagreementsOf(db, biz.id, asked, a)];
  const stated = { vendorId: asked?.id ?? null, amountMinor: a.amountMinor, currency: a.currency, sourceRef: a.reference, flags: concerns, trusted: agent.scopes.includes("attest") };
  // The copy is closed as soon as the check is done: a native database copy per check must not pile up (AG7 run).
  const copy = snapshotOf(db);
  const r = await evaluatePayment(copy, { businessId: biz.id, payee: asked?.name ?? a.payee, amountMinor: a.amountMinor, currency: a.currency, reference: a.reference, description: a.description, evidence: a.evidence, evidenceSource: evidenceSourceOf(agent), actor: `mcp:${agent.name}`, text: requestTextFor(kind, asked?.name ?? a.payee, a), stated }).finally(() => (copy as unknown as { $client: { close(): void } }).$client.close());
  return { asked, stated, r, payeeKey: probeKeyOf(asked?.id, a.payee, a.currency, a.reference) };
}

export async function checkPayment(db: Db, agent: AgentKey, raw: unknown): Promise<CheckAnswer> {
  const a = validatePaymentArgs(raw);
  const prov = validateProvenance((raw as Record<string, unknown>).provenance);
  const provenanceJson = prov ? JSON.stringify(prov) : null;
  const biz = businessOf(db);
  supplierGate(db, agent, biz, a, "check_payment", { provenanceJson });
  const found = assessProvenance(prov);
  const { asked, r, payeeKey } = await judge(db, agent, biz, a, "check", found.holds);
  const others = otherNames(db, biz.id, [asked?.name]);
  const keep = asked?.name ?? null;
  let verdict = r.verdict;
  const supplier = isSupplierKey(agent);
  // A payment held because of bills reads the same to an agent whether it names a bill or not and whether it fits or
  // not: hold, one neutral sentence, nothing that depends on a match or on a bill's balance, state or other parts, so no
  // answer can be used to find a bill or what is open. That wins over anything else the rules said about it, the
  // supported figure a supplier's agent would otherwise be offered included. Provenance is the agent layer's own and
  // says nothing about bills: its holds are still listed and its refusals still block.
  const aboutBill = supplierBillReview(db, biz.id, asked?.id, a.reference);
  const blocks = aboutBill ? [] : r.blocks.map((b) => ({ rule: b.rule, message: clean(forAgent(b.rule, b.message, supplier), others, keep) }));
  // A provenance hold is Checkrail's own sentence around an address the agent itself sent: shown whole, not redacted.
  const mapped = r.warnings.map((w) =>
    w.rule === "ai_flag" && found.holds.includes(w.message) ? { rule: PROVENANCE_HOLD_RULE, message: w.message }
    : { rule: w.rule === "ai_flag" && w.message.startsWith(AGENT_FLAG_PREFIX) ? "agent_mismatch" : w.rule, message: clean(forAgent(w.rule, w.message, supplier), others, keep) },
  );
  const holds = mapped.filter((w) => w.rule === PROVENANCE_HOLD_RULE);
  const warnings = aboutBill ? [...holds, { rule: "bill_review", message: BILL_NEUTRAL }] : [...holds, ...mapped.filter((w) => w.rule !== PROVENANCE_HOLD_RULE)];
  if (aboutBill) verdict = "hold";
  // Payout details from anywhere but the verified supplier flow: refused, whatever the rules say.
  if (found.refusal) {
    verdict = "block";
    blocks.unshift({ rule: PROVENANCE_REFUSAL_RULE, message: found.refusal });
  }

  // An agent trying amount after amount for one job is looking for the line. It does not get a "pay" that way.
  const distinct = probing(db, agent, payeeKey, a.amountMinor, a.reference);
  // An agent trying reference after reference for one supplier is looking for bills on file: past the limit, a person.
  if (!aboutBill && verdict !== "block" && referenceSpread(db, agent, payeeKey, a.reference) >= SPREAD_LIMIT) {
    verdict = "hold";
    warnings.unshift({ rule: "reference_spread", message: "This agent has tried many different references for this supplier in 10 minutes; a person confirms this one" });
  }
  if (distinct >= PROBE_DISTINCT_AMOUNTS && verdict !== "block" && !aboutBill) {
    verdict = "hold";
    warnings.unshift({ rule: "agent_probing", message: `This agent has tried ${distinct} different amounts for this payment in 15 minutes; a person confirms this one` });
  }

  const lead = verdict === "block" ? blocks[0] : verdict === "hold" ? warnings[0] : undefined;
  const summary =
    lead?.rule === PROVENANCE_REFUSAL_RULE ? `Do not pay: ${lead.message}.`
    : lead?.rule === PROVENANCE_HOLD_RULE ? lead.message
    : clean(
        verdict === "block" ? `Do not pay: ${blocks[0]?.message ?? "a rule blocks it"}.`
        : verdict === "pay" ? "Clear to pay: every rule passed within the limits this business set."
        : `A person must look first: ${warnings[0]?.message ?? "it needs approval"}.`,
        others,
        keep,
      ).replace(/\.\.$/, ".");
  const amount = formatMoney(a.amountMinor, a.currency, { code: true });
  const checkId = log(db, { businessId: biz.id, agent: agent.name, tool: "check_payment", verdict, payee: a.payee, payeeKey, amountMinor: a.amountMinor, currency: a.currency, reference: a.reference, summary, rulesJson: JSON.stringify([...blocks, ...warnings].map((x) => x.rule)), obligationId: null, idempotencyKey: null, provenanceJson });
  // A supplier's agent asking more than the record supports gets the supported figure back, as an offer it can take.
  // Never for a payment held because of bills: the figure would say what is open.
  let offer: CounterOffer | undefined;
  if (supplier && verdict === "block" && !found.refusal && !aboutBill && asked) {
    const basis = counterOfferFrom(db, { businessId: biz.id, vendorId: asked.id, obligationId: null }, r.blocks, a.amountMinor, a.currency);
    if (basis) offer = offerForAgent(recordOffer(db, { businessId: biz.id, agent: agent.name, vendorId: asked.id, checkId, obligationId: null, askedMinor: a.amountMinor, currency: a.currency, reference: a.reference, basis, request: { payee: a.payee, reference: a.reference, description: a.description, evidence: a.evidence } }));
  }
  return {
    check_id: checkId,
    verdict,
    summary,
    payee: asked?.name ?? null,
    amount,
    reference: a.reference,
    blocks,
    warnings,
    next_steps: supplier ? supplierSteps(verdict, offer) : nextSteps(verdict, [...blocks, ...warnings]),
    paypal_transaction_id: aboutBill ? null : paypalTxnIn([...r.blocks, ...r.warnings].map((x) => x.message)),
    autonomy: supplier ? null : effectiveAutonomy(JSON.parse(biz.policyJson)),
    checked_at: now(),
    note: "Judged against a copy of the books. Nothing was paid, saved or sent.",
    ...(prov ? {} : { provenance_hint: PROVENANCE_HINT }),
    ...(offer ? { counter_offer: offer } : {}),
  };
}

// ---------- request_payment and payment_status ----------

export type { RequestStatus } from "../api/view";

export interface StatusAnswer {
  request_id: string;
  status: RequestStatus;
  summary: string;
  payee: string | null;
  amount: string | null;
  reference: string | null;
  reasons: string[];
  releases_at: string | null;
  paid: { rail: string; provider_id: string | null; settled_at: string } | null;
  review_path: string;
}

/** "at 18:12 UTC, in 10 minutes": readable by a person and an agent alike. releases_at keeps the exact time. */
export function whenRelease(iso: string, at = Date.now()): string {
  const d = new Date(iso);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  const mins = Math.max(0, Math.round((d.getTime() - at) / 60_000));
  return `at ${hhmm}, ${mins === 0 ? "within a minute" : `in ${mins} minute${mins === 1 ? "" : "s"}`},`;
}

function describe(db: Db, id: string, supplier = false): StatusAnswer {
  // The same outside view the REST API reads (src/lib/api/view.ts), so the two channels cannot drift: status, whether
  // it is held because of bills, and which rules fail come from it. Only the wording is this channel's own.
  const v = outsideView(db, id);
  if (!v) throw new AgentInputError("No such request");
  const { ob, settled, attempt } = v;
  const vendor = ob.vendorId ? db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, ob.vendorId)).get() ?? null : null;
  const others = otherNames(db, ob.businessId, [vendor?.name]);
  const amount = ob.amountMinor && ob.currency ? formatMoney(ob.amountMinor, ob.currency, { code: true }) : null;
  const status = v.status;
  // Blocks first, then the agent layer's own provenance holds, then every other warning. A provenance hold is
  // Checkrail's own sentence around an address the agent itself sent, so it is not redacted. A request held because of
  // bills reads the one neutral sentence and nothing else.
  const say = (r: { ruleId: string; message: string; ownHold: boolean }) => (r.ownHold ? r.message : clean(forAgent(r.ruleId, r.message, supplier), others, vendor?.name ?? null));
  const reasons = v.aboutBill ? v.reasons.slice(0, 6) : v.failing.map(say).slice(0, 6);
  const blockReasons = v.failing.filter((r) => r.severity === "block");
  const holdReasons = v.failing.filter((r) => r.severity !== "block" && r.ownHold);
  // A request whose counter-offer the supplier's agent disputed: a person is reviewing it, and that leads. Never on a
  // request held because of bills: the offer's figure is tied to the bill.
  const dispute = v.aboutBill ? undefined : db.select().from(agentOffers).where(and(or(eq(agentOffers.obligationId, id), eq(agentOffers.resultObligationId, id)), eq(agentOffers.status, "disputed"))).orderBy(desc(agentOffers.createdAt)).get();
  const disputeLine = dispute?.disputeReason ? clean(`The supplier's agent disputes Checkrail's counter-offer of ${formatMoney(dispute.offerMinor, dispute.currency, { code: true })}, and a person is reviewing it. Its reason, its own say-so: ${dispute.disputeReason}`, others, vendor?.name ?? null) : null;
  if (disputeLine) reasons.unshift(disputeLine);
  if (reasons.length > 6) reasons.length = 6;
  const firstBlock = blockReasons.length ? say(blockReasons[0]) : null;
  const provenanceFirst = !disputeLine && blockReasons.length === 0 && holdReasons.length > 0;
  const summary =
    status === "blocked" && disputeLine ? `A person is reviewing the supplier's dispute. Until they decide, the rules still block it: ${firstBlock ?? "a rule blocks it"}.`
    : status === "waiting_for_approval" && disputeLine ? "Waiting for a person, who is reviewing the supplier's dispute."
    : status === "blocked" ? `Blocked: ${reasons[0] ?? "a rule blocks it"}.`
    : status === "waiting_for_evidence" ? "Waiting for supporting evidence before anyone can approve it."
    : status === "waiting_for_approval" ? `Waiting for a person to approve${reasons[0] ? `: ${reasons[0]}` : "."}`
    : status === "scheduled" ? `Autopilot sends it ${whenRelease(v.releasesAt!)} unless a person cancels before then.`
    : status === "approved" ? (!v.aboutBill ? "Approved by the rules; a person sends it." : v.verdict === "approved" ? "Approved by a person; it is sent from here." : "Waiting to be sent.")
    : status === "sending" ? "Sent to the payment rail; waiting for it to confirm."
    : status === "paid" ? `Paid${settled ? ` over ${settled.rail}` : ""}.`
    : status === "returned" ? "The payment came back; a person decides what happens next."
    : status === "cancelled" ? "Cancelled; nothing will be sent."
    : `Status: ${status}.`;
  return {
    request_id: id,
    status,
    summary:
      provenanceFirst && status === "waiting_for_approval" ? `Waiting for a person to approve: ${reasons[0]}`
      : provenanceFirst && status === "waiting_for_evidence" ? `Waiting for supporting evidence before anyone can approve it. ${reasons[0]}`
      : clean(summary, others, vendor?.name ?? null).replace(/\.\.$/, "."),
    payee: vendor?.name ?? null,
    amount,
    reference: ob.sourceRef,
    reasons,
    releases_at: v.releasesAt,
    paid: settled ? { rail: settled.rail, provider_id: settled.externalId ?? attempt?.externalId ?? null, settled_at: settled.settledAt } : null,
    review_path: `/obligations/${id}`,
  };
}

/**
 * One request at a time per business, in this process. Two requests for the same job racing through ingest would each
 * miss the other and both be scheduled; in turn, the second sees the first as committed and is blocked.
 * The stdio server queues its messages too, and policy runs again at release whatever happened here.
 */
const lanes = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = lanes.get(key) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  lanes.set(key, tail);
  try {
    return await run;
  } finally {
    if (lanes.get(key) === tail) lanes.delete(key);
  }
}

/** Take back a request an agent should not have left in the books: cancel its release and the request itself. */
function withdraw(db: Db, id: string, agent: AgentKey, reason: string): void {
  db.update(obligations).set({ releaseAt: null, autopilotCancelledAt: now() }).where(eq(obligations.id, id)).run();
  const state = db.select({ s: obligations.state }).from(obligations).where(eq(obligations.id, id)).get()?.s as ObligationState | undefined;
  if (state && TRANSITIONS[state].includes("cancelled")) transition(db, id, "cancelled", `mcp:${agent.name}`, "agent.request_withdrawn", { reason });
}

export type RequestAnswer = StatusAnswer & {
  replayed: boolean;
  /** Only when the agent sent no provenance: that it may. */
  provenance_hint?: string;
  /** Only for a request made under a mandate: what is left under it after this one. */
  mandate?: { mandate_id: string; remaining: string; summary: string };
  /** Only for a supplier's agent blocked for more than the evidence or rate card supports. */
  counter_offer?: CounterOffer;
};

/** Internal options for a request the agent layer makes on an agent's behalf (accepting or disputing an offer). */
export interface SubmitOptions {
  /** The amount is Checkrail's own offer, or the one already asked: trying it is not a probe. */
  skipProbe?: boolean;
  /** No counter-offer on this request: it is the supplier's dispute of one, for a person to decide (review AF2-S2). */
  noOffer?: boolean;
  /** Concerns to hold the request for a person, before the agent's own. */
  flags?: string[];
}

export async function requestPayment(db: Db, agent: AgentKey, raw: unknown): Promise<RequestAnswer> {
  return submitRequest(db, agent, raw, {});
}

export async function submitRequest(db: Db, agent: AgentKey, raw: unknown, opts: SubmitOptions): Promise<RequestAnswer> {
  if (!agent.scopes.includes("request")) throw new AgentInputError("This agent key may check payments but not request them");
  const a = validatePaymentArgs(raw);
  const idem = text((raw as Record<string, unknown>).idempotency_key, "idempotency_key", 80, true)!;
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(idem)) throw new AgentInputError("idempotency_key must be 8 to 80 letters, digits, dots, colons, dashes or underscores");
  const prov = validateProvenance((raw as Record<string, unknown>).provenance);
  const provenanceJson = prov ? JSON.stringify(prov) : null;
  const mandateToken = text((raw as Record<string, unknown>).mandate, "mandate", 4000);
  const biz = businessOf(db);
  const supplier = isSupplierKey(agent);

  return oneAtATime(biz.id, async () => {
    // A retry, or two calls racing, gets the one request this key stands for.
    const existing = db.select().from(agentChecks).where(and(eq(agentChecks.agent, agent.name), eq(agentChecks.idempotencyKey, idem))).get();
    if (existing && existing.verdict === "refused" && !existing.obligationId) {
      // Nothing was created under a refused key, so a corrected request may use it again. The refusal
      // stays in the log, and still counts towards the probe hold.
      db.update(agentChecks).set({ idempotencyKey: null }).where(eq(agentChecks.id, existing.id)).run();
    } else if (existing) {
      if (existing.payee !== a.payee || existing.amountMinor !== a.amountMinor || existing.currency !== a.currency || (existing.reference ?? null) !== (a.reference ?? null)) throw new AgentInputError("idempotency_key was already used for a different payment");
      if (!existing.obligationId) throw new AgentInputError("That request is still being created; ask payment_status again in a moment");
      const offerRow = supplier && !outsideBillMatch(db, existing.obligationId) ? offerOnObligation(db, existing.obligationId) : null;
      const m = existing.mandateId ? db.select().from(agentMandates).where(eq(agentMandates.id, existing.mandateId)).get() : undefined;
      const left = m ? Math.max(0, m.totalMinor - spentUnder(db, m.id)) : 0;
      return {
        ...describe(db, existing.obligationId, supplier),
        replayed: true,
        ...(m ? { mandate: { mandate_id: m.id, remaining: formatMoney(left, m.currency, { code: true }), summary: `${formatMoney(left, m.currency, { code: true })} left of ${formatMoney(m.totalMinor, m.currency, { code: true })} under this mandate.` } } : {}),
        ...(offerRow ? { counter_offer: offerForAgent(offerRow) } : {}),
      };
    }

    // A request that follows a run of other amounts for the same job is refused before anything is written.
    const asked = vendorNamed(db, biz.id, a.payee);
    const payeeKey = probeKeyOf(asked?.id, a.payee, a.currency, a.reference);
    let mandate: MandateRow | null = null;
    const refuse = (summary: string): never => {
      log(db, { businessId: biz.id, agent: agent.name, tool: "request_payment", verdict: "refused", payee: a.payee, payeeKey, amountMinor: a.amountMinor, currency: a.currency, reference: a.reference, summary, rulesJson: null, obligationId: null, idempotencyKey: idem, provenanceJson, mandateId: mandate?.id ?? null });
      throw new AgentInputError(`Refused, and nothing was created: ${summary}`);
    };
    supplierGate(db, agent, biz, a, "request_payment", { idempotencyKey: idem, provenanceJson });
    // Provenance and the mandate are decided here, in the agent layer, before anything reaches ingest.
    const found = assessProvenance(prov);
    if (found.refusal) refuse(`${found.refusal}.`);
    if (!opts.skipProbe && probing(db, agent, payeeKey, a.amountMinor, a.reference) >= PROBE_DISTINCT_AMOUNTS) refuse("this agent has tried several different amounts for this payment in 15 minutes. Ask a person for the right figure and its record.");
    if (mandateToken) {
      const m = loadMandate(db, biz.id, mandateToken);
      if (!m.ok) refuse(`${m.reason}.`);
      else mandate = m.row;
      const vendor = asked ? { id: asked.id, name: asked.name, role: asked.role } : null;
      const why = outOfScope(db, mandate!, agent, a, vendor);
      if (why) refuse(`${why}. A mandate only narrows what this agent may ask for; ask the owner for a new one.`);
    }

    // The agent's fields are fixed on the request; its own text, where it disagrees, holds it for a person (AG2-1, AG2-3).
    const concerns = [...found.holds, ...(opts.flags ?? []), ...disagreementsOf(db, biz.id, asked, a)];
    const claimRow = { businessId: biz.id, agent: agent.name, tool: "request_payment", verdict: "hold", payee: a.payee, payeeKey, amountMinor: a.amountMinor, currency: a.currency, reference: a.reference, summary: "Creating the request", rulesJson: null, obligationId: null, idempotencyKey: idem, provenanceJson, mandateId: mandate?.id ?? null } as const;
    let claim: string;
    if (mandate) {
      // The budget left and this request's claim on it are one transaction, taken with the write lock, so two requests
      // at once (here, or from another server on the same database) cannot both fit in what is left.
      const m = mandate;
      const out = db.transaction((tx) => {
        const spent = spentUnder(tx as unknown as Db, m.id);
        if (spent + a.amountMinor > m.totalMinor) return { left: Math.max(0, m.totalMinor - spent) };
        const id = newId("agc");
        tx.insert(agentChecks).values({ ...claimRow, id, createdAt: now() }).run();
        return { id };
      }, { behavior: "immediate" });
      if ("left" in out) refuse(`the mandate has ${formatMoney(out.left, m.currency, { code: true })} left of ${formatMoney(m.totalMinor, m.currency, { code: true })}; this asks for ${formatMoney(a.amountMinor, a.currency, { code: true })}. A mandate only narrows what this agent may ask for; ask the owner for a new one.`);
      claim = (out as { id: string }).id;
    } else claim = log(db, claimRow);
    let id: string;
    try {
      id = await ingestObligation(db, {
        businessId: biz.id,
        sourceType: "operator_instruction",
        sourceRef: a.reference,
        rawInput: requestTextFor(`request ${claim}`, asked?.name ?? a.payee, a),
        evidence: supplier ? a.evidence.map((e) => ({ ...e, label: supplierLabel(e.label) })) : a.evidence,
        evidenceSource: evidenceSourceOf(agent),
        actor: `mcp:${agent.name}`,
        stated: { vendorId: asked?.id ?? null, amountMinor: a.amountMinor, currency: a.currency, sourceRef: a.reference, flags: concerns, trusted: agent.scopes.includes("attest") },
      });
    } catch (e) {
      // Nothing half-made stays behind: no stuck key, no orphan draft.
      const orphan = db.select({ id: obligations.id }).from(obligations).where(like(obligations.rawInput, `%request ${claim}]%`)).get();
      if (orphan) withdraw(db, orphan.id, agent, "creating the request failed");
      db.delete(agentChecks).where(eq(agentChecks.id, claim)).run();
      // Never the exception's own text: it can name other payments or internal ids. The detail goes
      // to the server log.
      console.error("[checkrail] agent request could not be created", e);
      throw new AgentInputError("Checkrail could not process this request. Nothing was paid.");
    }

    // The request in the books must be exactly what was sent. Fixed fields make that so; this is the belt to those braces.
    const ob = db.select().from(obligations).where(eq(obligations.id, id)).get()!;
    if ((ob.vendorId ?? null) !== (asked?.id ?? null) || ob.amountMinor !== a.amountMinor || ob.currency !== a.currency || (ob.sourceRef ?? null) !== (a.reference ?? null)) {
      const why = "the request in the books is not the payee, amount and reference sent";
      withdraw(db, id, agent, why);
      db.update(agentChecks).set({ obligationId: id, verdict: "refused", summary: `Refused: ${why}.` }).where(eq(agentChecks.id, claim)).run();
      throw new AgentInputError(`Refused, and the request was cancelled: ${why}.`);
    }
    const answer = describe(db, id, supplier);
    const verdict = answer.status === "blocked" ? "block" : answer.status === "scheduled" || answer.status === "approved" ? "pay" : "hold";
    db.update(agentChecks).set({ obligationId: id, verdict, summary: answer.summary, rulesJson: JSON.stringify(answer.reasons) }).where(eq(agentChecks.id, claim)).run();
    // A supplier's agent asking more than the record supports gets the supported figure back, as an offer it can take.
    let offer: CounterOffer | undefined;
    if (supplier && !opts.noOffer && answer.status === "blocked" && asked && !outsideBillMatch(db, id)) {
      const failing = previewPolicy(db, id).rules.filter((x) => !x.passed && x.severity === "block").map((x) => ({ rule: x.ruleId, message: x.message }));
      const basis = counterOfferFrom(db, { businessId: biz.id, vendorId: asked.id, obligationId: id }, failing, a.amountMinor, a.currency);
      if (basis) offer = offerForAgent(recordOffer(db, { businessId: biz.id, agent: agent.name, vendorId: asked.id, checkId: claim, obligationId: id, askedMinor: a.amountMinor, currency: a.currency, reference: a.reference, basis, request: { payee: a.payee, reference: a.reference, description: a.description, evidence: a.evidence } }));
    }
    const left = mandate ? Math.max(0, mandate.totalMinor - spentUnder(db, mandate.id)) : 0;
    return {
      ...answer,
      replayed: false,
      ...(prov ? {} : { provenance_hint: PROVENANCE_HINT }),
      ...(mandate ? { mandate: { mandate_id: mandate.id, remaining: formatMoney(left, mandate.currency, { code: true }), summary: `${formatMoney(left, mandate.currency, { code: true })} left of ${formatMoney(mandate.totalMinor, mandate.currency, { code: true })} under this mandate.` } } : {}),
      ...(offer ? { counter_offer: offer } : {}),
    };
  });
}

export function paymentStatus(db: Db, agent: AgentKey, raw: unknown): StatusAnswer {
  const id = text((raw as Record<string, unknown> | null)?.request_id, "request_id", 64, true)!;
  // An agent sees only the requests it made; a supplier's agent, only those still for its own supplier.
  const mine = db.select({ id: agentChecks.id }).from(agentChecks).where(and(eq(agentChecks.agent, agent.name), eq(agentChecks.obligationId, id))).get();
  if (!mine) throw new AgentInputError("No request with that id was made by this agent");
  if (isSupplierKey(agent) && db.select({ v: obligations.vendorId }).from(obligations).where(eq(obligations.id, id)).get()?.v !== agent.vendorId) throw new AgentInputError("No request with that id was made by this agent");
  return describe(db, id, isSupplierKey(agent));
}

// ---------- lookup_payee and explain_rule ----------

export function lookupPayee(db: Db, raw: unknown) {
  const name = text((raw as Record<string, unknown> | null)?.name, "name", 80, true)!;
  const biz = businessOf(db);
  const v = vendorNamed(db, biz.id, name);
  if (!v) {
    // Suggestions only for a real attempt at a name: four characters or more, sharing a whole word.
    // Generic words ("transport", "boats") name a kind of business, not one, so they suggest nothing.
    const words = new Set(normaliseName(name).split(" ").filter((w) => w.length >= 3 && !isGenericWord(w)));
    const close = normaliseName(name).length < 4 ? [] : db.select({ name: vendors.name }).from(vendors).where(eq(vendors.businessId, biz.id)).all().map((x) => x.name).filter((n) => normaliseName(n).split(" ").some((w) => words.has(w))).slice(0, 3);
    return { known: false, name: null, suggestions: close, note: "Checkrail does not pay a payee it does not know. A person adds and verifies new suppliers." };
  }
  const paidBefore = db.select({ id: obligations.id }).from(obligations).where(and(eq(obligations.vendorId, v.id), eq(obligations.state, "settled"))).get();
  return {
    known: true,
    name: v.name,
    role: v.role,
    country: v.country,
    status: v.status,
    payout_details_verified: Boolean(v.verifiedAt),
    can_be_paid_by: [v.paypalEmail ? "paypal" : null, v.stellarAccount ? "stellar" : null, v.bankLabel ? "bank" : null].filter(Boolean),
    paid_before: Boolean(paidBefore),
    note: "Payout details are never shared with agents.",
  };
}

export function explainRule(raw: unknown) {
  const rule = text((raw as Record<string, unknown> | null)?.rule, "rule", 40, true)!;
  return { rule, ...guideFor(rule) };
}

export const agentVerdictOf = verdictOf;

/** A request's status as an agent reads it (payment_status's answer), for the negotiation tools. */
export const describeRequest = describe;

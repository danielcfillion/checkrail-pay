import { bareKey, canonicalForms, foldConfusables, isSharedKey, jobKeys, sourceRefKeys } from "./ids";

/**
 * References in a free-text PayPal note however they were typed ("JOB HG4D 0914 guide fee", "Invoice 4471"): the
 * comparison forms of every run of one to four words, after amounts ("PHP 10830") are taken out so a figure is never
 * read as a reference (agent guard reviews AG4-4, AG5-5). A payment made in the PayPal app by hand is the case this
 * catches. Forms are kept from three characters; they only ever match one of the request's own reference forms.
 */
const NOTE_AMOUNT = /(?:US\$|USD|PHP|VND|THB|EUR|GBP|[$₱₫฿€£])\s?[\d][\d.,]*|[\d][\d.,]*\s?(?:USD|PHP|VND|THB|EUR|GBP|đ|₫|dong)\b/giu;
function noteRefKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const words = text.slice(0, 500).replace(NOTE_AMOUNT, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const run = words.slice(i, i + n);
      // A short bare number ("Room 152", "Boat 2026, 1031 pax") is a room, a year or a count, not a reference, unless
      // a word says it is one ("Invoice 4471", "No. 152") or it is the whole note (AG6-6).
      // "No." after a room, table or seat word is that thing's number, not a reference; "bill" is a meal (AG7-12).
      const refWord = i > 0 && /^(?:invoice|inv|ref|reference|no|number|hd)$/i.test(words[i - 1]) && !(i > 1 && /^(?:no|number)$/i.test(words[i - 1]) && /^(?:room|table|seat|bed|unit|phone|tel|bus|van|car)$/i.test(words[i - 2]));
      if (run.every((w) => /^\d+$/.test(w)) && run.join("").length < 5 && !refWord && words.length !== n) continue;
      for (const f of canonicalForms(run.join("-"))) out.add(`~${f}`);
    }
  }
  return [...out];
}

/**
 * PayPal's own record of money already sent, checked deterministically before a payment: not by the model, and not
 * only when the model chose to call a tool. The orchestrator reads PayPal Transaction Search itself (the same read-only
 * call the agent has) and this pure function decides whether any line already paid this job to this payee.
 *
 * A line matches when all hold: money went out (negative amount); its status is completed or pending; the
 * counterparty is this vendor's PayPal email; and its note, subject or invoice id names this request's reference or
 * one of its job identifiers (look-alike letters folded). A payout that PayPal later reversed (a positive line naming
 * it as the reference) does not count, nor does one already recorded here as come back.
 */

export interface PayPalHistoryMatch {
  transactionId: string;
  date: string;
  amountMinor: number;
  currency: string;
  email: string;
  matched: string;
}

export interface PayPalHistoryCheck {
  checkedAt: string;
  ok: boolean;
  error?: string;
  lines: number;
  matches: PayPalHistoryMatch[];
  /** Payouts that share only a booking or purchase order with this request: a person looks (agent guard review AG7-1). */
  shared?: PayPalHistoryMatch[];
}

interface TsRow {
  transaction_info?: {
    transaction_id?: string;
    paypal_reference_id?: string;
    invoice_id?: string;
    transaction_initiation_date?: string;
    transaction_amount?: { currency_code?: string; value?: string };
    transaction_status?: string;
    transaction_subject?: string;
    transaction_note?: string;
  };
  payer_info?: { email_address?: string };
}

/**
 * @param raw the JSON text PayPal returned (or an already parsed object)
 * @param ids this request's reference and job identifiers, as jobKeys returns them (a leading "~" marks a core key)
 * @param vendorEmail the payee's PayPal email
 * @param excludeIds PayPal transaction ids known to have come back (refunded here)
 */
export function matchPayPalHistory(raw: unknown, ids: string[], vendorEmail: string | null | undefined, excludeIds: Iterable<string> = []): { lines: number; matches: PayPalHistoryMatch[]; shared: PayPalHistoryMatch[] } {
  const email = (vendorEmail ?? "").trim().toLowerCase();
  let body: { transaction_details?: TsRow[] } | null = null;
  try {
    body = typeof raw === "string" ? JSON.parse(raw) : (raw as typeof body);
  } catch {
    body = null;
  }
  const rows = Array.isArray(body?.transaction_details) ? body!.transaction_details : [];
  if (!email || !ids.length) return { lines: rows.length, matches: [], shared: [] };
  // The same identity the duplicate check uses: job identifiers taken from the line's text, compared as keys, so
  // "HG4D-0914" never matches inside a longer number.
  // An agreement number names every job under a contract, not one job, so it never identifies a payment.
  // Keys compare bare; a match is a payout for this job when both sides name the job, and a shared booking or order
  // (a hold) when either side has it only as one (AG7-1).
  const wanted = new Map<string, boolean>();
  for (const k of ids.map((x) => foldConfusables(x).toLowerCase())) {
    const b = bareKey(k);
    if (b.startsWith("agr")) continue;
    wanted.set(b, (wanted.get(b) ?? false) || !isSharedKey(k));
  }
  const reversed = new Set<string>(excludeIds);
  for (const r of rows) {
    const t = r.transaction_info;
    const v = Number(t?.transaction_amount?.value ?? "0");
    if (t?.paypal_reference_id && v > 0) reversed.add(t.paypal_reference_id);
  }
  const matches: PayPalHistoryMatch[] = [];
  const shared: PayPalHistoryMatch[] = [];
  for (const r of rows) {
    const t = r.transaction_info;
    if (!t?.transaction_id || reversed.has(t.transaction_id)) continue;
    const value = Number(t.transaction_amount?.value ?? "0");
    if (!(value < 0)) continue;
    if (!["S", "P"].includes((t.transaction_status ?? "").toUpperCase())) continue;
    if ((r.payer_info?.email_address ?? "").trim().toLowerCase() !== email) continue;
    const theirs = [...jobKeys(t.transaction_note, t.transaction_subject, t.invoice_id), ...sourceRefKeys(t.invoice_id), ...noteRefKeys(t.transaction_note), ...noteRefKeys(t.transaction_subject)].filter((k) => wanted.has(bareKey(k)) && !bareKey(k).startsWith("agr"));
    const strong = theirs.find((k) => !isSharedKey(k) && wanted.get(bareKey(k)));
    const hit = strong ?? theirs[0];
    if (!hit) continue;
    (strong ? matches : shared).push({
      transactionId: t.transaction_id,
      date: (t.transaction_initiation_date ?? "").slice(0, 10),
      amountMinor: Math.round(-value * 100),
      currency: (t.transaction_amount?.currency_code ?? "").toUpperCase(),
      email,
      matched: bareKey(hit).toUpperCase(),
    });
  }
  return { lines: rows.length, matches, shared };
}

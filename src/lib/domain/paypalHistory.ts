import { canonicalForms, foldConfusables, jobKeys, sourceRefKeys } from "./ids";

/**
 * References in a free-text PayPal note however they were typed ("JOB HG4D 0914 guide fee", "job_hg4d_0914"): the
 * comparison forms of every run of one to four words. A payment made in the PayPal app by hand is the case this
 * catches (agent guard review AG4-4). Only forms of five characters or more, so a bare amount never matches.
 */
function noteRefKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const words = text.slice(0, 500).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      for (const f of canonicalForms(words.slice(i, i + n).join("-"))) if (f.replace(/\./g, "").length >= 5) out.add(`~${f}`);
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
export function matchPayPalHistory(raw: unknown, ids: string[], vendorEmail: string | null | undefined, excludeIds: Iterable<string> = []): { lines: number; matches: PayPalHistoryMatch[] } {
  const email = (vendorEmail ?? "").trim().toLowerCase();
  let body: { transaction_details?: TsRow[] } | null = null;
  try {
    body = typeof raw === "string" ? JSON.parse(raw) : (raw as typeof body);
  } catch {
    body = null;
  }
  const rows = Array.isArray(body?.transaction_details) ? body!.transaction_details : [];
  if (!email || !ids.length) return { lines: rows.length, matches: [] };
  // The same identity the duplicate check uses: job identifiers taken from the line's text, compared as keys, so
  // "HG4D-0914" never matches inside a longer number.
  // An agreement number names every job under a contract, not one job, so it never identifies a payment.
  const wanted = new Set(ids.map((k) => foldConfusables(k).toLowerCase()).filter((k) => !k.startsWith("agr-") && !k.startsWith("~agr")));
  const reversed = new Set<string>(excludeIds);
  for (const r of rows) {
    const t = r.transaction_info;
    const v = Number(t?.transaction_amount?.value ?? "0");
    if (t?.paypal_reference_id && v > 0) reversed.add(t.paypal_reference_id);
  }
  const matches: PayPalHistoryMatch[] = [];
  for (const r of rows) {
    const t = r.transaction_info;
    if (!t?.transaction_id || reversed.has(t.transaction_id)) continue;
    const value = Number(t.transaction_amount?.value ?? "0");
    if (!(value < 0)) continue;
    if (!["S", "P"].includes((t.transaction_status ?? "").toUpperCase())) continue;
    if ((r.payer_info?.email_address ?? "").trim().toLowerCase() !== email) continue;
    const hit = [...jobKeys(t.transaction_note, t.transaction_subject, t.invoice_id), ...sourceRefKeys(t.invoice_id), ...noteRefKeys(t.transaction_note), ...noteRefKeys(t.transaction_subject)].find((k) => wanted.has(k) && !k.startsWith("agr-") && !k.startsWith("~agr"));
    if (!hit) continue;
    matches.push({
      transactionId: t.transaction_id,
      date: (t.transaction_initiation_date ?? "").slice(0, 10),
      amountMinor: Math.round(-value * 100),
      currency: (t.transaction_amount?.currency_code ?? "").toUpperCase(),
      email,
      matched: hit.replace(/^~/, "").toUpperCase(),
    });
  }
  return { lines: rows.length, matches };
}

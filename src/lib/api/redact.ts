/**
 * What an integration may read about why a request is held or blocked (API review R5-M3). The text is built from the
 * rule's code alone, never from the message a person sees: those messages name other suppliers, other payments, their
 * states and their dates, and no rewording of them is safe to hand out. One fixed sentence per code, no amounts or
 * names from the books.
 */

export const API_REASON: Readonly<Record<string, string>> = {
  vendor_known: "The payee is not a supplier on file.",
  vendor_active: "The supplier may not be paid at the moment.",
  recipient_verified: "The supplier's payout details still need checking by a person.",
  amount_present: "The request has no amount.",
  amount_sane: "The amount is outside what this business allows.",
  currency_supported: "The currency is not supported.",
  corridor_allowed: "Payments to this supplier's country are not enabled.",
  evidence_present: "Supporting evidence is needed before anyone can approve it.",
  evidence_provenance: "The evidence is the sender's own say-so; a person checks it against the source.",
  evidence_names_vendor: "The evidence does not name the payee in full.",
  request_names_vendor: "The request does not name the payee.",
  amount_matches_evidence: "The amount does not match the evidence.",
  expected_amount: "The amount does not match the rate card and departure on file.",
  stated_unit_rate: "A unit price in the request differs from the rate card.",
  short_pay: "The amount is less than the evidence shows; a person confirms a part payment.",
  invoice_date: "The invoice date needs a look.",
  tax_form: "The supplier's tax form is missing or out of date.",
  payout_returned: "An earlier payout to these payout details came back.",
  payout_shared: "These payout details are shared with another supplier.",
  paypal_history: "PayPal's own records show a payout for this job.",
  reference_present: "The request has no reference.",
  reference_lookalike: "The reference uses look-alike characters.",
  reference_other_vendor: "This reference is also on a payment to another supplier; a person checks who did the job.",
  no_duplicate: "This job matches another payment on file.",
  ai_confidence: "The reader is not confident about this request.",
  ai_flag: "The reader raised a concern; a person looks.",
  agent_mismatch: "The description disagrees with the request's fields; a person confirms which is right.",
  ai_missing: "The reader wants more information.",
  // Every rule about bills reads the same to an outside caller (API reviews R8, R10): see BILL_NEUTRAL.
  bill_recent: "A person reviews payments to this supplier.",
  bill_part_repeat: "A person reviews payments to this supplier.",
  bill_part: "A person reviews payments to this supplier.",
  bill_review: "A person reviews payments to this supplier.",
  bill_ambiguous: "A person reviews payments to this supplier.",
  bill_misfit: "A person reviews payments to this supplier.",
};

/**
 * The one answer an outside caller gets for any request held because of bills, whether it names one or not and whether
 * it fits or not (API reviews R8, R10): nothing it sees may depend on whether a bill matched, nor on a bill's balance,
 * state or other parts.
 */
export const BILL_NEUTRAL = API_REASON.bill_review;

/** For a decision that needs a person when no single rule says why (caps, dual approval, autonomy, own say-so only). */
export const API_NEEDS_PERSON = "A person approves this payment under the business's rules.";

export function apiReasonFor(code: string): string {
  return API_REASON[code] ?? `A rule needs a person to look (${code.replace(/[^a-z_]/g, "")}).`;
}

/** The reasons an integration reads: one sentence per failing rule, blocking ones first, by code. */
export function apiReasons(rules: Array<{ ruleId: string; passed: boolean; severity: string }>, decision: string | null): string[] {
  const failing = rules.filter((r) => !r.passed && r.severity !== "info").sort((x, y) => Number(y.severity === "block") - Number(x.severity === "block"));
  const out = [...new Set(failing.map((r) => apiReasonFor(r.ruleId)))];
  if (!out.length && decision === "require_approval") out.push(API_NEEDS_PERSON);
  return out.slice(0, 8);
}

/**
 * What each policy rule checks and what would clear it, written for an agent that has to act on a refusal.
 * "clear" never suggests changing a figure to get past a rule: an agent fixes the request or hands it to a person.
 */
export interface RuleGuide { checks: string; clear: string }

export const RULE_GUIDE: Record<string, RuleGuide> = {
  vendor_known: { checks: "The payee is a supplier on file for this business.", clear: "Ask a person to add the supplier and verify their payout details; Checkrail never pays an unknown payee." },
  vendor_active: { checks: "The supplier has not been blocked by the business.", clear: "A person must unblock the supplier. Do not retry." },
  recipient_verified: { checks: "The supplier's payout details were verified by a second person after they were last changed.", clear: "A person verifies the details (for example a callback on a number on file). Do not retry." },
  request_names_vendor: { checks: "The request itself names who is being paid.", clear: "Resend with the supplier's full name in the description." },
  evidence_present: { checks: "Something besides the request supports the payment: a job sheet, booking, contract or invoice.", clear: "Attach the job record or booking this payment is for." },
  evidence_names_vendor: { checks: "The record whose amount matches names the payee in full.", clear: "Attach the record that names this supplier, or let a person confirm who did the job." },
  evidence_provenance: { checks: "Supporting records came from the business's own systems, not only from the requester or the supplier.", clear: "A person confirms; records typed by an agent never count as independent support." },
  amount_present: { checks: "A positive amount could be read.", clear: "Resend with the amount and currency." },
  amount_sane: { checks: "The amount is within sensible bounds for this business.", clear: "Check the figure; a person confirms an unusually large payment." },
  amount_matches_evidence: { checks: "The amount asked for is not more than the supporting record says.", clear: "Pay the amount the record supports, or attach a record that supports the higher figure. Do not raise the record to match." },
  expected_amount: { checks: "The amount is within what the rate card and the departure say is owed.", clear: "Pay up to the expected amount, or a person approves the difference." },
  stated_unit_rate: { checks: "A unit price stated in the request is not above the contract rate.", clear: "Use the contract rate, or a person approves the higher rate." },
  short_pay: { checks: "A payment well under the invoice total is intended (a deposit or part payment).", clear: "Say it is a deposit or part payment, or pay the full amount." },
  currency_supported: { checks: "The currency is one this business pays in.", clear: "Resend in a supported currency." },
  corridor_allowed: { checks: "Paying from this business's country to the supplier's country is switched on.", clear: "A person enables the corridor in settings. Do not retry." },
  reference_present: { checks: "An invoice, job or booking reference was given, so duplicates can be matched.", clear: "Resend with the reference." },
  reference_other_vendor: { checks: "The reference is not already on a payment to a different supplier.", clear: "Check who did the job; a person confirms." },
  reference_lookalike: { checks: "The reference has no look-alike letters or hidden characters.", clear: "Retype the reference in plain letters and digits." },
  no_duplicate: { checks: "This job has not already been paid or requested by this business.", clear: "Do not pay. If it really is a different job, resend with that job's own reference and record." },
  paypal_history: { checks: "PayPal's own transaction history does not show this job already paid to this payee.", clear: "Do not pay. The PayPal transaction id is in the message." },
  payout_shared: { checks: "The payout account is not shared with another supplier.", clear: "A person confirms both suppliers really use that account." },
  payout_returned: { checks: "An earlier payment to these payout details did not come back.", clear: "A person reads why it came back before paying again." },
  invoice_date: { checks: "The invoice date is plausible (not far in the future or the distant past).", clear: "Check the date; a person confirms." },
  ai_confidence: { checks: "The reader is confident it understood the request.", clear: "Resend with the payee, amount, currency and reference stated plainly." },
  ai_missing: { checks: "Nothing the reader needed was missing.", clear: "Provide what the message lists as missing." },
  ai_flag: { checks: "The reader raised no concern about this request.", clear: "A person reads the concern." },
  tax_form: { checks: "A tax form needed for this supplier is on file.", clear: "A person collects the form; the payment can still be approved." },
  tax_withholding: { checks: "Any tax to withhold has been worked out.", clear: "Nothing to do; it is shown for the record." },
  agent_mismatch: { checks: "What Checkrail read from the request is the payee and amount the agent sent.", clear: "Send the payee and amount the request actually asks for. A verdict covers only those." },
  agent_probing: { checks: "The same agent has not tried several different amounts for one payee in a short time.", clear: "Stop trying amounts. Ask the person who wants this paid for the right figure and its record." },
};

export function guideFor(rule: string): RuleGuide {
  return RULE_GUIDE[rule] ?? { checks: "A business rule.", clear: "A person reads the message." };
}

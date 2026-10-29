import { formatDate, formatMoney, railLabel } from "@/lib/format";
import { checkStatement, type ReaderView } from "./check-statement";

/** Severity of the decision on a payment request: red, amber, green, or neutral for states with nothing to decide. */
export type DecisionTone = "blocked" | "attention" | "settled" | "neutral";

/** Text colour for a tone, shared by the decision card and the deciding message so they never disagree. */
export function toneText(tone: DecisionTone): string {
  return tone === "blocked" ? "var(--blocked)" : tone === "attention" ? "var(--attention)" : tone === "settled" ? "var(--settled)" : "var(--ink)";
}

/** The one action the decision card offers. The action bar keeps every other choice. */
export type PrimaryAction =
  | { kind: "amend_amount"; amountMinor: number; label: string; note: string }
  | { kind: "approve"; label: string }
  | { kind: "pay"; rail: string; label: string }
  | { kind: "reject"; label: string; note: string }
  | { kind: "retry"; rail: string; label: string }
  | { kind: "reconcile"; label: string }
  | { kind: "confirm"; label: string };

export type EarlierPayment = { id: string; vendorName: string | null; sourceRef: string | null; amountMinor: number | null; currency: string | null; state: string; settledAt: string | null };

export type DecisionInput = {
  state: string;
  /** Who is being paid, for the Approve button and the phone bar. */
  vendorName?: string | null;
  amountMinor: number | null;
  currency: string | null;
  blockedReason: string | null;
  policyReasons: string[];
  rules: Array<{ ruleId: string; passed: boolean; severity: string; message: string }>;
  selectedRail: string | null;
  /** The selected rail's quote, when it can serve the payment. */
  quote?: { rail: string; receiveAmountMinor: number | null; receiveCurrency: string | null; feeMinor: number | null; sendCurrency: string | null } | null;
  availableRails: string[];
  hasAccounting: boolean;
  settlement?: { rail: string; grossMinor: number; grossCurrency: string; receivedMinor: number | null; receivedCurrency: string | null; settledAt: string } | null;
  releaseAt?: string | null;
  /** The earlier payment a duplicate block points at, looked up by the page. */
  earlier?: EarlierPayment | null;
  /** The reading the page shows under "What the agent read". The band may not call the checks clear over its concerns. */
  reader?: ReaderView | null;
};

export type Decision = {
  tone: DecisionTone;
  /** States the outcome, in money where there is a figure. */
  title: string;
  /** One line of evidence. */
  evidence: string;
  /** A link that belongs to the evidence line (the earlier payment, for a duplicate). */
  evidenceLink?: { href: string; label: string; after?: string } | null;
  action: PrimaryAction | null;
  /** Which policy reason the card already states, so other panels do not repeat it. */
  statedReason: string | null;
  /** A second line of evidence the card also states (PayPal's own record of a duplicate). */
  note?: string | null;
  /** Further policy reasons the card states through its note, so "Policy also found" does not count them again. */
  alsoStated?: string[];
  /** A short label for the card's corner when something besides the rules is open ("1 reader concern"). */
  chip?: string | null;
  /** One line under the button saying what it will and will not do. */
  actionHint?: string | null;
  /** A warning triangle in place of the tone's own icon, for a green-by-state band that still carries something to read. */
  icon?: "warn";
  /** What the phone bar says in place of the title: who and how much, so the bar is enough to decide from. */
  barText?: string | null;
};

/** A payee name short enough for a button: the first 28 characters, then an ellipsis. */
const shortName = (n: string) => (n.length > 28 ? `${n.slice(0, 27).trimEnd()}…` : n);

/** Whether this viewer may take the card's action. The server checks again. */
export function allowedAction(a: PrimaryAction, perms: { approve: boolean; pay: boolean; amend: boolean }, approveRefusal: string | null | undefined): boolean {
  switch (a.kind) {
    case "amend_amount":
    case "reject":
      return perms.amend;
    case "approve":
      return perms.approve && !approveRefusal;
    case "pay":
    case "retry":
    case "reconcile":
      return perms.pay;
    case "confirm":
      return true;
  }
}

/** "PayPal transaction 9QX on 2026-10-20 already paid USD 240.00 for JOB-KAL3D-1019 to x@example.com", the paypal_history block. */
const PAYPAL_PAID = /^PayPal transaction (\S+) on (\d{4}-\d{2}-\d{2}) already paid ([A-Z]{3}) ([\d,]+(?:\.\d+)?) for (\S+) to (\S+)$/;

/** A block that says this job was paid already: by reference, by a shared job identifier, or in PayPal's own records. */
export function isDuplicateReason(reason: string | null | undefined): boolean {
  return /already used|^Same job as/.test(reason ?? "") || PAYPAL_PAID.test(reason ?? "");
}

/** The paypal_history block as a title and one evidence line: what PayPal paid, when, and its transaction id. */
export function paypalPaid(reason: string): { title: string; evidence: string; transactionId: string } | null {
  const m = reason.match(PAYPAL_PAID);
  if (!m) return null;
  return { title: `Blocked: PayPal already paid ${m[5]}`, evidence: `PayPal transaction ${m[1]}, ${formatDate(m[2])}: ${formatMoney(toMinor(m[4]), m[3])} to ${m[6]}.`, transactionId: m[1] };
}

/**
 * The short caption beside the break in the check line. Never an internal id: a duplicate by job names the original's
 * reference ("same job as INV-TAM-0834"), and any id left in other text becomes "an earlier request".
 */
export function checkLineCaption(reason: string, earlier?: Map<string, EarlierPayment>): string {
  if (/already used/.test(reason)) return "duplicate reference";
  const job = reason.match(/^Same job as (?:obligation |payment request )?(obl_[a-z0-9]+)/i);
  if (job) {
    const ref = earlier?.get(job[1])?.sourceRef ?? reason.match(/both name (\S+?)[,)]?(?:\s|$)/)?.[1] ?? null;
    return ref ? `same job as ${ref}` : "same job as an earlier request";
  }
  if (PAYPAL_PAID.test(reason)) return "PayPal already paid this job";
  const m = reason.match(/says ([A-Z]{3} [\d,]+\.\d{2})/);
  if (m) return `evidence says ${m[1]}`;
  const clean = tidyDates(reason)
    .replace(/(?:payment request|obligation) obl_[a-z0-9]+(?: \([a-z_ ]+\))?/gi, "an earlier request")
    .replace(/obl_[a-z0-9]+/gi, "an earlier request");
  const first = clean.charAt(0).toLowerCase() + clean.slice(1);
  return first.length > 48 ? first.slice(0, 45).trimEnd() + "…" : first;
}

/**
 * "What you are deciding" as one line on the decision card: what was asked, what the evidence says, and where the
 * money goes. A contract or rate card states a rate, not this job's total, so it is left out of the evidence figure.
 */
export function decidingLine(i: {
  askMinor: number | null;
  currency: string | null;
  evidence: Array<{ kind: string; amountMinor: number | null; currency: string | null }>;
  vendorName: string | null;
  rail: string | null;
  verified: boolean;
  alsoFound?: { blocks: number; warnings: number };
}): string {
  const asked = i.askMinor !== null ? `Asked ${formatMoney(i.askMinor, i.currency)}.` : "No amount asked.";
  const totals = i.evidence.filter((e) => e.amountMinor !== null && e.kind !== "contract" && e.kind !== "rate_card");
  const amounts = Array.from(new Set(totals.map((e) => formatMoney(e.amountMinor, e.currency))));
  const evidence = amounts.length ? `Evidence ${amounts.join(" and ")}.` : "No evidence states an amount.";
  const to = i.vendorName ? `Goes to ${i.vendorName}${i.rail ? ` by ${railLabel(i.rail)}` : ""}.` : "No vendor on file.";
  const unverified = i.vendorName && !i.verified ? " Payout details never verified." : "";
  const f = i.alsoFound;
  const more = f && (f.blocks || f.warnings) ? ` Policy also found ${[f.blocks ? `${f.blocks} more ${f.blocks === 1 ? "block" : "blocks"}` : null, f.warnings ? `${f.warnings} ${f.warnings === 1 ? "warning" : "warnings"}` : null].filter(Boolean).join(" and ")}, listed first under Policy.` : "";
  return `${asked} ${evidence} ${to}${unverified}${more}`;
}

/** "USD 160" for whole amounts, "USD 160.50" otherwise: short enough for a title, still the code, not a symbol. */
export function shortMoney(minor: number, currency: string | null | undefined): string {
  const full = formatMoney(minor, currency);
  return full.replace(/\.00$/, "");
}

const MONEY = "([A-Z]{3}) ([\\d,]+(?:\\.\\d+)?)";
const toMinor = (s: string) => Math.round(Number(s.replace(/,/g, "")) * 100);

/** "Trip sheet HG-4D-0927" to "trip sheet": the kind of record, without its reference. */
export function recordNoun(label: string): string {
  const words = label.trim().split(/\s+/);
  while (words.length > 1 && /\d/.test(words[words.length - 1])) words.pop();
  const noun = words.join(" ").replace(/\s*\(.*\)$/, "");
  return noun.charAt(0).toLowerCase() + noun.slice(1);
}

/** ISO dates in engine text ("verified 2026-08-14") shown as "14 Aug 2026", like every other date. */
export function tidyDates(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?\b/g, (_, d: string) => formatDate(d));
}

/** When PayPal's own records also show the job paid, the card says so in one line and Policy's row is not counted again. */
function paypalAgrees(rules: DecisionInput["rules"]): Pick<Decision, "note" | "alsoStated"> {
  const rows = rules.filter((r) => r.ruleId === "paypal_history" && !r.passed && r.severity === "block");
  const first = rows.map((r) => r.message.match(PAYPAL_PAID)).find(Boolean);
  if (!first) return {};
  // No date here: PayPal dates a payout in UTC, and the original's local settlement date is already on the line above.
  return { note: `PayPal's own records agree: transaction ${first[1]}.`, alsoStated: rows.map((r) => r.message) };
}

function blockedDecision(i: DecisionInput): Decision {
  const reason = i.blockedReason ?? i.policyReasons[0] ?? "A check failed";
  const cur = i.currency;
  const base = { tone: "blocked" as const, statedReason: reason };
  const correct = (evidenced: number): PrimaryAction => ({ kind: "amend_amount", amountMinor: evidenced, label: `Correct to ${formatMoney(evidenced, cur)}`, note: `Corrected to evidenced amount ${formatMoney(evidenced, cur)}` });

  // "Requested USD 960.00 but Trip sheet HG-4D-0927 says USD 800.00 (+USD 160.00)"
  let m = reason.match(new RegExp(`^Requested ${MONEY} but (.+?) says ${MONEY}`));
  if (m) {
    const asked = toMinor(m[2]);
    const evidenced = toMinor(m[5]);
    const diff = asked - evidenced;
    const label = m[3];
    return {
      ...base,
      title: diff > 0 ? `Blocked: ${shortMoney(diff, m[1])} more than the ${recordNoun(label)}` : `Blocked: ${shortMoney(-diff, m[1])} less than the ${recordNoun(label)}`,
      evidence: `Requested ${formatMoney(asked, m[1])}. ${label} says ${formatMoney(evidenced, m[4])}.`,
      action: correct(evidenced),
    };
  }
  // "Rate card and departure HG-4D-0927 say USD 800.00 (4 vehicle-days x USD 200.00); this asks for USD 960.00"
  m = reason.match(new RegExp(`^Rate card and departure (\\S+) say ${MONEY} \\((.+?)\\); this asks for ${MONEY}`));
  if (m) {
    const expected = toMinor(m[3]);
    const asked = toMinor(m[6]);
    return {
      ...base,
      title: `Blocked: ${shortMoney(asked - expected, m[2])} more than the rate card`,
      evidence: `Requested ${formatMoney(asked, m[5])}. The rate card for ${m[1]} says ${formatMoney(expected, m[2])} (${m[4]}).`,
      action: { kind: "amend_amount", amountMinor: expected, label: `Correct to ${formatMoney(expected, cur)}`, note: `Short pay to the rate card: ${formatMoney(expected, cur)}` },
    };
  }
  // "Requested USD 900.00 but only USD 400.00 is still open on INV-7 (total ...)"
  m = reason.match(new RegExp(`^Requested ${MONEY} but only ${MONEY} is still open on (\\S+)`));
  if (m) {
    const asked = toMinor(m[2]);
    const open = toMinor(m[4]);
    return { ...base, title: `Blocked: ${shortMoney(asked - open, m[1])} more than is open on ${m[5]}`, evidence: `Requested ${formatMoney(asked, m[1])}. Only ${formatMoney(open, m[3])} is still open on ${m[5]}.`, action: correct(open) };
  }
  // PayPal's own records show this job paid (a payout made outside Checkrail, or one this app made and lost track of).
  const pp = paypalPaid(reason);
  if (pp) return { ...base, title: pp.title, evidence: pp.evidence, action: { kind: "reject", label: "Cancel request", note: "Already paid on PayPal" } };
  // Duplicates: "Reference X was already used by obligation obl_ (settled)" and "Same job as obligation obl_ (settled): ..."
  if (/already used|^Same job as/.test(reason)) {
    const e = i.earlier;
    const ref = e?.sourceRef ?? reason.match(/^Reference (\S+)/)?.[1] ?? null;
    const paidAmount = e?.amountMinor ?? i.amountMinor;
    const paidCur = e?.currency ?? cur;
    const paid = e?.state === "settled";
    const verb = paid ? "already paid" : "already requested";
    const title = paidAmount !== null && ref ? `Blocked: ${shortMoney(paidAmount, paidCur)} ${verb} for ${ref}` : `Blocked: this job was ${verb}`;
    const when = e?.settledAt ? ` on ${formatDate(e.settledAt)}` : "";
    const evidence = e ? (paid ? "The original was paid" : "The original is") : tidyDates(reason);
    return {
      ...base,
      title,
      evidence: e ? `${evidence}${paid ? when : ` ${e.state.replace(/_/g, " ")}`}:` : evidence,
      evidenceLink: e ? { href: `/obligations/${e.id}`, label: `${e.vendorName ?? "the vendor"}, ${e.sourceRef ?? "no reference"}`, after: e.amountMinor !== null ? `, ${formatMoney(e.amountMinor, e.currency)}.` : "." } : null,
      action: { kind: "reject", label: "Cancel request", note: "Duplicate of a paid request" },
      ...paypalAgrees(i.rules),
    };
  }
  if (/not a known vendor/i.test(reason)) return { ...base, title: `Blocked: ${i.amountMinor !== null ? `${shortMoney(i.amountMinor, cur)} to a payee` : "the payee is"} not on file`, evidence: "Nobody on file matches this payee. Match it to a vendor or add the vendor first.", action: null };
  if (/Payout details changed or were never verified/.test(reason)) return { ...base, title: "Blocked: payout details are not verified", evidence: "Re-verify the vendor's payout details before any money goes to them.", action: null };
  const first = reason.split(/;\s/)[0];
  return { ...base, title: `Blocked: ${first.charAt(0).toLowerCase()}${first.slice(1)}`, evidence: i.amountMinor !== null ? `Nothing is paid until this is fixed. The request is for ${formatMoney(i.amountMinor, cur)}.` : "Nothing is paid until this is fixed.", action: null };
}

function approvalDecision(i: DecisionInput): Decision {
  const reasons = i.policyReasons.map((r) => r.replace(/^New since approval: /, ""));
  const reason = reasons[0] ?? null;
  // The boilerplate "evidence supplied by operator" warning goes last, so a specific reason (a unit price above the
  // contract rate, a payee not named in full) is what the headline says.
  const warnings = i.rules.filter((r) => !r.passed && r.severity === "warn").sort((a, b) => Number(a.ruleId === "evidence_provenance") - Number(b.ruleId === "evidence_provenance"));
  const matched = i.rules.find((r) => r.ruleId === "amount_matches_evidence" && r.passed);
  const route = i.quote && i.quote.receiveAmountMinor !== null ? `${railLabel(i.quote.rail)} delivers ${formatMoney(i.quote.receiveAmountMinor, i.quote.receiveCurrency)}.` : "";
  const evidenceLine = [matched ? `${tidyDates(matched.message)}.` : "", route].filter(Boolean).join(" ") || "Check the evidence and the route below.";
  // What the checks may claim: "Every check passed." only when the rules and the reading both are clean.
  const checks = checkStatement({ rules: i.rules, reader: i.reader });
  const chip = checks.chip;
  // The button names what it does: who is paid and how much. Approving does not send anything.
  const who = i.vendorName ? shortName(i.vendorName) : null;
  const money = i.amountMinor !== null ? formatMoney(i.amountMinor, i.currency) : null;
  const action: PrimaryAction = { kind: "approve", label: money && who ? `Approve ${money} to ${who}` : "Approve" };
  const base = { tone: "attention" as const, statedReason: reason, action, chip, actionHint: "Does not send money. Policy checks again, then it is ready to pay.", barText: money && who ? `${who}, ${money}` : null };
  // Only a clear result is silent on the other branches; anything open is said first.
  const lead = (line: string) => (checks.kind === "clear" ? line : `${checks.text} ${line}`);

  let m = reason?.match(new RegExp(`^Amount exceeds auto-execute threshold ${MONEY}`));
  if (m) return { ...base, title: `Needs your approval: above ${shortMoney(toMinor(m[2]), m[1])}`, evidence: `${checks.text} ${evidenceLine}` };
  m = reason?.match(new RegExp(`^Amount exceeds dual-approval threshold ${MONEY}; (\\d+) more`));
  if (m) return { ...base, title: `Needs ${m[3] === "1" ? "a second approval" : `${m[3]} approvals`}: above ${shortMoney(toMinor(m[2]), m[1])}`, evidence: lead(evidenceLine) };
  m = reason?.match(new RegExp(`^Amount exceeds the autopilot per-payment cap ${MONEY}`));
  if (m) return { ...base, title: `Needs your approval: above the autopilot cap of ${shortMoney(toMinor(m[2]), m[1])}`, evidence: lead(evidenceLine) };
  if (reason && /daily cap/.test(reason)) return { ...base, title: "Needs your approval: over the daily cap", evidence: lead(tidyDates(reason) + ".") };
  if (reason && /^Only the vendor's own documents/.test(reason)) return { ...base, title: `Needs your approval: only the vendor's own invoice supports ${i.amountMinor !== null ? formatMoney(i.amountMinor, i.currency) : "this amount"}`, evidence: lead("No job sheet, booking or rate card confirms it.") };
  if (reason && /^First payment to this vendor/.test(reason)) return { ...base, title: "Needs your approval: first payment to this vendor", evidence: lead(evidenceLine) };
  if (reason && /times this vendor's usual/.test(reason)) return { ...base, title: `Needs your approval: ${reason.split(":")[0]}`, evidence: lead(evidenceLine) };
  if (reason && /review everything/.test(reason)) return { ...base, title: "Needs your approval: you review every payment", evidence: lead(evidenceLine) };
  if (warnings.length) {
    return {
      ...base,
      chip: checks.kind === "warnings" ? null : chip,
      title: `Needs your approval: ${warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`} on ${i.amountMinor !== null ? formatMoney(i.amountMinor, i.currency) : "this request"}`,
      evidence: `${tidyDates(warnings[0].message)}.${warnings.length > 1 ? " The rest are listed first under Policy." : ""}`,
    };
  }
  return { ...base, title: "Needs your approval", evidence: reason ? lead(`${tidyDates(reason)}.`) : lead(evidenceLine) };
}

/** The decision a person is looking at on a payment request, stated once, with the one action that moves it on. */
export function decide(i: DecisionInput): Decision {
  const amount = i.amountMinor !== null ? formatMoney(i.amountMinor, i.currency) : "this request";
  switch (i.state) {
    case "blocked":
      return blockedDecision(i);
    case "awaiting_approval":
      return approvalDecision(i);
    case "needs_evidence":
      return { tone: "attention", title: `Needs evidence: nothing supports ${amount} yet`, evidence: "Policy holds it until a job sheet, invoice or contract is attached. Ask the vendor with the link under Actions.", action: null, statedReason: i.policyReasons[0] ?? null };
    case "approved": {
      const rail = i.selectedRail ?? i.availableRails[0] ?? null;
      const passed = i.rules.filter((r) => r.passed).length;
      const delivered = i.quote && i.quote.receiveAmountMinor !== null ? ` Recipient gets ${formatMoney(i.quote.receiveAmountMinor, i.quote.receiveCurrency)} by ${railLabel(i.quote.rail)}, fee ${formatMoney(i.quote.feeMinor, i.quote.sendCurrency)}.` : "";
      // The same rule as the approval band: "All N checks passed" only when the reading holds no open concern either.
      const st = checkStatement({ rules: i.rules, reader: i.reader });
      const readerOpen = st.kind === "reader" || st.kind === "low_confidence" || st.kind === "blocked";
      const checks = readerOpen ? st.text : i.rules.length ? (passed === i.rules.length ? `All ${passed} checks passed.` : `${passed} of ${i.rules.length} checks passed; the rest were approved.`) : "";
      const scheduled = i.releaseAt ? " Autopilot sends it when the cancel window ends." : "";
      // Green only when nothing is open: a statement that is not clear (a reader concern, low confidence, an approved warning) makes the band amber, with a warning icon and the chip.
      const open = st.kind !== "clear";
      return { tone: open ? "attention" : "settled", icon: open ? "warn" : undefined, title: `Ready to pay: ${amount}`, evidence: `${checks}${delivered}${scheduled}`.trim(), action: rail ? { kind: "pay", rail, label: `Pay with ${railLabel(rail)}` } : null, statedReason: null, chip: open ? st.chip : null };
    }
    case "settled": {
      const s = i.settlement;
      const got = s && s.receivedMinor !== null && s.receivedCurrency && s.receivedCurrency !== s.grossCurrency ? `, recipient got ${formatMoney(s.receivedMinor, s.receivedCurrency)}` : "";
      const line = s ? `${formatMoney(s.grossMinor, s.grossCurrency)} by ${railLabel(s.rail)} on ${formatDate(s.settledAt)}${got}.` : `${amount} paid.`;
      return i.hasAccounting
        ? { tone: "settled", title: "Paid and reconciled", evidence: `${line} Recorded in the books.`, action: null, statedReason: null }
        : { tone: "settled", title: "Paid, waiting for the books", evidence: line, action: null, statedReason: null };
    }
    case "failed": {
      const rail = i.selectedRail ?? i.availableRails[0] ?? null;
      return { tone: "blocked", title: `Failed: ${amount} did not go out`, evidence: "The rail rejected the payment and nothing moved. A retry checks the payout details and runs policy again first.", action: rail && i.availableRails.includes(rail) ? { kind: "retry", rail, label: `Retry with ${railLabel(rail)}` } : null, statedReason: null };
    }
    case "execution_pending":
      return { tone: "attention", title: `Unclear: ${amount} may or may not have gone out`, evidence: `${railLabel(i.selectedRail) || "The rail"} did not give a clear answer. Nothing here pays it again.`, action: { kind: "reconcile", label: `Reconcile with ${railLabel(i.selectedRail) || "the rail"}` }, statedReason: null };
    case "sent":
      return { tone: "neutral", title: `Sent: ${amount} is on its way`, evidence: `Handed to ${railLabel(i.selectedRail) || "the rail"}. Waiting for it to settle.`, action: { kind: "confirm", label: "Check settlement" }, statedReason: null };
    case "refunded":
      return { tone: "attention", title: `Came back: ${amount} is owed again`, evidence: "The payout was unclaimed or reversed. Check the payout details with the vendor before paying again.", action: null, statedReason: null };
    case "cancelled":
      return { tone: "neutral", title: "Cancelled: no money moved", evidence: "Nothing is left to do on this request.", action: null, statedReason: null };
    default:
      return { tone: "neutral", title: `Being checked: ${amount}`, evidence: "The agent and policy have not finished with this request.", action: null, statedReason: null };
  }
}

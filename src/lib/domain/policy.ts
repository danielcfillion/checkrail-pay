import { namesVendor as mentionsVendor, namesVendorFully } from "./vendorNames";
import { localDateString } from "../format";
import { foldConfusables, hasConfusables, mixesScripts } from "./ids";

/** Under Autopilot, an amount at least this many times the vendor's median settled payment waits for a person. */
export const UNUSUAL_MULTIPLE = 3;
import { BASE_AMOUNT_LIMIT_MINOR, SUPPORTED_CURRENCIES, ZERO_DECIMAL_CURRENCIES, isValidAmountMinor } from "./money";
import { effectiveAutonomy, fingerprintCovered, warningFingerprint } from "./types";
import type {
  ApprovalPolicy,
  PolicyInput,
  PolicyOutcome,
  PolicyRuleResult,
} from "./types";

/**
 * Deterministic payment policy.
 *
 * This is the only thing that can authorise money movement. It is a pure
 * function: same input, same output, no network, no model. The AI's
 * interpretation is one input among several and can only make the outcome
 * more conservative, never less.
 *
 * Decision ladder (first match wins):
 *   block            -> a hard rule failed; a human must intervene and fix the input
 *   hold             -> something is missing; needs evidence, not a decision
 *   require_approval -> a human must sign off
 *   auto_execute     -> all rules passed and the amount is within the auto threshold
 */
export function evaluatePolicy(policy: ApprovalPolicy, input: PolicyInput): PolicyOutcome {
  const rules: PolicyRuleResult[] = [];
  const { obligation, vendor, evidence, ai } = input;

  // R1: vendor must exist
  rules.push(
    vendor
      ? pass("vendor_known", "Recipient is a known vendor")
      : block("vendor_known", "Recipient is not a known vendor")
  );
  // R1b: a vendor someone has blocked is never paid, whatever else passes.
  if (vendor?.status === "blocked") rules.push(block("vendor_active", `${vendor.name} is blocked from payments; unblock them on their vendor page first`));

  // R2: amount and currency present
  const hasAmount = isValidAmountMinor(obligation.amountMinor) && !!obligation.currency;
  rules.push(
    hasAmount
      ? pass("amount_present", "Amount and currency are present")
      : block("amount_present", "Amount or currency is missing")
  );

  // R2b: the currency must be one the rails can pay, with a reference rate to the base currency so every threshold,
  // cap and approval limit below compares like with like.
  const foreign = hasAmount && obligation.currency !== input.baseCurrency;
  const baseAmount = !hasAmount ? 0 : foreign ? (input.baseAmountMinor ?? null) : obligation.amountMinor!;
  if (hasAmount) {
    if (!SUPPORTED_CURRENCIES.includes(obligation.currency!)) rules.push(block("currency_supported", `Currency ${obligation.currency} is not supported; payments can be made in ${SUPPORTED_CURRENCIES.join(", ")}`));
    else if (baseAmount === null) rules.push(block("currency_supported", `No reference rate from ${obligation.currency} to ${input.baseCurrency}, so limits cannot be checked`));
    else rules.push(pass("currency_supported", foreign ? `${fmt(obligation.amountMinor!, obligation.currency!)} is about ${fmt(baseAmount, input.baseCurrency)}; limits and caps use that` : `Currency ${obligation.currency} is the business base currency`));
    if (baseAmount !== null && baseAmount > BASE_AMOUNT_LIMIT_MINOR) rules.push(block("amount_sane", `${fmt(obligation.amountMinor!, obligation.currency!)} is above the largest single payment this system accepts; check the amount`));
  }

  // R3: evidence required
  if (policy.requireEvidence) {
    rules.push(
      evidence.length > 0
        ? pass("evidence_present", `${evidence.length} supporting record${evidence.length === 1 ? "" : "s"} attached`)
        : hold("evidence_present", "No supporting evidence attached")
    );
  }

  // R3b: evidence typed in by an operator is not independent proof of anything
  if (evidence.some((e) => e.provenance === "operator")) {
    rules.push(warn("evidence_provenance", "Evidence supplied by operator, not system; check it against the source documents"));
  }
  // A document the vendor uploaded through their link is their claim: a person reads it before it counts.
  if (evidence.some((e) => e.provenance === "vendor")) {
    rules.push(warn("evidence_provenance", "The vendor uploaded a document through their evidence link; read it before approving"));
  }

  // R3a: the request itself should name the payee. Without this a reader (rules or Claude) that picked a vendor
  // from the documents alone could pay whoever a supplier's invoice happens to name.
  if (vendor && input.requestText != null) {
    const otherNamesForReq = (input.knownVendorNames ?? []).filter((v) => v.id !== vendor.id).map((v) => v.name);
    if (!mentionsVendor(input.requestText, vendor.name, otherNamesForReq)) {
      rules.push(warn("request_names_vendor", `The request does not name ${vendor.name}; the payee was chosen from the attached records. Confirm who is being paid`));
    }
  }

  // R2c: two vendors paid to one destination is how a fake vendor collects real payments (or a copy-paste slip).
  if (input.sharedPayoutWith?.length) {
    rules.push(warn("payout_shared", `${vendor?.name ?? "This vendor"} is paid to the same account as ${input.sharedPayoutWith.join(", ")}; confirm both are right`));
  }

  // R3c: the evidence must name the vendor the agent chose. The agent proposes vendorId; this rule binds it.
  // Only the vendor's full name binds without a warning. A partial mention ("Driver: Phuong") is shown to a person:
  // single words collide with places and peoples ("Tam Son", "Red Dao"), and a reference alone comes from the request.
  const namesVendor = new Set<string>();
  const mentions = new Set<string>();
  const others = (input.knownVendorNames ?? []).filter((v) => v.id !== vendor?.id);
  const otherNames = others.map((v) => v.name);
  const alsoNames = new Map<string, string[]>(); // evidence id -> other known vendors the same record mentions
  if (vendor && evidence.length > 0) {
    for (const e of evidence) {
      const text = `${e.label} ${e.excerpt ?? ""}`;
      if (namesVendorFully(text, vendor.name)) namesVendor.add(e.id);
      else if (mentionsVendor(text, vendor.name, otherNames)) mentions.add(e.id);
      const also = others.filter((o) => mentionsVendor(text, o.name, [vendor.name, ...otherNames.filter((n) => n !== o.name)])).map((o) => o.name);
      if (also.length) alsoNames.set(e.id, also);
    }
    rules.push(
      namesVendor.size > 0
        ? pass("evidence_names_vendor", `Evidence names ${vendor.name}`)
        : mentions.size > 0
          ? warn("evidence_names_vendor", `${evidence.filter((e) => mentions.has(e.id)).map((e) => e.label).join(", ")} ${mentions.size === 1 ? "names" : "name"} the payee only by part of the name, not "${vendor.name}" in full; confirm who is being paid before approving`)
          : warn("evidence_names_vendor", `None of the attached records name ${vendor.name}; confirm the payee`),
    );
  }

  // R4: amount matches evidence within tolerance. A payment against a bill (deposit, balance, part) is checked against
  // what is still open on the bill instead: never more than the invoice total less what is already paid or credited.
  const evidenced = evidence.filter((e) => e.amountMinor != null && e.currency);
  const bill = input.bill ?? null;
  // The business's own rate card for this departure (R4c below). An advance is cash for costs on the road, not a fee,
  // so it is never measured against the guide's day rate.
  const exp = input.expectation && hasAmount && input.expectation.currency === obligation.currency && input.paymentKind !== "advance" ? input.expectation : null;
  if (hasAmount && bill) {
    const open = Math.max(0, bill.totalMinor - bill.coveredMinor);
    const slack = Math.floor((bill.totalMinor * policy.amountToleranceBps) / 10_000);
    if (bill.vendorId !== obligation.vendorId) rules.push(block("amount_matches_evidence", `Bill ${bill.reference} belongs to another vendor`));
    else if (bill.status !== "open") rules.push(block("amount_matches_evidence", `Bill ${bill.reference} is ${bill.status}; nothing more is owed on it`));
    else if (bill.currency !== obligation.currency) rules.push(block("amount_matches_evidence", `Bill ${bill.reference} is in ${bill.currency}, this payment is in ${obligation.currency}`));
    else if (obligation.amountMinor! > open + slack) rules.push(block("amount_matches_evidence", `Requested ${fmt(obligation.amountMinor!, obligation.currency!)} but only ${fmt(open, bill.currency)} is still open on ${bill.reference} (total ${fmt(bill.totalMinor, bill.currency)}, ${fmt(bill.coveredMinor, bill.currency)} already paid or credited)`));
    else {
      const left = Math.max(0, open - obligation.amountMinor!);
      rules.push(pass("amount_matches_evidence", left > 0 ? `Part of ${bill.reference}: ${fmt(obligation.amountMinor!, bill.currency)} of ${fmt(bill.totalMinor, bill.currency)}; ${fmt(left, bill.currency)} left after this` : `Settles ${bill.reference} in full (${fmt(bill.totalMinor, bill.currency)}${bill.coveredMinor ? `, ${fmt(bill.coveredMinor, bill.currency)} already paid or credited` : ""})`));
    }
  } else if (hasAmount && evidenced.length > 0) {
    const sameCurrency = evidenced.filter((e) => e.currency === obligation.currency);
    if (sameCurrency.length === 0) {
      rules.push(
        warn("amount_matches_evidence", `Evidence is in ${evidenced[0].currency}, the request is in ${obligation.currency}; cannot compare automatically`)
      );
    } else {
      const matches = sameCurrency.filter((e) => withinTolerance(obligation.amountMinor!, e.amountMinor!, policy.amountToleranceBps));
      if (matches.length > 0) {
        // The record that carries the matching amount must be one that names the payee. A trip sheet naming the driver
        // with the guide's fee on it must not clear a payment to the driver.
        const bound = matches.find((e) => namesVendor.has(e.id)) ?? (namesVendor.size === 0 ? matches[0] : undefined);
        if (!bound) rules.push(warn("amount_matches_evidence", `Amount matches ${matches[0].label}, but the record that names ${vendor?.name ?? "the vendor"} carries a different amount; confirm which record this payment is for`));
        else if (alsoNames.has(bound.id) && namesVendor.has(bound.id)) {
          // A trip sheet naming the driver and the guide is normal, but one amount on it cannot say whose it is.
          rules.push(warn("amount_matches_evidence", `${bound.label} names ${vendor?.name} and also ${alsoNames.get(bound.id)!.join(", ")}; confirm this amount is ${vendor?.name}'s`));
        } else rules.push(pass("amount_matches_evidence", `Amount matches ${bound.label}`));
      } else {
        // Compare against the most relevant record: same reference first, else the closest amount.
        const byRef = obligation.sourceRef ? sameCurrency.find((e) => e.reference && refKey(e.reference) === refKey(obligation.sourceRef!)) : undefined;
        const ref = byRef ?? [...sameCurrency].sort((a, b) => Math.abs(a.amountMinor! - obligation.amountMinor!) - Math.abs(b.amountMinor! - obligation.amountMinor!))[0];
        const diff = obligation.amountMinor! - ref.amountMinor!;
        // Short pay to contract: the invoice asks for more than the rate card, and the payment is the rate-card
        // amount. Paying less than asked is safe for the business; a person approves it and tells the vendor why.
        const expSlack = exp ? Math.floor((exp.expectedMinor * policy.amountToleranceBps) / 10_000) : 0;
        if (exp && diff < 0 && Math.abs(obligation.amountMinor! - exp.expectedMinor) <= expSlack) {
          rules.push(warn("short_pay", `Short pay to the rate card: ${ref.label} asks for ${fmt(ref.amountMinor!, ref.currency!)}, this pays ${fmt(obligation.amountMinor!, obligation.currency!)} (${exp.basis}). Tell the vendor why ${fmt(-diff, obligation.currency!)} is not paid.`));
        } else
        rules.push(
          block(
            "amount_matches_evidence",
            `Requested ${fmt(obligation.amountMinor!, obligation.currency!)} but ${ref.label} says ${fmt(ref.amountMinor!, ref.currency!)} (${diff > 0 ? "+" : ""}${fmt(diff, obligation.currency!)})`
          )
        );
      }
    }
  } else if (hasAmount && evidence.length > 0) {
    // Records are attached but none carries an amount (a booking, a chat message): the figure is unverified.
    rules.push(warn("amount_matches_evidence", "None of the attached records carries an amount; the requested figure has not been checked against anything"));
  }

  // R4c: the business's own rate card and departure say what this job costs. More than that is blocked; a match is
  // support that does not come from the vendor, which Autopilot needs (see below).
  let rateCardMatch = false;
  if (exp) {
    const slack = Math.floor((exp.expectedMinor * policy.amountToleranceBps) / 10_000);
    const asked = obligation.amountMinor!;
    const fullJob = bill ? bill.totalMinor : asked;
    if (fullJob > exp.expectedMinor + slack) rules.push(block("expected_amount", `Rate card and departure ${exp.departureCode} say ${fmt(exp.expectedMinor, exp.currency)} (${exp.basis}); this asks for ${fmt(fullJob, obligation.currency!)}`));
    else {
      rateCardMatch = true;
      rules.push(pass("expected_amount", `Within the rate card for ${exp.departureCode}: ${exp.basis} = ${fmt(exp.expectedMinor, exp.currency)}`));
    }
  }

  // R8: tax. Withholding is information for the approver (the vendor receives less); a missing form holds for a person.
  if (input.withholding) rules.push({ ruleId: "tax_withholding", passed: true, severity: "info", message: input.withholding.reason });
  if (input.taxFormWarning) rules.push(warn("tax_form", input.taxFormWarning));

  // R5x: the same job reference already billed by a different payee. Driver and guide on one trip have their own
  // invoice numbers; one reference on two payees is how a job gets paid twice.
  for (const o of input.otherVendorRefs ?? []) {
    // The key changes when the other payment moves from open to committed (approved, sending or paid), so an
    // approval given while it was still open does not cover it once it is being paid.
    const committed = ["approved", "execution_pending", "sent", "settled"].includes(o.state);
    rules.push({ ...warn("reference_other_vendor", `Reference ${o.reference} is also on a payment to ${o.vendorName} (${o.state}); confirm who did this job`), key: `${o.obligationId}:${committed ? "committed" : "open"}` });
  }

  // R5: duplicate job for the same vendor. Three layers:
  //   a) the same reference string;
  //   b) any shared job identifier (trip id, invoice number, evidence reference), which catches
  //      the same job re-invoiced under a new number;
  //   c) same vendor, same amount, settled in the last 30 days with no shared identifier: a warning that forces approval.
  {
    // Earlier payments on the same bill are its other parts; the bill check above stops them adding up to too much.
    const live = input.priorSourceRefs.filter((p) => p.obligationId !== obligation.id && p.state !== "cancelled" && p.state !== "failed" && p.state !== "refunded" && !(bill && p.billId === bill.id));
    const myKeys = new Set((input.jobKeys ?? []).filter((k) => !k.startsWith("~agr") && !k.startsWith("agr-")));
    if (obligation.sourceRef) myKeys.add(refKey(obligation.sourceRef));
    const byRef = obligation.sourceRef ? live.find((p) => p.sourceRef && refKey(p.sourceRef) === refKey(obligation.sourceRef!)) : undefined;
    const byKey = byRef ? undefined : live.find((p) => (p.keys ?? []).some((k) => myKeys.has(k) && !k.startsWith("~agr") && !k.startsWith("agr-")));
    if (byRef) {
      rules.push(block("no_duplicate", `Reference ${obligation.sourceRef} was already used by obligation ${byRef.obligationId} (${byRef.state})`));
    } else if (byKey) {
      const shared = (byKey.keys ?? []).find((k) => myKeys.has(k))!;
      rules.push(block("no_duplicate", `Same job as obligation ${byKey.obligationId} (${byKey.state}): both name ${shared.replace(/^~/, "").toUpperCase()}${obligation.sourceRef ? `, this one under a new reference ${obligation.sourceRef}` : ""}`));
    } else {
      // Only when this obligation carries no job identifier beyond its own reference. A guide paid the same
      // day rate for a different, named trip is routine; an invoice number alone with a familiar amount is not.
      const ownRef = obligation.sourceRef ? refKey(obligation.sourceRef) : undefined;
      const independentKeys = [...myKeys].filter((k) => k !== ownRef && !k.startsWith("~") && k !== ownRef?.replace(/^(inv|job|bk|po|ref|trip|tour)-/, ""));
      const coreOfRef = ownRef ? `~${ownRef.replace(/^(inv|job|bk|po|ref|trip|tour)-/, "").replace(/-/g, "")}` : null;
      const hasOwnJobId = independentKeys.length > 0 || [...myKeys].some((k) => k.startsWith("~") && k !== coreOfRef);
      const since = Date.now() - 30 * 86_400_000;
      const sameAmount = obligation.amountMinor && !hasOwnJobId
        ? live.find((p) => p.amountMinor === obligation.amountMinor && ["settled", "sent", "approved", "execution_pending"].includes(p.state) && (!p.updatedAt || new Date(p.updatedAt).getTime() >= since))
        : undefined;
      // A monthly retainer bills the same figure every month: that is expected, as long as it is not twice in one month.
      const retainer = sameAmount && vendor?.retainerMinor && vendor.retainerMinor === obligation.amountMinor && (!sameAmount.updatedAt || Date.now() - new Date(sameAmount.updatedAt).getTime() >= 20 * 86_400_000);
      if (retainer) {
        rules.push(pass("no_duplicate", `${vendor!.name}'s monthly retainer (${fmt(vendor!.retainerMinor!, obligation.currency!)}); the last one was more than 20 days ago`));
      } else if (sameAmount) {
        rules.push(warn("no_duplicate", `Same amount as obligation ${sameAmount.obligationId} (${sameAmount.state}) for this vendor in the last 30 days; confirm this is a different job${vendor?.retainerMinor === obligation.amountMinor ? " (a retainer is paid once a month)" : ""}`));
      } else {
        rules.push(pass("no_duplicate", obligation.sourceRef ? "Reference and job identifiers have not been paid before" : "No earlier request matches this job"));
      }
    }
  }
  // R5d: PayPal's own records. Read by the orchestrator before this run, never by the model, so a reader that skipped
  // its tools cannot hide a payout PayPal already made for this job to this payee.
  if (input.paypalHistory) {
    const h = input.paypalHistory;
    // A bill paid in parts (a deposit, then the balance) shows its earlier parts on PayPal: those are expected, as long
    // as everything PayPal shows plus this payment stays within the bill's total.
    const partsOfBill = bill && h.matches.length > 0 && h.matches.every((m) => m.currency === bill.currency) && obligation.currency === bill.currency;
    const shownMinor = h.matches.reduce((sum, m) => sum + m.amountMinor, 0);
    if (partsOfBill && shownMinor + (obligation.amountMinor ?? 0) <= bill!.totalMinor) {
      rules.push(pass("paypal_history", `PayPal shows ${fmt(shownMinor, bill!.currency)} already paid on ${bill!.reference}; with this payment that stays within its total of ${fmt(bill!.totalMinor, bill!.currency)}`));
    } else if (h.matches.length) {
      for (const m of h.matches.slice(0, 3)) rules.push(block("paypal_history", `PayPal transaction ${m.transactionId} on ${m.date} already paid ${fmt(m.amountMinor, m.currency)} for ${m.matched} to ${m.email}`));
    } else if (h.ok) rules.push(pass("paypal_history", "PayPal's own records show no payment for this job in the last 31 days"));
    else rules.push(pass("paypal_history", `PayPal's records could not be read (${h.error ?? "no answer"}); this app's own payment history was checked`));
  }
  if (!obligation.sourceRef) rules.push(warn("reference_present", "No reference supplied; duplicate check relied on job identifiers and amount"));
  else if (mixesScripts(obligation.sourceRef)) rules.push(warn("reference_present", `Reference ${obligation.sourceRef} mixes letters from different scripts, so it could not be compared with earlier references; check it is not a re-issue of a job already paid`));
  else if (hasConfusables(obligation.sourceRef)) rules.push(warn("reference_present", `Reference ${obligation.sourceRef} contains look-alike letters from another script or hidden characters; it was compared as ${foldConfusables(obligation.sourceRef)}`));

  // R6: recipient details changed since verification
  if (policy.blockOnRecipientChange && vendor) {
    rules.push(
      vendor.verifiedAt
        ? pass("recipient_verified", `Payout details verified ${localDateString(new Date(vendor.verifiedAt))}`)
        : block("recipient_verified", "Payout details changed or were never verified; re-verify before paying")
    );
  }

  // R6b: the last payment to these exact details came back (unclaimed or reversed). Paying them again is how money
  // bounces twice; someone confirms the details with the vendor first.
  if (input.returnedToSameDetails) rules.push(warn("payout_returned", `A payment to these payout details came back (obligation ${input.returnedToSameDetails}); confirm them with the vendor before paying again`));

  if (input.invoiceDate && input.today && input.invoiceDate > input.today) rules.push(warn("invoice_date", `The invoice is dated ${input.invoiceDate}, in the future; check the date before paying`));

  // R7: corridor allowed
  if (vendor) {
    const corridor = `${input.businessCountry}->${vendor.country}`;
    rules.push(
      policy.allowedCorridors.includes(corridor)
        ? pass("corridor_allowed", `Corridor ${corridor} is enabled`)
        : block("corridor_allowed", `Corridor ${corridor} is not enabled for this business`)
    );
  }

  // R8: AI confidence and flags
  // A payment the system built from a bill ("Please pay the balance on INV-DML-1010") was checked against the bill
  // above. The agent's guess at the amount, and its doubt about it, are noise there; every other flag still counts.
  const billChecked = Boolean(bill) && rules.some((r) => r.ruleId === "amount_matches_evidence" && r.passed);
  if (ai && billChecked) {
    rules.push(pass("ai_confidence", `Amount checked against bill ${bill!.reference}, not read by the agent`));
    for (const f of ai.flags) if (!/amount differs|differs from/i.test(f)) rules.push(warn("ai_flag", f));
    for (const m of ai.missing) rules.push(warn("ai_missing", `Agent wants: ${m}`));
  } else if (ai) {
    if (ai.confidence < policy.minAiConfidence) {
      rules.push(warn("ai_confidence", `Agent confidence ${ai.confidence}% is below the ${policy.minAiConfidence}% threshold`));
    } else {
      rules.push(pass("ai_confidence", `Agent confidence ${ai.confidence}%`));
    }
    // Flags are concerns; every one needs a person. Neutral observations travel as notes and never reach policy.
    for (const f of ai.flags) rules.push(warn("ai_flag", f));
    for (const m of ai.missing) rules.push(warn("ai_missing", `Agent wants: ${m}`));
  } else {
    rules.push(warn("ai_confidence", "No agent interpretation available; human review required"));
  }

  // Decide
  // Blocking reasons first, so the headline of a blocked payment is what blocked it, not a warning that happened to run earlier.
  const failing = rules.filter((r) => !r.passed);
  const reasons = [...failing.filter((r) => r.severity === "block"), ...failing.filter((r) => r.severity !== "block")].map((r) => r.message);
  if (rules.some((r) => r.severity === "block" && !r.passed)) {
    return { decision: "block", reasons, rules };
  }
  if (rules.some((r) => r.ruleId === "evidence_present" && !r.passed)) {
    return { decision: "hold", reasons, rules };
  }
  const anyWarn = rules.some((r) => r.severity === "warn" && !r.passed);
  // Thresholds and caps are in the base currency.
  const amount = baseAmount ?? 0;
  // Warnings need a human to look; one explicit approval acknowledges them.
  if (anyWarn && input.approvalsCount < 1) {
    return { decision: "require_approval", reasons, rules };
  }
  // An approval covers the warnings the person saw, not ones that appeared later (a second payee billing the
  // same reference, a changed amount record). A new warning sends the payment back for a fresh look.
  if (input.approvalsCount >= 1 && input.acknowledgedWarnings) {
    const seen = new Set(input.acknowledgedWarnings);
    const fresh = rules.filter((r) => r.severity === "warn" && !r.passed && !fingerprintCovered(seen, warningFingerprint(r)));
    if (fresh.length) {
      return { decision: "require_approval", reasons: fresh.map((r) => `New since approval: ${r.message}`), rules, unacknowledged: fresh.map(warningFingerprint) };
    }
  }
  if (policy.dualApprovalThresholdMinor > 0 && amount > policy.dualApprovalThresholdMinor && input.approvalsCount < 2) {
    return { decision: "require_approval", reasons: [`Amount exceeds dual-approval threshold ${fmt(policy.dualApprovalThresholdMinor, input.baseCurrency)}; ${2 - input.approvalsCount} more approval(s) needed`], rules };
  }
  // Velocity cap: this vendor's committed payments in the last 24h plus this one.
  const cap = policy.vendorDailyCapMinor ?? 0;
  const recent = input.vendorRecentMinor ?? 0;
  if (cap > 0 && recent + amount > cap && input.approvalsCount < 1) {
    return { decision: "require_approval", reasons: [`Payments to this vendor in the last 24h would total ${fmt(recent + amount, input.baseCurrency)}, above the ${fmt(cap, input.baseCurrency)} daily cap`], rules };
  }
  // An invoice is the vendor's own claim, however it arrived. Nothing is paid without a person unless a record the
  // vendor did not write supports it: a job sheet, booking or purchase order from the business's systems, or the
  // rate card. This holds at every autonomy level.
  const independent = rateCardMatch || evidence.some((e) => (e.provenance ?? "system") === "system" && ["job_sheet", "booking", "purchase_order"].includes(e.kind));
  const selfAttested = (): PolicyOutcome => ({ decision: "require_approval", reasons: ["Only the vendor's own documents support this amount; it is paid without a person only when a job sheet, booking or the rate card confirms it, so a person approves this one"], rules });
  // A cash advance is money out before anything is delivered, backed only by the record the business typed itself:
  // a person approves every one, at every autonomy level (and never the person who prepared it, while someone else can).
  if (input.paymentKind === "advance" && input.approvalsCount < 1) {
    return { decision: "require_approval", reasons: ["A cash advance is paid before anything is delivered, so a person approves every advance"], rules };
  }
  // Autonomy only removes the approval step. Everything above (blocks, holds, warnings, dual approval, vendor cap) has already applied.
  const level = effectiveAutonomy(policy);
  if (level === "review" && input.approvalsCount < 1) {
    return { decision: "require_approval", reasons: ["Autonomy is set to review everything: a person approves every payment"], rules };
  }
  if (level === "autopilot") {
    // Autopilot fails closed: a missing or zero cap means "the agent may send nothing", never "no limit".
    const perCap = policy.autopilotPerPaymentCapMinor ?? 0;
    const dayCapSet = policy.autopilotDailyCapMinor ?? 0;
    if ((perCap <= 0 || dayCapSet <= 0) && input.approvalsCount < 1) {
      return { decision: "require_approval", reasons: ["Autopilot has no per-payment or daily cap set, so it sends nothing on its own; set both caps in Settings"], rules };
    }
    if (amount > perCap && input.approvalsCount < 1) {
      return { decision: "require_approval", reasons: [`Amount exceeds the autopilot per-payment cap ${fmt(perCap, input.baseCurrency)}`], rules };
    }
    const dayCap = policy.autopilotDailyCapMinor ?? 0;
    const bizRecent = input.businessRecentMinor ?? 0;
    if (bizRecent + amount > dayCap && input.approvalsCount < 1) {
      return { decision: "require_approval", reasons: [`Payments committed across the business in the last 24h total ${fmt(bizRecent, input.baseCurrency)}; this one would take it to ${fmt(bizRecent + amount, input.baseCurrency)}, above the ${fmt(dayCap, input.baseCurrency)} autopilot daily cap`], rules };
    }

    // Autopilot sends without a person, so it does not send what a person would want to see first: the first
    // payment to a vendor, or an amount far above what this vendor is usually paid.
    if (input.vendorSettledMinors && input.approvalsCount < 1) {
      const past = [...input.vendorSettledMinors].sort((a, b) => a - b);
      if (past.length === 0) {
        return { decision: "require_approval", reasons: ["First payment to this vendor: autopilot leaves it for a person"], rules };
      }
      if (past.length >= 2) {
        const mid = Math.floor(past.length / 2);
        const median = past.length % 2 ? past[mid] : Math.round((past[mid - 1] + past[mid]) / 2);
        if (median > 0 && amount >= UNUSUAL_MULTIPLE * median) {
          return { decision: "require_approval", reasons: [`${fmt(amount, input.baseCurrency)} is ${(amount / median).toFixed(1)} times this vendor's usual ${fmt(median, input.baseCurrency)}: autopilot leaves it for a person`], rules };
        }
      }
    }
    if (!independent && input.approvalsCount < 1) return selfAttested();
    return { decision: "auto_execute", reasons: [], rules };
  }
  if (amount > policy.autoExecuteThresholdMinor && input.approvalsCount < 1) {
    return { decision: "require_approval", reasons: [`Amount exceeds auto-execute threshold ${fmt(policy.autoExecuteThresholdMinor, input.baseCurrency)}`], rules };
  }
  if (!independent && input.approvalsCount < 1) return selfAttested();
  return { decision: "auto_execute", reasons: [], rules };
}

function withinTolerance(a: number, b: number, bps: number): boolean {
  if (a === b) return true;
  const tol = Math.ceil((Math.abs(b) * bps) / 10_000);
  return Math.abs(a - b) <= tol;
}

function pass(ruleId: string, message: string): PolicyRuleResult {
  return { ruleId, passed: true, severity: "info", message };
}
function warn(ruleId: string, message: string): PolicyRuleResult {
  return { ruleId, passed: false, severity: "warn", message };
}
function hold(ruleId: string, message: string): PolicyRuleResult {
  return { ruleId, passed: false, severity: "warn", message };
}
function block(ruleId: string, message: string): PolicyRuleResult {
  return { ruleId, passed: false, severity: "block", message };
}

export function fmt(minor: number, currency: string): string {
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  const sign = minor < 0 ? "-" : "";
  // Currencies without a minor unit in everyday use (VND) show whole units; the stored hundredths are kept exact.
  if (ZERO_DECIMAL_CURRENCIES.has(currency) && abs % 100 === 0) return `${sign}${currency} ${major.toLocaleString("en-US")}`;
  return `${sign}${currency} ${major.toLocaleString("en-US")}.${cents}`;
}

/** A reference as compared for duplicates: look-alike letters folded, case ignored. */
function refKey(ref: string): string {
  return foldConfusables(ref).toLowerCase();
}

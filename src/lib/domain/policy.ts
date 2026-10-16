import { namesVendor as mentionsVendor, namesVendorFully } from "./vendorNames";
import { isValidAmountMinor } from "./money";
import { effectiveAutonomy, warningFingerprint } from "./types";
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

  // R2: amount and currency present
  const hasAmount = isValidAmountMinor(obligation.amountMinor) && !!obligation.currency;
  rules.push(
    hasAmount
      ? pass("amount_present", "Amount and currency are present")
      : block("amount_present", "Amount or currency is missing")
  );

  // R2b: only the business's base currency can be paid. Thresholds, rails and quotes all assume it.
  if (hasAmount) {
    rules.push(
      obligation.currency === input.baseCurrency
        ? pass("currency_supported", `Currency ${obligation.currency} is the business base currency`)
        : block("currency_supported", `Currency ${obligation.currency} is not supported; payments are made in ${input.baseCurrency} only`)
    );
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
          ? warn("evidence_names_vendor", `The attached records mention ${vendor.name} only by part of the name; confirm the payee`)
          : warn("evidence_names_vendor", `None of the attached records name ${vendor.name}; confirm the payee`),
    );
  }

  // R4: amount matches evidence within tolerance
  const evidenced = evidence.filter((e) => e.amountMinor != null && e.currency);
  if (hasAmount && evidenced.length > 0) {
    const sameCurrency = evidenced.filter((e) => e.currency === obligation.currency);
    if (sameCurrency.length === 0) {
      rules.push(
        warn("amount_matches_evidence", `Evidence is in ${evidenced[0].currency}, obligation is in ${obligation.currency}; cannot compare automatically`)
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
        const byRef = obligation.sourceRef ? sameCurrency.find((e) => e.reference && e.reference.toLowerCase() === obligation.sourceRef!.toLowerCase()) : undefined;
        const ref = byRef ?? [...sameCurrency].sort((a, b) => Math.abs(a.amountMinor! - obligation.amountMinor!) - Math.abs(b.amountMinor! - obligation.amountMinor!))[0];
        const diff = obligation.amountMinor! - ref.amountMinor!;
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

  // R5x: the same job reference already billed by a different payee. Driver and guide on one trip have their own
  // invoice numbers; one reference on two payees is how a job gets paid twice.
  for (const o of input.otherVendorRefs ?? []) {
    rules.push({ ...warn("reference_other_vendor", `Reference ${o.reference} is also on a payment to ${o.vendorName} (${o.state}); confirm who did this job`), key: o.obligationId });
  }

  // R5: duplicate job for the same vendor. Three layers:
  //   a) the same reference string;
  //   b) any shared job identifier (trip id, invoice number, evidence reference), which catches
  //      the same job re-invoiced under a new number;
  //   c) same vendor, same amount, settled in the last 30 days with no shared identifier: a warning that forces approval.
  {
    const live = input.priorSourceRefs.filter((p) => p.obligationId !== obligation.id && p.state !== "cancelled" && p.state !== "failed");
    const myKeys = new Set((input.jobKeys ?? []).filter((k) => !k.startsWith("~agr") && !k.startsWith("agr-")));
    if (obligation.sourceRef) myKeys.add(obligation.sourceRef.toLowerCase());
    const byRef = obligation.sourceRef ? live.find((p) => p.sourceRef && p.sourceRef.toLowerCase() === obligation.sourceRef!.toLowerCase()) : undefined;
    const byKey = byRef ? undefined : live.find((p) => (p.keys ?? []).some((k) => myKeys.has(k) && !k.startsWith("~agr") && !k.startsWith("agr-")));
    if (byRef) {
      rules.push(block("no_duplicate", `Reference ${obligation.sourceRef} was already used by obligation ${byRef.obligationId} (${byRef.state})`));
    } else if (byKey) {
      const shared = (byKey.keys ?? []).find((k) => myKeys.has(k))!;
      rules.push(block("no_duplicate", `Same job as obligation ${byKey.obligationId} (${byKey.state}): both name ${shared.replace(/^~/, "").toUpperCase()}${obligation.sourceRef ? `, this one under a new reference ${obligation.sourceRef}` : ""}`));
    } else {
      // Only when this obligation carries no job identifier beyond its own reference. A guide paid the same
      // day rate for a different, named trip is routine; an invoice number alone with a familiar amount is not.
      const ownRef = obligation.sourceRef?.toLowerCase();
      const independentKeys = [...myKeys].filter((k) => k !== ownRef && !k.startsWith("~") && k !== ownRef?.replace(/^(inv|job|bk|po|ref|trip|tour)-/, ""));
      const coreOfRef = ownRef ? `~${ownRef.replace(/^(inv|job|bk|po|ref|trip|tour)-/, "").replace(/-/g, "")}` : null;
      const hasOwnJobId = independentKeys.length > 0 || [...myKeys].some((k) => k.startsWith("~") && k !== coreOfRef);
      const since = Date.now() - 30 * 86_400_000;
      const sameAmount = obligation.amountMinor && !hasOwnJobId
        ? live.find((p) => p.amountMinor === obligation.amountMinor && ["settled", "sent", "approved", "execution_pending"].includes(p.state) && (!p.updatedAt || new Date(p.updatedAt).getTime() >= since))
        : undefined;
      if (sameAmount) {
        rules.push(warn("no_duplicate", `Same amount as obligation ${sameAmount.obligationId} (${sameAmount.state}) for this vendor in the last 30 days; confirm this is a different job`));
      } else {
        rules.push(pass("no_duplicate", obligation.sourceRef ? "Reference and job identifiers have not been paid before" : "No earlier obligation matches this job"));
      }
    }
  }
  if (!obligation.sourceRef) rules.push(warn("reference_present", "No reference supplied; duplicate check relied on job identifiers and amount"));

  // R6: recipient details changed since verification
  if (policy.blockOnRecipientChange && vendor) {
    rules.push(
      vendor.verifiedAt
        ? pass("recipient_verified", `Payout details verified ${vendor.verifiedAt.slice(0, 10)}`)
        : block("recipient_verified", "Payout details changed or were never verified; re-verify before paying")
    );
  }

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
  if (ai) {
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
  const amount = obligation.amountMinor ?? 0;
  // Warnings need a human to look; one explicit approval acknowledges them.
  if (anyWarn && input.approvalsCount < 1) {
    return { decision: "require_approval", reasons, rules };
  }
  // An approval covers the warnings the person saw, not ones that appeared later (a second payee billing the
  // same reference, a changed amount record). A new warning sends the payment back for a fresh look.
  if (input.approvalsCount >= 1 && input.acknowledgedWarnings) {
    const seen = new Set(input.acknowledgedWarnings);
    const fresh = rules.filter((r) => r.severity === "warn" && !r.passed && !seen.has(warningFingerprint(r)) && !seen.has(r.ruleId));
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
  // Autonomy only removes the approval step. Everything above (blocks, holds, warnings, dual approval, vendor cap) has already applied.
  const level = effectiveAutonomy(policy);
  if (level === "review" && input.approvalsCount < 1) {
    return { decision: "require_approval", reasons: ["Autonomy is set to review everything: a person approves every payment"], rules };
  }
  if (level === "autopilot") {
    const perCap = policy.autopilotPerPaymentCapMinor ?? 0;
    if (perCap > 0 && amount > perCap && input.approvalsCount < 1) {
      return { decision: "require_approval", reasons: [`Amount exceeds the autopilot per-payment cap ${fmt(perCap, input.baseCurrency)}`], rules };
    }
    const dayCap = policy.autopilotDailyCapMinor ?? 0;
    const bizRecent = input.businessRecentMinor ?? 0;
    if (dayCap > 0 && bizRecent + amount > dayCap && input.approvalsCount < 1) {
      return { decision: "require_approval", reasons: [`Payments committed across the business in the last 24h total ${fmt(bizRecent, input.baseCurrency)}; this one would take it to ${fmt(bizRecent + amount, input.baseCurrency)}, above the ${fmt(dayCap, input.baseCurrency)} autopilot daily cap`], rules };
    }
    return { decision: "auto_execute", reasons: [], rules };
  }
  if (amount > policy.autoExecuteThresholdMinor && input.approvalsCount < 1) {
    return { decision: "require_approval", reasons: [`Amount exceeds auto-execute threshold ${fmt(policy.autoExecuteThresholdMinor, input.baseCurrency)}`], rules };
  }
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
  return `${sign}${currency} ${major.toLocaleString("en-US")}.${cents}`;
}

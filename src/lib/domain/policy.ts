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
  const hasAmount = obligation.amountMinor != null && obligation.amountMinor > 0 && !!obligation.currency;
  rules.push(
    hasAmount
      ? pass("amount_present", "Amount and currency are present")
      : block("amount_present", "Amount or currency is missing")
  );

  // R3: evidence required
  if (policy.requireEvidence) {
    rules.push(
      evidence.length > 0
        ? pass("evidence_present", `${evidence.length} supporting record${evidence.length === 1 ? "" : "s"} attached`)
        : hold("evidence_present", "No supporting evidence attached")
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
        rules.push(pass("amount_matches_evidence", `Amount matches ${matches[0].label}`));
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
  }

  // R5: duplicate reference / amount for same vendor
  if (obligation.sourceRef) {
    const dupRef = input.priorSourceRefs.find(
      (p) => p.obligationId !== obligation.id && p.sourceRef && p.sourceRef.toLowerCase() === obligation.sourceRef!.toLowerCase() && p.state !== "cancelled"
    );
    if (dupRef) {
      rules.push(block("no_duplicate", `Reference ${obligation.sourceRef} was already used by obligation ${dupRef.obligationId} (${dupRef.state})`));
    } else {
      rules.push(pass("no_duplicate", "Reference has not been paid before"));
    }
  } else {
    const dupAmount = input.priorSourceRefs.find(
      (p) => p.obligationId !== obligation.id && p.amountMinor === obligation.amountMinor && ["sent", "settled", "approved", "execution_pending"].includes(p.state)
    );
    rules.push(
      dupAmount
        ? warn("no_duplicate", `No reference supplied and an identical amount was paid recently (${dupAmount.obligationId}); confirm this is not a duplicate`)
        : warn("no_duplicate", "No reference supplied; duplicate check is amount-based only")
    );
  }

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
    for (const f of ai.flags) rules.push(warn("ai_flag", f));
    for (const m of ai.missing) rules.push(warn("ai_missing", `Agent wants: ${m}`));
  } else {
    rules.push(warn("ai_confidence", "No agent interpretation available; human review required"));
  }

  // Decide
  const reasons = rules.filter((r) => !r.passed).map((r) => r.message);
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
  if (policy.dualApprovalThresholdMinor > 0 && amount > policy.dualApprovalThresholdMinor && input.approvalsCount < 2) {
    return { decision: "require_approval", reasons: [`Amount exceeds dual-approval threshold ${fmt(policy.dualApprovalThresholdMinor, input.baseCurrency)}; ${2 - input.approvalsCount} more approval(s) needed`], rules };
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

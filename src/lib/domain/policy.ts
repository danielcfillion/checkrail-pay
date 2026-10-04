import { isValidAmountMinor } from "./money";
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
  if (vendor && evidence.length > 0) {
    const parts = vendor.name.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    // Bound when a record names the vendor, or when a record is explicitly the document for this reference.
    const named = evidence.some((e) => {
      const text = `${e.label} ${e.excerpt ?? ""}`.toLowerCase();
      const byName = parts.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
      const byRef = Boolean(obligation.sourceRef && e.reference && e.reference.toLowerCase() === obligation.sourceRef.toLowerCase());
      return byName || byRef;
    });
    rules.push(named ? pass("evidence_names_vendor", `Evidence is tied to ${vendor.name}`) : warn("evidence_names_vendor", `None of the attached records name ${vendor.name} or carry this reference; confirm the payee`));
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
    // Flags are concerns. A note that a figure was taken from the attached record is information, and the
    // amount-matches-evidence rule already checks it, so it is recorded as passing rather than as a warning.
    for (const f of ai.flags) rules.push(/^(Amount|Reference [A-Z0-9-]+) taken from /.test(f) ? pass("ai_flag", f) : warn("ai_flag", f));
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
  // Velocity cap: this vendor's committed payments in the last 24h plus this one.
  const cap = policy.vendorDailyCapMinor ?? 0;
  const recent = input.vendorRecentMinor ?? 0;
  if (cap > 0 && recent + amount > cap && input.approvalsCount < 1) {
    return { decision: "require_approval", reasons: [`Payments to this vendor in the last 24h would total ${fmt(recent + amount, input.baseCurrency)}, above the ${fmt(cap, input.baseCurrency)} daily cap`], rules };
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

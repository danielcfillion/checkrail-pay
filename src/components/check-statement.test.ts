import { describe, expect, it } from "vitest";
import { checkStatement, firstClause, runLineStatement, type ReaderView } from "./check-statement";
import { decide, type DecisionInput } from "./decision-model";

const pass = (ruleId: string, message = "ok") => ({ ruleId, passed: true, severity: "info", message });
const warn = (ruleId: string, message: string) => ({ ruleId, passed: false, severity: "warn", message });
const block = (ruleId: string, message: string) => ({ ruleId, passed: false, severity: "block", message });
const clean: ReaderView = { confidence: 92, concerns: [], missing: [], recorded: false };
const PAYPAL_FLAG = "JOB-PAL3D-0927 appears to have already been paid: PayPal transaction 878829956L370032P (USD 750.00 to ana.reyes@example.com, 12 Oct 2026) has status P (pending). Confirm whether it completed.";

describe("checkStatement", () => {
  it("says every check passed only when the rules and the reading are both clean", () => {
    const s = checkStatement({ rules: [pass("a"), pass("b")], reader: clean });
    expect(s).toEqual({ kind: "clear", text: "Every check passed.", chip: null });
    expect(checkStatement({ rules: [pass("a")], reader: null }).kind).toBe("clear");
  });

  it("never says every check passed over a reader concern", () => {
    const s = checkStatement({ rules: [pass("a")], reader: { confidence: 82, concerns: ["Invoice total differs from the trip sheet"], missing: [], recorded: false } });
    expect(s.kind).toBe("reader");
    expect(s.text).toBe("Rules passed, but the reader raised 1 concern: Invoice total differs from the trip sheet. Confidence 82%.");
    expect(s.chip).toBe("1 reader concern");
    expect(s.text).not.toMatch(/every check passed/i);
  });

  it("says a recorded run raised the concern and that the rules did not see it", () => {
    const s = checkStatement({ rules: [pass("a")], reader: { confidence: 30, concerns: [PAYPAL_FLAG], missing: [], recorded: true } });
    expect(s.kind).toBe("reader");
    expect(s.text).toBe("Rules passed, but the recorded Claude run raised 1 concern: JOB-PAL3D-0927 appears to have already been paid. Confidence 30%. The rules did not see this run.");
    expect(s.chip).toBe("1 reader concern");
  });

  it("counts concerns and missing records together on the chip", () => {
    const s = checkStatement({ rules: [pass("a")], reader: { confidence: 90, concerns: ["a", "b"], missing: ["Invoice"], recorded: false } });
    expect(s.chip).toBe("3 reader concerns");
    expect(s.text).toContain("raised 2 concerns and wants 1 missing record: a.");
  });

  it("flags low confidence on its own", () => {
    const s = checkStatement({ rules: [pass("a")], reader: { confidence: 60, concerns: [], missing: [], recorded: false } });
    expect(s.kind).toBe("low_confidence");
    expect(s.text).toBe("Rules passed, but the reader's confidence is 60%, below the 75% threshold.");
    expect(s.chip).toBe("Low confidence 60%");
  });

  it("uses the threshold the rules name", () => {
    const rules = [warn("ai_confidence", "Agent confidence 80% is below the 90% threshold")];
    expect(checkStatement({ rules, reader: null }).kind).toBe("warnings");
    expect(checkStatement({ rules: [pass("a"), pass("ai_confidence")], reader: { confidence: 80, concerns: [], missing: [], recorded: false }, minConfidence: 90 }).kind).toBe("low_confidence");
  });

  it("reports warnings without double counting the reader's own rules", () => {
    const rules = [pass("a"), warn("ai_flag", "Odd payee"), warn("vendor_new", "First payment to this vendor")];
    const live: ReaderView = { confidence: 88, concerns: ["Odd payee"], missing: [], recorded: false };
    const s = checkStatement({ rules, reader: live });
    expect(s.text).toBe("Rules passed, with 1 warning, and the reader raised 1 concern: Odd payee. Confidence 88%.");
    // With no reading to account for them, the same rules are two warnings.
    expect(checkStatement({ rules, reader: null }).text).toBe("Rules passed, with 2 warnings.");
    expect(checkStatement({ rules, reader: null }).kind).toBe("warnings");
    expect(checkStatement({ rules, reader: null }).chip).toBe("2 warnings");
  });

  it("keeps a live warning on top of a recorded reading", () => {
    const s = checkStatement({ rules: [warn("ai_flag", "Odd payee")], reader: { confidence: 30, concerns: ["Looks paid"], missing: [], recorded: true } });
    expect(s.text).toMatch(/^Rules passed, with 1 warning, and the recorded Claude run raised 1 concern: Looks paid\./);
  });

  it("says when rules block", () => {
    const s = checkStatement({ rules: [block("amount_matches_evidence", "Requested USD 960.00 but the sheet says USD 800.00")], reader: clean });
    expect(s).toEqual({ kind: "blocked", text: "1 rule blocks this request.", chip: "1 blocking rule" });
    const two = checkStatement({ rules: [block("a", "x"), block("b", "y"), warn("c", "z")], reader: { confidence: 10, concerns: ["Looks wrong"], missing: [], recorded: false } });
    expect(two.kind).toBe("blocked");
    expect(two.text).toBe("2 rules block this request and 1 warning, and the reader raised 1 concern: Looks wrong. Confidence 10%.");
  });
});

describe("firstClause", () => {
  it("cuts a long concern at the colon, the full stop or a word", () => {
    expect(firstClause(PAYPAL_FLAG)).toBe("JOB-PAL3D-0927 appears to have already been paid");
    expect(firstClause("Short one.")).toBe("Short one");
    const long = firstClause("word ".repeat(60));
    expect(long.length).toBeLessThanOrEqual(97);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("the approval band", () => {
  const base: DecisionInput = {
    state: "awaiting_approval",
    amountMinor: 75000,
    currency: "USD",
    blockedReason: null,
    policyReasons: ["Amount exceeds auto-execute threshold USD 250.00"],
    rules: [pass("amount_matches_evidence", "Amount matches Trip sheet PAL-3D-0927")],
    selectedRail: "stellar",
    quote: { rail: "stellar", receiveAmountMinor: 4466600, receiveCurrency: "PHP", feeMinor: 600, sendCurrency: "USD" },
    availableRails: ["stellar"],
    hasAccounting: false,
  };

  it("keeps the plain sentence when nothing is open", () => {
    const d = decide({ ...base, reader: clean });
    expect(d.evidence).toBe("Every check passed. Amount matches Trip sheet PAL-3D-0927. Stellar delivers PHP 44,666.00.");
    expect(d.chip).toBeNull();
  });

  it("states the reader's concern on Ana's card instead of saying every check passed", () => {
    const d = decide({ ...base, reader: { confidence: 30, concerns: [PAYPAL_FLAG], missing: [], recorded: true } });
    expect(d.evidence).not.toMatch(/every check passed/i);
    expect(d.evidence).toMatch(/^Rules passed, but the recorded Claude run raised 1 concern: JOB-PAL3D-0927 appears to have already been paid\. Confidence 30%/);
    expect(d.evidence).toMatch(/Amount matches Trip sheet PAL-3D-0927\. Stellar delivers PHP 44,666\.00\.$/);
    expect(d.chip).toBe("1 reader concern");
    expect(d.tone).toBe("attention");
  });

  it("says it on the other approval reasons too", () => {
    const d = decide({ ...base, policyReasons: ["First payment to this vendor"], reader: { confidence: 90, concerns: [], missing: ["Invoice"], recorded: false } });
    expect(d.evidence).toMatch(/^Rules passed, but the reader wants 1 missing record: Invoice\./);
  });
});

describe("runLineStatement: what a payment run line says about the reader", () => {
  it("says nothing when the reader has nothing open", () => {
    expect(runLineStatement({ rules: [pass("a")], reader: clean })).toBeNull();
    expect(runLineStatement({ rules: [pass("a")], reader: null })).toBeNull();
  });

  it("gives the request page's own sentence and a concern chip for a recorded run the rules did not see", () => {
    const reader: ReaderView = { confidence: 25, concerns: [PAYPAL_FLAG], missing: [], recorded: true };
    const line = runLineStatement({ rules: [pass("a")], reader })!;
    expect(line.note).toBe(checkStatement({ rules: [pass("a")], reader }).text);
    expect(line.note).toMatch(/the recorded Claude run raised 1 concern.*The rules did not see this run\.$/);
    expect(line.chips).toEqual(["1 reader concern", "Low confidence 25%"]);
  });

  it("names low confidence alone, and keeps the reader chip when a rule also warns", () => {
    const low = runLineStatement({ rules: [pass("a")], reader: { confidence: 60, concerns: [], missing: [], recorded: false } })!;
    expect(low.chips).toEqual(["Low confidence 60%"]);
    expect(low.note).toBe("Rules passed, but the reader's confidence is 60%, below the 75% threshold.");
    const both = runLineStatement({ rules: [warn("tax_form", "No W-9")], reader: { confidence: 90, concerns: ["Total differs"], missing: [], recorded: false } })!;
    expect(both.chips).toEqual(["1 reader concern"]);
    expect(both.note).toBe("Rules passed, with 1 warning, and the reader raised 1 concern: Total differs. Confidence 90%.");
  });
});

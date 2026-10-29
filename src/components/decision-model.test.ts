import { describe, expect, it } from "vitest";
import { checkLineCaption, decide, decidingLine, isDuplicateReason, recordNoun, tidyDates, type DecisionInput } from "./decision-model";

const base: DecisionInput = { state: "blocked", amountMinor: 96000, currency: "USD", blockedReason: null, policyReasons: [], rules: [], selectedRail: "paypal", quote: null, availableRails: ["paypal"], hasAccounting: false };
const pass = (ruleId: string, message: string) => ({ ruleId, passed: true, severity: "info", message });

describe("decide", () => {
  it("states an amount mismatch in money, with the correction inline", () => {
    const d = decide({ ...base, blockedReason: "Requested USD 960.00 but Trip sheet HG-4D-0927 says USD 800.00 (+USD 160.00)" });
    expect(d.tone).toBe("blocked");
    expect(d.title).toBe("Blocked: USD 160 more than the trip sheet");
    expect(d.evidence).toBe("Requested USD 960.00. Trip sheet HG-4D-0927 says USD 800.00.");
    expect(d.action).toMatchObject({ kind: "amend_amount", amountMinor: 80000, label: "Correct to USD 800.00" });
  });

  it("names the original of a duplicate by vendor and reference, never its id", () => {
    const d = decide({
      ...base,
      amountMinor: 18000,
      blockedReason: "Reference JOB-HG4D-0914 was already used by obligation obl_abc123 (settled)",
      earlier: { id: "obl_abc123", vendorName: "Maria Santos", sourceRef: "JOB-HG4D-0914", amountMinor: 18000, currency: "USD", state: "settled", settledAt: "2026-09-16T03:12:44Z" },
    });
    expect(d.title).toBe("Blocked: USD 180 already paid for JOB-HG4D-0914");
    expect(d.evidence).toBe("The original was paid on 16 Sept 2026:");
    expect(d.evidenceLink).toEqual({ href: "/obligations/obl_abc123", label: "Maria Santos, JOB-HG4D-0914", after: ", USD 180.00." });
    expect(d.action).toMatchObject({ kind: "reject", label: "Cancel request" });
    expect(`${d.title} ${d.evidence} ${d.evidenceLink?.label}`).not.toMatch(/obl_/);
  });

  it("asks for approval above the threshold", () => {
    const d = decide({
      ...base,
      state: "awaiting_approval",
      amountMinor: 75000,
      policyReasons: ["Amount exceeds auto-execute threshold USD 250.00"],
      rules: [pass("amount_matches_evidence", "Amount matches Trip sheet PAL-3D-0927")],
      quote: { rail: "stellar", receiveAmountMinor: 4466600, receiveCurrency: "PHP", feeMinor: 600, sendCurrency: "USD" },
    });
    expect(d.tone).toBe("attention");
    expect(d.title).toBe("Needs your approval: above USD 250");
    expect(d.evidence).toBe("Every check passed. Amount matches Trip sheet PAL-3D-0927. Stellar delivers PHP 44,666.00.");
    expect(d.action).toMatchObject({ kind: "approve", label: "Approve" });
  });

  it("leads with the specific warning, not the boilerplate one about who typed the evidence (PR6-2)", () => {
    const warn = (ruleId: string, message: string) => ({ ruleId, passed: false, severity: "warn", message });
    const d = decide({
      ...base,
      state: "awaiting_approval",
      amountMinor: 88000,
      policyReasons: ["Evidence supplied by operator, not system; check it against the source documents"],
      rules: [warn("evidence_provenance", "Evidence supplied by operator, not system; check it against the source documents"), warn("stated_unit_rate", "The invoice charges USD 220.00 per day; the contract rate is USD 200.00 per vehicle-day (USD 80.00 more over 4 vehicle-days). Check it against the contract before approving")],
    });
    expect(d.title).toBe("Needs your approval: 2 warnings on USD 880.00");
    expect(d.evidence).toMatch(/^The invoice charges USD 220.00 per day; the contract rate is USD 200.00 per vehicle-day/);
  });

  it("offers the router's rail when ready to pay", () => {
    const d = decide({ ...base, state: "approved", amountMinor: 18000, rules: [pass("a", "x"), pass("b", "y")], quote: { rail: "paypal", receiveAmountMinor: 1093131, receiveCurrency: "PHP", feeMinor: 360, sendCurrency: "USD" } });
    expect(d.tone).toBe("settled");
    expect(d.title).toBe("Ready to pay: USD 180.00");
    expect(d.evidence).toBe("All 2 checks passed. Recipient gets PHP 10,931.31 by PayPal, fee USD 3.60.");
    expect(d.action).toMatchObject({ kind: "pay", rail: "paypal", label: "Pay with PayPal" });
  });

  it("says paid and reconciled once the books have it", () => {
    const d = decide({ ...base, state: "settled", hasAccounting: true, settlement: { rail: "paypal", grossMinor: 18000, grossCurrency: "USD", receivedMinor: 1093131, receivedCurrency: "PHP", settledAt: "2026-10-12T03:00:00Z" } });
    expect(d.title).toBe("Paid and reconciled");
    expect(d.tone).toBe("settled");
    expect(d.action).toBeNull();
  });
});

describe("helpers", () => {
  it("names the record kind without its reference", () => {
    expect(recordNoun("Trip sheet HG-4D-0927")).toBe("trip sheet");
    expect(recordNoun("Booking confirmation HG-4D-1001")).toBe("booking confirmation");
    expect(recordNoun("Invoice")).toBe("invoice");
  });
  it("shows ISO dates the way the rest of the page does", () => {
    expect(tidyDates("Payout details verified 2026-08-14")).toBe("Payout details verified 14 Aug 2026");
  });
});

describe("PayPal's own records", () => {
  const paypal = "PayPal transaction 9QX11122AB3344556 on 2026-10-20 already paid USD 240.00 for JOB-KAL3D-1019 to rosa@example.com";

  it("titles the paypal_history block by the job, with the transaction id and date as evidence", () => {
    const d = decide({ ...base, amountMinor: 24000, blockedReason: paypal, rules: [{ ruleId: "paypal_history", passed: false, severity: "block", message: paypal }] });
    expect(d.title).toBe("Blocked: PayPal already paid JOB-KAL3D-1019");
    expect(d.evidence).toBe("PayPal transaction 9QX11122AB3344556, 20 Oct 2026: USD 240.00 to rosa@example.com.");
    expect(d.action).toMatchObject({ kind: "reject", label: "Cancel request" });
  });

  it("adds PayPal's agreement to a duplicate the app found first, and does not count it again", () => {
    const ref = "Reference JOB-HG4D-0914 was already used by obligation obl_abc123 (settled)";
    const pp = "PayPal transaction A12EE6CBFE3F3 on 2026-10-11 already paid USD 180.00 for JOB-HG4D-0914 to maria.santos@example.com";
    const d = decide({ ...base, amountMinor: 18000, blockedReason: ref, rules: [{ ruleId: "no_duplicate", passed: false, severity: "block", message: ref }, { ruleId: "paypal_history", passed: false, severity: "block", message: pp }] });
    expect(d.title).toBe("Blocked: USD 180 already requested for JOB-HG4D-0914");
    expect(d.note).toBe("PayPal's own records agree: transaction A12EE6CBFE3F3.");
    expect(d.alsoStated).toEqual([pp]);
  });

  it("treats every form of duplicate alike, for the action panel", () => {
    expect(isDuplicateReason(paypal)).toBe(true);
    expect(isDuplicateReason("Same job as obligation obl_4fbc (settled): both name INV-TAM-0834")).toBe(true);
    expect(isDuplicateReason("Reference X was already used by obligation obl_1 (settled)")).toBe(true);
    expect(isDuplicateReason("Requested USD 960.00 but Trip sheet says USD 800.00")).toBe(false);
  });
});

describe("checkLineCaption", () => {
  const tam = "Same job as obligation obl_4fbc2b0094b54704 (settled): both name INV-TAM-0834, this one under a new reference INV-TAM-0834-B";

  it("names the original's reference for a duplicate by job, never its id", () => {
    expect(checkLineCaption(tam)).toBe("same job as INV-TAM-0834");
    const earlier = new Map([["obl_4fbc2b0094b54704", { id: "obl_4fbc2b0094b54704", vendorName: "Tam Motorbike Rental", sourceRef: "INV-TAM-0834", amountMinor: 36000, currency: "USD", state: "settled", settledAt: null }]]);
    expect(checkLineCaption(tam, earlier)).toBe("same job as INV-TAM-0834");
  });

  it("never lets obl_ through, whatever the reason", () => {
    const reasons = [tam, "Reference JOB-1 was already used by obligation obl_abc (settled)", "Same job as obligation obl_x (approved)", "Something about payment request obl_zz9 (sent) that is long enough to be cut off at the end", "Odd: obl_123 here", "PayPal transaction 9QX on 2026-10-20 already paid USD 1.00 for JOB-1 to a@b.c"];
    for (const r of reasons) expect(checkLineCaption(r)).not.toMatch(/obl_|obligation/i);
  });

  it("keeps the short forms", () => {
    expect(checkLineCaption("Reference JOB-1 was already used by obligation obl_abc (settled)")).toBe("duplicate reference");
    expect(checkLineCaption("Requested USD 960.00 but Trip sheet HG-4D-0927 says USD 800.00 (+USD 160.00)")).toBe("evidence says USD 800.00");
  });
});

describe("decidingLine", () => {
  it("states ask, evidence and destination in one line, leaving a rate out of the evidence total", () => {
    const line = decidingLine({ askMinor: 96000, currency: "USD", evidence: [{ kind: "contract", amountMinor: 20000, currency: "USD" }, { kind: "job_sheet", amountMinor: 80000, currency: "USD" }], vendorName: "Phuong Transport", rail: "paypal", verified: true });
    expect(line).toBe("Asked USD 960.00. Evidence USD 800.00. Goes to Phuong Transport by PayPal.");
  });

  it("counts what Policy also found, and flags unverified payout details", () => {
    const line = decidingLine({ askMinor: 80000, currency: "USD", evidence: [], vendorName: "Phuong Transport", rail: null, verified: false, alsoFound: { blocks: 1, warnings: 2 } });
    expect(line).toBe("Asked USD 800.00. No evidence states an amount. Goes to Phuong Transport. Payout details never verified. Policy also found 1 more block and 2 warnings, listed first under Policy.");
  });
});

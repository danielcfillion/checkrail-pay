import { describe, expect, it } from "vitest";
import { decide, recordNoun, tidyDates, type DecisionInput } from "./decision-model";

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

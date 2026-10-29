import { describe, expect, it } from "vitest";
import { autopilotSentence, checkStatement, concernNote, type ReaderView } from "./check-statement";
import { decide, type DecisionInput } from "./decision-model";

/** Any sentence that tells a person the request is in the clear. */
const CLAIM = /checks? passed|every (check|rule)|all clear|nothing wrong|no concerns/i;

const pass = (ruleId: string, message = "ok") => ({ ruleId, passed: true, severity: "info", message });
const concern: ReaderView = { confidence: 25, concerns: ["Possible duplicate: a PayPal transaction on 2026-10-12 already pays this job reference. Confirm."], missing: [], recorded: true };
const clean: ReaderView = { confidence: 93, concerns: [], missing: [], recorded: false };

const base: DecisionInput = {
  state: "drafted",
  vendorName: "Maria Santos",
  amountMinor: 18000,
  currency: "USD",
  blockedReason: null,
  policyReasons: [],
  rules: [pass("amount_matches_evidence", "Amount matches Trip sheet HG-4D-0921"), pass("vendor_known")],
  selectedRail: "paypal",
  quote: { rail: "paypal", receiveAmountMinor: 1093131, receiveCurrency: "PHP", feeMinor: 360, sendCurrency: "USD" },
  availableRails: ["paypal"],
  hasAccounting: false,
  settlement: { rail: "paypal", grossMinor: 18000, grossCurrency: "USD", receivedMinor: 1093131, receivedCurrency: "PHP", settledAt: "2026-10-12T03:00:00Z" },
};

const STATES: Array<[string, Partial<DecisionInput>]> = [
  ["drafted", {}],
  ["needs_evidence", {}],
  ["awaiting_approval", { policyReasons: ["Amount exceeds auto-execute threshold USD 250.00"] }],
  ["approved", {}],
  ["execution_pending", {}],
  ["sent", {}],
  ["settled", {}],
  ["failed", {}],
  ["refunded", {}],
  ["cancelled", {}],
  ["blocked", { blockedReason: "Requested USD 960.00 but Trip sheet HG-4D-0927 says USD 800.00 (+USD 160.00)" }],
];

const said = (d: ReturnType<typeof decide>) => [d.title, d.evidence, d.note].filter(Boolean).join(" ");

describe("no state tells a person the request is clear over an open reader concern", () => {
  for (const [state, extra] of STATES) {
    it(`${state}: with a concern`, () => {
      const d = decide({ ...base, ...extra, state, reader: concern });
      expect(said(d), said(d)).not.toMatch(CLAIM);
    });
  }

  it("approved: names the concern, with a chip, instead of 'All 2 checks passed'", () => {
    const d = decide({ ...base, state: "approved", reader: concern });
    expect(d.evidence).toMatch(/^Rules passed, but the recorded Claude run raised 1 concern: Possible duplicate\. Confidence 25%\. The rules did not see this run\. Recipient gets PHP 10,931\.31 by PayPal, fee USD 3\.60\.$/);
    expect(d.chip).toBe("1 reader concern");
    expect(d.action).toMatchObject({ kind: "pay", label: "Pay with PayPal" });
  });

  it("approved: green only when clear; amber with a warning icon and the chip for anything else", () => {
    const clear = decide({ ...base, state: "approved", reader: clean });
    expect(clear).toMatchObject({ tone: "settled" });
    expect(clear.icon).toBeUndefined();
    expect(clear.chip ?? null).toBeNull();
    const withConcern = decide({ ...base, state: "approved", reader: concern });
    expect(withConcern).toMatchObject({ tone: "attention", icon: "warn", chip: "1 reader concern" });
    const low = decide({ ...base, state: "approved", reader: { confidence: 60, concerns: [], missing: [], recorded: false } });
    expect(low).toMatchObject({ tone: "attention", icon: "warn", chip: "Low confidence 60%" });
    const missing = decide({ ...base, state: "approved", reader: { confidence: 90, concerns: [], missing: ["Invoice"], recorded: false } });
    expect(missing).toMatchObject({ tone: "attention", icon: "warn" });
    const warned = decide({ ...base, state: "approved", rules: [pass("a"), { ruleId: "vendor_new", passed: false, severity: "warn", message: "First payment to this vendor" }], reader: clean });
    expect(warned).toMatchObject({ tone: "attention", icon: "warn", chip: "1 warning" });
    // States other than approved keep their own tone.
    expect(decide({ ...base, state: "settled", reader: concern }).tone).toBe("settled");
    expect(decide({ ...base, state: "blocked", blockedReason: "Requested USD 960.00 but Trip sheet HG-4D-0927 says USD 800.00 (+USD 160.00)", reader: concern }).tone).toBe("blocked");
  });

  it("approved: still says all checks passed when the reading is clean, or when nobody has read it", () => {
    for (const reader of [clean, null, undefined]) {
      const d = decide({ ...base, state: "approved", reader });
      expect(d.evidence).toBe("All 2 checks passed. Recipient gets PHP 10,931.31 by PayPal, fee USD 3.60.");
      expect(d.chip ?? null).toBeNull();
    }
  });

  it("approved: a low reading with no concern is named too", () => {
    const d = decide({ ...base, state: "approved", reader: { confidence: 60, concerns: [], missing: [], recorded: false } });
    expect(d.evidence).toMatch(/^Rules passed, but the reader's confidence is 60%, below the 75% threshold\./);
    expect(d.chip).toBe("Low confidence 60%");
  });

  it("approved over a warning keeps its own wording when the reading is clean", () => {
    const rules = [pass("a"), { ruleId: "vendor_new", passed: false, severity: "warn", message: "First payment to this vendor" }];
    expect(decide({ ...base, state: "approved", rules, reader: clean }).evidence).toMatch(/^1 of 2 checks passed; the rest were approved\./);
  });

  it("awaiting approval: clear without a concern, qualified with one", () => {
    const awaiting = { ...base, state: "awaiting_approval", policyReasons: ["Amount exceeds auto-execute threshold USD 250.00"] };
    expect(decide({ ...awaiting, reader: clean }).evidence).toMatch(/^Every check passed\./);
    expect(decide({ ...awaiting, reader: concern }).evidence).toMatch(/^Rules passed, but the recorded Claude run raised 1 concern/);
  });

  it("the states with no claim to make stay silent with and without a concern", () => {
    for (const state of ["drafted", "needs_evidence", "execution_pending", "sent", "settled", "failed", "refunded", "cancelled"]) {
      for (const reader of [clean, concern]) expect(said(decide({ ...base, state, reader })), state).not.toMatch(CLAIM);
    }
  });
});

describe("concernNote", () => {
  it("is null when clear, and otherwise the chip and the statement without its 'Rules passed, but'", () => {
    expect(concernNote(checkStatement({ rules: [pass("a")], reader: clean }))).toBeNull();
    expect(concernNote(checkStatement({ rules: [pass("a")], reader: concern }))).toEqual({
      chip: "1 reader concern",
      line: "The recorded Claude run raised 1 concern: Possible duplicate. Confidence 25%. The rules did not see this run.",
    });
    const low = concernNote(checkStatement({ rules: [pass("a")], reader: { confidence: 60, concerns: [], missing: [], recorded: false } }));
    expect(low).toEqual({ chip: "Low confidence 60%", line: "The reader's confidence is 60%, below the 75% threshold." });
  });
});

describe("autopilotSentence", () => {
  it("says every check passed only when the statement is clear", () => {
    expect(autopilotSentence(checkStatement({ rules: [pass("a")], reader: clean }))).toBe("Every check passed and this is within your caps, so the agent will send it when the cancel window ends. Policy runs once more at that moment.");
  });

  it("leads with the concern and says the agent will still send it unless cancelled", () => {
    const s = autopilotSentence(checkStatement({ rules: [pass("a")], reader: concern }));
    expect(s).not.toMatch(/every check passed/i);
    expect(s).toMatch(/^Rules passed, but the recorded Claude run raised 1 concern/);
    expect(s).toMatch(/so the agent will send it when the cancel window ends unless you cancel it\. Policy runs once more at that moment\.$/);
  });
});

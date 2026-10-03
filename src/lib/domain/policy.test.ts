import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "./policy";
import { DEFAULT_POLICY, type PolicyInput, type VendorPayoutProfile } from "./types";

const vendor: VendorPayoutProfile = {
  id: "v1",
  name: "Maria Santos",
  country: "PH",
  preferredRail: null,
  paypalEmail: "maria@example.com",
  stellarAccount: null,
  bankCountry: "PH",
  bankCurrency: "PHP",
  bankLabel: "BDO ****1234",
  detailsHash: "abc",
  verifiedAt: "2026-09-01T00:00:00Z",
};

function base(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    obligation: { id: "o1", amountMinor: 18_000, currency: "USD", sourceRef: "JOB-0921", vendorId: "v1" },
    vendor,
    evidence: [
      { id: "e1", kind: "job_sheet", label: "Job sheet JOB-0921", amountMinor: 18_000, currency: "USD", reference: "JOB-0921", excerpt: null },
    ],
    ai: { vendorName: "Maria Santos", vendorId: "v1", amountMinor: 18_000, currency: "USD", description: "Guide fee", sourceRef: "JOB-0921", dueDate: null, summary: "", confidence: 92, flags: [], missing: [] },
    businessCountry: "US",
    baseCurrency: "USD",
    priorSourceRefs: [],
    approvalsCount: 0,
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  it("auto-executes a small, evidenced, matching obligation", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base());
    expect(out.decision).toBe("auto_execute");
    expect(out.reasons).toEqual([]);
  });

  it("blocks on amount mismatch beyond tolerance", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({ obligation: { id: "o1", amountMinor: 24_000, currency: "USD", sourceRef: "JOB-0921", vendorId: "v1" } }));
    expect(out.decision).toBe("block");
    expect(out.reasons.join(" ")).toMatch(/Requested USD 240.00/);
  });

  it("passes amount within tolerance", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({ obligation: { id: "o1", amountMinor: 18_050, currency: "USD", sourceRef: "JOB-0921", vendorId: "v1" } }));
    expect(out.decision).toBe("auto_execute");
  });

  it("blocks duplicate reference for same vendor", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({ priorSourceRefs: [{ obligationId: "o0", sourceRef: "job-0921", amountMinor: 18_000, state: "settled" }] }));
    expect(out.decision).toBe("block");
    expect(out.reasons[0]).toMatch(/already used/);
  });

  it("holds when evidence is missing", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({ evidence: [] }));
    expect(out.decision).toBe("hold");
  });

  it("requires approval above auto threshold", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({
      obligation: { id: "o1", amountMinor: 120_000, currency: "USD", sourceRef: "INV-9", vendorId: "v1" },
      evidence: [{ id: "e1", kind: "invoice", label: "Invoice INV-9", amountMinor: 120_000, currency: "USD", reference: "INV-9", excerpt: null }],
    }));
    expect(out.decision).toBe("require_approval");
  });

  it("auto-executes above threshold once approved", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({
      obligation: { id: "o1", amountMinor: 120_000, currency: "USD", sourceRef: "INV-9", vendorId: "v1" },
      evidence: [{ id: "e1", kind: "invoice", label: "Invoice INV-9", amountMinor: 120_000, currency: "USD", reference: "INV-9", excerpt: null }],
      approvalsCount: 1,
    }));
    expect(out.decision).toBe("auto_execute");
  });

  it("requires two approvals above dual threshold", () => {
    const big = { id: "o1", amountMinor: 900_000, currency: "USD", sourceRef: "INV-10", vendorId: "v1" };
    const ev = [{ id: "e1", kind: "invoice", label: "Invoice INV-10", amountMinor: 900_000, currency: "USD", reference: "INV-10", excerpt: null }];
    expect(evaluatePolicy(DEFAULT_POLICY, base({ obligation: big, evidence: ev, approvalsCount: 1 })).decision).toBe("require_approval");
    expect(evaluatePolicy(DEFAULT_POLICY, base({ obligation: big, evidence: ev, approvalsCount: 2 })).decision).toBe("auto_execute");
  });

  it("blocks when recipient details are unverified", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({ vendor: { ...vendor, verifiedAt: null } }));
    expect(out.decision).toBe("block");
  });

  it("blocks unsupported corridor", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({ vendor: { ...vendor, country: "NG" } }));
    expect(out.decision).toBe("block");
    expect(out.reasons.join()).toMatch(/US->NG/);
  });

  it("low AI confidence downgrades auto to approval, never upgrades", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({ ai: { ...base().ai!, confidence: 40 } }));
    expect(out.decision).toBe("require_approval");
  });

  it("AI flags cannot unblock a hard failure", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({
      obligation: { id: "o1", amountMinor: 24_000, currency: "USD", sourceRef: "JOB-0921", vendorId: "v1" },
      ai: { ...base().ai!, confidence: 100, flags: [], missing: [] },
    }));
    expect(out.decision).toBe("block");
  });

  it("unknown vendor blocks", () => {
    expect(evaluatePolicy(DEFAULT_POLICY, base({ vendor: null })).decision).toBe("block");
  });
});

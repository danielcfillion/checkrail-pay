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

  it("blocks a currency other than the business base currency (M4)", () => {
    const out = evaluatePolicy(DEFAULT_POLICY, base({
      obligation: { id: "o1", amountMinor: 18_000, currency: "PHP", sourceRef: "JOB-0921", vendorId: "v1" },
      evidence: [],
    }));
    expect(out.decision).toBe("block");
    expect(out.reasons.join(" ")).toMatch(/Currency PHP is not supported/);
  });

  it("blocks amounts that are not a safe in-range integer", () => {
    for (const amountMinor of [18_000.5, 1e21, 2_000_000_000, -1, Number.NaN]) {
      const out = evaluatePolicy(DEFAULT_POLICY, base({ obligation: { id: "o1", amountMinor, currency: "USD", sourceRef: "JOB-0921", vendorId: "v1" }, evidence: [] }));
      expect(out.decision).toBe("block");
    }
  });

  it("forces approval when a vendor's 24h total passes the cap, and approval clears it (H7)", () => {
    const over = base({ vendorRecentMinor: 90_000 });
    const out = evaluatePolicy(DEFAULT_POLICY, over);
    expect(out.decision).toBe("require_approval");
    expect(out.reasons.join(" ")).toMatch(/daily cap/);
    expect(evaluatePolicy(DEFAULT_POLICY, { ...over, approvalsCount: 1 }).decision).toBe("auto_execute");
    // Exactly at the cap is fine; a cap of 0 disables the rule.
    expect(evaluatePolicy(DEFAULT_POLICY, base({ vendorRecentMinor: 82_000 })).decision).toBe("auto_execute");
    expect(evaluatePolicy({ ...DEFAULT_POLICY, vendorDailyCapMinor: 0 }, over).decision).toBe("auto_execute");
  });

  it("an older policy without the cap field falls back to no cap rather than crashing", () => {
    const { vendorDailyCapMinor: _omit, ...legacy } = DEFAULT_POLICY;
    void _omit;
    expect(evaluatePolicy(legacy, base({ vendorRecentMinor: 900_000 })).decision).toBe("auto_execute");
  });

  it("warns on operator-supplied evidence and needs one approval to acknowledge it (H7)", () => {
    const ev = [{ ...base().evidence[0], provenance: "operator" as const }];
    const out = evaluatePolicy(DEFAULT_POLICY, base({ evidence: ev }));
    expect(out.decision).toBe("require_approval");
    expect(out.reasons.join(" ")).toMatch(/Evidence supplied by operator, not system/);
    expect(evaluatePolicy(DEFAULT_POLICY, base({ evidence: ev, approvalsCount: 1 })).decision).toBe("auto_execute");
    const sys = [{ ...base().evidence[0], provenance: "system" as const }];
    expect(evaluatePolicy(DEFAULT_POLICY, base({ evidence: sys })).decision).toBe("auto_execute");
  });
});

describe("duplicate detection beyond the exact reference", () => {
  const base = (over: Partial<Parameters<typeof evaluatePolicy>[1]>) =>
    evaluatePolicy(DEFAULT_POLICY, {
      obligation: { id: "o2", amountMinor: 18_000, currency: "USD", sourceRef: "INV-MS-0044", vendorId: "ven_maria" },
      vendor: { id: "ven_maria", name: "Maria Santos", country: "PH", preferredRail: null, paypalEmail: "m@example.com", stellarAccount: null, bankCountry: "PH", bankCurrency: "PHP", bankLabel: "x", verifiedAt: "2026-08-14T00:00:00.000Z", detailsHash: "h" } as never,
      evidence: [{ id: "e", kind: "invoice", label: "Invoice INV-MS-0044", amountMinor: 18_000, currency: "USD", reference: "INV-MS-0044", excerpt: "guide fee" }] as never,
      ai: null,
      businessCountry: "US",
      baseCurrency: "USD",
      priorSourceRefs: [{ obligationId: "o1", sourceRef: "JOB-HG4D-0914", amountMinor: 18_000, state: "settled", keys: ["job-hg4d-0914", "~hg4d0914", "hg-4d-0914"], updatedAt: new Date().toISOString() }],
      approvalsCount: 0,
      ...over,
    });

  it("blocks the same trip re-invoiced under a new number when the text names the trip", () => {
    const o = base({ jobKeys: ["inv-ms-0044", "~ms0044", "hg-4d-0914", "~hg4d0914"] });
    const r = o.rules.find((x) => x.ruleId === "no_duplicate")!;
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("block");
    expect(r.message).toMatch(/Same job as obligation o1/);
  });

  it("warns and forces approval when only the amount matches and the invoice names no job", () => {
    const o = base({ jobKeys: ["inv-ms-0044", "~ms0044"] });
    const r = o.rules.find((x) => x.ruleId === "no_duplicate")!;
    expect(r.passed).toBe(false);
    expect(r.severity).toBe("warn");
    expect(o.decision).toBe("require_approval");
  });

  it("passes a same-amount invoice that names a different trip", () => {
    const o = base({ jobKeys: ["inv-ms-0044", "~ms0044", "hg-4d-0921", "~hg4d0921"] });
    expect(o.rules.find((x) => x.ruleId === "no_duplicate")!.passed).toBe(true);
  });
});

describe("the agent's vendor choice is bound to the evidence", () => {
  const run = (evidence: Array<{ label: string; excerpt: string; reference: string | null }>) =>
    evaluatePolicy(DEFAULT_POLICY, {
      obligation: { id: "o", amountMinor: 18_000, currency: "USD", sourceRef: "INV-77", vendorId: "ven_jake" },
      vendor: { id: "ven_jake", name: "Jake Morrison", country: "US", preferredRail: null, paypalEmail: "j@example.com", stellarAccount: null, bankCountry: "US", bankCurrency: "USD", bankLabel: "x", verifiedAt: "2026-08-14T00:00:00.000Z", detailsHash: "h" } as never,
      evidence: evidence.map((e, i) => ({ id: `e${i}`, kind: "job_sheet", amountMinor: 18_000, currency: "USD", ...e })) as never,
      ai: null, businessCountry: "US", baseCurrency: "USD", priorSourceRefs: [], approvalsCount: 0,
    });
  it("warns when the attached record names someone else and carries a different reference", () => {
    const o = run([{ label: "Trip sheet HG-4D-0921", excerpt: "Lead guide Maria Santos, 4 days", reference: "JOB-HG4D-0921" }]);
    const r = o.rules.find((x) => x.ruleId === "evidence_names_vendor")!;
    expect(r.passed).toBe(false);
    expect(o.decision).toBe("require_approval");
  });
  it("passes when the record names the vendor", () => {
    expect(run([{ label: "Invoice", excerpt: "Jake Morrison: recap video", reference: null }]).rules.find((x) => x.ruleId === "evidence_names_vendor")!.passed).toBe(true);
  });
});

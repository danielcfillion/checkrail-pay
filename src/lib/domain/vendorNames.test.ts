import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "./policy";
import { DEFAULT_POLICY } from "./types";
import { distinctiveWords, namesVendor } from "./vendorNames";

const VENDORS = [
  { id: "ven_maria", name: "Maria Santos" },
  { id: "ven_phuong", name: "Phuong Transport" },
  { id: "ven_linh", name: "Linh Family Homestay" },
  { id: "ven_tam", name: "Tam Motorbike Rental" },
  { id: "ven_bayan", name: "Bayan Island Boats" },
];
const others = (id: string) => VENDORS.filter((v) => v.id !== id).map((v) => v.name);

describe("namesVendor", () => {
  it("matches the full name or a distinctive word, never a generic business word", () => {
    expect(namesVendor("Driver: Phuong. 4 vehicle days.", "Phuong Transport", others("ven_phuong"))).toBe(true);
    expect(namesVendor("Transport by van included.", "Phuong Transport", others("ven_phuong"))).toBe(false);
    expect(namesVendor("Family group of 4, homestay nights included.", "Linh Family Homestay", others("ven_linh"))).toBe(false);
    expect(namesVendor("Two nights at Linh's.", "Linh Family Homestay", others("ven_linh"))).toBe(true);
    expect(namesVendor("Two nights with Linh, breakfast.", "Linh Family Homestay", others("ven_linh"))).toBe(true);
    expect(namesVendor("Island hopping, boats from the pier.", "Bayan Island Boats", others("ven_bayan"))).toBe(false);
    expect(namesVendor("Phương Transport, Hà Giang", "Phuong Transport", others("ven_phuong"))).toBe(true);
  });
  it("a first name shared by two vendors is no longer distinctive", () => {
    expect(distinctiveWords("Maria Santos", ["Maria Lopez"])).toEqual(["santos"]);
    expect(namesVendor("Guide: Maria.", "Maria Santos", ["Maria Lopez"])).toBe(false);
  });
});

describe("a trip sheet cannot pay a vendor it does not name (critic round 3)", () => {
  const run = (vendorId: string, vendorName: string, excerpt: string) =>
    evaluatePolicy(DEFAULT_POLICY, {
      obligation: { id: "o", amountMinor: 18_000, currency: "USD", sourceRef: "JOB-HG4D-1009", vendorId },
      vendor: { id: vendorId, name: vendorName, country: "VN", preferredRail: null, paypalEmail: "x@example.com", stellarAccount: null, bankCountry: "VN", bankCurrency: "VND", bankLabel: "x", verifiedAt: "2026-08-14T00:00:00.000Z", detailsHash: "h" } as never,
      evidence: [{ id: "e1", kind: "job_sheet", label: "Trip sheet HG-4D-1009", amountMinor: 18_000, currency: "USD", reference: "JOB-HG4D-1009", excerpt, provenance: "system" }],
      ai: { vendorName, vendorId, amountMinor: 18_000, currency: "USD", description: "Trip fee", sourceRef: "JOB-HG4D-1009", dueDate: null, summary: "", confidence: 92, flags: [], missing: [] },
      businessCountry: "US", baseCurrency: "USD", priorSourceRefs: [], approvalsCount: 0, knownVendorNames: VENDORS,
    });
  it("A2: 'transport by van' on Maria's sheet does not clear Phuong Transport", () => {
    expect(run("ven_phuong", "Phuong Transport", "Lead guide Maria Santos, guide fee USD 180. Transport by van.").decision).toBe("require_approval");
  });
  it("A3: a sheet naming both the driver and the guide holds the payment for a person", () => {
    const o = run("ven_phuong", "Phuong Transport", "Driver: Phuong Transport. Lead guide Maria Santos, guide fee USD 180.");
    expect(o.decision).toBe("require_approval");
    expect(o.reasons.join(" ")).toMatch(/also Maria Santos/);
  });
  it("A4: 'family group' and 'homestay' do not clear Linh Family Homestay", () => {
    expect(run("ven_linh", "Linh Family Homestay", "Lead guide Maria Santos, family group of 4, homestay nights. USD 180.").decision).toBe("require_approval");
  });
  it("Maria's own sheet still clears Maria", () => {
    const o = run("ven_maria", "Maria Santos", "Lead guide Maria Santos, guide fee USD 180. Transport by van.");
    expect(o.reasons).toEqual([]);
    expect(o.decision).toBe("auto_execute");
  });
});

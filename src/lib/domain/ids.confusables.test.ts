import { describe, it, expect } from "vitest";
import { foldConfusables, hasConfusables, jobKeys } from "./ids";

describe("references with look-alike characters", () => {
  it("keys a Cyrillic, full-width or zero-width disguised reference as the same job", () => {
    const plain = jobKeys("JOB-HG4D-0914");
    expect(jobKeys("JOB-HG4D-0914".replace("O", "\u041E"))).toEqual(plain);
    expect(jobKeys("\uFF2AOB-HG4D-0914")).toEqual(plain);
    expect(jobKeys("JOB-HG4D\u200B-0914")).toEqual(plain);
    expect(jobKeys("JOB\u2013HG4D\u20130914")).toEqual(plain);
  });

  it("flags a reference that only looks plain", () => {
    expect(hasConfusables("INV-2026-0152")).toBe(false);
    expect(hasConfusables("INV-2026-0152".replace("I", "\u0406"))).toBe(true);
    expect(foldConfusables("\u0420\u041E-1182")).toBe("PO-1182");
  });
});

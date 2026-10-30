import { describe, it, expect } from "vitest";
import { foldConfusables, hasConfusables, jobKeys, mixesScripts } from "./ids";

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

  it("flags look-alikes from scripts the fold list misses, without a list (SEC2-7)", () => {
    const ref = "JOB-HG4D-0914";
    // Armenian O, Cherokee A, Latin small capital O, Coptic o and a Devanagari zero each slip past the fold list.
    for (const [from, to] of [["O", "\u0555"], ["O", "\u0585"], ["J", "\u13AB"], ["O", "\u1D0F"], ["O", "\u2C9F"], ["0", "\u0966"]]) {
      const spoof = ref.replace(from, to);
      expect(foldConfusables(spoof)).toBe(spoof.normalize("NFKC"));
      expect(hasConfusables(spoof)).toBe(true);
      expect(mixesScripts(spoof)).toBe(true);
    }
    // Plain references, Vietnamese diacritics and a whole word in another script are not flagged.
    for (const ok of [ref, "INV-2026-0152", "HĐ-Nguyễn-0914", "Hóa đơn 0914", "\u0436\u0437\u0438", "\u0394\u03A9"]) expect(hasConfusables(ok)).toBe(false);
    // The Cyrillic case still reports as folded, not as mixed.
    expect(mixesScripts(ref.replace("O", "\u041E"))).toBe(false);
  });
});

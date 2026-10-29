import { describe, expect, it } from "vitest";
import { DEMO_PERSONAS } from "@/lib/auth/roles";
import { personaLabel } from "./persona-label";

describe("personaLabel", () => {
  it("shortens the longest persona so the sidebar select does not cut it off", () => {
    expect(personaLabel("Minh (operations manager)")).toBe("Minh (ops manager)");
    expect(personaLabel("Daniel (owner)")).toBe("Daniel (owner)");
  });
  it("keeps every demo persona within what fits (about 20 characters)", () => {
    for (const p of DEMO_PERSONAS) expect(personaLabel(p.name).length, p.name).toBeLessThanOrEqual(20);
  });
});

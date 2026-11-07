import { describe, expect, it } from "vitest";
import { PROMPT_STARTERS, guideInstructions } from "./onboardingAi";
import { FALSE_HOLDS, READINESS_GAUGE } from "./onboardingReport";

describe("the assistant on Your first weeks", () => {
  it("offers the three starters from the brief", () => {
    expect(PROMPT_STARTERS.map((p) => p.label)).toEqual(["Why am I not ready for Autopilot yet?", "Which supplier causes most holds that turned out fine?", "Add a chart of money stopped by supplier"]);
    for (const p of PROMPT_STARTERS) expect(p.prompt.length).toBeGreaterThan(p.label.length);
  });

  it("tells the guide what it may not do, which widgets to use, and the business's currency", () => {
    const text = guideInstructions("Ridgeline Expeditions", "VND");
    expect(text).toMatch(/cannot change a rule/);
    expect(text).toMatch(/cannot approve, hold or pay anything/);
    expect(text).toContain(READINESS_GAUGE);
    expect(text).toContain(FALSE_HOLDS);
    expect(text).toContain("Ridgeline Expeditions");
    expect(text).toMatch(/Money is in VND/);
    expect(text + JSON.stringify(PROMPT_STARTERS)).not.toMatch(/\u2014/);
  });
});

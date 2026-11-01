import { describe, expect, it } from "vitest";
import { TOUR_STEPS, TOUR_TOTAL, finale, move, nextLabel, parseTourCookie, progressLabel, resolvePath, stepOnPage, tourCookieValue } from "./steps";

const ids = { phuong: "obl_P1", duplicate: "obl_D2", paypal: "obl_M3" };

describe("the judge tour", () => {
  it("has eight steps, in the order the product is meant to be used", () => {
    expect(TOUR_TOTAL).toBe(8);
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(["overview", "phuong", "duplicate", "paypal", "autopilot", "agents", "getting-started", "close"]);
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_TOTAL);
  });

  it("says what to click on every step, short and plain", () => {
    for (const s of TOUR_STEPS) {
      for (const text of [s.title, s.body, s.doThis, s.action?.label ?? "", s.link?.label ?? ""]) {
        expect(text).not.toMatch(/[\u2014\u2013]/); // no em or en dashes
        expect(text.toLowerCase()).not.toContain("obligation"); // people never see the word
      }
      expect(s.doThis).toMatch(/^(Press|Read|Apply)/);
      // One or two sentences.
      expect(s.body.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
      expect(s.title.length).toBeLessThanOrEqual(40);
    }
    for (const sandbox of [true, false]) expect(finale(sandbox).body).not.toMatch(/[\u2014\u2013]/);
    expect(finale(true).title).toBe("Now explore on your own");
  });

  it("has one primary action at most per card, and only steps 5 and 6 act from the card", () => {
    expect(TOUR_STEPS.filter((s) => s.action).map((s) => [s.id, s.action!.kind])).toEqual([
      ["autopilot", "autopilot"],
      ["agents", "demo-agent"],
    ]);
  });

  it("fills in the seeded request ids, and gives up when one is missing", () => {
    expect(resolvePath("/obligations/:phuong", ids)).toBe("/obligations/obl_P1");
    expect(resolvePath("/", ids)).toBe("/");
    expect(resolvePath("/obligations/:paypal", { phuong: "x" })).toBeNull();
    expect(resolvePath("/obligations/:duplicate", { duplicate: "a b" })).toBe("/obligations/a%20b");
  });

  it("knows which step lives on which page, including the extra pages a step allows", () => {
    const byId = (id: string) => TOUR_STEPS.find((s) => s.id === id)!;
    expect(stepOnPage(byId("phuong"), "/obligations/obl_P1", ids)).toEqual({ target: { selector: "button", text: "Correct to" } });
    expect(stepOnPage(byId("phuong"), "/obligations/obl_D2", ids)).toBeNull();
    expect(stepOnPage(byId("overview"), "/", ids)).not.toBeNull();
    expect(stepOnPage(byId("close"), "/close/", ids)).not.toBeNull();
    expect(stepOnPage(byId("getting-started"), "/onboarding/dashboard", ids)).toEqual({ target: { selector: ".cr-gauge" } });
    expect(stepOnPage(byId("getting-started"), "/onboarding", ids)).toEqual({ target: undefined });
    expect(stepOnPage(byId("agents"), "/settings", ids)).toBeNull();
  });

  it("keeps progress in a cookie value, and ignores anything else", () => {
    expect(parseTourCookie(undefined)).toEqual({ status: "off" });
    expect(parseTourCookie("off")).toEqual({ status: "off" });
    expect(parseTourCookie("3")).toEqual({ status: "on", index: 3 });
    expect(parseTourCookie("8")).toEqual({ status: "done" });
    expect(parseTourCookie("done")).toEqual({ status: "done" });
    expect(parseTourCookie("99")).toEqual({ status: "off" });
    expect(parseTourCookie("-1")).toEqual({ status: "off" });
    expect(parseTourCookie("<script>")).toEqual({ status: "off" });
    for (const v of ["off", "0", "7", "done"]) expect(tourCookieValue(parseTourCookie(v))).toBe(v);
  });

  it("moves forward and back, finishes after the last step and never goes below the first", () => {
    expect(move({ status: "on", index: 0 }, -1)).toEqual({ status: "on", index: 0 });
    expect(move({ status: "on", index: 0 }, 1)).toEqual({ status: "on", index: 1 });
    expect(move({ status: "on", index: 7 }, 1)).toEqual({ status: "done" });
    expect(move({ status: "off" }, 1)).toEqual({ status: "off" });
    expect(progressLabel(0)).toBe("Step 1 of 8");
    expect(nextLabel(6)).toBe("Next");
    expect(nextLabel(7)).toBe("Finish");
  });
});

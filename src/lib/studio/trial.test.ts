import { describe, it, expect } from "vitest";
import { trialNotice } from "./trial";

describe("trialNotice", () => {
  it("stays quiet through the last day, then names the date and the contact", () => {
    expect(trialNotice("2026-12-14", "2026-12-14")).toBeNull();
    expect(trialNotice("2026-12-14", "2026-11-05")).toBeNull();
    expect(trialNotice("2026-12-14", "2026-12-15")).toEqual({ label: "14 Dec 2026", contact: "danielcfillion@gmail.com" });
  });
  it("shows nothing when no valid end date is set", () => {
    expect(trialNotice(undefined, "2027-01-01")).toBeNull();
    expect(trialNotice("", "2027-01-01")).toBeNull();
    expect(trialNotice("14/12/2026", "2027-01-01")).toBeNull();
    expect(trialNotice("2026-13-40", "2027-01-01")).toBeNull();
  });
});

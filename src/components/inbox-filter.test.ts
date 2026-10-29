import { describe, expect, it } from "vitest";
import { defaultInboxFilter } from "./inbox-filter";

describe("defaultInboxFilter", () => {
  it("opens on Waiting for you when something waits for this person", () => {
    expect(defaultInboxFilter(undefined, 4)).toBe("mine");
  });
  it("opens on All when nothing waits, or nobody is signed in", () => {
    expect(defaultInboxFilter(undefined, 0)).toBe("all");
    expect(defaultInboxFilter(undefined, null)).toBe("all");
  });
  it("always honours a tab the link names", () => {
    expect(defaultInboxFilter("all", 4)).toBe("all");
    expect(defaultInboxFilter("blocked", 4)).toBe("blocked");
    expect(defaultInboxFilter("mine", 0)).toBe("mine");
  });
});

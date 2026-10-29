import { describe, expect, it } from "vitest";
import { waitingLine } from "./waiting-line";

describe("waitingLine", () => {
  it("says how many wait on this viewer and, separately, how many in all need someone", () => {
    expect(waitingLine({ mine: 4, needsSomeone: 11 })).toEqual({ lead: "4 requests wait on you.", leadHref: "/obligations?filter=mine", rest: "11 in all need someone.", restHref: "/obligations?filter=needs_action" });
  });
  it("does not repeat itself when they are the same set", () => {
    expect(waitingLine({ mine: 1, needsSomeone: 1 })).toEqual({ lead: "1 request waits on you.", leadHref: "/obligations?filter=mine", rest: null, restHref: null });
  });
  it("says nothing waits on you while others still need someone", () => {
    expect(waitingLine({ mine: 0, needsSomeone: 3 })).toEqual({ lead: "Nothing waits on you right now.", leadHref: null, rest: "3 in all need someone.", restHref: "/obligations?filter=needs_action" });
    expect(waitingLine({ mine: 0, needsSomeone: 0 }).rest).toBeNull();
  });
  it("names only the business-wide number when nobody is signed in", () => {
    expect(waitingLine({ mine: null, needsSomeone: 2 })).toEqual({ lead: "2 requests need someone.", leadHref: "/obligations?filter=needs_action", rest: null, restHref: null });
    expect(waitingLine({ mine: null, needsSomeone: 0 }).lead).toBe("Nothing needs anyone right now.");
  });
});

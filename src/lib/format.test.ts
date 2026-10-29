import { describe, expect, it } from "vitest";
import { entryParts, formatDateRange, groupThousands, humaniseEntry, parseDateInput, timeAgoShort } from "./format";

describe("dates as people read them (DS2-17)", () => {
  it("shows a departure as one range", () => {
    expect(formatDateRange("2026-10-24", "2026-10-25")).toBe("24 to 25 Oct 2026");
    expect(formatDateRange("2026-09-30", "2026-10-03")).toBe("30 Sept to 3 Oct 2026");
    expect(formatDateRange("2026-12-30", "2027-01-02")).toBe("30 Dec 2026 to 2 Jan 2027");
    expect(formatDateRange("2026-10-24", "2026-10-24")).toBe("24 Oct 2026");
  });

  it("reads what a person types into a date field and stores ISO", () => {
    expect(parseDateInput("29 Oct 2026")).toBe("2026-10-29");
    expect(parseDateInput("29 October 2026")).toBe("2026-10-29");
    expect(parseDateInput("Oct 29, 2026")).toBe("2026-10-29");
    expect(parseDateInput("2026-10-29")).toBe("2026-10-29");
    expect(parseDateInput("29/10/2026")).toBe("2026-10-29");
    expect(parseDateInput("31 Feb 2026")).toBeNull();
    expect(parseDateInput("soon")).toBeNull();
  });

  it("keeps the Updated column short", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(timeAgoShort("2026-10-29T11:57:00Z", now)).toBe("3 min");
    expect(timeAgoShort("2026-10-21T12:00:00Z", now)).toBe("8 d");
    expect(timeAgoShort("2026-10-29T11:59:50Z", now)).toBe("just now");
  });
});

describe("engine strings as people read them (DS2-16)", () => {
  it("names the reader and the intake source in words", () => {
    expect(humaniseEntry("ai:rules", "ai.interpreted")).toBe("The rule-based reader read the request");
    expect(entryParts("system:booking-webhook", "obligation.created")).toEqual({ who: "", what: "Created from the booking system" });
    expect(entryParts("system:email-ingest", "obligation.created")).toEqual({ who: "", what: "Created from the invoice inbox" });
  });
});

describe("groupThousands", () => {
  it("adds thousands separators to a decimal string and leaves anything else alone", () => {
    expect(groupThousands("1000.00")).toBe("1,000.00");
    expect(groupThousands("1020")).toBe("1,020");
    expect(groupThousands("10800000")).toBe("10,800,000");
    expect(groupThousands("-1234567.5")).toBe("-1,234,567.5");
    expect(groupThousands("999.99")).toBe("999.99");
    expect(groupThousands("n/a")).toBe("n/a");
    expect(groupThousands(null)).toBe("");
    expect(groupThousands(1500)).toBe("1,500");
  });
});

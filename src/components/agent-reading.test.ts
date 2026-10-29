import { describe, expect, it } from "vitest";
import { amountAsRead, correctionLine, RECORDED_LABEL, selectRecordedReading, summaryWithoutCount } from "./agent-reading";
import { recordedReadingFor } from "@/lib/demo/recordedReadings";

const phuong = { engine: "rules" as const, vendorId: "ven_phuong", sourceRef: "INV-2026-0152", readAmountMinor: 96000, readCurrency: "USD", newestForReference: true };

describe("selectRecordedReading", () => {
  it("replays the recorded Claude reading on a rule-based read of the same request", () => {
    const r = selectRecordedReading(phuong);
    expect(r?.sourceRef).toBe("INV-2026-0152");
    expect(r?.model).toBe("claude-sonnet-5-5");
    expect(r?.toolCalls.length).toBeGreaterThan(0);
  });

  it("never replaces a reading Claude made on this request", () => {
    expect(selectRecordedReading({ ...phuong, engine: "claude" })).toBeNull();
  });

  it("shows nothing without an agent reading, or for another vendor or reference", () => {
    expect(selectRecordedReading({ ...phuong, engine: null })).toBeNull();
    expect(selectRecordedReading({ ...phuong, vendorId: "ven_maria" })).toBeNull();
    expect(selectRecordedReading({ ...phuong, sourceRef: "INV-2026-0153" })).toBeNull();
    expect(selectRecordedReading({ ...phuong, sourceRef: null })).toBeNull();
  });

  it("matches on vendor and reference only, so a renamed demo job simply shows no recording", () => {
    expect(selectRecordedReading({ ...phuong, vendorId: "ven_maria", sourceRef: "JOB-HG4D-0931", readAmountMinor: 18000 })).toBeNull();
  });

  it("shows nothing when the reader saw a different amount, or on the older request a duplicate points at", () => {
    expect(selectRecordedReading({ ...phuong, readAmountMinor: 80000 })).toBeNull();
    expect(selectRecordedReading({ ...phuong, readCurrency: "VND" })).toBeNull();
    expect(selectRecordedReading({ ...phuong, newestForReference: false })).toBeNull();
  });

  it("uses the lookup it is given, so it stays a pure function", () => {
    const fake = { ...recordedReadingFor("ven_dao", "INV-DML-1010")!, vendorId: "v", sourceRef: "r" };
    expect(selectRecordedReading({ ...phuong, vendorId: "v", sourceRef: "r", readAmountMinor: fake.amountMinor }, () => fake)).toBe(fake);
  });

  it("labels the replay as recorded, with no model call and the decision from the rules", () => {
    expect(RECORDED_LABEL).toBe("Recorded from a live Claude run (claude-sonnet-5-5, PayPal sandbox) on 28 Oct 2026 and replayed here. No model call is made in this demo; the decision below comes from the rules.");
    expect(RECORDED_LABEL).not.toMatch(/—/);
  });
});

const amended = [
  { actor: "ai:rules", action: "ai.interpreted", detailJson: "{}", createdAt: "2026-10-28T22:51:00Z" },
  { actor: "user:daniel", action: "obligation.amended", detailJson: JSON.stringify({ patch: { amountMinor: 80000 }, previous: { amountMinor: 96000, currency: "USD" } }), createdAt: "2026-10-28T22:58:00Z" },
];

describe("after a correction", () => {
  it("reads the amount the reader saw from the first correction", () => {
    expect(amountAsRead(amended, { amountMinor: 80000, currency: "USD" })).toEqual({ amountMinor: 96000, currency: "USD" });
    expect(amountAsRead([], { amountMinor: 80000, currency: "USD" })).toEqual({ amountMinor: 80000, currency: "USD" });
  });

  it("keeps the recording on a corrected request, because it read the original amount", () => {
    const read = amountAsRead(amended, { amountMinor: 80000, currency: "USD" });
    expect(selectRecordedReading({ ...phuong, readAmountMinor: read.amountMinor })).not.toBeNull();
  });

  it("says what was read and who corrected it", () => {
    expect(correctionLine(amended, "USD")).toBe("Read as USD 960.00. Corrected to USD 800.00 by Daniel, 05:58.");
    expect(correctionLine([], "USD")).toBeNull();
  });

  it("drops the concern count from the rule-based summary", () => {
    expect(summaryWithoutCount("Phuong Transport is owed USD 960.00 for INV-2026-0152. 2 concerns noted.")).toBe("Phuong Transport is owed USD 960.00 for INV-2026-0152.");
    expect(summaryWithoutCount("Owed USD 5.00. 1 concern noted.")).toBe("Owed USD 5.00.");
  });
});

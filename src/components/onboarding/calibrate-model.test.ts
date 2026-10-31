import { describe, expect, it } from "vitest";
import { SUGGESTION_PERMISSION, type SuggestionKind } from "@/lib/onboarding/calibration";
import { applyEffect, chipCounts, decisionPermission, defaultChip, markProgress, matchesChip, screenLabel, summarise, verdictLabel, whoDecides, withMarks } from "./calibrate-model";

const call = (id: string, verdict: string, mark: string | null) => ({ call_id: id, verdict, mark });

describe("calls and chips", () => {
  const rows = [call("a", "block", null), call("b", "hold", "was_fine"), call("c", "hold", null), call("d", "block", "right_catch")];

  it("counts each chip", () => {
    expect(chipCounts(rows)).toEqual({ unmarked: 2, all: 4, block: 2, hold: 2 });
    expect(matchesChip(rows[0], "unmarked")).toBe(true);
    expect(matchesChip(rows[1], "block")).toBe(false);
  });

  it("starts on Unmarked until every call is marked", () => {
    expect(defaultChip(rows)).toBe("unmarked");
    expect(defaultChip([rows[1], rows[3]])).toBe("all");
  });

  it("lays this page's marks over the server rows, changing a mark too", () => {
    const out = withMarks(rows, { a: "right_catch", b: "right_catch" });
    expect(out.map((r) => r.mark)).toEqual(["right_catch", "right_catch", null, "right_catch"]);
    expect(out[2]).toBe(rows[2]);
    expect(rows[0].mark).toBeNull();
  });

  it("measures progress", () => {
    expect(markProgress(rows)).toEqual({ marked: 2, total: 4, share: 0.5 });
    expect(markProgress([])).toEqual({ marked: 0, total: 0, share: 0 });
  });

  it("names verdicts in plain words", () => {
    expect([verdictLabel("block"), verdictLabel("hold"), verdictLabel("pay")]).toEqual(["Blocked", "Held", "Clear"]);
  });
});

describe("summarise", () => {
  const imp = (currency: string, payments: number, extra: Partial<Record<string, unknown>> = {}) => ({ status: "checked", currency, payments, would_have_blocked_minor: 100, blocked_count: 1, held_count: 2, clear_count: payments - 3, period_from: "2026-08-01", period_to: "2026-08-31", ...extra });

  it("is null with nothing checked", () => {
    expect(summarise([])).toBeNull();
    expect(summarise([imp("VND", 10, { status: "failed" })])).toBeNull();
  });

  it("adds up the leading currency's re-checks and names the others", () => {
    const s = summarise([imp("VND", 10), imp("VND", 6, { period_from: "2026-07-01", period_to: "2026-09-30" }), imp("USD", 4), imp("VND", 9, { status: "failed" })])!;
    expect(s).toEqual({ currency: "VND", stoppedMinor: 200, blocked: 2, held: 4, clear: 10, payments: 16, imports: 2, periodFrom: "2026-07-01", periodTo: "2026-09-30", otherCurrencies: ["USD"] });
  });
});

describe("suggestions", () => {
  it("says what applying a rate card adds before anyone presses it", () => {
    const card = { kind: "rate_card", proposed_unit: "room_night", proposed_rate_minor: 170_000_000, proposed_currency: "VND", proposed_valid_from: "2026-08-03" };
    expect(applyEffect(card)).toBe("Adds the rate card: VND 1,700,000 a room-night, from 3 Aug 2026. Their invoices are then checked against it.");
    expect(applyEffect(card, 150_000_000)).toMatch(/VND 1,500,000 a room-night/);
    expect(applyEffect({ kind: "booking_feed", proposed_unit: null, proposed_rate_minor: null, proposed_currency: null, proposed_valid_from: null })).toMatch(/nothing else changes/);
  });

  it("never names a supplier by its id", () => {
    for (const kind of ["rate_card", "verify_supplier", "retainer"]) expect(applyEffect({ kind, proposed_unit: "trip", proposed_rate_minor: 100, proposed_currency: "USD", proposed_valid_from: null })).not.toMatch(/ven_/);
  });

  it("labels the screen where the change is made", () => {
    expect([screenLabel("/settings"), screenLabel("/vendors/ven_dao"), screenLabel("/vendors"), screenLabel("/x")]).toEqual(["Open Settings", "Open the supplier", "Open vendors", "Open"]);
  });

  it("asks the same permission as the backend for every kind", () => {
    for (const [kind, perm] of Object.entries(SUGGESTION_PERMISSION) as Array<[SuggestionKind, string]>) expect(decisionPermission(kind)).toBe(perm);
    expect(whoDecides("booking_feed")).toBe("The owner decides this one.");
  });

  it("never uses an em dash", () => {
    const text = ["rate_card", "booking_feed", "verify_supplier", "retainer", "other"].map((kind) => applyEffect({ kind, proposed_unit: "trip", proposed_rate_minor: 100, proposed_currency: "USD", proposed_valid_from: null })).join(" ");
    expect(text).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
  });
});

import { describe, expect, it } from "vitest";
import { timelineRow } from "./timeline-model";

const row = (actor: string, action: string, fromState: string | null = null, toState: string | null = null, detailJson: string | null = null) => timelineRow({ actor, action, fromState, toState, detailJson });

describe("timelineRow", () => {
  it("names the intake a request came from", () => {
    expect(row("system:booking-webhook", "obligation.created", null, "drafted")).toEqual({ who: "", what: "Created from the booking system", change: null });
    expect(row("system:email-ingest", "obligation.created", null, "drafted").what).toBe("Created from an email");
    expect(row("system:booking-webhook", "evidence.attached").what).toBe("Evidence attached from the booking system");
  });

  it("says which reader read the request", () => {
    expect(row("ai:rules", "ai.interpreted")).toMatchObject({ who: "", what: "The rule-based reader read the request" });
    expect(row("ai:claude-sonnet-5-5", "ai.interpreted").what).toBe("Claude read the request");
  });

  it("drops the state change a policy row already names", () => {
    expect(row("policy", "policy.block", "drafted", "blocked")).toEqual({ who: "Policy", what: "blocked it", change: null });
    expect(row("policy", "policy.verified", "drafted", "verified").change).toBeNull();
  });

  it("keeps a state change the title does not say", () => {
    expect(row("user:daniel", "review.resolved", "blocked", "verified")).toEqual({ who: "Daniel", what: "resolved the review", change: "Blocked to Verified" });
  });

  it("says what PayPal's own records showed", () => {
    expect(row("paypal:history", "paypal.history_checked", null, null, JSON.stringify({ ok: true, matches: [] })).what).toBe("Checked PayPal's own records: no payment for this job");
    expect(row("paypal:history", "paypal.history_checked", null, null, JSON.stringify({ ok: true, matches: ["A1"] })).what).toBe("PayPal's records show this job already paid");
    expect(row("paypal:history", "paypal.history_checked", null, null, JSON.stringify({ ok: false })).what).toBe("PayPal's records could not be read");
  });

  it("never shows engine names", () => {
    const all = [row("system:booking-webhook", "obligation.created"), row("ai:rules", "ai.interpreted"), row("paypal:history", "paypal.history_checked", null, null, "{}"), row("rail:paypal", "settlement.checked:seed")];
    for (const r of all) expect(`${r.who} ${r.what}`).not.toMatch(/webhook|Agent \(rules\)|paypal:history|seed|obligation/i);
  });
});

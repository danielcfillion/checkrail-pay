import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openTestDb } from "../db";
import { auditEntries, businesses, onboardingMarks, onboardingSuggestions, rateCards, vendors } from "../db/schema";
import { applySuggestion, candidateSuggestions, dismissSuggestion, generateSuggestions, listSuggestions, markCall } from "./calibration";
import { loadCalls } from "./calls";
import { BIZ, addImport, addRateCard, addVendor, setUpBusiness } from "./testkit";

const EV = ["evidence_present"];

function fixture() {
  const db = openTestDb();
  const people = setUpBusiness(db);
  addVendor(db, "ven_dao", "Dao Mountain Lodge");
  addVendor(db, "ven_phuong", "Phuong Transport");
  addRateCard(db, "ven_phuong");
  addVendor(db, "ven_tam", "Tam Motorbike Rental", { verified: false });
  const importId = addImport(db, [
    { date: "2026-10-05", payee: "Dao Mountain Lodge", amount: 1_360_000_000, cat: "needs_a_look", rules: ["amount_sane"] },
    { date: "2026-10-06", payee: "Dao Mountain Lodge", amount: 1_200_000_000 },
    { date: "2026-10-06", payee: "Phuong Transport", cat: "needs_a_look", rules: EV },
    { date: "2026-10-07", payee: "Phuong Transport", cat: "needs_a_look", rules: EV },
    { date: "2026-10-08", payee: "Tam Motorbike Rental", cat: "needs_a_look", rules: [...EV, "amount_sane"] },
    { date: "2026-10-09", payee: "HOA MAI GUESTHOUSE", cat: "needs_a_look", rules: EV },
    { date: "2026-10-09", payee: "Phuong Transport" },
  ]);
  const call = (row: number) => loadCalls(db, BIZ).find((c) => c.row === row)!;
  return { db, people, importId, call };
}

describe("marking calls", () => {
  it("records who marked what and when, and replaces an earlier mark", () => {
    const { db, people, call } = fixture();
    markCall(db, BIZ, people.owner, call(2).id, "right_catch", "  The lodge billed us twice ");
    let m = db.select().from(onboardingMarks).all();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ mark: "right_catch", note: "The lodge billed us twice", markedBy: "user:daniel" });
    markCall(db, BIZ, people.approver, call(2).id, "was_fine");
    m = db.select().from(onboardingMarks).all();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ mark: "was_fine", note: null, markedBy: "user:minh" });
  });

  it("refuses a clear call, an unknown one, another business's, a bad mark and a long note", () => {
    const { db, people, call } = fixture();
    expect(() => markCall(db, BIZ, people.owner, call(3).id, "was_fine")).toThrow(/Only a payment the re-check stopped or held/);
    expect(() => markCall(db, BIZ, people.owner, "obr_nope", "was_fine")).toThrow(/No such call/);
    expect(() => markCall(db, "biz_other", people.owner, call(2).id, "was_fine")).toThrow(/No such call/);
    expect(() => markCall(db, BIZ, people.owner, call(2).id, "maybe")).toThrow(/right_catch/);
    expect(() => markCall(db, BIZ, people.owner, call(2).id, "was_fine", "x".repeat(501))).toThrow(/500 characters/);
  });

  it("is for people who approve payments: not the clerk, not the accountant", () => {
    const { db, people, call } = fixture();
    expect(() => markCall(db, BIZ, people.clerk, call(2).id, "was_fine")).toThrow(/cannot mark/);
    expect(() => markCall(db, BIZ, people.accountant, call(2).id, "was_fine")).toThrow(/cannot mark/);
  });

  it("never changes a rule, a rate card, a supplier or the policy on its own", () => {
    const { db, people, call } = fixture();
    const before = { rates: db.select().from(rateCards).all(), vendors: db.select().from(vendors).all(), policy: db.select().from(businesses).all()[0].policyJson };
    for (const row of [2, 4, 5, 6, 7]) markCall(db, BIZ, people.owner, call(row).id, "was_fine");
    expect({ rates: db.select().from(rateCards).all(), vendors: db.select().from(vendors).all(), policy: db.select().from(businesses).all()[0].policyJson }).toEqual(before);
    expect(listSuggestions(db, BIZ).every((s) => s.status === "proposed")).toBe(true);
  });
});

describe("suggestions from marks", () => {
  it("proposes a rate card for a supplier without one whose amount holds were fine, with values to check", () => {
    const { db, people, call } = fixture();
    const r = markCall(db, BIZ, people.owner, call(2).id, "was_fine");
    expect(r.proposed.map((s) => s.title)).toEqual(["Add a rate card for Dao Mountain Lodge"]);
    expect(r.proposed[0]).toMatchObject({ kind: "rate_card", target: "ven_dao", status: "proposed", basisCount: 1, proposed: { unit: "trip", rateMinor: 1_200_000_000, currency: "VND", validFrom: "2026-10-05" }, screen: "/vendors/ven_dao" });
  });

  it("does not propose a rate card for a supplier that has one", () => {
    const { db, people, call } = fixture();
    markCall(db, BIZ, people.owner, call(4).id, "was_fine");
    expect(listSuggestions(db, BIZ).filter((s) => s.kind === "rate_card")).toEqual([]);
  });

  it("proposes a booking feed after three fine holds for missing evidence, not before", () => {
    const { db, people, call } = fixture();
    markCall(db, BIZ, people.owner, call(4).id, "was_fine");
    markCall(db, BIZ, people.owner, call(5).id, "was_fine");
    expect(listSuggestions(db, BIZ).some((s) => s.kind === "booking_feed")).toBe(false);
    markCall(db, BIZ, people.owner, call(6).id, "was_fine");
    const feed = listSuggestions(db, BIZ).find((s) => s.kind === "booking_feed")!;
    expect(feed).toMatchObject({ target: "business", basisCount: 3, screen: "/settings" });
    expect(feed.detail).toMatch(/^3 payments you marked fine were held/);
  });

  it("proposes verifying a supplier who is unverified or not on the list once a call about them is marked", () => {
    const { db, people, call } = fixture();
    markCall(db, BIZ, people.owner, call(6).id, "right_catch");
    markCall(db, BIZ, people.owner, call(7).id, "was_fine");
    const titles = listSuggestions(db, BIZ).filter((s) => s.kind === "verify_supplier").map((s) => [s.title, s.target]);
    expect(titles.sort()).toEqual([["Verify supplier HOA MAI GUESTHOUSE", "payee:hoa mai guesthouse"], ["Verify supplier Tam Motorbike Rental", "ven_tam"]]);
  });

  it("withdraws a proposed suggestion when the mark it rested on changes", () => {
    const { db, people, call } = fixture();
    markCall(db, BIZ, people.owner, call(2).id, "was_fine");
    expect(listSuggestions(db, BIZ)).toHaveLength(1);
    markCall(db, BIZ, people.owner, call(2).id, "right_catch");
    expect(listSuggestions(db, BIZ)).toEqual([]);
  });

  it("proposes a retainer for a fine repeat a month after the first payment", () => {
    const db = openTestDb();
    const people = setUpBusiness(db);
    addVendor(db, "ven_jake", "Jake Video");
    addRateCard(db, "ven_jake");
    addImport(db, [
      { date: "2026-09-01", payee: "Jake Video", amount: 1_000_000_000, ref: null },
      { date: "2026-09-29", payee: "Jake Video", amount: 1_000_000_000, ref: null, cat: "duplicate", rules: ["no_duplicate"], dupOf: 2 },
    ]);
    const dup = loadCalls(db, BIZ).find((c) => c.category === "duplicate")!;
    markCall(db, BIZ, people.owner, dup.id, "was_fine");
    expect(listSuggestions(db, BIZ).map((s) => [s.kind, s.title])).toEqual([["retainer", "Record Jake Video's monthly retainer"]]);
  });

  it("is deterministic: the same marks give the same suggestions, and generating again changes nothing", () => {
    const { db, people, call } = fixture();
    for (const row of [2, 4, 5, 6]) markCall(db, BIZ, people.owner, call(row).id, "was_fine");
    const a = candidateSuggestions(db, BIZ);
    const stored = listSuggestions(db, BIZ);
    generateSuggestions(db, BIZ);
    expect(candidateSuggestions(db, BIZ)).toEqual(a);
    expect(listSuggestions(db, BIZ)).toEqual(stored);
  });
});

describe("applying and dismissing", () => {
  it("applying a rate card adds it through the rate card screen's own function, then logs who applied it", () => {
    const { db, people, call } = fixture();
    markCall(db, BIZ, people.owner, call(2).id, "was_fine");
    const s = listSuggestions(db, BIZ)[0];
    const out = applySuggestion(db, BIZ, people.approver, s.id, { rate: { rateMinor: 1_300_000_000 }, note: "Checked with the lodge" });
    expect(out.changed).toBe(true);
    expect(out.suggestion).toMatchObject({ status: "applied", decidedBy: "user:minh", decisionNote: "Checked with the lodge" });
    const rate = db.select().from(rateCards).where(eq(rateCards.vendorId, "ven_dao")).get()!;
    expect(rate).toMatchObject({ unit: "trip", rateMinor: 1_300_000_000, currency: "VND", validFrom: "2026-10-05", createdBy: "user:minh" });
    const actions = db.select().from(auditEntries).all().map((a) => a.action);
    expect(actions).toContain("rate.set");
    const applied = db.select().from(auditEntries).all().find((a) => a.action === "onboarding.suggestion_applied")!;
    expect(applied.actor).toBe("user:minh");
    expect(JSON.parse(applied.detailJson!)).toMatchObject({ suggestionId: s.id, kind: "rate_card", changed: true, rateCardId: rate.id });
  });

  it("applying anything else records the decision and changes nothing in the books", () => {
    const { db, people, call } = fixture();
    markCall(db, BIZ, people.owner, call(6).id, "was_fine");
    const verify = listSuggestions(db, BIZ).find((s) => s.kind === "verify_supplier")!;
    const before = db.select().from(vendors).all();
    const out = applySuggestion(db, BIZ, people.approver, verify.id);
    expect(out.changed).toBe(false);
    expect(out.message).toMatch(/Nothing was changed here/);
    expect(db.select().from(vendors).all()).toEqual(before);
    expect(db.select().from(vendors).where(eq(vendors.id, "ven_tam")).get()!.verifiedAt).toBeNull();
  });

  it("checks the permission for each kind: a clerk applies nothing, a booking feed is the owner's", () => {
    const { db, people, call } = fixture();
    for (const row of [4, 5, 6, 2]) markCall(db, BIZ, people.owner, call(row).id, "was_fine");
    const all = listSuggestions(db, BIZ);
    const feed = all.find((s) => s.kind === "booking_feed")!;
    const rate = all.find((s) => s.kind === "rate_card")!;
    expect(() => applySuggestion(db, BIZ, people.clerk, rate.id)).toThrow(/cannot apply this suggestion/);
    expect(() => applySuggestion(db, BIZ, people.accountant, rate.id)).toThrow(/cannot apply/);
    expect(() => applySuggestion(db, BIZ, people.approver, feed.id)).toThrow(/cannot apply/);
    expect(() => dismissSuggestion(db, BIZ, people.clerk, feed.id)).toThrow(/cannot dismiss/);
    expect(applySuggestion(db, BIZ, people.owner, feed.id).suggestion.status).toBe("applied");
    expect(db.select().from(rateCards).where(eq(rateCards.vendorId, "ven_dao")).all()).toEqual([]);
  });

  it("dismissing keeps it dismissed, logs it, and the marks do not bring it back", () => {
    const { db, people, call } = fixture();
    markCall(db, BIZ, people.owner, call(2).id, "was_fine");
    const s = listSuggestions(db, BIZ)[0];
    expect(dismissSuggestion(db, BIZ, people.owner, s.id, "We pay per stay, no fixed rate")).toMatchObject({ status: "dismissed", decisionNote: "We pay per stay, no fixed rate" });
    markCall(db, BIZ, people.owner, call(2).id, "was_fine", "again");
    expect(listSuggestions(db, BIZ).map((x) => x.status)).toEqual(["dismissed"]);
    expect(db.select().from(auditEntries).all().map((a) => a.action)).toContain("onboarding.suggestion_dismissed");
  });

  it("refuses to apply or dismiss twice, or another business's suggestion", () => {
    const { db, people, call } = fixture();
    markCall(db, BIZ, people.owner, call(2).id, "was_fine");
    const s = listSuggestions(db, BIZ)[0];
    expect(() => applySuggestion(db, "biz_other", people.owner, s.id)).toThrow(/No such suggestion/);
    applySuggestion(db, BIZ, people.owner, s.id);
    expect(() => applySuggestion(db, BIZ, people.owner, s.id)).toThrow(/already applied/);
    expect(() => dismissSuggestion(db, BIZ, people.owner, s.id)).toThrow(/already applied/);
    expect(db.select().from(onboardingSuggestions).all()).toHaveLength(1);
  });

  it("a rate card with values the rate screen refuses is not applied", () => {
    const { db, people, call } = fixture();
    markCall(db, BIZ, people.owner, call(2).id, "was_fine");
    const s = listSuggestions(db, BIZ)[0];
    expect(() => applySuggestion(db, BIZ, people.owner, s.id, { rate: { unit: "bananas" } })).toThrow(/Unit must be one of/);
    expect(listSuggestions(db, BIZ)[0].status).toBe("proposed");
  });
});

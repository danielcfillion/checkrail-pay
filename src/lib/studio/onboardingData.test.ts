import { describe, expect, it } from "vitest";
import { openTestDb } from "../db";
import { DEMO_BUSINESS_ID, seedDemo } from "../demo/seed";
import { onboardingDashboard, type DashboardData } from "../onboarding/dashboard";
import { FIELDS, buildOnboardingStudioData, callMoney, currenciesIn, displayCurrency, moneyFormatString, studioRows, toMajor } from "./onboardingData";

describe("the Studio data sources for Your first weeks", async () => {
  const db = openTestDb();
  await seedDemo(db);
  const data = onboardingDashboard(db, DEMO_BUSINESS_ID);
  const studio = buildOnboardingStudioData(data, { today: "2026-10-31" });
  const sources = studio.sources as Array<{ id: string; name?: string; description?: string; data: Array<Record<string, unknown>>; fields: Array<{ id: string; name?: string; format: string; hide?: boolean; formatOptions?: { format?: string } }> }>;

  it("has one table per backend data source, each named and described for the agent", () => {
    expect(sources.map((s) => s.id).sort()).toEqual(Object.keys(data).sort());
    for (const s of sources) {
      expect(s.name, s.id).toBeTruthy();
      expect((s.description ?? "").length, s.id).toBeGreaterThan(60);
    }
    expect(studio.description).toMatch(/Nothing here can change a rule or pay anyone/);
  });

  it("declares exactly the fields its rows carry, with no money left in minor units", () => {
    for (const s of sources) {
      const declared = s.fields.map((f) => f.id).sort();
      expect(new Set(declared).size, s.id).toBe(declared.length);
      expect(s.data.length, s.id).toBeGreaterThan(0);
      for (const row of s.data) expect(Object.keys(row).sort(), s.id).toEqual(declared);
      expect(declared.some((id) => id.endsWith("_minor")), s.id).toBe(false);
    }
  });

  it("names every visible field in plain words", () => {
    for (const s of sources) for (const f of s.fields) if (!f.hide) expect(f.name, `${s.id}.${f.id}`).toMatch(/^[A-Z]/);
  });

  it("converts money to major units and formats it in the business's currency (VND without decimals)", () => {
    expect(displayCurrency(data)).toBe("VND");
    const ms = sources.find((s) => s.id === "money_stopped")!;
    const dup = data.money_stopped.find((r) => r.category === "duplicate")!;
    expect(ms.data.find((r) => r.category === "duplicate")!.stopped).toBe(dup.stopped_minor / 100);
    expect(ms.fields.find((f) => f.id === "stopped")!.formatOptions?.format).toBe('"VND "#,##0');
    expect(moneyFormatString("usd")).toBe('"USD "#,##0.00');
    expect(toMajor(null)).toBeNull();
  });

  it("splits each call's money the same way as the totals by reason, so sums by supplier agree with them", () => {
    const rows = studioRows(data).calls;
    const stopped = rows.reduce((a, r) => a + (r.stopped ?? 0), 0);
    const held = rows.reduce((a, r) => a + (r.held ?? 0), 0);
    expect(stopped).toBe(data.money_stopped.reduce((a, r) => a + r.stopped_minor, 0) / 100);
    expect(held).toBe(data.money_stopped.reduce((a, r) => a + r.held_minor, 0) / 100);
    expect(callMoney("overcharge", 720_000_000, 180_000_000)).toEqual({ stopped: 1_800_000, held: 0 });
    expect(callMoney("needs_a_look", 400_000_000, 0)).toEqual({ stopped: 0, held: 4_000_000 });
  });

  it("marks each call reviewed, fine or right as 1 or 0 so the agent can sum them by supplier", () => {
    for (const r of studioRows(data).calls) {
      expect(r.reviewed).toBe(r.mark ? 1 : 0);
      expect(r.was_fine + r.right_catch).toBe(r.reviewed);
      expect(r.mark_label).toMatch(/^(Right catch|Was fine|Not reviewed)$/);
    }
  });

  it("relates calls to their import, puts payment dates on a calendar, and defines the three ratios from real fields", () => {
    const ids = new Set(sources.flatMap((s) => s.fields.map((f) => `${s.id}.${f.id}`)));
    for (const e of studio.expressions ?? []) {
      const inputs = (e.expression as { inputs: Array<{ id: string }> }).inputs;
      for (const i of inputs) expect(ids.has(i.id), `${e.id} reads ${i.id}`).toBe(true);
    }
    expect(studio.relationships?.map((r) => r.id)).toEqual(["call-import", "calls-date-calendar"]);
    const cal = studio.calendars?.[0];
    expect(cal?.range.from).toEqual({ type: "date", value: [...data.calls].map((c) => c.date).sort()[0] });
  });

  it("warns the agent to filter by currency only when there is more than one", () => {
    expect(studio.description).not.toMatch(/filter by currency/);
    const mixed: DashboardData = { ...data, calls: [...data.calls, { ...data.calls[0], call_id: "x", currency: "USD" }] };
    expect(currenciesIn(mixed)).toEqual(["USD", "VND"]);
    expect(buildOnboardingStudioData(mixed).description).toMatch(/filter by currency before summing/);
  });

  it("keeps the field lists in step with the backend's documented sources", () => {
    expect(Object.keys(FIELDS).sort()).toEqual(Object.keys(data).sort());
  });

  it("never uses an em dash in anything the owner or the agent reads", () => {
    expect(JSON.stringify(studio)).not.toMatch(/\u2014/);
  });
});

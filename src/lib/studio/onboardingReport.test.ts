import { describe, expect, it } from "vitest";
import type { DashboardData } from "../onboarding/dashboard";
import { FIELDS, buildOnboardingStudioData } from "./onboardingData";
import { CUSTOM_WIDGET_TYPES, FALSE_HOLDS, PAGE_ID, READINESS_GAUGE, defaultReport, layoutFor, reportFieldIds } from "./onboardingReport";

const empty: DashboardData = { readiness_summary: [], readiness: [], money_stopped: [], weekly_false_holds: [], rule_hits: [], calls: [], imports: [], suggestions: [] };
const expressionIds = new Set((buildOnboardingStudioData(empty, { today: "2026-10-31" }).expressions ?? []).map((e) => e.id));
const fieldIds = new Set(Object.entries(FIELDS).flatMap(([t, fs]) => fs.map((f) => `${t}.${f.id}`)));

type Box = { xTrack: number; yTrack: number; xSpan: number; ySpan: number };
const overlaps = (a: Box, b: Box) => a.xTrack < b.xTrack + b.xSpan && b.xTrack < a.xTrack + a.xSpan && a.yTrack < b.yTrack + b.ySpan && b.yTrack < a.yTrack + a.ySpan;

describe("the default layout of Your first weeks", () => {
  for (const assistant of [false, true]) {
    describe(assistant ? "beside the assistant" : "full width", () => {
      const state = defaultReport({ assistant });
      const page = state.pages[0];
      const layout = page.widgetLayout as Record<string, Box>;

      it("is one page, selected", () => {
        expect(state.pages).toHaveLength(1);
        expect(state.selectedPageId).toBe(PAGE_ID);
        expect(page.id).toBe(PAGE_ID);
      });

      it("reads only fields and measures the data sources define", () => {
        const ids = reportFieldIds(state);
        expect(ids.length).toBeGreaterThan(10);
        for (const id of ids) expect(fieldIds.has(id) || expressionIds.has(id), id).toBe(true);
      });

      it("places every widget once, inside the 24 columns, with no two overlapping", () => {
        expect(Object.keys(layout).sort()).toEqual(Object.keys(page.widgets ?? {}).sort());
        const boxes = Object.entries(layout);
        for (const [id, b] of boxes) {
          expect(b.xTrack >= 0 && b.xTrack + b.xSpan <= 24, id).toBe(true);
          expect(b.ySpan, id).toBeGreaterThanOrEqual(8);
        }
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i][1], boxes[j][1]), `${boxes[i][0]} and ${boxes[j][0]}`).toBe(false);
      });

      it("leads with the readiness gauge and the false-hold chart side by side on the top row", () => {
        const widgets = page.widgets as Record<string, { type: string }>;
        expect(widgets.readiness.type).toBe(READINESS_GAUGE);
        expect(widgets["false-holds"].type).toBe(FALSE_HOLDS);
        const top = Object.entries(layout).filter(([, b]) => b.yTrack === 0).map(([id]) => id).sort();
        expect(top).toEqual(["false-holds", "readiness"]);
        expect(layout["stopped-by-reason"].yTrack).toBeGreaterThan(layout["money-stopped"].yTrack);
        expect(layout.calls.yTrack).toBeGreaterThan(layout["rule-agreement"].yTrack);
      });
    });
  }

  it("titles every built-in widget in plain English, with no em dash", () => {
    const widgets = defaultReport().pages[0].widgets as Record<string, { type: string; format?: { title?: { text?: string } } }>;
    for (const [id, w] of Object.entries(widgets)) {
      if ((CUSTOM_WIDGET_TYPES as readonly string[]).includes(w.type)) continue;
      expect(w.format?.title?.text, id).toMatch(/^[A-Z][a-z]/);
    }
    expect(JSON.stringify(defaultReport())).not.toMatch(/\u2014/);
  });

  it("shows stopped money only in the bar, never holds", () => {
    const f = defaultReport().pages[0].filter?.widget?.["stopped-by-reason"]?.[0];
    expect(f?.model).toEqual({ operator: "isIn", value: ["duplicate", "overcharge", "blocked_other"] });
  });

  it("hands out a fresh copy each time", () => {
    const a = defaultReport();
    (a.pages[0].widgetLayout as Record<string, Box>).readiness.xTrack = 5;
    expect((defaultReport().pages[0].widgetLayout as Record<string, Box>).readiness.xTrack).toBe(0);
    expect(layoutFor(true).readiness.ySpan).toBeGreaterThan(layoutFor(false).readiness.ySpan);
  });
});

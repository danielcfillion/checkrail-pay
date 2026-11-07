import { describe, expect, it } from "vitest";
import { LAYOUT_KEY, LAYOUT_VERSION, clearLayout, differs, loadLayout, parseSaved, saveLayout } from "./layoutStore";
import { cssTokenLookup, resolveChartTokens, restoreChartTokens } from "./chartTokens";
import { CUSTOM_WIDGET_TYPES, defaultReport } from "./onboardingReport";

const KNOWN = new Set(["value", "grid", "bar-chart-grouped", ...CUSTOM_WIDGET_TYPES]);

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}
const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };

describe("the owner's layout, kept in this browser", () => {
  it("round-trips a layout and drops what is not layout (panels, selection)", () => {
    const store = memory();
    const state = { ...defaultReport(), panels: { filters: { collapsed: true } } };
    expect(saveLayout(state, store)).toBe(true);
    const back = loadLayout(KNOWN, store)!;
    expect(back.pages).toEqual(defaultReport().pages);
    expect("panels" in back).toBe(false);
    clearLayout(store);
    expect(store.m.has(LAYOUT_KEY)).toBe(false);
  });

  it("ignores a saved layout that is corrupt, from another version, or names an unknown widget", () => {
    const ok = JSON.stringify({ v: LAYOUT_VERSION, state: defaultReport() });
    expect(parseSaved(ok, KNOWN)).not.toBeNull();
    expect(parseSaved("{not json", KNOWN)).toBeNull();
    expect(parseSaved(null, KNOWN)).toBeNull();
    expect(parseSaved(JSON.stringify({ v: LAYOUT_VERSION + 1, state: defaultReport() }), KNOWN)).toBeNull();
    expect(parseSaved(JSON.stringify({ v: LAYOUT_VERSION, state: { ...defaultReport(), selectedPageId: "gone" } }), KNOWN)).toBeNull();
    const odd = defaultReport();
    (odd.pages[0].widgets as Record<string, { type: string }>).readiness.type = "no-such-widget";
    expect(parseSaved(JSON.stringify({ v: LAYOUT_VERSION, state: odd }), KNOWN)).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    expect(loadLayout(KNOWN, broken)).toBeNull();
    expect(saveLayout(defaultReport(), broken)).toBe(false);
    expect(() => clearLayout(broken)).not.toThrow();
    expect(loadLayout(KNOWN, null)).toBeNull();
  });

  it("tells a moved card from the default, and not a change of selection", () => {
    const moved = defaultReport();
    (moved.pages[0].widgetLayout as Record<string, { xTrack: number }>)["money-held"].xTrack = 9;
    expect(differs(moved, defaultReport())).toBe(true);
    expect(differs({ ...defaultReport(), panels: { filters: { collapsed: false } } }, defaultReport())).toBe(false);
  });
});

describe("chart colours in saved state", () => {
  const colours: Record<string, string> = { "action-ink": " #ffffff", blocked: "#b42318" };
  const lookup = (t: string) => colours[t] ?? null;

  it("are resolved for the canvas on the way in and back to tokens on the way out", () => {
    const state = defaultReport();
    const resolved = resolveChartTokens(state, lookup);
    const label = (s: typeof state) => (s.pages[0].widgets as Record<string, { format: { style: { theme: { bar: { series: { label: { color: string } } } } } } }>)["stopped-by-reason"].format.style.theme.bar.series.label.color;
    expect(label(state)).toBe("var(--action-ink)");
    expect(label(resolved)).toBe("#ffffff");
    expect(restoreChartTokens(resolved, lookup)).toEqual(state);
  });

  it("leave value tiles (drawn as HTML, where var() works) and unknown tokens alone", () => {
    const resolved = resolveChartTokens(defaultReport(), lookup);
    const tile = (resolved.pages[0].widgets as Record<string, { format: { style: { color?: string } } }>)["money-stopped"];
    expect(tile.format.style.color).toBe("var(--blocked)");
    expect(resolveChartTokens(defaultReport(), () => null)).toEqual(defaultReport());
    expect(cssTokenLookup()("action")).toBeNull();
  });
});

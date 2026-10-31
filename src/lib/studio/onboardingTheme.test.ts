import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CHART_PALETTE, THEME_KEYWORDS, onboardingThemeParams } from "./onboardingThemeParams";

const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");
const VAR = /^var\(--([a-z0-9-]+)\)$/;

/** Every string anywhere in a parameter value (borders and shadows are objects). */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

describe("the Studio theme for Your first weeks", () => {
  const entries = Object.entries(onboardingThemeParams);

  it("points every colour, font and shadow at one of the app's tokens", () => {
    for (const [key, value] of entries) {
      for (const s of strings(value)) {
        if (THEME_KEYWORDS.has(s)) continue;
        expect(s, key).toMatch(VAR);
      }
    }
  });

  it("only uses tokens the app defines in light and dark (or Geist's font variable)", () => {
    const used = new Set(entries.flatMap(([, v]) => strings(v)).map((s) => VAR.exec(s)?.[1]).filter((t): t is string => !!t));
    const darkBlock = css.slice(css.indexOf(":root[data-theme=\"dark\"]"));
    for (const t of used) {
      if (t === "font-geist-sans") continue;
      expect(css, t).toContain(`--${t}:`);
      expect(darkBlock, `${t} in dark`).toContain(`--${t}:`);
    }
  });

  it("uses the card radius, no hard card border, and Geist", () => {
    expect(onboardingThemeParams.studioWidgetBorderRadius).toBe(16);
    expect(onboardingThemeParams.studioWidgetBorder.color).toBe("var(--card-edge)");
    expect(onboardingThemeParams.fontFamily).toBe("var(--font-geist-sans)");
    expect(onboardingThemeParams.studioCanvasBorder).toBe(false);
  });

  it("leads the chart palette with cobalt, then navy ink, then neutrals, with no status colour", () => {
    expect(CHART_PALETTE[0]).toBe("var(--action)");
    expect(CHART_PALETTE[1]).toBe("var(--ink)");
    for (const c of CHART_PALETTE) expect(c).not.toMatch(/settled|attention|blocked|alarm/);
    expect((onboardingThemeParams as Record<string, unknown>).chartPaletteFills1Color).toBe("var(--action)");
  });
});

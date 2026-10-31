/**
 * AG Charts draws on a canvas and rejects a CSS variable as a colour, so a chart widget's own colours (a data label,
 * say) cannot be written as var(--token) the way Studio's theme parameters can. Report state keeps the token; these
 * swap it for the colour the page resolves it to on the way into Studio, and back again on the way out, so a saved
 * layout never pins one theme's colour. Only chart widgets' formats are touched. Pure.
 */
import type { AgReportState } from "ag-studio";

const VAR = /^var\(--([a-z0-9-]+)\)$/i;

/** Tokens a chart widget's format may use. */
export const CHART_TOKENS = ["action-ink", "ink", "ink-soft", "sheet", "blocked", "attention", "settled"] as const;

type Lookup = (token: string) => string | null | undefined;

const isChart = (type: unknown) => typeof type === "string" && /chart/.test(type);

function mapFormats(state: AgReportState, fn: (s: string) => string): AgReportState {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fn(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return {
    ...state,
    pages: state.pages.map((p) => ({
      ...p,
      widgets: p.widgets
        ? Object.fromEntries(
            Object.entries(p.widgets).map(([id, w]) => {
              const widget = w as { type?: unknown; format?: unknown } | undefined;
              return [id, widget && isChart(widget.type) && widget.format ? { ...widget, format: walk(widget.format) } : w];
            }),
          )
        : p.widgets,
    })) as AgReportState["pages"],
  };
}

/** var(--token) in chart formats becomes the colour `lookup` gives for it (left as is when it has none). */
export function resolveChartTokens(state: AgReportState, lookup: Lookup): AgReportState {
  return mapFormats(state, (s) => {
    const m = VAR.exec(s);
    const value = m ? lookup(m[1])?.trim() : null;
    return value ? value : s;
  });
}

/** The reverse: a chart colour equal to a known token's resolved colour becomes var(--token) again. */
export function restoreChartTokens(state: AgReportState, lookup: Lookup, tokens: readonly string[] = CHART_TOKENS): AgReportState {
  const back = new Map<string, string>();
  for (const t of tokens) {
    const value = lookup(t)?.trim().toLowerCase();
    if (value && !back.has(value)) back.set(value, `var(--${t})`);
  }
  return mapFormats(state, (s) => back.get(s.trim().toLowerCase()) ?? s);
}

/** Reads a token from the page's root element, in the browser. */
export function cssTokenLookup(): Lookup {
  return (token) => {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(`--${token}`) || null;
    } catch {
      return null;
    }
  };
}

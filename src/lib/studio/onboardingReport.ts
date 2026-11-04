/**
 * The default layout of "Your first weeks", as AG Studio report state: one page that leads with the answer (the
 * readiness gauge and how often a hold turned out fine), then what Checkrail stopped and how often the owner agreed
 * with each rule, then every flagged payment. Field ids ("money_stopped.stopped") are the data sources in
 * ./onboardingData.ts; the two custom widget types are registered in src/components/onboarding/studio/widgets.tsx.
 *
 * The owner's own layout (edit mode) is kept per browser by ./layoutStore.ts; this is what "Reset layout" restores.
 * Pure: no Studio runtime import.
 */
import type { AgPageState, AgReportState, AgWidgetLayoutState } from "ag-studio";

/** Custom widget types: the ids Studio, the report and the agent use. */
export const READINESS_GAUGE = "checkrail-readiness-gauge";
export const FALSE_HOLDS = "checkrail-false-holds";
export const CUSTOM_WIDGET_TYPES = [READINESS_GAUGE, FALSE_HOLDS] as const;

export const PAGE_ID = "first-weeks";

/** Position on Studio's canvas grid, in tracks: 24 columns wide, rows of studioCanvasRowHeight (16px). */
export const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState => ({ xTrack, yTrack, xSpan, ySpan });

const title = (text: string, caption?: string) => ({
  title: { enabled: true, text },
  ...(caption && { caption: { enabled: true, text: caption } }),
});
const sum = (id: string) => ({ id, aggregation: "sum" as const });

const tile = (text: string, value: string, caption: string, color?: string) => ({
  type: "value" as const,
  dataMapping: { value: [sum(value)] },
  format: {
    ...title(text, caption),
    // Text scaling keeps a long amount (VND runs to eight figures) whole in a narrow tile instead of an ellipsis.
    style: { verticalAlign: "center" as const, textAlign: "left" as const, textScaling: { enabled: true }, ...(color && { color }) },
  },
});

/** A widget whose type is one of ours. Studio's typings only know the built-in types, hence the cast at the end. */
const custom = (type: string) => ({ type, dataMapping: {} });

const page = {
  id: PAGE_ID,
  widgets: {
    readiness: custom(READINESS_GAUGE),
    "false-holds": custom(FALSE_HOLDS),
    "money-stopped": tile("Money stopped", "money_stopped.stopped", "Would not have left your account", "var(--blocked)"),
    "money-held": tile("Waited for a person", "money_stopped.held", "Held until someone looked"),
    "still-to-review": tile("Still to review", "money_stopped.unreviewed_calls", "Flagged payments you have not marked"),
    "stopped-by-reason": {
      type: "bar-chart-grouped",
      dataMapping: {
        categoryKey: [{ id: "money_stopped.category_label" }],
        valueKey: [sum("money_stopped.stopped")],
      },
      format: {
        ...title("Money stopped, by reason"),
        style: { theme: { common: { legend: { enabled: false } }, bar: { series: { label: { enabled: true, color: "var(--action-ink)", fontWeight: "bold" as const } } } } },
      },
    },
    "rule-agreement": {
      type: "grid",
      dataMapping: {
        // One row per rule, so the counts need no aggregation; agreement is the ratio measure, right for any grouping.
        cols: [{ id: "rule_hits.rule_label" }, { id: "rule_hits.hits" }, { id: "rule_agreement" }],
      },
      sort: [{ field: { id: "rule_hits.hits" }, direction: "desc" }],
      format: { ...title("How often you agreed with each rule"), style: { grandTotalRow: { enabled: false } } },
    },
    calls: {
      type: "grid",
      dataMapping: {
        cols: [
          { id: "calls.date" },
          { id: "calls.payee" },
          { id: "calls.verdict_label" },
          { id: "calls.category_label" },
          { id: "calls.amount" },
          { id: "calls.mark_label" },
        ],
      },
      sort: [{ field: { id: "calls.date" }, direction: "desc" }],
      format: { ...title("Every payment Checkrail flagged, newest first"), style: { grandTotalRow: { enabled: false } } },
    },
  },
  filter: {
    // Holds are money that waited, not money stopped: the bar shows stopped money only.
    widget: {
      "stopped-by-reason": [{ field: { id: "money_stopped.category" }, model: { operator: "isIn", value: ["duplicate", "overcharge", "blocked_other"] } }],
    },
  },
};

/**
 * Where each card sits. With the assistant open the canvas is about 340px narrower, so the leading row is taller
 * (the checks' lines wrap more) and the bar and the rule table each take a full row.
 */
export function layoutFor(assistant: boolean): Record<string, AgWidgetLayoutState> {
  if (assistant) {
    return {
      readiness: at(0, 0, 15, 36),
      "false-holds": at(15, 0, 9, 36),
      "money-stopped": at(0, 36, 8, 9),
      "money-held": at(8, 36, 8, 9),
      "still-to-review": at(16, 36, 8, 9),
      "stopped-by-reason": at(0, 45, 24, 15),
      "rule-agreement": at(0, 60, 24, 17),
      calls: at(0, 77, 24, 26),
    };
  }
  // The leading row is 30 tracks tall so the gauge card shows all four checks and the time line without clipping.
  return {
    readiness: at(0, 0, 14, 30),
    "false-holds": at(14, 0, 10, 30),
    "money-stopped": at(0, 30, 8, 9),
    "money-held": at(8, 30, 8, 9),
    "still-to-review": at(16, 30, 8, 9),
    "stopped-by-reason": at(0, 39, 10, 19),
    "rule-agreement": at(10, 39, 14, 19),
    calls: at(0, 58, 24, 26),
  };
}

/** The default report, laid out for the canvas with or without the assistant beside it: a fresh copy each time. */
export function defaultReport(opts: { assistant?: boolean } = {}): AgReportState {
  const copy = JSON.parse(JSON.stringify({ ...page, widgetLayout: layoutFor(!!opts.assistant) })) as AgPageState;
  return { selectedPageId: PAGE_ID, pages: [copy] };
}

/** Every field id the default report reads, for checking against the data sources. */
export function reportFieldIds(state: AgReportState = defaultReport()): string[] {
  const ids = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.id === "string" && ("aggregation" in o || Object.keys(o).length === 1)) ids.add(o.id);
      Object.values(o).forEach(visit);
    }
  };
  for (const p of state.pages) {
    for (const w of Object.values(p.widgets ?? {})) {
      const widget = w as { dataMapping?: unknown; sort?: { field: unknown }[] } | undefined;
      visit(widget?.dataMapping);
      widget?.sort?.forEach((s) => visit(s.field));
    }
    for (const filters of Object.values(p.filter?.widget ?? {})) filters.forEach((f) => visit(f.field));
    p.filter?.page?.forEach((f) => visit(f.field));
  }
  return [...ids].sort();
}

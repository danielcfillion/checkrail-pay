"use client";

import { Component, type ComponentType, type ReactNode } from "react";
import type { AgWidgetField, AgWidgetParams, AgWidgetsConfig } from "ag-studio";
import { createWidgets, type AgWidgetDefinition } from "ag-studio-react";
import type { CustomCellRendererProps } from "ag-grid-react";
import { FALSE_HOLDS, READINESS_GAUGE } from "@/lib/studio/onboardingReport";
import { FalseHoldsChart } from "./FalseHoldsChart";
import { ReadinessGauge } from "./ReadinessGauge";

/** One widget failing shows a plain line in its own card; it never takes the rest of the dashboard with it. */
class WidgetBoundary extends Component<{ children: ReactNode; name: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[Checkrail] ${this.props.name} widget failed`, error);
  }
  render() {
    return this.state.failed ? <p className="cr-widget cr-caption">This card could not be drawn. The same figures are on the re-check screen.</p> : this.props.children;
  }
}

const guarded = (Inner: ComponentType<AgWidgetParams>, name: string) => {
  const Guarded = (params: AgWidgetParams) => (
    <WidgetBoundary name={name}>
      <Inner {...params} />
    </WidgetBoundary>
  );
  Guarded.displayName = `Guarded(${name})`;
  return Guarded;
};

const GAUGE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M7 24a11 11 0 1 1 18 0" stroke="var(--ag-border-color, #b3b4b4)" stroke-width="4" stroke-linecap="round"/><path d="M7 24a11 11 0 0 1 14.5-15.5" stroke="var(--settled, #0b6b4a)" stroke-width="4" stroke-linecap="round"/></svg>';
const HOLDS_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M3 20h26" stroke="var(--ag-border-color, #b3b4b4)" stroke-width="2" stroke-dasharray="3 3"/><path d="M4 7l8 6 8 9 8 2" stroke="var(--ink, #0a1628)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="28" cy="24" r="3" fill="var(--settled, #0b6b4a)"/></svg>';

/** `label` is the short name under the icon in Studio's widget menu; `ai.label` is the full name the agent reads. */
const custom = (id: string, label: string, comp: ComponentType<AgWidgetParams>, ai: { label: string; description: string; usage: string; configuration: string }, size: { width: number; height: number }): AgWidgetDefinition => ({
  id,
  label,
  icon: id === READINESS_GAUGE ? GAUGE_ICON : HOLDS_ICON,
  comp: guarded(comp, ai.label),
  // The widget reads its own tables, so the only setting is the widget type.
  form: ({ createWidgetSection }) => [createWidgetSection()],
  defaultSize: size,
  minSize: { width: 8, height: 14 },
  toolbar: ["duplicate", "delete"],
  ai,
});

export const CHECKRAIL_WIDGETS: AgWidgetDefinition[] = [
  custom(
    READINESS_GAUGE,
    "Gauge",
    ReadinessGauge,
    {
      label: "Readiness gauge",
      description:
        "A radial gauge of how many readiness checks are met for the next level (for example 'Ready for Autopilot: 3 of 4'), filling from 0 to its value, with each check listed under it as met (green) or not yet (amber) and its plain line, and the time gate (weeks in Assist) as a separate line.",
      usage: "Use it to answer 'am I ready for Autopilot?' or 'why am I not ready yet?'. One per page, near the top. Do not use it for money or for weekly trends.",
      configuration: "Needs no data mapping and no format: it reads the readiness and readiness_summary tables itself. Give it at least 12 columns by 20 rows so every check's line fits.",
    },
    { width: 14, height: 22 },
  ),
  custom(
    FALSE_HOLDS,
    "Fine holds",
    FalseHoldsChart,
    {
      label: "Holds that turned out fine",
      description:
        "A weekly line of the share of reviewed holds the owner marked fine (false_hold_rate), with the 10% target as a dashed line, green points under target and amber over, the latest week as a large figure and one plain caption such as 'Under the 10% target for 2 weeks in a row'.",
      usage: "Use it to show whether Checkrail's holds are nearly always right, the first readiness check. One per page. For holds by supplier use a bar chart of calls.was_fine by calls.payee instead.",
      configuration: "Needs no data mapping and no format: it reads the weekly_false_holds table itself. Give it at least 8 columns by 18 rows.",
    },
    { width: 10, height: 22 },
  ),
];

export const CHECKRAIL_MENU_GROUP = { label: "Checkrail", widgetIds: [READINESS_GAUGE, FALSE_HOLDS] };

// --- Grid cells: agreement as a bar, Checkrail's call as a status pill ---------------------------------------------

function AgreementCell({ value, valueFormatted }: CustomCellRendererProps) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return <span className="cr-cell-muted">Not reviewed</span>;
  const v = Math.max(0, Math.min(1, Number(value)));
  const tone = v >= 0.8 ? "cr-bar-ok" : "cr-bar-wait";
  return (
    <span className="cr-agree">
      <span className="cr-agree-track" aria-hidden>
        <span className={`cr-agree-fill ${tone}`} style={{ width: `${v * 100}%` }} />
      </span>
      <span className="num">{valueFormatted ?? `${Math.round(v * 100)}%`}</span>
    </span>
  );
}

const VERDICT_TONE: Record<string, string> = { Blocked: "cr-pill-blocked", Held: "cr-pill-held", Clear: "cr-pill-clear" };

function VerdictCell({ value }: CustomCellRendererProps) {
  const text = String(value ?? "");
  return <span className={`cr-pill ${VERDICT_TONE[text] ?? ""}`}>{text}</span>;
}

/** Studio's grid widget asks once per column which renderer to use. */
export function createCellRenderer(field: AgWidgetField): ComponentType<CustomCellRendererProps> | undefined {
  const id = String(field.fieldId);
  if (id === "rule_agreement" || id === "rule_hits.agreement_rate" || id === "false_hold_share") return AgreementCell;
  if (id === "calls.verdict_label") return VerdictCell;
  return undefined;
}

/**
 * Studio's `widgets` property: the built-in widgets and menu, plus a "Checkrail" group first with the two custom
 * widgets, and the grid widget's cells drawn in the app's status colours.
 */
export function checkrailWidgets(defaults: AgWidgetsConfig): AgWidgetsConfig {
  const config = createWidgets({
    additionalTypes: CHECKRAIL_WIDGETS,
    menu: [CHECKRAIL_MENU_GROUP, ...defaults.menu],
    overrides: [{ id: "grid", options: { createCellRenderer } }],
  } as unknown as Parameters<typeof createWidgets>[0]);
  return config as unknown as AgWidgetsConfig;
}

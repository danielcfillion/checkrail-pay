"use client";

import { useEffect, useMemo, useRef } from "react";
import { AgStudioAiModule, enableStudioDevValidations, type AgPanelConfig, type AgReportState, type AgStudioApi, type AgStudioMode } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import type { DashboardData } from "@/lib/onboarding/dashboard";
import { buildOnboardingAi } from "@/lib/studio/onboardingAi";
import { buildOnboardingStudioData, displayCurrency, studioRows } from "@/lib/studio/onboardingData";
import { CUSTOM_WIDGET_TYPES, defaultReport } from "@/lib/studio/onboardingReport";
import { onboardingStudioTheme } from "@/lib/studio/onboardingTheme";
import { clearLayout, differs, loadLayout, saveLayout } from "@/lib/studio/layoutStore";
import { checkrailWidgets } from "./widgets";
import { fromStudio, studioDefault, toStudio } from "./state";
import type { WidgetContext } from "./engineRows";
import "./studio.css";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

/** Built-in widget types Studio ships, for checking a saved layout before loading it. */
const BUILT_IN_TYPES = [
  "value", "grid", "pivot-grid", "column-chart-grouped", "column-chart-stacked", "column-chart-stacked-100", "bar-chart-grouped", "bar-chart-stacked", "bar-chart-stacked-100",
  "line-chart", "area-chart", "area-chart-stacked", "area-chart-stacked-100", "scatter-chart", "bubble-chart", "radar-line-chart", "radar-area-chart", "radial-column-chart",
  "nightingale-chart", "radial-bar-chart", "pie-chart", "donut-chart", "funnel-chart", "cone-funnel-chart", "pyramid-chart", "treemap-chart", "sunburst-chart", "radial-gauge",
  "linear-gauge", "button-filter", "list-filter", "date-filter", "text", "image", "combo-chart-grouped-column-line", "combo-chart-stacked-column-line",
];
export const KNOWN_TYPES: ReadonlySet<string> = new Set([...BUILT_IN_TYPES, ...CUSTOM_WIDGET_TYPES]);

/**
 * View mode: the assistant on the right (nothing without AI). Edit mode: Studio's widget and data panels on the left
 * and no assistant, so the canvas keeps Studio's minimum width; the conversation is still there back in view mode.
 */
function panelsFor(ai: boolean): AgPanelConfig {
  return {
    // Studio's typings allow only the filters panel in view mode; at runtime the assistant panel works there too.
    view: { right: ai ? (["ai"] as unknown as "filters"[]) : [] },
    edit: { left: ["edit", "data"], right: [] },
  };
}

const LOCALE = {
  panelTitleAi: "Ask about your setup",
  aiMessageInputPlaceholder: "Ask about your payments",
  aiNewChat: "New question",
  aiNewConversation: "New question",
};

export interface StudioCanvasProps {
  data: DashboardData;
  licenseKey?: string;
  /** Present only when live AI is configured on the server; null hides the assistant. */
  assistant: { business: string } | null;
  mode: AgStudioMode;
  onApi: (api: AgStudioApi | null) => void;
  /** Whether the dashboard now differs from the default layout (so "Reset layout" has something to do). */
  onCustomised: (customised: boolean) => void;
  /** Studio could not load the default layout: the page shows the plain summary instead. */
  onFatal: () => void;
}

export default function StudioCanvas({ data, licenseKey, assistant, mode, onApi, onCustomised, onFatal }: StudioCanvasProps) {
  const studioData = useMemo(() => buildOnboardingStudioData(data), [data]);
  const context = useMemo<WidgetContext>(() => ({ rows: studioRows(data) }), [data]);
  const ai = useMemo(() => (assistant ? buildOnboardingAi({ business: assistant.business, currency: displayCurrency(data) }) : undefined), [assistant, data]);
  const panels = useMemo(() => panelsFor(!!ai), [ai]);

  // Studio reads initialState once. The owner's saved layout, when this browser has a usable one, else the default.
  const initial = useRef<{ state: AgReportState; saved: boolean } | null>(null);
  if (initial.current === null) {
    const saved = loadLayout(KNOWN_TYPES);
    initial.current = saved ? { state: toStudio(saved), saved: true } : { state: studioDefault(!!assistant), saved: false };
  }
  const apiRef = useRef<AgStudioApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onCustomised(initial.current?.saved ?? false);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      onApi(null);
    };
  }, [onApi, onCustomised]);

  const persist = (state: AgReportState) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const plain = fromStudio(state);
      const custom = differs(plain, defaultReport({ assistant: !!assistant }));
      if (custom) saveLayout(plain);
      else clearLayout();
      onCustomised(custom);
    }, 300);
  };

  return (
    <AgStudioProvider licenseKey={licenseKey || undefined} modules={ai ? [AgStudioAiModule] : undefined}>
      <AgStudio
        className="cr-studio"
        style={{ height: "100%", width: "100%" }}
        theme={onboardingStudioTheme}
        data={studioData}
        context={context}
        widgets={checkrailWidgets}
        initialState={initial.current.state}
        mode={mode}
        panels={panels}
        ai={ai}
        localeText={LOCALE}
        layout={{ widgetBorderEnabled: true }}
        onApiReady={(e) => {
          apiRef.current = e.api;
          onApi(e.api);
        }}
        onStateUpdated={(e) => persist(e.state)}
        onErrorRaised={(e) => {
          console.error("[Checkrail] Studio reported", e.errorType, e.errorDetails);
          if (!e.fatal) return;
          // A saved layout Studio cannot load is dropped for the default; if the default fails, show the summary.
          if (initial.current?.saved && apiRef.current) {
            clearLayout();
            initial.current = { state: studioDefault(!!assistant), saved: false };
            apiRef.current.setState(studioDefault(!!assistant));
            apiRef.current.clearHistory();
            onCustomised(false);
          } else onFatal();
        }}
      />
    </AgStudioProvider>
  );
}

"use client";

import type { AgReportState } from "ag-studio";
import { cssTokenLookup, resolveChartTokens, restoreChartTokens } from "@/lib/studio/chartTokens";
import { defaultReport } from "@/lib/studio/onboardingReport";

/** The default layout as Studio should receive it: chart colours resolved for this page's theme. */
export const studioDefault = (assistant: boolean): AgReportState => toStudio(defaultReport({ assistant }));

/** Report state on its way into Studio. */
export const toStudio = (state: AgReportState): AgReportState => resolveChartTokens(state, cssTokenLookup());

/** Report state from Studio, with chart colours back to tokens, as it is saved and compared. */
export const fromStudio = (state: AgReportState): AgReportState => restoreChartTokens(state, cssTokenLookup());

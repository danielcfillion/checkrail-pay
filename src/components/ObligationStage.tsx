"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { CheckLine } from "./CheckLine";
import type { StationIndex } from "./checkline-model";

type Stage = { animateTo: StationIndex | undefined; travel: (to: StationIndex | undefined) => void };
const StageContext = createContext<Stage>({ animateTo: undefined, travel: () => {} });

/**
 * Shares the pay animation between the full check line at the top of the
 * obligation page and the action bar in the right column.
 */
export function ObligationStageProvider({ children }: { children: ReactNode }) {
  const [animateTo, setAnimateTo] = useState<StationIndex | undefined>(undefined);
  return <StageContext.Provider value={{ animateTo, travel: setAnimateTo }}>{children}</StageContext.Provider>;
}

export function useStage() {
  return useContext(StageContext);
}

export function StageCheckLine({ state, hasAccounting, caption }: { state: string; hasAccounting: boolean; caption?: string | null }) {
  const { animateTo } = useStage();
  return <CheckLine state={state} variant="full" hasAccounting={hasAccounting} animateTo={animateTo} caption={animateTo !== undefined ? null : caption} blockedAtStation={animateTo !== undefined ? null : undefined} />;
}

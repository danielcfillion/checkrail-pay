"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { CheckLine } from "./CheckLine";
import type { StationIndex } from "./checkline-model";

type Stage = { animateTo: StationIndex | undefined; travel: (to: StationIndex | undefined) => void; note: string; setNote: (n: string) => void };
const StageContext = createContext<Stage>({ animateTo: undefined, travel: () => {}, note: "", setNote: () => {} });

/**
 * Shares the pay animation between the full check line at the top of the
 * obligation page and the action bar in the right column, and the approval note: it is typed under Actions and
 * sent with whichever Approve or Reject the person presses, the decision card's or the action bar's.
 */
export function ObligationStageProvider({ children }: { children: ReactNode }) {
  const [animateTo, setAnimateTo] = useState<StationIndex | undefined>(undefined);
  const [note, setNote] = useState("");
  return <StageContext.Provider value={{ animateTo, travel: setAnimateTo, note, setNote }}>{children}</StageContext.Provider>;
}

export function useStage() {
  return useContext(StageContext);
}

export function StageCheckLine({ state, hasAccounting, caption }: { state: string; hasAccounting: boolean; caption?: string | null }) {
  const { animateTo } = useStage();
  return <CheckLine state={state} variant="full" hasAccounting={hasAccounting} animateTo={animateTo} caption={animateTo !== undefined ? null : caption} blockedAtStation={animateTo !== undefined ? null : undefined} />;
}

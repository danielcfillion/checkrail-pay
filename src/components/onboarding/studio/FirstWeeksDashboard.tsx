"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useRef, useState, type ReactNode } from "react";
import type { AgStudioApi, AgStudioMode } from "ag-studio";
import type { DashboardData } from "@/lib/onboarding/dashboard";
import { PageHeader } from "@/components/ui";
import { clearLayout } from "@/lib/studio/layoutStore";
import { usdEquivalentNote } from "@/lib/onboarding/usdNote";
import { localDateString } from "@/lib/format";
import { studioDefault } from "./state";
import { FallbackSummary } from "./FallbackSummary";
import type { StudioCanvasProps } from "./StudioCanvas";

/** Studio's frame on the page: tall enough for the leading row and the money row, never cramped. */
const FRAME_STYLE = { height: "calc(100vh - 220px)", minHeight: 720 } as const;

function StudioSkeleton() {
  return (
    <div className="grid h-full grid-cols-24 gap-4" aria-busy="true" aria-label="Loading the dashboard">
      <div className="panel col-span-14 h-[340px] animate-pulse" />
      <div className="panel col-span-10 h-[340px] animate-pulse" />
      <div className="panel col-span-8 h-[112px] animate-pulse" />
      <div className="panel col-span-8 h-[112px] animate-pulse" />
      <div className="panel col-span-8 h-[112px] animate-pulse" />
    </div>
  );
}

// Studio runs in the browser only; its script loads after the page. A failed load lands in the boundary below.
const StudioCanvas = dynamic<StudioCanvasProps>(() => import("./StudioCanvas"), { ssr: false, loading: StudioSkeleton });

/** If Studio throws while loading or rendering, the page shows the same numbers as plain text instead. */
class StudioBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("[Checkrail] The dashboard could not load; showing the summary instead.", error);
    this.props.onFail();
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface FirstWeeksDashboardProps {
  data: DashboardData;
  /** AG Studio licence key from the server's AG_STUDIO variable. Without it Studio shows a trial watermark. */
  licenseKey?: string;
  /** Present only when live AI is on (isLiveAi() on the server); null hides the assistant. */
  assistant: { business: string } | null;
}

/**
 * "Your first weeks": the readiness dashboard, built with AG Studio. The owner can switch to edit mode to move,
 * resize and add widgets; their layout is kept in this browser, and "Reset layout" returns to the one from code.
 */
export function FirstWeeksDashboard({ data, licenseKey, assistant }: FirstWeeksDashboardProps) {
  const [mode, setMode] = useState<AgStudioMode>("view");
  const [customised, setCustomised] = useState(false);
  const [failed, setFailed] = useState(false);
  const api = useRef<AgStudioApi | null>(null);
  const onApi = useCallback((a: AgStudioApi | null) => {
    api.current = a;
  }, []);
  const onCustomised = useCallback((c: boolean) => setCustomised(c), []);
  const onFatal = useCallback(() => setFailed(true), []);

  const editing = mode === "edit";
  const usdNote = usdEquivalentNote(data, localDateString());
  const reset = () => {
    clearLayout();
    api.current?.setState(studioDefault(!!assistant));
    api.current?.clearHistory();
    setCustomised(false);
  };
  const fallback = <FallbackSummary data={data} note="The interactive dashboard could not load here, so these are the same figures as plain text." />;

  return (
    <>
      <PageHeader
        title="Your first weeks"
        lede="How Checkrail's calls have held up against your own payments. When its holds are nearly always right, it suggests handing it more."
        actions={
          failed ? null : (
            <>
              <span className="dense hidden rounded-full border hairline px-2.5 py-1 text-ink-soft sm:inline-flex">Dashboard built with AG Studio</span>
              {editing || customised ? (
                <button type="button" className="btn btn-sm" onClick={reset} disabled={!customised}>
                  Reset layout
                </button>
              ) : null}
              <button type="button" className={editing ? "btn btn-primary" : "btn"} aria-pressed={editing} onClick={() => setMode(editing ? "view" : "edit")}>
                {editing ? "Done" : "Edit dashboard"}
              </button>
            </>
          )
        }
      />
      {failed ? (
        fallback
      ) : (
        <>
          {editing ? (
            <p className="dense mb-3 text-ink-soft">Drag a card to move it, pull its corner to resize, or add one from the widget list. Your layout stays in this browser.</p>
          ) : assistant ? (
            <p className="dense mb-3 text-right text-ink-soft">The assistant explains the numbers and adds widgets. It cannot change a rule or pay anyone.</p>
          ) : null}
          {!editing && usdNote ? <p className="dense mb-3 text-ink-soft">{usdNote}</p> : null}
          <div className="cr-frame" style={FRAME_STYLE}>
            <StudioBoundary fallback={fallback} onFail={onFatal}>
              <StudioCanvas data={data} licenseKey={licenseKey} assistant={assistant} mode={mode} onApi={onApi} onCustomised={onCustomised} onFatal={onFatal} />
            </StudioBoundary>
          </div>
        </>
      )}
    </>
  );
}

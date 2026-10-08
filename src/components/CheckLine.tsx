"use client";

import { useEffect, useRef, useState } from "react";
import { positionFor, stationOffset, STATIONS, STATION_LABELS, type StationIndex } from "./checkline-model";
import { stateLabel } from "@/lib/format";

type Props = {
  state: string | null | undefined;
  variant?: "compact" | "full";
  hasAccounting?: boolean;
  /** Override the broken station (defaults from state). */
  blockedAtStation?: StationIndex | null;
  /** When set, the marker travels one station at a time to this index. */
  animateTo?: StationIndex;
  /** Full variant only: text shown beside the marker. */
  caption?: string | null;
  className?: string;
};

const TONE_FILL: Record<string, string> = {
  neutral: "var(--ink)",
  attention: "var(--attention)",
  settled: "var(--settled)",
  blocked: "var(--blocked)",
  muted: "var(--ink-soft)",
};

/**
 * The check line. A marker travels left to right through five stations. The only
 * motion in the app happens here: when the target station moves forward, the
 * marker steps one station at a time (600ms each, CSS transition on left).
 */
export function CheckLine({ state, variant = "compact", hasAccounting, blockedAtStation, animateTo, caption, className = "" }: Props) {
  const pos = positionFor(state, { hasAccounting });
  const target: StationIndex = animateTo ?? pos.station;
  const brokenAt = blockedAtStation === undefined ? pos.brokenAt : blockedAtStation;
  const [shown, setShown] = useState<StationIndex>(target);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (shown === target) return;
    if (target < shown) {
      setShown(target);
      return;
    }
    timer.current = setTimeout(() => setShown((s) => Math.min(s + 1, target) as StationIndex), shown === pos.station ? 50 : 600);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [shown, target, pos.station]);

  const fill = pos.inactive ? "var(--ink-soft)" : TONE_FILL[pos.tone];
  const label = `${stateLabel(state)}: at ${STATION_LABELS[STATIONS[shown]]}${brokenAt !== null ? ", line broken at " + STATION_LABELS[STATIONS[brokenAt]] : ""}`;

  if (variant === "compact") {
    return (
      <span className={`relative inline-block h-3 w-24 align-middle ${className}`} role="img" aria-label={label} title={label}>
        <span className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2" style={{ background: pos.inactive ? "var(--rule)" : "var(--rule-strong)" }} />
        {!pos.inactive && (
          <span className="absolute left-0 top-1/2 h-px -translate-y-1/2" style={{ background: fill, width: `${stationOffset(shown)}%`, opacity: 0.9 }} />
        )}
        {STATIONS.map((s, i) => (
          <span key={s} className="absolute top-1/2 h-1.5 w-px -translate-y-1/2" style={{ left: `${stationOffset(i)}%`, background: "var(--rule-strong)", transform: "translate(-50%, -50%)" }} />
        ))}
        {brokenAt !== null && (
          <span className="absolute top-1/2 flex h-3 w-3 items-center justify-center" style={{ left: `${stationOffset(brokenAt)}%`, transform: "translate(-50%, -50%)", background: "var(--sheet)" }} aria-hidden>
            <svg width="10" height="10" viewBox="0 0 10 10" stroke="var(--blocked)" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </span>
        )}
        {brokenAt === null && (
          <span
            className="dl-marker absolute top-1/2 h-2 w-2 rounded-full"
            style={{ left: `${stationOffset(shown)}%`, transform: "translate(-50%, -50%)", background: fill, border: "2px solid var(--sheet)", boxSizing: "content-box" }}
            aria-hidden
          />
        )}
      </span>
    );
  }

  return (
    <div className={`relative ${className}`} role="img" aria-label={label}>
      <div className="relative h-8">
        {/* base track */}
        <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2" style={{ background: pos.inactive ? "var(--rule)" : "var(--rule-strong)" }} />
        {/* travelled portion */}
        {!pos.inactive && brokenAt === null && (
          <div className="dl-marker absolute left-0 top-1/2 h-0.5 -translate-y-1/2" style={{ background: fill, width: `${stationOffset(shown)}%`, transition: "width 600ms cubic-bezier(0.4,0,0.2,1)" }} />
        )}
        {!pos.inactive && brokenAt !== null && (
          <div className="absolute left-0 top-1/2 h-0.5 -translate-y-1/2" style={{ background: "var(--ink)", width: `calc(${stationOffset(brokenAt)}% - 14px)` }} />
        )}
        {/* break: the rest of the line is cut */}
        {brokenAt !== null && (
          <div className="absolute top-1/2 h-px -translate-y-1/2" style={{ left: `calc(${stationOffset(brokenAt)}% + 14px)`, right: 0, background: "var(--rule)", opacity: 0.6 }} />
        )}
        {STATIONS.map((s, i) => (
          <div key={s} className="absolute top-1/2 h-3 w-px" style={{ left: `${stationOffset(i)}%`, background: "var(--rule-strong)", transform: "translate(-50%, -50%)" }} />
        ))}
        {brokenAt !== null ? (
          <div className="absolute top-1/2 flex h-7 w-7 items-center justify-center rounded-full" style={{ left: `${stationOffset(brokenAt)}%`, transform: "translate(-50%, -50%)", background: "var(--sheet)", border: "1.5px solid var(--blocked)" }} aria-hidden>
            <svg width="14" height="14" viewBox="0 0 14 14" stroke="var(--blocked)" strokeWidth="1.75" strokeLinecap="round">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </div>
        ) : (
          <div
            className="dl-marker absolute top-1/2 h-3.5 w-3.5 rounded-full"
            style={{ left: `${stationOffset(shown)}%`, transform: "translate(-50%, -50%)", background: fill, border: "3px solid var(--sheet)", boxSizing: "content-box" }}
            aria-hidden
          />
        )}
      </div>
      <div className="relative mt-1 h-5">
        {STATIONS.map((s, i) => {
          const active = brokenAt !== null ? i === brokenAt : i === shown;
          const colour = active ? fill : i < shown && brokenAt === null && !pos.inactive ? "var(--ink)" : "var(--ink-soft)";
          return (
            <span
              key={s}
              className="dense absolute top-0 whitespace-nowrap"
              style={{ left: `${stationOffset(i)}%`, transform: i === 0 ? "none" : i === STATIONS.length - 1 ? "translateX(-100%)" : "translateX(-50%)", color: colour, fontWeight: active ? 600 : 500 }}
            >
              {STATION_LABELS[s]}
              {active && (caption ?? pos.caption) ? <span className="font-normal" style={{ color: fill }}>{`, ${caption ?? pos.caption}`}</span> : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

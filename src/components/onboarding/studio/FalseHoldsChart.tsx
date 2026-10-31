"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgWidgetParams } from "ag-studio";
import { falseHoldCaption, falseHoldPoints, percent, plot, targetOf, underTargetStreak, type FalseHoldWeek } from "@/lib/studio/falseHolds";
import { useEngineRows } from "./engineRows";

const BOX = { left: 36, right: 22, top: 16, bottom: 24 };

/** The element's size, kept current as Studio resizes the card. A callback ref, since the element mounts once data arrives. */
function useSize<T extends HTMLElement>() {
  const observer = useRef<ResizeObserver | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = () => setSize((s) => (s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, size] as const;
}

/**
 * Custom Studio widget: "Holds that turned out fine". The share of reviewed holds the owner marked fine, week by
 * week, against the dashed 10% target, with one plain caption. Points are green under the target and amber over it
 * (a hold that was a good payment is a held payment); the line itself is neutral ink. Weeks nobody reviewed are
 * left out, not drawn as 0%.
 */
export function FalseHoldsChart(params: AgWidgetParams) {
  const { rows } = useEngineRows<FalseHoldWeek>(params, "weekly_false_holds", ["week_start", "week_label", "reviewed", "false_hold_rate", "target_rate", "under_target"]);
  const points = useMemo(() => (rows ? falseHoldPoints(rows) : []), [rows]);
  const target = rows ? targetOf(rows) : 0.1;
  const [chartRef, size] = useSize<HTMLDivElement>();

  const { widgetApi } = params;
  useEffect(() => {
    if (!rows) widgetApi.setDisplayState("loading", { prominent: true });
    else widgetApi.setDisplayState("displayed");
  }, [rows, widgetApi]);

  if (!rows) return <div className="cr-widget" aria-busy="true" />;

  const latest = points.at(-1);
  const p = size.width > 0 ? plot(points, target, { width: size.width, height: size.height, ...BOX }) : null;
  const streak = underTargetStreak(points);
  const caption = falseHoldCaption(points, target);
  const drawKey = points.map((x) => `${x.week_start}:${x.rate}`).join("|");

  return (
    <div className="cr-widget cr-holds">
      <h3 className="cr-widget-title">Holds that turned out fine</h3>
      <p className="cr-holds-figure">
        {latest ? (
          <>
            <span className={`cr-holds-value num ${latest.under ? "cr-ok" : "cr-wait"}`}>{percent(latest.rate)}</span>
            <span className="cr-holds-when">latest week ({latest.label})</span>
          </>
        ) : (
          <span className="cr-holds-when">No holds reviewed yet</span>
        )}
      </p>
      <div ref={chartRef} className="cr-holds-chart">
        {p ? (
          <svg width={size.width} height={size.height} role="img" aria-label={`Holds that turned out fine by week. ${caption}`}>
            {p.ticks.map((t) => (
              <g key={t.value}>
                <line x1={BOX.left} x2={size.width - BOX.right} y1={t.y} y2={t.y} stroke="var(--rule)" strokeWidth={1} />
                <text x={BOX.left - 6} y={t.y + 4} textAnchor="end" className="cr-axis">
                  {percent(t.value)}
                </text>
              </g>
            ))}
            <line x1={BOX.left} x2={size.width - BOX.right} y1={p.targetY} y2={p.targetY} stroke="var(--ink-soft)" strokeWidth={1.5} strokeDasharray="5 4" />
            <text x={BOX.left + 6} y={p.targetY - 6} textAnchor="start" className="cr-axis cr-target-label">
              {percent(target)} target
            </text>
            {p.points.length > 1 ? <path key={drawKey} d={p.path} fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="cr-draw" /> : null}
            {p.points.map((pt) => (
              <g key={pt.week_start}>
                <circle cx={pt.x} cy={pt.y} r={4.5} fill={pt.under ? "var(--settled)" : "var(--attention)"} stroke="var(--sheet)" strokeWidth={2}>
                  <title>{`${pt.label}: ${percent(pt.rate)} of reviewed holds were fine`}</title>
                </circle>
                <text x={pt.x} y={size.height - 6} textAnchor="middle" className="cr-axis">
                  {pt.label}
                </text>
              </g>
            ))}
          </svg>
        ) : null}
      </div>
      <p className={`cr-caption ${streak >= 2 ? "cr-caption-ok" : ""}`}>{caption}</p>
    </div>
  );
}

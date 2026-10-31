"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgWidgetParams } from "ag-studio";
import { GAUGE_DURATION_MS, GAUGE_START, GAUGE_SWEEP, arcLength, arcPath, dashOffset, gaugeFraction, notchAngles, polar, tween } from "@/lib/studio/gauge";
import { prefersReducedMotion, useEngineRows } from "./engineRows";
import { CheckIcon, WaitIcon } from "./icons";

type Criterion = { label: string; line: string; met: boolean; counts_toward_gauge: boolean; position: number };
type Summary = { next_level_label: string | null; level_label: string; ready: boolean };

const SIZE = 168;
const R = 68;
const STROKE = 14;
const C = SIZE / 2;
const HEIGHT = Math.ceil(polar(C, C, R, GAUGE_START).y + STROKE / 2 + 2);
const LENGTH = arcLength(R, GAUGE_SWEEP);
const TRACK = arcPath(C, C, R, GAUGE_START, GAUGE_START + GAUGE_SWEEP);

/** The arc's drawn fraction: fills from where it is to `target` over 600 ms, ease-out, or jumps under reduced motion. */
function useFill(target: number | null): number {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (target === null) return;
    if (prefersReducedMotion()) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const step = (now: number) => {
      const v = tween(origin, target, now - start, GAUGE_DURATION_MS);
      from.current = v;
      setShown(v);
      if (now - start < GAUGE_DURATION_MS) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

/**
 * Custom Studio widget: "Ready for Autopilot: 3 of 4". A 240 degree gauge of readiness checks met (the time gate is a
 * separate line, not part of the count), each check listed under it with its plain line. Green means a check is
 * met; amber means it is still waiting. Reads the readiness tables through Studio's data engine.
 */
export function ReadinessGauge(params: AgWidgetParams) {
  const criteria = useEngineRows<Criterion>(params, "readiness", ["label", "line", "met", "counts_toward_gauge", "position"]);
  const summary = useEngineRows<Summary>(params, "readiness_summary", ["next_level_label", "level_label", "ready"]);
  const rows = useMemo(() => (criteria.rows ? [...criteria.rows].sort((a, b) => Number(a.position) - Number(b.position)) : null), [criteria.rows]);
  const checks = rows?.filter((r) => r.counts_toward_gauge) ?? [];
  const gate = rows?.find((r) => !r.counts_toward_gauge) ?? null;
  const met = checks.filter((r) => r.met).length;
  const total = checks.length;
  const s = summary.rows?.[0];
  const next = s ? s.next_level_label : undefined;
  const fill = useFill(rows ? gaugeFraction(met, total) : null);

  const { widgetApi } = params;
  const loading = !rows || !summary.rows;
  useEffect(() => {
    if (loading) widgetApi.setDisplayState("loading", { prominent: true });
    else widgetApi.setDisplayState(rows.length ? "displayed" : "noData");
  }, [loading, rows, widgetApi]);

  if (loading) return <div className="cr-widget" aria-busy="true" />;

  const heading = next === null ? `On ${s?.level_label ?? "Autopilot"}` : `Ready for ${next ?? "the next level"}: ${met} of ${total}`;
  const label = next === null ? heading : `${heading} checks met`;

  return (
    <div className="cr-widget cr-gauge">
      <div className="cr-gauge-dial">
        <svg width={SIZE} height={HEIGHT} viewBox={`0 0 ${SIZE} ${HEIGHT}`} role="img" aria-label={label}>
          <path d={TRACK} fill="none" stroke="var(--neutral-soft)" strokeWidth={STROKE} strokeLinecap="round" />
          <path d={TRACK} fill="none" stroke="var(--settled)" strokeWidth={STROKE} strokeLinecap="round" strokeDasharray={LENGTH} strokeDashoffset={dashOffset(LENGTH, fill)} style={{ opacity: fill > 0.001 ? 1 : 0 }} />
          {notchAngles(total).map((a) => {
            const p = polar(C, C, R - STROKE / 2 - 1, a);
            const q = polar(C, C, R + STROKE / 2 + 1, a);
            return <line key={a} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--sheet)" strokeWidth={3} />;
          })}
          <text x={C} y={C + 4} textAnchor="middle" className="cr-gauge-value">
            {met}/{total}
          </text>
          <text x={C} y={C + 26} textAnchor="middle" className="cr-gauge-unit">
            checks met
          </text>
        </svg>
      </div>
      <div className="cr-gauge-body">
        <h3 className="cr-widget-title cr-gauge-title">{heading}</h3>
        <ul className="cr-checks">
          {checks.map((c) => (
            <li key={c.label} className="cr-check">
              {c.met ? <CheckIcon className="cr-ok" /> : <WaitIcon className="cr-wait" />}
              <span>
                <span className="cr-check-label">{c.label}</span>
                <span className="cr-check-line">{c.line}</span>
              </span>
            </li>
          ))}
        </ul>
        {gate ? (
          <p className="cr-gate">
            {gate.met ? <CheckIcon className="cr-ok" small /> : <WaitIcon className="cr-wait" small />}
            <span>
              <span className="cr-gate-label">Time in Assist:</span> {gate.line}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

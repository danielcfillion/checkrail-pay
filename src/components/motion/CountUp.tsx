"use client";

import { useEffect, useRef, useState } from "react";
import { formatMoneySymbol } from "@/lib/format";

const KEY = "checkrail:countup:";
const DURATION_MS = 700;

/** Ease-out cubic: fast start, gentle landing, so the eye reads the final figure rather than the motion. */
const ease = (t: number) => 1 - (1 - t) ** 3;

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/**
 * A money figure that counts up from the last value this browser saw to the current one. The server renders the
 * real figure, so without script, on first visit, or with reduced motion it simply shows it. It only moves when
 * the number has grown since the viewer last looked (a block just stopped more money), which is the moment worth
 * showing.
 */
export function CountUp({ minor, currency, id = "prevented" }: { minor: number; currency: string; id?: string }) {
  const [shown, setShown] = useState(minor);
  const frame = useRef<number | null>(null);
  const last = useRef<number | null>(null);

  useEffect(() => {
    let from: number | null = last.current;
    if (from === null) {
      try {
        const saved = window.sessionStorage.getItem(KEY + id);
        from = saved === null ? null : Number(saved);
      } catch {
        from = null;
      }
    }
    last.current = minor;
    try {
      window.sessionStorage.setItem(KEY + id, String(minor));
    } catch {
      // Storage blocked: the figure still shows, it just does not animate next time.
    }
    if (from === null || !Number.isFinite(from) || from >= minor || reducedMotion()) {
      setShown(minor);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      setShown(Math.round(from! + (minor - from!) * ease(t)));
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    setShown(from);
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [minor, id]);

  // Screen readers hear the settled value once, not every frame.
  return (
    <>
      <span aria-hidden>{formatMoneySymbol(shown, currency)}</span>
      <span className="sr-only">{formatMoneySymbol(minor, currency)}</span>
    </>
  );
}

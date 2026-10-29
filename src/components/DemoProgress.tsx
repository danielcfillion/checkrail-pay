"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Progress through the /demo guide (DS2-27). Most steps are done when the database says so (the server passes
 * `done`). Two are done when a page has been opened since the last reset: the overview (step 1) and Accounting
 * (step 10). Those visits are remembered in this browser only, stamped with the time, and count only when they come
 * after the demo was last reset, so a reset starts the count again.
 */

const KEY = (page: string) => `checkrail.demo.visited.${page}`;

/** Drop on a page to record that it was opened. Renders nothing. */
export function DemoVisit({ page }: { page: string }) {
  useEffect(() => {
    try {
      window.localStorage.setItem(KEY(page), new Date().toISOString());
    } catch {
      /* storage blocked: the step just does not tick */
    }
  }, [page]);
  return null;
}

type Step = { done: boolean; visit?: string };
const Ctx = createContext<boolean[]>([]);

function visitedSince(page: string, sinceIso: string): boolean {
  try {
    const at = window.localStorage.getItem(KEY(page));
    return Boolean(at && at > sinceIso);
  } catch {
    return false;
  }
}

export function DemoProgressProvider({ steps, seededAt, children }: { steps: Step[]; seededAt: string; children: ReactNode }) {
  const [done, setDone] = useState(() => steps.map((s) => s.done));
  useEffect(() => {
    setDone(steps.map((s) => s.done || (s.visit ? visitedSince(s.visit, seededAt) : false)));
    // steps is rebuilt on every server render; compare by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(steps), seededAt]);
  return <Ctx.Provider value={done}>{children}</Ctx.Provider>;
}

/** "4 of 10 done" with a thin bar. */
export function DemoProgressCount() {
  const done = useContext(Ctx);
  const n = done.filter(Boolean).length;
  const total = done.length;
  return (
    <div className="mt-3 max-w-sm">
      <p className="text-sm">
        <span className="wide num">{n} of {total}</span> <span className="text-ink-soft">done</span>
      </p>
      <div className="mt-1 h-1.5 w-full rounded-full" style={{ background: "var(--rule)" }} role="progressbar" aria-label="Demo guide progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={n}>
        <div className="h-1.5 rounded-full" style={{ width: `${total ? (n / total) * 100 : 0}%`, background: "var(--settled)" }} />
      </div>
    </div>
  );
}

/** The step's "Done" mark. */
export function StepDone({ index }: { index: number }) {
  const done = useContext(Ctx);
  return done[index] ? <span className="dense text-settled">Done</span> : null;
}

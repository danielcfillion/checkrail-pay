"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ResetDemoButton } from "./ResetDemoButton";

const KEY = "checkrail.demoBanner.dismissed";

/**
 * First thing a judge sees on the hosted demo: what the business is, what the product does, and where to click.
 * Dismissing it is remembered in this browser only; Reset demo and the guide stay one click away.
 */
export function DemoBanner({ startHref, canReset }: { startHref: string; canReset: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(KEY) === "1");
    } catch {
      /* storage blocked: show the banner */
    }
  }, []);
  const set = (v: boolean) => {
    setDismissed(v);
    try {
      if (v) window.localStorage.setItem(KEY, "1");
      else window.localStorage.removeItem(KEY);
    } catch {
      /* not remembered, still hidden for this visit */
    }
  };

  if (dismissed) {
    return (
      <section aria-label="Demo" className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
        <p className="text-ink-soft">Demo data, shared by everyone using it.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/demo" className="btn btn-sm">
            Demo guide
          </Link>
          {canReset ? <ResetDemoButton size="sm" /> : null}
          <button type="button" className="btn btn-sm" onClick={() => set(false)}>
            Show intro
          </button>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Demo" className="panel mb-6 border-l-4 px-4 py-4 sm:px-5" style={{ borderLeftColor: "var(--ink)" }}>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-3xl text-base">
          Demo: Ridgeline Expeditions pays guides, drivers and homestays in Vietnam and the Philippines. Checkrail Pay checks every request before money moves.
        </p>
        <button type="button" className="btn btn-sm shrink-0" aria-label="Dismiss the demo introduction" onClick={() => set(true)}>
          Dismiss
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link href={startHref} className="btn btn-primary">
          Start with the USD 960 invoice
        </Link>
        <Link href="/demo" className="btn">
          Demo guide
        </Link>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3 text-sm text-ink-soft hairline">
        <span>This demo is shared by everyone using it. Reset puts the four opening requests back.</span>
        {canReset ? <ResetDemoButton size="sm" /> : null}
      </div>
    </section>
  );
}

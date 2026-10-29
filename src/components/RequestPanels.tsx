import type { ReactNode } from "react";

/*
 * Three panel tiers for the payment request page (DESIGN.md, DS-36):
 * - Decision: the one card that states the outcome. No border, sheet, 18px title. Lives in DecisionCard.
 * - Working: what a person reads to make the decision. The standard panel, title bar and hairline.
 * - Reference: the record, for whoever wants it. No title bar, paper background, 12px dense labels.
 * Classes only, so the page does not depend on new global CSS.
 */

export function WorkingPanel({ title, aside, children, className = "", label }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return (
    <section className={`panel min-w-0 ${className}`} aria-label={label}>
      <div className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5 hairline">
        <h2 className="font-medium">{title}</h2>
        {aside ? <div className="dense text-ink-soft">{aside}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function ReferencePanel({ title, aside, children, className = "" }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-md border bg-[color:var(--paper)] px-4 py-3 hairline ${className}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="dense text-ink-soft">{title}</h2>
        {aside ? <div className="dense text-ink-soft">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/*
 * Touch targets (DS2-12): 44px tall on coarse pointers, unchanged with a mouse. The button classes live outside any
 * CSS layer, so their height needs the important flag to be overridden; the summary style is in the components layer.
 */
/** For a disclosure summary. The chevron comes from the global summary style, so there is exactly one. */
export const SUMMARY = "pointer-coarse:min-h-11";
/** For a small button (btn-sm). */
export const TOUCH_SM = "pointer-coarse:h-11!";
/** For an inline text control (a link-styled button or an icon): a taller hit area without moving the text. */
export const TOUCH_INLINE = "pointer-coarse:inline-block pointer-coarse:min-h-11 pointer-coarse:-my-3.5 pointer-coarse:py-3.5 pointer-coarse:-mx-2 pointer-coarse:px-2";

/** A disclosure that reads as a control: the global summary style draws the chevron that turns when open. */
export function Disclosure({ summary, children, className = "" }: { summary: ReactNode; children: ReactNode; className?: string }) {
  return (
    <details className={className}>
      <summary className={SUMMARY}>{summary}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

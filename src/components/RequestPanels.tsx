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

/** A disclosure that reads as a control: chevron that turns when open, small ghost button style. */
export function Disclosure({ summary, children, className = "" }: { summary: ReactNode; children: ReactNode; className?: string }) {
  return (
    <details className={`group ${className}`}>
      <summary className="inline-flex h-[26px] items-center gap-1.5 rounded px-1.5 text-xs font-medium text-ink-soft hover:bg-[color:var(--paper)] hover:text-ink">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="transition-transform group-open:rotate-90 motion-reduce:transition-none">
          <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

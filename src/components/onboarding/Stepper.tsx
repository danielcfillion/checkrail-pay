import Link from "next/link";

/** The three onboarding screens, in order. Each step links to its page; the current one is marked for screen readers. */
export const ONBOARDING_STEPS = [
  { n: 1, label: "Bring in your data", href: "/onboarding" },
  { n: 2, label: "Check our calls", href: "/onboarding/calibrate" },
  { n: 3, label: "Your first weeks", href: "/onboarding/dashboard" },
] as const;

/**
 * The setup stepper at the top of each onboarding page. Steps before the current one show a tick; colour is not
 * used for progress (the app keeps colour for payment status), only weight and fill.
 */
export function Stepper({ current }: { current: 1 | 2 | 3 }) {
  return (
    <nav aria-label="Setup steps" className="mb-6">
      <p className="dense mb-2 text-ink-soft">
        Setup, step {current} of {ONBOARDING_STEPS.length}
      </p>
      <ol className="flex flex-wrap items-center gap-2">
        {ONBOARDING_STEPS.map((s, i) => {
          const here = s.n === current;
          const done = s.n < current;
          return (
            <li key={s.n} className="flex items-center gap-2">
              <Link
                href={s.href}
                aria-current={here ? "step" : undefined}
                className={`inline-flex h-9 items-center gap-2 rounded-full pl-1.5 pr-4 text-sm ${here ? "bg-[color:var(--primary)] font-semibold text-[color:var(--primary-ink)]" : "bg-sheet font-medium text-ink shadow-[var(--card-shadow)] hover:text-ink"}`}
              >
                <span
                  aria-hidden
                  className={`num inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${here ? "bg-[color:var(--primary-ink)] text-[color:var(--primary)]" : "bg-neutral-soft text-ink"}`}
                >
                  {done ? (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                      <path d="M3.25 6.25l1.9 1.9L8.9 4.2" />
                    </svg>
                  ) : (
                    s.n
                  )}
                </span>
                {s.label}
                {done ? <span className="sr-only"> (done)</span> : null}
              </Link>
              {i < ONBOARDING_STEPS.length - 1 ? <span aria-hidden className="h-px w-4 bg-[color:var(--rule-strong)] max-sm:hidden" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

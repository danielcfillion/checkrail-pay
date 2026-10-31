import type { DashboardData } from "@/lib/onboarding/dashboard";
import { formatMoney } from "@/lib/format";
import { LEVEL_LABEL } from "@/lib/studio/onboardingData";
import { falseHoldCaption, falseHoldPoints, percent, targetOf } from "@/lib/studio/falseHolds";
import { CheckIcon, WaitIcon } from "./icons";

/**
 * The same numbers as the dashboard, as plain readable text: shown while Studio loads its script, and instead of
 * Studio if it cannot load. Readiness checks, money stopped, and holds that turned out fine, week by week.
 */
export function FallbackSummary({ data, note }: { data: DashboardData; note?: string }) {
  const summary = data.readiness_summary[0];
  const checks = data.readiness.filter((r) => r.counts_toward_gauge).sort((a, b) => a.position - b.position);
  const gate = data.readiness.find((r) => !r.counts_toward_gauge);
  const met = checks.filter((c) => c.met).length;
  const next = summary?.next_level ? (LEVEL_LABEL[summary.next_level] ?? summary.next_level) : null;
  const stopped = data.money_stopped.filter((r) => r.stopped_minor > 0);
  const byCurrency = new Map<string, number>();
  for (const r of stopped) byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.stopped_minor);
  const weeks = falseHoldPoints(data.weekly_false_holds);
  const target = targetOf(data.weekly_false_holds);

  return (
    <div className="grid gap-6 lg:grid-cols-2" data-testid="dashboard-fallback">
      {note ? <p className="dense text-ink-soft lg:col-span-2">{note}</p> : null}
      <section className="panel p-5">
        <h2 className="text-base font-semibold">{next ? `Ready for ${next}: ${met} of ${checks.length}` : `On ${LEVEL_LABEL[summary?.level ?? ""] ?? "Autopilot"}`}</h2>
        <ul className="mt-3 space-y-3">
          {checks.map((c) => (
            <li key={c.criterion_id} className="flex gap-2.5">
              <span className={`mt-0.5 shrink-0 ${c.met ? "text-settled" : "text-attention"}`}>{c.met ? <CheckIcon /> : <WaitIcon />}</span>
              <span>
                <span className="block font-medium">{c.label}</span>
                <span className="block text-ink-soft">{c.line}</span>
              </span>
            </li>
          ))}
        </ul>
        {gate ? <p className="dense mt-4 text-ink-soft">Time in Assist: {gate.line}</p> : null}
      </section>
      <section className="panel p-5">
        <h2 className="text-base font-semibold">Money stopped since you started</h2>
        <p className="num mt-2 text-2xl font-bold tracking-[-0.02em] text-blocked">{[...byCurrency].map(([cur, minor]) => formatMoney(minor, cur)).join(" + ") || "Nothing yet"}</p>
        <ul className="mt-3 divide-y hairline">
          {stopped.map((r) => (
            <li key={`${r.category}-${r.currency}`} className="flex justify-between gap-3 py-2">
              <span>{r.category_label}</span>
              <span className="num">{formatMoney(r.stopped_minor, r.currency)}</span>
            </li>
          ))}
        </ul>
        <h2 className="mt-6 text-base font-semibold">Holds that turned out fine</h2>
        <p className="mt-1 text-ink-soft">{falseHoldCaption(weeks, target)}</p>
        <ul className="mt-2 divide-y hairline">
          {weeks.map((w) => (
            <li key={w.week_start} className="flex justify-between gap-3 py-2">
              <span>Week of {w.label}</span>
              <span className={`num ${w.under ? "text-settled" : "text-attention"}`}>{percent(w.rate)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

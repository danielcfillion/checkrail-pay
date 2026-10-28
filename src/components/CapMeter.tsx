import { formatMoneySymbol } from "@/lib/format";

/** Used versus limit, as a plain bar with the numbers written out. Colour is never the only signal. */
export function CapMeter({ usedMinor, capMinor, currency, label }: { usedMinor: number; capMinor: number; currency: string; label: string }) {
  const pct = capMinor > 0 ? Math.min(100, Math.round((usedMinor / capMinor) * 100)) : 0;
  const tone = pct >= 100 ? "var(--blocked)" : pct >= 80 ? "var(--attention)" : "var(--settled)";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="dense text-ink-soft">{label}</span>
        <span className="num">
          {formatMoneySymbol(usedMinor, currency)} <span className="text-ink-soft">of {formatMoneySymbol(capMinor, currency)}</span>
        </span>
      </div>
      <div className="mt-1 h-2 w-full rounded-sm" style={{ background: "var(--rule)" }} role="img" aria-label={`${label}: ${formatMoneySymbol(usedMinor, currency)} of ${formatMoneySymbol(capMinor, currency)}, ${pct}%`}>
        <div className="h-2 rounded-sm" style={{ width: `${pct}%`, background: tone }} />
      </div>
      <p className="mt-1 text-xs text-ink-soft">{pct >= 100 ? "Cap reached. Further payments wait for a person." : `${formatMoneySymbol(Math.max(0, capMinor - usedMinor), currency)} left before the agent has to ask.`}</p>
    </div>
  );
}

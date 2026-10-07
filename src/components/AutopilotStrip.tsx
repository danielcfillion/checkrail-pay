import Link from "next/link";
import { getDb } from "@/lib/db";
import { autopilotStatus } from "@/lib/engine/autopilot";
import { formatMoney, formatMoneySymbol } from "@/lib/format";
import { ScheduledReleases } from "./ScheduledReleases";
import { PauseButton } from "./PauseButton";

/** Autonomy at a glance on the overview: the level, what is used of today's cap, what is about to go out, and the stop control. */
export function AutopilotStrip({ businessId, currency }: { businessId: string; currency: string }) {
  const ap = autopilotStatus(getDb(), businessId);
  const on = ap.level === "autopilot" && !ap.paused;
  const name = ap.level === "autopilot" ? (ap.paused ? "Autopilot paused" : "Autopilot on") : ap.level === "review" ? "Review everything" : "Assist";
  const line =
    ap.level === "autopilot"
      ? ap.paused
        ? "Nothing is sent without a person until you resume."
        : `The agent sends clean payments up to ${formatMoneySymbol(ap.perPaymentCapMinor, currency)} each. ${formatMoneySymbol(ap.committed24hMinor, currency)} of ${formatMoneySymbol(ap.dailyCapMinor, currency)} used in the last 24 hours.`
      : ap.level === "review"
        ? "A person approves and sends every payment."
        : "Clean small payments are approved for you. A person sends them.";
  return (
    <section className="panel mb-6" aria-label="Autonomy">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: on ? "var(--settled)" : ap.paused ? "var(--attention)" : "var(--ink-soft)" }} />
          <p className="min-w-0">
            <span className="font-medium">{name}.</span> <span className="text-ink-soft">{line}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {ap.level === "autopilot" ? <PauseButton paused={ap.paused} /> : null}
          <Link href="/close" className="btn btn-sm">
            Daily close
          </Link>
          <Link href="/settings" className="btn btn-sm">
            Change
          </Link>
        </div>
      </div>
      {ap.scheduled.length ? (
        <div className="border-t hairline">
          <ScheduledReleases rows={ap.scheduled.map((s) => ({ id: s.id, vendorName: s.vendorName, amountText: formatMoney(s.amountMinor, s.currency), releaseAt: s.releaseAt }))} />
        </div>
      ) : null}
    </section>
  );
}

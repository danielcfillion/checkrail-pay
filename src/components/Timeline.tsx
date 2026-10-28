import { entryParts, formatDateTime, formatTime, formatDate, stateLabel } from "@/lib/format";

export type AuditRow = {
  id: string;
  actor: string;
  action: string;
  fromState: string | null;
  toState: string | null;
  detailJson: string | null;
  createdAt: string;
};

/** Audit entries as a quiet vertical timeline. Detail JSON is collapsed by default. */
export function Timeline({ entries }: { entries: AuditRow[] }) {
  if (!entries.length) return <p className="text-ink-soft">No history yet.</p>;
  let lastDay = "";
  return (
    <ol className="relative ml-1.5 border-l hairline">
      {entries.map((e) => {
        const day = formatDate(e.createdAt);
        const showDay = day !== lastDay;
        lastDay = day;
        const tone = toneFor(e.action);
        return (
          <li key={e.id} className="relative pb-4 pl-4 last:pb-0">
            <span className="absolute -left-[4.5px] top-1.5 h-2 w-2 rounded-full" style={{ background: tone, border: "1.5px solid var(--sheet)", boxSizing: "content-box" }} aria-hidden />
            {showDay ? <p className="dense mb-0.5 text-ink-soft">{day}</p> : null}
            <div className="flex items-baseline justify-between gap-2">
              <p className="min-w-0">
                <span className="text-ink-soft">{entryParts(e.actor, e.action).who}</span>{" "}
                <span className="font-medium">{entryParts(e.actor, e.action).what}</span>
              </p>
              <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)} className="num shrink-0 text-xs text-ink-soft">
                {formatTime(e.createdAt)}
              </time>
            </div>
            {e.fromState || e.toState ? (
              <p className="text-xs text-ink-soft">
                {e.fromState ? `${stateLabel(e.fromState)} to ${stateLabel(e.toState)}` : `Now ${stateLabel(e.toState).toLowerCase()}`}
              </p>
            ) : null}
            {e.detailJson && e.detailJson !== "{}" ? (
              <details className="mt-1">
                <summary className="dense inline-block text-ink-soft hover:text-ink">Detail</summary>
                <pre className="num mt-1 max-h-64 overflow-auto rounded bg-paper p-2 text-2xs leading-4 text-ink-soft" style={{ fontFamily: "inherit", fontStretch: "92%" }}>
                  {pretty(e.detailJson)}
                </pre>
              </details>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function pretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function toneFor(action: string): string {
  if (action.startsWith("policy.block") || action.includes("failed") || action.includes("rejected") || action.includes("cancelled")) return "var(--blocked)";
  if (action.startsWith("settlement.confirmed") || action.startsWith("accounting")) return "var(--settled)";
  if (action.includes("require_approval") || action.includes("hold")) return "var(--attention)";
  return "var(--ink-soft)";
}

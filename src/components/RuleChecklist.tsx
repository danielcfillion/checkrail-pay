type Rule = { ruleId: string; passed: boolean; severity: string; message: string };

/** The policy engine's own output, verbatim, with pass/fail marks and severity. */
export function RuleChecklist({ rules, decision }: { rules: Rule[]; decision?: string | null }) {
  if (!rules.length) return <p className="text-ink-soft">Policy has not evaluated this obligation yet.</p>;
  const failed = rules.filter((r) => !r.passed);
  return (
    <div>
      <ul className="space-y-2">
        {rules.map((r, i) => {
          const colour = r.passed ? "var(--settled)" : r.severity === "block" ? "var(--blocked)" : "var(--attention)";
          return (
            <li key={`${r.ruleId}-${i}`} className="grid grid-cols-[16px_1fr_auto] items-start gap-x-2.5">
              <span className="mt-0.5 flex h-4 w-4 items-center justify-center" style={{ color: colour }} aria-hidden>
                {r.passed ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2.5 7.5l3 3 6-7" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                    <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
                  </svg>
                )}
              </span>
              <span className={r.passed ? "" : "font-medium"}>
                <span className="sr-only">{r.passed ? "Passed: " : "Failed: "}</span>
                {r.message}
              </span>
              <span className="dense whitespace-nowrap" style={{ color: r.passed ? "var(--ink-soft)" : colour }}>
                {r.passed ? r.ruleId.replace(/_/g, " ") : r.severity}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 border-t pt-2 text-xs text-ink-soft hairline">
        {rules.length - failed.length} of {rules.length} rules passed.
        {decision ? ` Decision: ${decisionLabel(decision)}.` : ""}
      </p>
    </div>
  );
}

export function decisionLabel(d: string): string {
  switch (d) {
    case "auto_execute":
      return "pay without approval";
    case "require_approval":
      return "approval required";
    case "block":
      return "block";
    case "hold":
      return "hold for evidence";
    default:
      return d.replace(/_/g, " ");
  }
}

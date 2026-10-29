import type { EarlierPayment } from "@/lib/earlier-payment";
import { ReasonText } from "./ReasonText";
import { Disclosure } from "./RequestPanels";

type Rule = { ruleId: string; passed: boolean; severity: string; message: string };

/** Severity in words, sentence case. */
export function severityLabel(r: Rule): string {
  if (r.passed) return "Passed";
  return r.severity === "block" ? "Blocks payment" : "Warning";
}

/** Failing rows first (blocks, then warnings), passes after: what a person has to read comes first. */
export function orderRules<T extends Rule>(rules: T[]): { failing: T[]; passed: T[] } {
  const blocks = rules.filter((r) => !r.passed && r.severity === "block");
  const warnings = rules.filter((r) => !r.passed && r.severity !== "block");
  return { failing: [...blocks, ...warnings], passed: rules.filter((r) => r.passed) };
}

function Mark({ passed, colour }: { passed: boolean; colour: string }) {
  return (
    <span className="mt-0.5 flex h-4 w-4 items-center justify-center" style={{ color: colour }} aria-hidden>
      {passed ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 7.5l3 3 6-7" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
        </svg>
      )}
    </span>
  );
}

function Row({ r, earlier }: { r: Rule; earlier?: Map<string, EarlierPayment> }) {
  const colour = r.passed ? "var(--settled)" : r.severity === "block" ? "var(--blocked)" : "var(--attention)";
  return (
    <li className="grid grid-cols-[16px_1fr] items-start gap-x-2.5 sm:grid-cols-[16px_1fr_auto]">
      <Mark passed={r.passed} colour={colour} />
      <span className={r.passed ? "" : "font-medium"}>
        <span className="sr-only">{severityLabel(r)}: </span>
        <ReasonText text={r.message} earlier={earlier} />
      </span>
      {r.passed ? null : (
        <span className="col-start-2 mt-0.5 sm:col-start-3 sm:mt-0">
          <span className="dense inline-flex h-5 items-center whitespace-nowrap rounded-sm px-1.5" style={{ color: colour, background: r.severity === "block" ? "var(--blocked-soft)" : "var(--attention-soft)" }} aria-hidden>
            {severityLabel(r)}
          </span>
        </span>
      )}
    </li>
  );
}

/** The policy engine's own output, verbatim. Failing and warning rows first; passes collapsed behind a count. */
export function RuleChecklist({ rules, earlier, readerOpen = false }: { rules: Rule[]; earlier?: Map<string, EarlierPayment>; readerOpen?: boolean }) {
  if (!rules.length) return <p className="text-ink-soft">Policy has not checked this request yet.</p>;
  const { failing, passed } = orderRules(rules);
  return (
    <div>
      {failing.length ? (
        <ul className="space-y-2.5">
          {failing.map((r, i) => (
            <Row key={`${r.ruleId}-${i}`} r={r} earlier={earlier} />
          ))}
        </ul>
      ) : (
        <p className="flex items-start gap-2 text-settled">
          <Mark passed colour="var(--settled)" />
          {readerOpen ? "Every rule passed. The agent's concerns are not rules; read them under What the agent read." : "Every check passed."}
        </p>
      )}
      {passed.length ? (
        <Disclosure className={failing.length ? "mt-3 border-t pt-2 hairline" : "mt-2"} summary={`${passed.length} ${passed.length === 1 ? "check" : "checks"} passed`}>
          <ul className="space-y-2 pb-1 pl-1.5">
            {passed.map((r, i) => (
              <Row key={`${r.ruleId}-${i}`} r={r} earlier={earlier} />
            ))}
          </ul>
        </Disclosure>
      ) : null}
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

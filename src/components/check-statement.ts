/**
 * What the decision band may say about the checks, built from data the page already has: the policy rules and the
 * reading shown under "What the agent read". The band must never say "Every check passed" while that reading holds
 * an open concern, a missing record or a low confidence, because the reader of the band is about to click Approve.
 */

type Rule = { ruleId: string; passed: boolean; severity: string; message: string };

/** The reading the page shows, whichever one it leads with. */
export type ReaderView = {
  /** Percent, 0 to 100; null when nobody has read the request. */
  confidence: number | null;
  concerns: string[];
  missing: string[];
  /** A replayed live run. Policy never saw it, so the band says the rules did not either. */
  recorded: boolean;
};

export type CheckKind = "clear" | "reader" | "low_confidence" | "warnings" | "blocked";

export type CheckStatement = {
  kind: CheckKind;
  /** The sentence that replaces "Every check passed." on the band. */
  text: string;
  /** A short label for the band's corner; null when everything is clear. */
  chip: string | null;
};

/** The default threshold in policy.ts (minAiConfidence). The rules carry the live figure when they warn about it. */
export const DEFAULT_MIN_CONFIDENCE = 75;

/** Rules that restate the reader's own output; the reading counts them, so the rules must not count them twice. */
const READER_RULES = new Set(["ai_confidence", "ai_flag", "ai_missing"]);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The first clause of a long concern: up to the first colon or full stop, clipped at a word. */
export function firstClause(text: string, max = 96): string {
  const first = text.trim().split(/:\s|\.\s|\.$/)[0].trim();
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : cut.length).trimEnd()}…`;
}

/** The threshold a "below the N% threshold" warning names, if the rules carry one. */
function thresholdFrom(rules: Rule[]): number {
  for (const r of rules) {
    const m = r.ruleId === "ai_confidence" ? r.message.match(/below the (\d+)% threshold/) : null;
    if (m) return Number(m[1]);
  }
  return DEFAULT_MIN_CONFIDENCE;
}

export function checkStatement(i: { rules: Rule[]; reader?: ReaderView | null; minConfidence?: number }): CheckStatement {
  const reader = i.reader ?? null;
  const min = i.minConfidence ?? thresholdFrom(i.rules);
  // A live reading is already in the rules as warnings; a recorded one never was.
  const dropReaderRules = reader !== null && !reader.recorded;
  const failing = i.rules.filter((r) => !r.passed && !(dropReaderRules && READER_RULES.has(r.ruleId)));
  const blocks = failing.filter((r) => r.severity === "block").length;
  const warnings = failing.length - blocks;

  const concerns = reader?.concerns.length ?? 0;
  const missing = reader?.missing.length ?? 0;
  const low = reader !== null && reader.confidence !== null && reader.confidence < min;
  const readerOpen = concerns + missing > 0 || low;

  if (blocks === 0 && warnings === 0 && !readerOpen) return { kind: "clear", text: "Every check passed.", chip: null };

  // The rules sentence, without its full stop: the reader's part may continue it.
  const head =
    blocks > 0
      ? `${plural(blocks, "rule blocks", "rules block")} this request${warnings ? ` and ${plural(warnings, "warning", "warnings")}` : ""}`
      : warnings > 0
        ? `Rules passed, with ${plural(warnings, "warning", "warnings")}`
        : "Rules passed";

  let tail = "";
  if (readerOpen && reader) {
    const joiner = blocks > 0 || warnings > 0 ? "and" : "but";
    const who = reader.recorded ? "the recorded Claude run" : "the reader";
    const bits: string[] = [];
    if (concerns > 0) bits.push(`raised ${plural(concerns, "concern", "concerns")}`);
    if (missing > 0) bits.push(`wants ${plural(missing, "missing record", "missing records")}`);
    const confidence = reader.confidence !== null ? `Confidence ${reader.confidence}%${low ? `, below the ${min}% threshold` : ""}.` : "";
    tail =
      bits.length > 0
        ? `, ${joiner} ${who} ${bits.join(" and ")}: ${firstClause((reader.concerns[0] ?? reader.missing[0]) as string)}. ${confidence}`
        : `, ${joiner} ${reader.recorded ? "the recorded run's" : "the reader's"} confidence is ${reader.confidence}%, below the ${min}% threshold.`;
    if (reader.recorded) tail += " The rules did not see this run.";
  } else {
    tail = ".";
  }

  const text = `${head}${tail}`.replace(/\s+/g, " ").trim();
  const kind: CheckKind = blocks > 0 ? "blocked" : concerns + missing > 0 ? "reader" : low ? "low_confidence" : "warnings";
  const chip =
    blocks > 0
      ? plural(blocks, "blocking rule", "blocking rules")
      : concerns + missing > 0
        ? plural(concerns + missing, "reader concern", "reader concerns")
        : low
          ? `Low confidence ${reader?.confidence}%`
          : plural(warnings, "warning", "warnings");
  return { kind, text, chip };
}

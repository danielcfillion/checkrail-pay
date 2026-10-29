import { humaniseAction, humaniseActor, stateLabel } from "@/lib/format";

export type TimelineEntry = { actor: string; action: string; fromState: string | null; toState: string | null; detailJson: string | null };

/** Where a request came from, for entries made by an intake rather than a person. */
const SOURCES: Record<string, string> = {
  "booking-webhook": "the booking system",
  "email-ingest": "an email",
};

const detail = (e: TimelineEntry): Record<string, unknown> => {
  try {
    return JSON.parse(e.detailJson ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * One history row as people read it: who did what, and the state change only where the title does not already say
 * it. "System (booking webhook) created the request" becomes "Created from the booking system", "Agent (rules) read
 * the request" becomes "The rule-based reader read the request", and "Policy blocked it" loses "Drafted to Blocked".
 */
export function timelineRow(e: TimelineEntry): { who: string; what: string; change: string | null } {
  const [kind, rest] = e.actor.split(":");
  const source = kind === "system" && rest ? SOURCES[rest] ?? rest.replace(/-/g, " ") : null;
  let who = humaniseActor(e.actor);
  let what = humaniseAction(e.action);

  if (source && e.action === "obligation.created") [who, what] = ["", `Created from ${source}`];
  else if (source && (e.action === "evidence.attached" || e.action === "evidence.added")) [who, what] = ["", `Evidence attached from ${source}`];
  else if (source) who = `From ${source}:`;
  else if (e.action === "ai.interpreted") [who, what] = ["", e.actor === "ai:rules" ? "The rule-based reader read the request" : "Claude read the request"];
  else if (e.action === "paypal.history_checked") {
    const d = detail(e) as { ok?: boolean; matches?: unknown[] };
    who = "";
    what = d.ok === false ? "PayPal's records could not be read" : d.matches?.length ? "PayPal's records show this job already paid" : "Checked PayPal's own records: no payment for this job";
  } else if (e.action.endsWith(":seed")) what = humaniseAction(e.action.replace(/:seed$/, ""));

  // The first letter after a name is lower case ("Daniel created the request"); a row with no actor starts a sentence.
  const first = who.split(" ")[0]?.toLowerCase();
  if (first && what.toLowerCase().startsWith(`${first} `)) what = what.slice(first.length + 1);
  if (who && !who.endsWith(":")) what = what.charAt(0).toLowerCase() + what.slice(1);
  if (who.endsWith(":")) what = what.charAt(0).toLowerCase() + what.slice(1);

  // Policy rows already name the outcome, and a new request is always drafted: those state changes are noise.
  const quiet = e.action.startsWith("policy.") || e.action === "obligation.created";
  const change = quiet || !(e.fromState || e.toState) ? null : e.fromState ? `${stateLabel(e.fromState)} to ${stateLabel(e.toState)}` : `Now ${stateLabel(e.toState).toLowerCase()}`;
  return { who, what, change };
}

import { formatMoney } from "@/lib/format";

/** A payment named for the tour card: who and how much. */
export type NamedPayment = { vendorName: string | null; amountMinor: number; currency: string };

const name = (p: NamedPayment) => `${p.vendorName ?? "Unknown vendor"} ${formatMoney(p.amountMinor, p.currency)}`;

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What step 5's card says after turning Autopilot on, naming exactly what this pass scheduled. */
export function autopilotMessage(scheduled: NamedPayment[], window: string): string {
  if (!scheduled.length) return `Autopilot is on with a cancel window of ${window}. Nothing new was ready to schedule.`;
  const verb = scheduled.length === 1 ? "is" : "are";
  return `Autopilot is on. ${list(scheduled.map(name))} ${verb} scheduled with a cancel window of ${window}.`;
}

/** Step 5 when step 4 was skipped: nothing changed, and why. */
export function step4Message(maria: NamedPayment | null): string {
  const who = maria ? name(maria) : "Maria's request";
  return `Do step 4 first. ${who} for JOB-HG4D-0921 is ready to pay, so Autopilot would schedule it, and the recorded Claude run raised a possible duplicate on it. A person decides that one: press Back, pay or cancel it, then come back. Nothing was changed.`;
}

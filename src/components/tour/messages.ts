import { formatMoney } from "@/lib/format";

/** A payment named for the tour card: who and how much. */
export type NamedPayment = { vendorName: string | null; amountMinor: number; currency: string };

const name = (p: NamedPayment) => `${p.vendorName ?? "Unknown vendor"} ${formatMoney(p.amountMinor, p.currency)}`;

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What step 5's card says after turning Autopilot on, naming exactly what this pass scheduled (and what was paid first). */
export function autopilotMessage(scheduled: NamedPayment[], window: string, paidFirst: NamedPayment | null): string {
  const first = paidFirst ? `${name(paidFirst)} was paid over PayPal first, as step 4 does. ` : "";
  if (!scheduled.length) return `${first}Autopilot is on with a cancel window of ${window}. Nothing new was ready to schedule.`;
  const verb = scheduled.length === 1 ? "is" : "are";
  return `${first}Autopilot is on. ${list(scheduled.map(name))} ${verb} scheduled with a cancel window of ${window}.`;
}

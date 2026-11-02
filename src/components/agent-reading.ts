import { formatMoney, formatTime } from "@/lib/format";
import { recordedReadingFor, type RecordedReading } from "@/lib/demo/recordedReadings";

/** The exact label over a replayed reading. It says what it is, and that it did not decide anything. */
export const RECORDED_LABEL = "Recorded from a live Claude run (claude-sonnet-5-5, PayPal sandbox) on 28 Oct 2026 and replayed here. No model call is made in this demo; the decision below comes from the rules.";

type AuditLike = { actor: string; action: string; detailJson: string | null; createdAt: string };

type Amended = { patch?: { amountMinor?: number | null }; previous?: { amountMinor?: number | null; currency?: string | null } };

const amendments = (audit: AuditLike[]) =>
  audit
    .filter((a) => a.action === "obligation.amended" && a.actor.startsWith("user:"))
    .map((a) => ({ a, d: JSON.parse(a.detailJson ?? "{}") as Amended }))
    .filter(({ d }) => d.patch?.amountMinor != null);

/** The amount the reader saw: the figure before the first correction a person made, or the current one. */
export function amountAsRead(audit: AuditLike[], current: { amountMinor: number | null; currency: string | null }): { amountMinor: number | null; currency: string | null } {
  const first = amendments(audit)[0];
  if (!first) return current;
  return { amountMinor: first.d.previous?.amountMinor ?? current.amountMinor, currency: first.d.previous?.currency ?? current.currency };
}

/**
 * Which reading the "What the agent read" panel leads with. A recorded live Claude reading is shown only when this
 * request was read by the rule-based reader (so no model call was made), the recording is for the same vendor and
 * reference, and it read the same amount the reader saw (a new request that reuses a reference is not the one Claude
 * read), and it is the newest request with that vendor and reference (an older one that request duplicates was not
 * what Claude read). Its confidence is also what policy checked: the rule-based reader takes it over at the source
 * (withRecordedConfidence in src/lib/ai/agent.ts), so the page and the policy rule agree (except a reading marked reflectsLiveAccount).
 */
export function selectRecordedReading(
  i: { engine: "claude" | "rules" | null | undefined; vendorId: string | null | undefined; sourceRef: string | null | undefined; readAmountMinor: number | null; readCurrency: string | null; newestForReference: boolean },
  find: (vendorId: string | null | undefined, sourceRef: string | null | undefined) => RecordedReading | null = recordedReadingFor,
): RecordedReading | null {
  if (i.engine !== "rules" || !i.newestForReference) return null;
  const r = find(i.vendorId, i.sourceRef);
  if (!r) return null;
  if (i.readAmountMinor !== null && (r.amountMinor !== i.readAmountMinor || (i.readCurrency && r.currency !== i.readCurrency))) return null;
  return r;
}

/** The rule-based reader ends its summary with "2 concerns noted."; the concerns are counted once, elsewhere. */
export function summaryWithoutCount(summary: string): string {
  return summary.replace(/\s*\d+ concerns? noted\.\s*$/, "").trim();
}

/** "Read as USD 960.00. Corrected to USD 800.00 by Daniel, 05:58." after a person corrected the amount. */
/** The amount the request was first read as, when a person has since corrected it; null when never corrected. */
export function amountReadAs(audit: AuditLike[]): number | null {
  const all = amendments(audit);
  return all.length ? (all[0].d.previous?.amountMinor ?? null) : null;
}

export function correctionLine(audit: AuditLike[], currency: string | null): string | null {
  const all = amendments(audit);
  if (!all.length) return null;
  const first = all[0].d;
  const last = all[all.length - 1];
  const cur = first.previous?.currency ?? currency;
  const who = last.a.actor.replace(/^user:/, "").replace(/^\w/, (c) => c.toUpperCase());
  return `Read as ${formatMoney(first.previous?.amountMinor ?? null, cur)}. Corrected to ${formatMoney(last.d.patch!.amountMinor!, currency)} by ${who}, ${formatTime(last.a.createdAt)}.`;
}

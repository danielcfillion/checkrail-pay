import { and, eq, gt } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db";
import { obligations } from "@/lib/db/schema";
import { getObligationDetail } from "@/lib/queries";
import { amountAsRead, selectRecordedReading } from "@/components/agent-reading";
import { checkStatement, concernNote, type ConcernNote, type ReaderView } from "@/components/check-statement";
import type { RecordedReading } from "@/lib/demo/recordedReadings";

type Detail = NonNullable<ReturnType<typeof getObligationDetail>>;

/**
 * The reading a request page leads with, and the same reading as the view the check statement takes. One function for
 * the request page, the autopilot countdown and Daily close, so none of them can show less than the page does.
 * `recorded` is a replayed live Claude run (display only; policy never sees it).
 */
export function readingFor(d: Detail, db: Db = getDb()): { recorded: RecordedReading | null; reader: ReaderView | null } {
  const o = d.obligation;
  const asRead = amountAsRead(d.audit, { amountMinor: o.amountMinor, currency: o.currency });
  const newer = o.vendorId && o.sourceRef ? db.select({ id: obligations.id }).from(obligations).where(and(eq(obligations.vendorId, o.vendorId), eq(obligations.sourceRef, o.sourceRef), gt(obligations.createdAt, o.createdAt))).get() : undefined;
  const recorded = selectRecordedReading({ engine: d.agentRun?.engine, vendorId: o.vendorId, sourceRef: o.sourceRef, readAmountMinor: asRead.amountMinor, readCurrency: asRead.currency, newestForReference: !newer });
  const reader: ReaderView | null = recorded
    ? { confidence: recorded.confidence, concerns: recorded.flags, missing: recorded.missing, recorded: true }
    : o.aiConfidence !== null
      ? { confidence: o.aiConfidence, concerns: d.aiFlags, missing: d.aiMissing, recorded: false }
      : null;
  return { recorded, reader };
}

/** What to show beside each of these requests when its reading is not clear, by id; requests with nothing open are left out. */
export function readerNotesFor(ids: string[], db: Db = getDb()): Record<string, ConcernNote> {
  const out: Record<string, ConcernNote> = {};
  for (const id of ids) {
    const d = getObligationDetail(id, db);
    if (!d) continue;
    const note = concernNote(checkStatement({ rules: d.policyRules, reader: readingFor(d, db).reader }));
    if (note) out[id] = note;
  }
  return out;
}

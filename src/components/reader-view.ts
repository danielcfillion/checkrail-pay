import { and, eq, gt } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { obligations } from "@/lib/db/schema";
import type { getObligationDetail } from "@/lib/queries";
import type { RecordedReading } from "@/lib/demo/recordedReadings";
import { amountAsRead, selectRecordedReading } from "./agent-reading";
import type { ReaderView } from "./check-statement";

type Detail = NonNullable<ReturnType<typeof getObligationDetail>>;

/**
 * The reading a request is shown with: a recorded live Claude run when one applies (display only, policy never sees it),
 * else the reader's own output stored on the request. The request page and the payment run page both take it from here,
 * so a concern is the same concern wherever it is shown.
 */
export function readingFor(d: Pick<Detail, "obligation" | "audit" | "agentRun" | "aiFlags" | "aiMissing">, db: Db): { recorded: RecordedReading | null; reader: ReaderView | null } {
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

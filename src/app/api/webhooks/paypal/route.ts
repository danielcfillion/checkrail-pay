import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { events, paymentAttempts } from "@/lib/db/schema";
import { newId, now } from "@/lib/domain/ids";
import { confirmSettlement } from "@/lib/engine/orchestrator";
import { config } from "@/lib/config";

/**
 * PayPal webhook receiver. Verifies the signature with PayPal in live mode,
 * stores the raw event (idempotent on event id), then asks the orchestrator to
 * re-check settlement for the matching obligation. The webhook never changes
 * state itself; it only triggers a status check, so a forged or replayed event
 * cannot mark anything as paid.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const db = getDb();

  if (config.rails.mode === "live") {
    const { PayPalRail } = await import("@/lib/rails/paypal");
    const ok = await new PayPalRail().verifyWebhook(headers, raw).catch(() => false);
    if (!ok) return NextResponse.json({ error: "signature verification failed" }, { status: 400 });
  }

  let body: { id?: string; event_type?: string; resource?: { payout_batch_id?: string; batch_header?: { payout_batch_id?: string }; sender_batch_id?: string } } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const externalEventId = body.id ?? null;
  if (externalEventId && db.select().from(events).where(eq(events.externalEventId, externalEventId)).get()) {
    return NextResponse.json({ ok: true, duplicate: true });
  }
  db.insert(events).values({ id: newId("evt"), source: "paypal_webhook", externalEventId, type: body.event_type ?? "unknown", payloadJson: raw, processedAt: null, createdAt: now() }).run();

  const batchId = body.resource?.payout_batch_id ?? body.resource?.batch_header?.payout_batch_id ?? null;
  if (batchId) {
    const attempt = db.select().from(paymentAttempts).where(eq(paymentAttempts.externalId, batchId)).get();
    if (attempt) await confirmSettlement(db, attempt.obligationId, "paypal_webhook");
  }
  if (externalEventId) db.update(events).set({ processedAt: now() }).where(eq(events.externalEventId, externalEventId)).run();
  return NextResponse.json({ ok: true });
}

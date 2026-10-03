import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { events, paymentAttempts } from "@/lib/db/schema";
import { newId, now } from "@/lib/domain/ids";
import { confirmSettlement } from "@/lib/engine/orchestrator";
import { config } from "@/lib/config";

/**
 * PayPal webhook receiver. Verifies the signature with PayPal in live mode,
 * stores the raw event (unique on event id), then asks the orchestrator to
 * re-check settlement for the matching obligation. The webhook never changes
 * state itself; it only triggers a status check, so a forged or replayed event
 * cannot mark anything as paid.
 *
 * Replays: an event is skipped only once it has been fully processed. If processing
 * failed, the stored row stays unprocessed, we answer 500, and PayPal's retry is
 * processed again instead of being swallowed as a duplicate.
 *
 * In mock mode there is no signature to check. The mock rail confirms anything it is
 * asked about, so do not expose this route to the internet with RAIL_MODE=mock.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const db = getDb();

  if (config.rails.mode === "live") {
    try {
      const { PayPalRail } = await import("@/lib/rails/paypal");
      const ok = await new PayPalRail().verifyWebhook(headers, raw);
      if (!ok) return NextResponse.json({ error: "signature verification failed" }, { status: 400 });
    } catch {
      return NextResponse.json({ error: "signature verification failed" }, { status: 400 });
    }
  }

  let body: { id?: string; event_type?: string; resource?: { payout_batch_id?: string; batch_header?: { payout_batch_id?: string }; sender_batch_id?: string } } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  // An event with no id is keyed by a hash of its body, so identical replays still dedupe.
  const externalEventId = typeof body.id === "string" && body.id.length > 0 ? body.id : `sha256:${createHash("sha256").update(raw).digest("hex")}`;

  try {
    const existing = db.select().from(events).where(eq(events.externalEventId, externalEventId)).get();
    if (existing?.processedAt) return NextResponse.json({ ok: true, duplicate: true });
    if (!existing) {
      // The unique index makes a concurrent duplicate insert a no-op instead of a second row.
      db.insert(events).values({ id: newId("evt"), source: "paypal_webhook", externalEventId, type: body.event_type ?? "unknown", payloadJson: raw, processedAt: null, createdAt: now() }).onConflictDoNothing().run();
    }

    const batchId = body.resource?.payout_batch_id ?? body.resource?.batch_header?.payout_batch_id ?? null;
    if (batchId) {
      const attempt = db.select().from(paymentAttempts).where(eq(paymentAttempts.externalId, batchId)).get();
      if (attempt) await confirmSettlement(db, attempt.obligationId, "paypal_webhook");
    }
    db.update(events).set({ processedAt: now() }).where(eq(events.externalEventId, externalEventId)).run();
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(`[webhook] processing failed for event ${externalEventId}: ${(e as Error).message}`);
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
